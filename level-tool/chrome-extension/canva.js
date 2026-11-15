/* Operates visible Canva editor UI.
 * Step 2:
 * 1. Clear old image on page 1 (xóa ảnh cũ đi, thu được 1 trang trắng).
 * 2. Upload / paste color origin image ([picture_name]_colored_origin).
 * 3. Fit / select image on page.
 * 4. Click "Chỉnh sửa" on floating toolbar -> "Sửa hình ảnh" sidebar opens.
 * 5. In "Khớp định dạng", click "Nghệ thuật đường nét" (Line art).
 * 6. Wait for line art conversion to finish.
 * 7. Extract line art image and return to FillColoring Studio as [picture_name]_line_notpatch.
 */
(() => {
  'use strict';
  if (window.__fillColoringCanvaBridgeLoaded) return;
  window.__fillColoringCanvaBridgeLoaded = true;

  let task = null, cancelled = false, phase = 'Đang mở Canva…', heartbeat = null;
  let interceptedDownloadUrl = null;

  // Intercept anchor clicks to catch Canva native export downloads
  try {
    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const href = this.href || this.getAttribute('href');
      if (href && (href.startsWith('blob:') || href.startsWith('data:image') || /\.(png|jpe?g)($|\?)/i.test(href))) {
        interceptedDownloadUrl = href;
      }
      return origAnchorClick.apply(this, arguments);
    };
  } catch (_) {}

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();

  const buttons = () => [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"], [tabindex="0"]')].filter(visible);
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
      const result = await fn();
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

  function getCanvasStage() {
    return document.querySelector('[data-testid="canvas-container"]') ||
           document.querySelector('[data-testid="page-container"]') ||
           document.querySelector('.canvas-container') ||
           document.querySelector('canvas') ||
           document.querySelector('[role="main"]') ||
           document.body;
  }

  function clickCenterOf(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  }

  // Step 2.1: Xóa ảnh cũ đi, thu được 1 trang trắng
  async function clearOldImage() {
    showStatus('Bước 2.1: Đang xóa ảnh cũ trên trang (thu được trang trắng)…');
    const stage = getCanvasStage();
    clickCenterOf(stage);
    await sleep(600);

    // Look for delete button on floating bar ("Xóa ảnh", "Xóa", trash icon)
    const delBtn = findButton(/^xóa ảnh$|^xóa$|^delete$/i) ||
                   document.querySelector('button[aria-label*="Xóa"], button[aria-label*="Delete"], button[title*="Xóa"], button[title*="Delete"]');
    if (delBtn && visible(delBtn)) {
      delBtn.click();
      await sleep(600);
    } else {
      // Dispatch Delete and Backspace keys
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', keyCode: 46, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Delete', code: 'Delete', keyCode: 46, bubbles: true }));
      await sleep(300);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
      await sleep(500);
    }
  }

  // Step 2.2: Kéo ảnh màu ở bước 1 vào
  async function uploadImage() {
    showStatus('Bước 2.2: Đang đưa ảnh màu gốc vào Canva…');
    const bytes = Uint8Array.from(atob(task.image), c => c.charCodeAt(0));
    const filename = task.filename || 'origin.png';
    const file = new File([bytes], filename, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);

    const stage = getCanvasStage();
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    stage.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    stage.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));

    try {
      const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      (document.activeElement || stage).dispatchEvent(pasteEvent);
    } catch (_) {}

    await sleep(3000);
  }

  function findEditButton() {
    const list = buttons();
    return list.find(el => {
      const txt = label(el).trim();
      if (/magic/i.test(txt)) return false;
      return /^(?:chỉnh sửa|chỉnh sửa hình ảnh|edit|edit image)$/i.test(txt);
    });
  }

  // Step 2.3 & 2.4: Click vào ảnh, chọn "Chỉnh sửa" -> Mở "Sửa hình ảnh"
  async function openEditPanel() {
    // If "Khớp định dạng" or "Nghệ thuật đường nét" is already visible, edit panel is open
    const alreadyVisible = findButton(/nghệ thuật đường nét|line art/i);
    if (alreadyVisible) return;

    showStatus('Bước 2.3: Đang chọn ảnh và mở "Chỉnh sửa"…');
    const stage = getCanvasStage();

    const editBtn = await waitFor(() => {
      let b = findEditButton();
      if (!b) {
        clickCenterOf(stage);
        b = findEditButton();
      }
      return b;
    }, 20, 'Không tìm thấy nút "Chỉnh sửa" trên thanh công cụ ảnh.');

    editBtn.click();
    await sleep(1500);
  }

  // Step 2.5: Trong Khớp định dạng, chọn "Nghệ thuật đường nét"
  async function applyLineArtStyle() {
    showStatus('Bước 2.4: Đang tìm và chọn "Nghệ thuật đường nét"…');

    const lineArtOption = await waitFor(() => {
      // Find element with text "Nghệ thuật đường nét" or "Line art"
      const all = [...document.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], [tabindex="0"], div, span')].filter(visible);
      return all.find(el => {
        const txt = label(el).trim();
        return /^(?:nghệ thuật đường nét|line art)$/i.test(txt) ||
               (/\b(?:nghệ thuật đường nét|line art)\b/i.test(txt) && el.children.length <= 2);
      });
    }, 25, 'Không tìm thấy tùy chọn "Nghệ thuật đường nét" trong Khớp định dạng.');

    lineArtOption.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);

    showStatus('Đang áp dụng hiệu ứng "Nghệ thuật đường nét"…');
    lineArtOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    lineArtOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    lineArtOption.click();

    // Wait for the AI line art filter to process
    showStatus('Canva đang chuyển tranh sang nét đen…');
    await sleep(6000);

    // Wait until spinner inside thumbnail or progress bar disappears
    await waitFor(() => {
      // If "Đặt lại kiểu" button is visible, the style has definitely applied!
      const resetBtn = findButton(/đặt lại kiểu|reset style/i);
      if (resetBtn) return true;

      // Check if spinners inside sidebar are gone
      const spinners = [...document.querySelectorAll('[role="progressbar"], [aria-label*="loading"], [aria-label*="đang tải"]')].filter(visible);
      return spinners.length === 0;
    }, 45, 'Canva xử lý hiệu ứng nét đen quá lâu.');

    await sleep(2000);
  }

  // Step 2.6: Trích xuất ảnh line art ([picture_name]_line_notpatch)
  async function extractLineImage(beforeSrcs) {
    showStatus('Đang lấy ảnh kết quả Line Art từ Canva…');

    // 1. If anchor click intercepted a download blob URL, use it directly
    if (interceptedDownloadUrl) {
      try {
        const b64 = await blobUrlToBase64(interceptedDownloadUrl);
        if (b64) return b64;
      } catch (_) {}
    }

    // 2. Check images inside the canvas stage (excluding left sidebar/navigation)
    const stage = getCanvasStage();
    const imgs = [...stage.querySelectorAll('img')].filter(img =>
      visible(img) && img.naturalWidth >= 300 && img.naturalHeight >= 300 &&
      !img.closest('nav, aside, [role="region"], [data-testid*="sidebar"], [data-testid*="panel"]')
    );

    // Sort by largest area
    imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));

    for (const img of imgs) {
      const src = img.currentSrc || img.src;
      // Try drawImage to canvas
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1024;
        c.height = img.naturalHeight || 1024;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataUrl = c.toDataURL('image/png');
        if (dataUrl && dataUrl.length > 500) {
          return dataUrl.split(',')[1];
        }
      } catch (_) {}

      // Try fetching blob directly
      if (src && (src.startsWith('blob:') || src.startsWith('https://'))) {
        try {
          const res = await fetch(src, { credentials: 'include' });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 16384) bin += String.fromCharCode(...bytes.subarray(i, i + 16384));
            return btoa(bin);
          }
        } catch (_) {}
      }
    }

    // 3. Check canvas elements on stage
    const canvases = [...stage.querySelectorAll('canvas')].filter(c => c.width >= 400 && c.height >= 400);
    for (const canvas of canvases) {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl && dataUrl.length > 2000) {
          return dataUrl.split(',')[1];
        }
      } catch (_) {}
    }

    // 4. Fallback: Trigger Canva native "Chia sẻ" -> "Tải xuống"
    showStatus('Đang kích hoạt Chia sẻ -> Tải xuống từ Canva…');
    const shareBtn = findButton(/chia sẻ|share/i);
    if (shareBtn) {
      shareBtn.click();
      await sleep(1000);
      const dlMenuItem = findButton(/^tải xuống$|^download$/i);
      if (dlMenuItem) {
        dlMenuItem.click();
        await sleep(1500);
        // Look for the purple download button inside the export panel
        const confirmDlBtn = findButton(/^tải xuống$|^download$/i);
        if (confirmDlBtn) {
          confirmDlBtn.click();
          // Wait for download interception
          const b64 = await waitFor(async () => {
            if (interceptedDownloadUrl) {
              return await blobUrlToBase64(interceptedDownloadUrl);
            }
            return null;
          }, 30, 'Không lấy được file tải về từ Canva.');
          if (b64) return b64;
        }
      }
    }

    throw new Error('Chưa lấy được ảnh Line Art. Bạn có thể bấm Chia sẻ -> Tải xuống PNG rồi dùng "Nhập kết quả có sẵn" trong Studio.');
  }

  async function blobUrlToBase64(url) {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 16384) bin += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(bin);
  }

  async function run() {
    const marker = 'fillcoloring-canva-submitted-' + task.id;
    if (sessionStorage.getItem(marker)) {
      throw new Error('Tab Canva đã xử lý tác vụ này trước đó.');
    }

    heartbeat = setInterval(() => message('canva-progress', { message: phase }).catch(() => { cancelled = true; }), 2000);
    showStatus('Đang chuẩn bị trang Canva…');
    await sleep(2500);

    const beforeSrcs = new Set([...document.images].map(img => img.currentSrc || img.src));

    // 1. Clear old content on page 1
    await clearOldImage();
    check();

    // 2. Upload / paste color origin image
    await uploadImage();
    check();

    // 3. Open Edit Image panel ("Chỉnh sửa")
    await openEditPanel();
    check();

    // 4. Apply "Nghệ thuật đường nét"
    await applyLineArtStyle();
    check();

    sessionStorage.setItem(marker, 'done');

    // 5. Extract line art image
    const result = await extractLineImage(beforeSrcs);

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
