/* Operates visible Canva editor UI.
 * Uploads color origin image, applies "Khớp định dạng" -> "Nghệ thuật đường nét",
 * and returns the line art image to FillColoring Studio.
 */
(() => {
  'use strict';
  if (window.__fillColoringCanvaBridgeLoaded) return;
  window.__fillColoringCanvaBridgeLoaded = true;

  let task = null, cancelled = false, phase = 'Đang mở Canva…', heartbeat = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();

  const buttons = () => [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"]')].filter(visible);
  const findButton = regex => buttons().find(el => regex.test(label(el)));

  async function message(type, extra = {}) {
    const answer = await chrome.runtime.sendMessage({ type, id: task?.id, ...extra });
    if (answer?.cancelled) cancelled = true;
    if (answer?.error) throw new Error(answer.error);
    return answer;
  }

  function check() {
    if (cancelled) throw new Error('Đã dừng tác vụ.');
  }

  async function waitFor(fn, seconds, error) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      check();
      const result = fn();
      if (result) return result;
      await sleep(400);
    }
    throw new Error(error);
  }

  function showStatus(text) {
    phase = text;
    let banner = document.getElementById('fillcoloring-canva-status');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fillcoloring-canva-status';
      Object.assign(banner.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
        background: '#00c4cc', color: '#0e1318', padding: '12px 20px', borderRadius: '10px',
        fontWeight: 'bold', font: '13px Segoe UI, sans-serif', maxWidth: '520px', pointerEvents: 'none',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
      });
      document.body.append(banner);
    }
    banner.textContent = 'FillColoring Canva · ' + text;
  }

  async function uploadImage() {
    showStatus('Đang đưa ảnh màu gốc vào Canva…');
    const bytes = Uint8Array.from(atob(task.image), c => c.charCodeAt(0));
    const file = new File([bytes], task.filename, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);

    // 1. Find drop target (canvas container in Canva editor)
    const dropTarget = document.querySelector('[data-testid="canvas-container"], canvas, [role="main"]') || document.body;
    dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));

    await sleep(2000);
  }

  async function applyLineArtStyle() {
    showStatus('Đang tìm tính năng Khớp định dạng…');
    // Try to open "Khớp định dạng" / "Style Match"
    let styleMatchBtn = findButton(/khớp định dạng|style match|match style/i);
    if (!styleMatchBtn) {
      // Click on canvas image first to select it
      const canvasEl = document.querySelector('canvas') || document.querySelector('[data-testid="canvas-container"]');
      if (canvasEl) canvasEl.click();
      await sleep(800);
      styleMatchBtn = findButton(/khớp định dạng|style match|match style/i);
    }

    if (styleMatchBtn) {
      styleMatchBtn.click();
      await sleep(1200);
    }

    // Now look for "Nghệ thuật đường nét" (Line art)
    showStatus('Đang chọn Nghệ thuật đường nét…');
    const lineArtOption = await waitFor(() => {
      const all = [...document.querySelectorAll('button, [role="button"], [role="radio"], [role="tab"], [role="option"]')].filter(visible);
      return all.find(el => /nghệ thuật đường nét|line art/i.test(label(el)));
    }, 20, 'Không tìm thấy tùy chọn "Nghệ thuật đường nét" trong Khớp định dạng.');

    lineArtOption.click();
    showStatus('Đang chuyển đổi sang ảnh đường nét (Canva)…');
    await sleep(3500);
  }

  async function extractLineImage(before) {
    showStatus('Đang chờ ảnh Line Art mới từ Canva.');
    // Editor canvases can be WebGL layers, blank buffers, or selection overlays.
    // Only accept a newly generated image; never serialize arbitrary editor canvases.
    let stable = '', since = 0;
    return await waitFor(() => {
      const candidates = [...document.images].filter(img =>
        visible(img) && img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256 &&
        !before.has(img.currentSrc || img.src));
      if (candidates.length !== 1) { stable = ''; return null; }
      const img = candidates[0], src = img.currentSrc || img.src;
      if (src !== stable) { stable = src; since = Date.now(); return null; }
      if (Date.now() - since < 5000) return null;
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      } catch (_) {
        if (/^https:\/\//.test(src)) return src;
        throw new Error('Không đọc được ảnh Canva. Tải PNG và nhập kết quả có sẵn.');
      }
    }, 180, 'Không xác định được một ảnh Line Art mới. Tải đúng PNG từ Canva rồi dùng Nhập kết quả có sẵn.');
  }

  async function run() {
    const marker = 'fillcoloring-canva-submitted-' + task.id;
    if (sessionStorage.getItem(marker)) {
      throw new Error('Tab Canva đã xử lý tác vụ này trước đó.');
    }

    heartbeat = setInterval(() => message('canva-progress', { message: phase }).catch(() => { cancelled = true; }), 2000);
    showStatus('Đang chuẩn bị trang Canva…');
    await sleep(3000);

    await uploadImage();
    check();

    const before = new Set([...document.images].map(img => img.currentSrc || img.src));
    await applyLineArtStyle();
    check();

    sessionStorage.setItem(marker, 'done');
    const result = await extractLineImage(before);

    showStatus('Đang chuyển ảnh nét về Studio…');
    clearInterval(heartbeat);
    heartbeat = null;

    if (result.length > 500 && !result.startsWith('http')) {
      await message('canva-result', { image: result });
    } else {
      await message('canva-result', { url: result });
    }
    showStatus('Đã đưa ảnh line vào Studio thành công!');
  }

  async function start() {
    for (let i = 0; i < 15; i++) {
      const answer = await chrome.runtime.sendMessage({ type: 'canva-ready' }).catch(() => null);
      if (answer?.task) { task = answer.task; break; }
      await sleep(1000);
    }
    if (!task) return;
    try {
      await run();
    } catch (error) {
      showStatus(error.message);
      if (!cancelled) await message('canva-error', { error: error.message }).catch(() => {});
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  start();
})();
