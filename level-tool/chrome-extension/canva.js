/* Operates visible Canva editor UI.
 * Step 2:
 * 1. Clear old image on page 1 (click vào tranh, nhấn DEL để xóa -> trang trắng).
 * 2. Upload / paste color origin image ([picture_name]_colored_origin).
 * 3. Kéo / đặt ảnh vừa 4 góc trang canvas.
 * 4. Click vào ảnh để chọn -> hiện nút "Chỉnh sửa" trên thanh công cụ -> click "Chỉnh sửa" -> hiện cửa sổ "Sửa hình ảnh".
 * 5. Trong "Khớp định dạng", click "Nghệ thuật đường nét" (Line art).
 * 6. Chờ Canva xử lý xong hiệu ứng nét đen.
 * 7. Trích xuất ảnh line art và gửi về FillColoring Studio dưới tên [picture_name]_line_notpatch.png.
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

  function querySelectorAllDeep(selector, root = document) {
    const results = [];
    try {
      results.push(...root.querySelectorAll(selector));
    } catch (_) {}
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      if (node.shadowRoot) {
        results.push(...querySelectorAllDeep(selector, node.shadowRoot));
      }
    }
    return results;
  }

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
        fontWeight: 'bold', font: '13px Segoe UI, sans-serif', maxWidth: '540px', pointerEvents: 'none',
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

  function getPageCenter() {
    const stage = getCanvasStage();
    if (stage && stage !== document.body) {
      const r = stage.getBoundingClientRect();
      if (r.width > 200 && r.height > 200) {
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function clickAt(x, y) {
    const target = document.elementFromPoint(x, y) || document.body;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      buttons: 1
    };
    try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
    try { if (target.focus) target.focus(); } catch (_) {}
    try { target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 })); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 })); } catch (_) {}
    return target;
  }

  function rightClickAt(x, y) {
    const target = document.elementFromPoint(x, y) || document.body;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 2,
      buttons: 2
    };
    try { target.dispatchEvent(new MouseEvent('contextmenu', opts)); } catch (_) {}
    return target;
  }

  function sendDeleteKeys() {
    const keys = [
      { key: 'Delete', code: 'Delete', keyCode: 46 },
      { key: 'Backspace', code: 'Backspace', keyCode: 8 }
    ];
    for (const { key, code, keyCode } of keys) {
      for (const target of [document.activeElement, document.body, document, window].filter(Boolean)) {
        try {
          target.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
        } catch (_) {}
      }
    }
  }

  function sendKey(key, code, keyCode) {
    for (const target of [document.activeElement, document.body, document, window].filter(Boolean)) {
      try {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
      } catch (_) {}
    }
  }

  // Step 2.1: Click vào tranh, nhấn DEL để xóa ảnh cũ -> trang trắng
  async function clearOldImage() {
    showStatus('Bước 2.1: Đang chọn ảnh cũ và nhấn DEL để xóa (thu trang trắng)…');
    const center = getPageCenter();

    // 1. Click center of canvas to select old element
    clickAt(center.x, center.y);
    await sleep(400);

    // 2. Press Delete key
    sendDeleteKeys();
    await sleep(300);

    // 3. If delete button on floating bar is visible, click it too
    const delBtn = querySelectorAllDeep('button, [role="button"]').find(el => {
      if (!visible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const text = (el.innerText || el.textContent || '').trim();
      return /^(?:xóa ảnh|xóa|delete)$/i.test(aria) ||
             /^(?:xóa ảnh|xóa|delete)$/i.test(title) ||
             /^(?:xóa ảnh|xóa|delete)$/i.test(text);
    });
    if (delBtn) {
      delBtn.click();
      await sleep(400);
    }

    sendDeleteKeys();
    await sleep(600);
  }

  // Step 2.2: Đưa ảnh màu gốc vào Canva
  async function uploadImage() {
    showStatus('Bước 2.2: Đang đưa ảnh màu gốc vào Canva…');
    const bytes = Uint8Array.from(atob(task.image), c => c.charCodeAt(0));
    const filename = task.filename || 'origin.png';
    const file = new File([bytes], filename, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);

    const center = getPageCenter();
    const stage = document.elementFromPoint(center.x, center.y) || getCanvasStage();

    stage.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: center.x, clientY: center.y }));
    stage.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: center.x, clientY: center.y }));
    stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: center.x, clientY: center.y }));

    try {
      const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      (document.activeElement || stage).dispatchEvent(pasteEvent);
    } catch (_) {}

    await sleep(3000);
  }

  // Step 2.2b: Đặt / kéo ảnh vừa với 4 góc trang
  async function fitImageToPage() {
    showStatus('Bước 2.2b: Đang khớp ảnh vừa với 4 góc trang…');
    const center = getPageCenter();

    // Select the newly placed image
    clickAt(center.x, center.y);
    await sleep(400);

    // Right-click to open context menu and select "Đặt hình ảnh làm nền" (snaps to exact 4 corners)
    rightClickAt(center.x, center.y);
    await sleep(600);

    const menuItems = querySelectorAllDeep('button, [role="menuitem"], [role="button"], div[tabindex="0"], span');
    const setBgOption = menuItems.find(el => {
      if (!visible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').trim();
      const text = (el.innerText || el.textContent || '').trim();
      return /đặt hình ảnh làm nền|đặt làm nền|set image as background|replace background/i.test(aria) ||
             /đặt hình ảnh làm nền|đặt làm nền|set image as background|replace background/i.test(text);
    });

    if (setBgOption) {
      setBgOption.click();
      await sleep(600);
    } else {
      sendKey('Escape', 'Escape', 27);
    }

    // Click again to ensure selection handles & toolbar are active
    clickAt(center.x, center.y);
    await sleep(400);
  }

  function isEditButton(el) {
    if (!el || !visible(el)) return false;
    const rawText = (el.innerText || el.textContent || '').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();

    // Exclude Magic tools (Chỉnh sửa Magic)
    if (/magic/i.test(rawText) || /magic/i.test(aria) || /magic/i.test(title)) return false;

    const patterns = [
      /^(?:chỉnh sửa|chỉnh sửa hình ảnh|chỉnh sửa ảnh|edit|edit image)$/i,
      /chỉnh sửa/i,
      /\bedit\b/i
    ];

    for (const pat of patterns) {
      if (pat.test(aria)) return true;
      if (pat.test(title)) return true;
      if (rawText.length > 0 && rawText.length <= 30 && pat.test(rawText)) return true;
    }
    return false;
  }

  function findEditButtonRobust() {
    const all = querySelectorAllDeep('button, [role="button"], [role="tab"], [role="menuitem"], div[tabindex], span[tabindex]');
    for (const el of all) {
      if (isEditButton(el)) return el;
    }

    // Fallback: Locate the toolbar container by looking for sibling buttons like "Thay thế" or "Xóa ảnh"
    for (const el of all) {
      const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
      if (/^(?:thay thế|xóa ảnh|xóa nền)$/i.test(txt)) {
        const parent = el.parentElement;
        if (parent) {
          const siblings = [...parent.children];
          const editSibling = siblings.find(s => isEditButton(s));
          if (editSibling) return editSibling;
          if (siblings[0] && visible(siblings[0])) return siblings[0];
        }
      }
    }

    return null;
  }

  function findLineArtOptionRobust() {
    const all = querySelectorAllDeep('button, [role="button"], [role="radio"], [role="option"], [tabindex="0"], div, span');
    return all.find(el => {
      if (!visible(el)) return false;
      const rawText = (el.innerText || el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const isLineArt = s => /nghệ thuật đường nét|line art/i.test(s);
      if (isLineArt(aria) || isLineArt(title)) return true;
      if (rawText.length > 0 && rawText.length <= 40 && isLineArt(rawText)) return true;
      return false;
    });
  }

  // Step 2.3 & 2.4: Chọn tranh -> hiện nút Chỉnh sửa -> nhấn nút Chỉnh sửa
  async function openEditPanel() {
    // If line art option is already visible, edit panel is already open!
    const alreadyOpen = findLineArtOptionRobust();
    if (alreadyOpen) return;

    showStatus('Bước 2.3: Đang chọn tranh để hiện nút "Chỉnh sửa"…');

    const editBtn = await waitFor(async () => {
      let btn = findEditButtonRobust();
      if (btn) return btn;

      // Click center of image to put it into selected state
      const center = getPageCenter();
      clickAt(center.x, center.y);
      await sleep(400);

      btn = findEditButtonRobust();
      if (btn) return btn;

      return null;
    }, 25, 'Không tìm thấy nút "Chỉnh sửa" trên thanh công cụ ảnh. Hãy click vào tranh trên Canva.');

    editBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(200);

    editBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    editBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    editBtn.click();

    showStatus('Đang mở cửa sổ "Sửa hình ảnh"…');
    await sleep(1500);
  }

  // Step 2.5: Trong Khớp định dạng, chọn "Nghệ thuật đường nét"
  async function applyLineArtStyle() {
    showStatus('Bước 2.4: Đang tìm và chọn "Nghệ thuật đường nét" trong Khớp định dạng…');

    const lineArtOption = await waitFor(() => {
      let opt = findLineArtOptionRobust();
      if (!opt) {
        // Scroll the sidebar to reveal "Khớp định dạng" if needed
        const sidebar = document.querySelector('[role="region"], aside, nav, [data-testid*="side-panel"]') || document.body;
        if (sidebar && sidebar.scrollTop !== undefined) sidebar.scrollTop += 200;
        opt = findLineArtOptionRobust();
      }
      return opt;
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
      const all = querySelectorAllDeep('button, [role="button"], span');
      const resetBtn = all.find(el => visible(el) && /đặt lại kiểu|reset style/i.test(el.innerText || el.textContent || ''));
      if (resetBtn) return true;

      // Check if spinners inside sidebar are gone
      const spinners = querySelectorAllDeep('[role="progressbar"], [aria-label*="loading"], [aria-label*="đang tải"]').filter(visible);
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
    const allButtons = querySelectorAllDeep('button, [role="button"]');
    const shareBtn = allButtons.find(el => visible(el) && /chia sẻ|share/i.test(el.innerText || el.textContent || el.getAttribute('aria-label') || ''));
    if (shareBtn) {
      shareBtn.click();
      await sleep(1000);
      const dlMenuItem = querySelectorAllDeep('button, [role="menuitem"], [role="button"]').find(el =>
        visible(el) && /^(?:tải xuống|download)$/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()));
      if (dlMenuItem) {
        dlMenuItem.click();
        await sleep(1500);
        const confirmDlBtn = querySelectorAllDeep('button, [role="button"]').find(el =>
          visible(el) && /^(?:tải xuống|download)$/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()));
        if (confirmDlBtn) {
          confirmDlBtn.click();
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

    // 1. Click vào tranh, nhấn DEL để xóa ảnh cũ -> trang trắng
    await clearOldImage();
    check();

    // 2. Kéo ảnh màu ở bước 1 vào
    await uploadImage();
    check();

    // 2b. Khớp ảnh vừa 4 góc trang canvas
    await fitImageToPage();
    check();

    // 3. Chọn tranh -> hiện nút Chỉnh sửa -> nhấn nút Chỉnh sửa -> hiện cửa sổ Sửa hình ảnh
    await openEditPanel();
    check();

    // 4. Trong Khớp định dạng, chọn Nghệ thuật đường nét
    await applyLineArtStyle();
    check();

    sessionStorage.setItem(marker, 'done');

    // 5. Trích xuất ảnh line art ([picture_name]_line_notpatch)
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
