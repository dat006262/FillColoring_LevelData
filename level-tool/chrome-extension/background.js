'use strict';
const SERVER = 'http://127.0.0.1:8765';
let polling = false;

async function context() {
  const saved = await chrome.storage.session.get(['connection', 'agent', 'active']);
  if (!saved.agent) {
    saved.agent = crypto.randomUUID();
    await chrome.storage.session.set({ agent: saved.agent });
  }
  return saved;
}

async function post(route, data) {
  const { connection } = await context();
  if (!connection) throw new Error('Mở FillColoring Studio trong Chrome để kết nối lại.');
  const response = await fetch(SERVER + '/api/browser/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-App-Token': connection.token },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Mất kết nối Studio.');
  return result;
}

async function report(active, data) {
  const { agent } = await context();
  return post('report', { task_id: active.id, lease: active.lease, agent, ...data });
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    const { agent, connection, active } = await context();
    if (!connection) return;
    const { task } = await post('poll', { agent });
    if (active) {
      try {
        await chrome.tabs.get(active.tabId);
      } catch (_) {
        await report(active, { error: 'Tab đã đóng. Kết quả trước vẫn được giữ; chạy lại khi sẵn sàng.' }).catch(() => {});
        await chrome.storage.session.remove('active');
      }
      return;
    }
    if (!task) return;
    const url = new URL(task.url);
    const isGemini = url.origin === 'https://gemini.google.com' && /^\/(?:u\/\d+\/)?app$/.test(url.pathname);
    const isAiStudio = url.origin === 'https://aistudio.google.com';
    const isCanva = (url.origin === 'https://www.canva.com' || url.origin === 'https://canva.com') && url.pathname.includes('/design/');
    if (!isGemini && !isAiStudio && !isCanva) {
      await report(task, { error: 'Địa chỉ Gemini, Google AI Studio hoặc Canva không hợp lệ.' });
      return;
    }
    const page = await chrome.tabs.create({ url: url.href, active: true });
    const { image, ...metadata } = task;
    await chrome.storage.session.set({ active: { ...metadata, tabId: page.id, started: Date.now() } });
    const siteName = isCanva ? 'Canva' : (isAiStudio ? 'AI Studio' : 'Gemini');
    await report(task, { message: `Đã mở tab ${siteName} riêng. Đang chuẩn bị tải ảnh…` });
  } catch (_) {
  } finally {
    polling = false;
  }
}

async function imageData(url) {
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
    await chrome.storage.session.set({ connection: { token: msg.token } });
    await tick();
    return { ok: true };
  }
  if (origin !== 'https://gemini.google.com' && origin !== 'https://aistudio.google.com' && origin !== 'https://www.canva.com' && origin !== 'https://canva.com') {
    throw new Error('Chỉ nhận phản hồi từ Gemini, Google AI Studio hoặc Canva.');
  }
  const { active } = await context();
  if (!active || active.tabId !== sender.tab.id) return { task: null, cancelled: true };
  if (msg.type === 'gemini-ready' || msg.type === 'aistudio-ready' || msg.type === 'canva-ready') {
    const { agent } = await context();
    return post('payload', { task_id: active.id, lease: active.lease, agent });
  }
  if (msg.id !== active.id) return { cancelled: true };
  if (msg.type === 'gemini-progress' || msg.type === 'aistudio-progress' || msg.type === 'canva-progress') {
    try {
      const result = await report(active, { message: msg.message, page_url: sender.url });
      if (result.cancelled) await chrome.storage.session.remove('active');
      return result;
    } catch (_) {
      await chrome.storage.session.remove('active');
      return { cancelled: true };
    }
  }
  if (msg.type === 'gemini-error' || msg.type === 'aistudio-error' || msg.type === 'canva-error') {
    await report(active, { error: msg.error, page_url: sender.url }).catch(() => {});
    await chrome.storage.session.remove('active');
    return { ok: true };
  }
  if (msg.type === 'gemini-result' || msg.type === 'aistudio-result' || msg.type === 'canva-result') {
    try {
      const raw = msg.image || await imageData(msg.url);
      if (typeof raw !== 'string' || raw.length > 26 * 1024 * 1024) throw new Error('Ảnh kết quả quá lớn.');
      const result = await report(active, { image: raw, page_url: sender.url });
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
