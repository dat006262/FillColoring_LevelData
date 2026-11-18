'use strict';
const SERVER = 'http://127.0.0.1:8765';
let polling = false;
let agentPromise;
let connectionPromise;

async function reconnect() {
  if (!connectionPromise) connectionPromise = (async () => {
    const response = await fetch(SERVER + '/', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Studio is unavailable');
    const html = await response.text();
    const token = html.match(/name="app-token" content="([^"]+)"/)?.[1];
    if (!token || token.length < 20) throw new Error('Invalid Studio connection');
    await chrome.storage.session.set({ connection: { token } });
  })().finally(() => { connectionPromise = null; });
  return connectionPromise;
}

async function context() {
  const saved = await chrome.storage.session.get(['connection', 'agent', 'active']);
  if (!saved.agent) {
    // Concurrent startup messages must share one identity.
    if (!agentPromise) agentPromise = (async () => {
      const agent = crypto.randomUUID();
      await chrome.storage.session.set({ agent });
      return agent;
    })().catch(error => { agentPromise = null; throw error; });
    saved.agent = await agentPromise;
  }
  return saved;
}

async function post(route, data, refreshed = false) {
  const { connection } = await context();
  if (!connection) throw new Error('Mở FillColoring Studio trong Chrome để kết nối lại.');
  const response = await fetch(SERVER + '/api/browser/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-App-Token': connection.token },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  // A restarted local server has a new token. A rejected request has not run,
  // so it is safe to refresh credentials and retry it once.
  if (response.status === 403 && !refreshed) {
    await reconnect();
    return post(route, data, true);
  }
  if (!response.ok) {
    const error = new Error(result.error || 'Mất kết nối Studio.');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function report(active, data) {
  const { agent } = await context();
  return post('report', { task_id: active.id, lease: active.lease, agent, ...data });
}

async function focusTaskTab(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;
    await chrome.tabs.update(tabId, { active: true, highlighted: true });
    if (tab.windowId) {
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      const updateInfo = { focused: true };
      if (win && win.state === 'minimized') {
        updateInfo.state = 'normal';
      }
      await chrome.windows.update(tab.windowId, updateInfo);
    }
  } catch (_) {}
}

function matchesTaskTab(value, target) {
  try {
    const candidate = new URL(value);
    if (candidate.origin !== target.origin) return false;
    if (target.origin === 'https://gemini.google.com') {
      return candidate.pathname === target.pathname || candidate.pathname.startsWith(target.pathname + '/');
    }
    // Keep separate AI Studio prompts and Canva designs in their own tabs.
    return candidate.pathname === target.pathname && candidate.search === target.search;
  } catch (_) { return false; }
}

async function openTaskTab(task) {
  const target = new URL(task.url);
  const { taskTabs = {}, active } = await chrome.storage.session.get(['taskTabs', 'active']);
  if (active) throw new Error('A browser task is still active');
  // Only clean up tracked tool tabs, never unrelated user tabs.
  for (const [url, tabId] of Object.entries(taskTabs)) {
    try {
      const old = await chrome.tabs.get(tabId);
      if (matchesTaskTab(old.url, new URL(url))) await chrome.tabs.remove(tabId);
    } catch (_) { /* Already closed or no longer accessible. */ }
  }
  // Install the lease before navigation so content scripts cannot miss it.
  const page = await chrome.tabs.create({ url: 'about:blank', active: true });
  const { image, ...metadata } = task;
  await chrome.storage.session.set({
    taskTabs: { [target.href]: page.id },
    active: { ...metadata, tabId: page.id, started: Date.now() }
  });
  await chrome.tabs.update(page.id, { url: target.href, active: true, highlighted: true });
  await focusTaskTab(page.id);
  setTimeout(() => focusTaskTab(page.id), 500);
  setTimeout(() => focusTaskTab(page.id), 1500);
  return page;
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    const { agent, connection, active } = await context();
    if (!connection) await reconnect();
    // Never claim a new task while holding an old active snapshot: the server
    // hands out each lease only once, so discarding that response stalls it.
    if (active) {
      if (active.tabId) {
        await focusTaskTab(active.tabId);
      }
      try {
        await post('payload', { task_id: active.id, lease: active.lease, agent });
      } catch (error) {
        if (error.status !== 400) throw error;
        const latest = await context();
        if (latest.active?.id === active.id) {
          await chrome.storage.session.remove('active');
          await chrome.tabs.remove(active.tabId).catch(() => {});
        }
      }
      if ((await context()).active) {
        try {
          await chrome.tabs.get(active.tabId);
        } catch (_) {
          await report(active, { error: 'Tab tác vụ đã đóng. Hãy chạy lại bước hiện tại.' });
          await chrome.storage.session.remove('active');
        }
        return;
      }
    }
    const { task } = await post('poll', { agent });
    if (!task) return;
    const url = new URL(task.url);
    const isGemini = url.origin === 'https://gemini.google.com' && /^\/(?:u\/\d+\/)?app$/.test(url.pathname);
    const isAiStudio = url.origin === 'https://aistudio.google.com';
    const isCanva = (url.origin === 'https://www.canva.com' || url.origin === 'https://canva.com') && url.pathname.includes('/design/');
    if (!isGemini && !isAiStudio && !isCanva) {
      await report(task, { error: 'Địa chỉ Gemini, Google AI Studio hoặc Canva không hợp lệ.' });
      return;
    }
    await openTaskTab(task);
    const siteName = isCanva ? 'Canva' : (isAiStudio ? 'AI Studio' : 'Gemini');
    await report(task, { message: `Đã mở tab ${siteName} riêng. Đang chuẩn bị tải ảnh…` });
  } catch (_) {
  } finally {
    polling = false;
  }
}

async function imageData(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('blob:')) {
    const response = await fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(binary);
  }
  const parsed = new URL(url);
  const allowed = ['gemini.google.com', 'aistudio.google.com', 'www.canva.com', 'canva.com'];
  const isAllowedHost = allowed.includes(parsed.hostname) ||
                        parsed.hostname.endsWith('.googleusercontent.com') ||
                        parsed.hostname.endsWith('.canva.com') ||
                        parsed.hostname.endsWith('.canva-static.com') ||
                        parsed.hostname.endsWith('.canvamedia.com');
  if (parsed.protocol !== 'https:' || !isAllowedHost) {
    throw new Error('Ảnh không thuộc Gemini/AI Studio/Canva. Hãy tải ảnh trong tab và nhập kết quả có sẵn.');
  }
  const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Không lấy được ảnh. Hãy tải ảnh trong tab rồi dùng Nhập kết quả có sẵn.');
  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('Trang chưa trả về file ảnh hợp lệ.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 18 * 1024 * 1024) throw new Error('Ảnh vượt quá 18 MB.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}

async function dispatch(msg, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab) throw new Error('Nguồn yêu cầu không hợp lệ.');
  const origin = new URL(sender.url || sender.tab.url).origin;
  if (msg.type === 'studio-heartbeat') {
    if (origin !== SERVER || typeof msg.token !== 'string' || msg.token.length < 20) throw new Error('Kết nối không hợp lệ.');
    // Do not overwrite a refreshed token with one from an old Studio tab.
    if (!(await context()).connection) await reconnect();
    await tick();
    return { ok: true };
  }
  if (origin !== 'https://gemini.google.com' && origin !== 'https://aistudio.google.com' && origin !== 'https://www.canva.com' && origin !== 'https://canva.com') {
    throw new Error('Chỉ nhận phản hồi từ Gemini, Google AI Studio hoặc Canva.');
  }
  const { active } = await context();
  if (!active || active.tabId !== sender.tab.id) return { task: null, cancelled: true };
  if (msg.type === 'force-focus') {
    const tabId = active?.tabId || sender.tab?.id;
    if (tabId) await focusTaskTab(tabId);
    return { ok: true };
  }
  if (msg.type === 'gemini-ready' || msg.type === 'aistudio-ready' || msg.type === 'canva-ready') {
    if (active?.tabId) await focusTaskTab(active.tabId);
    const { agent } = await context();
    return post('payload', { task_id: active.id, lease: active.lease, agent });
  }
  if (msg.id !== active.id) return { cancelled: true };
  if (msg.type === 'aistudio-reopen') {
    if (origin !== 'https://aistudio.google.com') throw new Error('Invalid retry source');
    if (active.editorRetry) return { retried: false };
    const { agent } = await context();
    await post('payload', { task_id: active.id, lease: active.lease, agent });
    const page = await chrome.tabs.create({ url: 'about:blank', active: true });
    await chrome.storage.session.set({
      active: { ...active, tabId: page.id, editorRetry: true },
      taskTabs: { [active.url]: page.id }
    });
    await chrome.tabs.update(page.id, { url: active.url, active: true, highlighted: true });
    await focusTaskTab(page.id);
    setTimeout(() => focusTaskTab(page.id), 500);
    await chrome.tabs.remove(active.tabId).catch(() => {});
    return { retried: true };
  }
  if (msg.type === 'gemini-progress' || msg.type === 'aistudio-progress' || msg.type === 'canva-progress') {
    if (active?.tabId) await focusTaskTab(active.tabId);
    try {
      const result = await report(active, { message: msg.message, page_url: sender.url });
      if (result.cancelled) await chrome.storage.session.remove('active');
      return result;
    } catch (error) {
      // Only a rejected lease ends the task; transport errors can recover.
      if (error.status === 400) {
        await chrome.storage.session.remove('active');
        return { cancelled: true };
      }
      return { reconnecting: true };
    }
  }
  if (msg.type === 'gemini-error' || msg.type === 'aistudio-error' || msg.type === 'canva-error') {
    await report(active, { error: msg.error, page_url: sender.url }).catch(() => {});
    await chrome.storage.session.remove('active');
    return { ok: true };
  }
  if (msg.type === 'gemini-result' || msg.type === 'aistudio-result' || msg.type === 'canva-result') {
    try {
      let raw = msg.image;
      if (!raw && msg.url) {
        raw = await imageData(msg.url);
      }
      if (raw) {
        if (typeof raw !== 'string' || raw.length > 26 * 1024 * 1024) throw new Error('Ảnh kết quả quá lớn.');
        const result = await report(active, { image: raw, page_url: sender.url });
        await chrome.storage.session.remove('active');
        return result;
      }
      const result = await report(active, { message: msg.message || 'Đã xuất file tải xuống thành công', page_url: sender.url });
      await chrome.storage.session.remove('active');
      return result;
    } catch (error) {
      await report(active, { error: error.message, page_url: sender.url }).catch(() => {});
      await chrome.storage.session.remove('active');
      throw error;
    }
  }
  throw new Error('Thao tác không hỗ trợ.');
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  dispatch(msg, sender).then(reply).catch(error => reply({ error: error.message }));
  return true;
});

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: SERVER }));
chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'heartbeat') tick();
});
// Fast polling while the worker is awake; alarms restore it after suspension.
setInterval(tick, 5000);
// Periodically reinforce task tab focus to prevent background tab throttling during all steps
setInterval(async () => {
  try {
    const { active } = await chrome.storage.session.get('active');
    if (active?.tabId) {
      await focusTaskTab(active.tabId);
    }
  } catch (_) {}
}, 2000);
tick();
