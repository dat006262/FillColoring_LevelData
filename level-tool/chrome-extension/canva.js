/* Operates visible Canva editor UI.
 * Step 2:
 * 1. Xóa ảnh cũ: Click vào tranh, nhấn DEL để xóa -> thu được 1 trang trắng.
 * 2. Đưa ảnh màu gốc vào Canva (chỉ 1 ảnh, không lặp lại).
 * 3. Chuột phải vào ảnh / bấm "..." -> chọn "Đổi cỡ khung vẽ cho vừa với vùng chọn".
 * 4. Click chọn ảnh -> nhấn nút "Chỉnh sửa" trên thanh công cụ -> hiện cửa sổ "Sửa hình ảnh".
 * 5. Trong mục "Khớp định dạng", nhấn "Nghệ thuật đường nét" (Line art).
 * 6. Chờ tranh thực sự biến đổi xong thành nét đen (kiểm tra pixel mất màu & nút Đặt lại kiểu), KHÔNG tải sớm.
 * 7. Tải / trích xuất ảnh nét và gửi về Studio dưới tên [picture_name]_line_notpatch.png.
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
        fontWeight: 'bold', font: '13px Segoe UI, sans-serif', maxWidth: '580px', pointerEvents: 'none',
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

  function openContextMenu(x, y) {
    const moreBtn = querySelectorAllDeep('button, [role="button"]').find(el => {
      if (!visible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const txt = (el.innerText || el.textContent || '').trim();
      return /^(?:tùy chọn khác|thêm|xem thêm|more options|more)$/i.test(aria) ||
             /^(?:tùy chọn khác|thêm|xem thêm|more options|more)$/i.test(title) ||
             /^(?:\.\.\.|···|…)$/.test(txt);
    });

    if (moreBtn) {
      const r = moreBtn.getBoundingClientRect();
      clickAt(r.left + r.width / 2, r.top + r.height / 2);
      moreBtn.click();
      return;
    }

    const target = document.elementFromPoint(x, y) || document.body;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 2,
      buttons: 2,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    };
    try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
    try { target.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 2, buttons: 0 })); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 2, buttons: 0 })); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('contextmenu', { ...opts, button: 2, buttons: 0 })); } catch (_) {}
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

  // Bước 1: Click vào tranh cũ và nhấn DEL để xóa -> trang trắng
  async function clearOldImage() {
    showStatus('Bước 1: Đang click vào tranh cũ và nhấn DEL để xóa (thu trang trắng)…');
    const center = getPageCenter();

    clickAt(center.x, center.y);
    await sleep(400);

    sendDeleteKeys();
    await sleep(300);

    const delBtn = querySelectorAllDeep('button, [role="button"]').find(el => {
      if (!visible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').trim();
      const text = (el.innerText || el.textContent || '').trim();
      return /^(?:xóa ảnh|xóa|delete)$/i.test(aria) || /^(?:xóa ảnh|xóa|delete)$/i.test(text);
    });
    if (delBtn) {
      delBtn.click();
      await sleep(300);
    }

    sendDeleteKeys();
    await sleep(600);
  }

  // Bước 2: Đưa duy nhất 1 ảnh màu gốc vào Canva (không lặp lại)
  async function uploadImage() {
    showStatus('Bước 2: Đang đưa ảnh màu gốc vào Canva (1 ảnh duy nhất)…');
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

    await sleep(2500);
  }

  function findResizeOption() {
    const all = querySelectorAllDeep('button, [role="menuitem"], [role="button"], div, span, p');
    return all.find(el => {
      if (!visible(el)) return false;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
      return /đổi cỡ khung vẽ cho vừa(?: với)? vùng(?: được)? chọn|resize canvas to fit selection/i.test(text);
    });
  }

  // Bước 3: Chuột phải chọn "Đổi cỡ khung vẽ cho vừa với vùng chọn"
  async function resizeCanvasToFit() {
    showStatus('Bước 3: Chuột phải -> Đổi cỡ khung vẽ cho vừa với vùng chọn…');
    const center = getPageCenter();

    let resizeOption = null;

    for (let attempt = 0; attempt < 6; attempt++) {
      clickAt(center.x, center.y);
      await sleep(400);

      openContextMenu(center.x, center.y);
      await sleep(700);

      resizeOption = findResizeOption();
      if (resizeOption) break;

      const offsets = [30, -30, 50, -50];
      const dx = offsets[attempt % offsets.length];
      clickAt(center.x + dx, center.y + dx);
      await sleep(400);
    }

    if (resizeOption) {
      showStatus('Đang nhấn "Đổi cỡ khung vẽ cho vừa với vùng chọn"…');
      const clickable = resizeOption.closest('button, [role="menuitem"], [role="button"], div[tabindex="0"]') || resizeOption;
      clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(200);

      const r = clickable.getBoundingClientRect();
      clickAt(r.left + r.width / 2, r.top + r.height / 2);
      clickable.click();
      resizeOption.click();
      await sleep(1000);

      const confirmResize = querySelectorAllDeep('button, [role="button"]').find(el => {
        if (!visible(el)) return false;
        const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
        return /^(?:đổi cỡ thiết kế này|đổi cỡ|resize this design|resize|tiếp tục|continue)$/i.test(t);
      });
      if (confirmResize) {
        confirmResize.click();
        await sleep(800);
      }
    } else {
      const menuItems = querySelectorAllDeep('button, [role="menuitem"], [role="button"], div[tabindex="0"], span');
      const setBgOption = menuItems.find(el => {
        if (!visible(el)) return false;
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
        return /đặt hình ảnh làm nền|đặt làm nền|set image as background/i.test(text);
      });
      if (setBgOption) {
        setBgOption.click();
        await sleep(600);
      } else {
        sendKey('Escape', 'Escape', 27);
      }
    }

    await sleep(400);
    clickAt(center.x, center.y);
    await sleep(500);
  }

  function isEditButton(el) {
    if (!el || !visible(el)) return false;
    const rawText = (el.innerText || el.textContent || '').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();

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

  // Bước 4: Click chọn ảnh -> nhấn nút Chỉnh sửa -> hiện cửa sổ Sửa hình ảnh
  async function openEditPanel() {
    if (findLineArtOptionRobust()) return;

    showStatus('Bước 4: Đang chọn ảnh và nhấn nút "Chỉnh sửa"…');

    const editBtn = await waitFor(async () => {
      let btn = findEditButtonRobust();
      if (btn) return btn;

      const center = getPageCenter();
      clickAt(center.x, center.y);
      await sleep(400);

      return findEditButtonRobust();
    }, 25, 'Không tìm thấy nút "Chỉnh sửa". Hãy click vào tranh trên Canva.');

    editBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(200);

    editBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    editBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    editBtn.click();

    showStatus('Đang mở cửa sổ "Sửa hình ảnh"…');
    await sleep(1500);
  }

  // Kiểm tra xem ảnh trên trang đã biến thành nét vẽ đen trắng hay chưa (không còn màu)
  function isCanvasImageLineArt() {
    const stage = getCanvasStage();

    // 1. Kiểm tra các thẻ img trên stage
    const imgs = [...stage.querySelectorAll('img')].filter(img =>
      visible(img) && img.naturalWidth >= 200 && img.naturalHeight >= 200 &&
      !img.closest('nav, aside, [role="region"], [data-testid*="sidebar"], [data-testid*="panel"]')
    );
    for (const img of imgs) {
      try {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        let colorPixels = 0;
        let total = 64 * 64;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a > 30) {
            const diff = Math.max(r, g, b) - Math.min(r, g, b);
            if (diff > 25) colorPixels++;
          }
        }
        // Nếu pixel có màu sắc > 8%, tranh vẫn còn là ảnh màu, chưa thành line art!
        if (colorPixels / total > 0.08) {
          return false;
        }
        return true;
      } catch (_) {}
    }

    // 2. Kiểm tra các thẻ canvas trên stage
    const canvases = [...stage.querySelectorAll('canvas')].filter(c => c.width >= 300 && c.height >= 300);
    for (const cv of canvases) {
      try {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        ctx.drawImage(cv, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        let colorPixels = 0;
        let total = 64 * 64;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a > 30) {
            const diff = Math.max(r, g, b) - Math.min(r, g, b);
            if (diff > 25) colorPixels++;
          }
        }
        if (colorPixels / total > 0.08) {
          return false;
        }
        return true;
      } catch (_) {}
    }

    return false;
  }

  // Bước 5 & 6: Nhấn Nghệ thuật đường nét -> Chờ tranh thực sự biến thành nét đen hoàn tất
  async function applyLineArtStyle() {
    showStatus('Bước 5: Đang nhấn vào "Nghệ thuật đường nét" trong Khớp định dạng…');

    const lineArtOption = await waitFor(() => {
      let opt = findLineArtOptionRobust();
      if (!opt) {
        const sidebar = document.querySelector('[role="region"], aside, nav, [data-testid*="side-panel"]') || document.body;
        if (sidebar && sidebar.scrollTop !== undefined) sidebar.scrollTop += 200;
        opt = findLineArtOptionRobust();
      }
      return opt;
    }, 25, 'Không tìm thấy tùy chọn "Nghệ thuật đường nét" trong Khớp định dạng.');

    const clickable = lineArtOption.closest('button, [role="button"], [role="radio"], [role="option"], [tabindex="0"]') || lineArtOption;
    clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(400);

    const r = clickable.getBoundingClientRect();
    clickAt(r.left + r.width / 2, r.top + r.height / 2);
    clickable.click();

    // Chờ tối thiểu 4s để Canva bắt đầu xử lý
    await sleep(4000);

    // VÒNG LẶP CHỜ BẮT BUỘC: Không tải sớm khi tranh chưa chuyển thành line art
    const startTime = Date.now();
    const maxWaitMs = 120 * 1000; // Tối đa 2 phút
    let ready = false;

    while (Date.now() - startTime < maxWaitMs) {
      check();
      await sleep(1500);

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      showStatus(`Bước 6: Canva đang biến đổi nét đen (${elapsed}s - đang chờ hoàn thành mới tải)…`);

      // 1. Kiểm tra nút "Đặt lại kiểu" (Reset style)
      const all = querySelectorAllDeep('button, [role="button"], span');
      const resetBtn = all.find(el => visible(el) && /đặt lại kiểu|reset style/i.test((el.innerText || el.textContent || '').trim()));

      // 2. Kiểm tra thanh tiến độ / spinner
      const spinners = querySelectorAllDeep('[role="progressbar"], [aria-label*="loading"], [aria-label*="đang tải"]').filter(visible);
      const isSpinning = spinners.length > 0;

      // 3. Kiểm tra xem ảnh trên trang đã thực sự thành nét đen trắng (mất màu) chưa
      const isLine = isCanvasImageLineArt();

      // Chỉ coi là hoàn thành khi:
      // - Đã xuất hiện nút Đặt lại kiểu HOẶC ảnh trên trang đã xác nhận là nét đen trắng
      // - VÀ không còn thanh loading/spinner
      // - VÀ đã trôi qua ít nhất 8 giây
      if (resetBtn && !isSpinning && elapsed >= 8) {
        if (isLine || elapsed >= 18) {
          ready = true;
          break;
        }
      } else if (isLine && !isSpinning && elapsed >= 10) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      throw new Error('Canva xử lý hiệu ứng nét đen quá lâu hoặc chưa xong. Kiểm tra lại tab Canva.');
    }

    showStatus('Canva đã hoàn tất chuyển đổi nét đen! Đang chuẩn bị tải ảnh…');
    await sleep(2500);
  }

  // Bước 7: Tải / Trích xuất ảnh Line Art sau khi đã chỉnh sửa xong hoàn toàn
  async function extractLineImage() {
    showStatus('Bước 7: Đang tải ảnh nét đã hoàn thiện về Studio…');

    // 1. Xuất chính thức từ Canva: Chia sẻ -> Tải xuống -> Tải xuống
    const allButtons = querySelectorAllDeep('button, [role="button"]');
    const shareBtn = allButtons.find(el => visible(el) && /^(?:chia sẻ|share)$/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()));
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
          }, 35, 'Không nhận được file xuất từ Canva.');
          if (b64) return b64;
        }
      }
    }

    // 2. Dự phòng: Canvas stage
    const stage = getCanvasStage();
    const imgs = [...stage.querySelectorAll('img')].filter(img =>
      visible(img) && img.naturalWidth >= 300 && img.naturalHeight >= 300 &&
      !img.closest('nav, aside, [role="region"], [data-testid*="sidebar"], [data-testid*="panel"]')
    );
    imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));

    for (const img of imgs) {
      const src = img.currentSrc || img.src;
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1024;
        c.height = img.naturalHeight || 1024;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataUrl = c.toDataURL('image/png');
        if (dataUrl && dataUrl.length > 2000) return dataUrl.split(',')[1];
      } catch (_) {}

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

    // 1. Xóa ảnh cũ (DEL)
    await clearOldImage();
    check();

    // 2. Kéo ảnh mới vào (duy nhất 1 ảnh)
    await uploadImage();
    check();

    // 3. Chuột phải / Menu "..." -> Đổi cỡ khung vẽ cho vừa với vùng chọn
    await resizeCanvasToFit();
    check();

    // 4. Click chọn ảnh -> Bấm "Chỉnh sửa" -> Hiện cửa sổ Sửa hình ảnh
    await openEditPanel();
    check();

    // 5 & 6. Nhấn "Nghệ thuật đường nét" -> Chờ tranh thực sự biến thành nét đen hoàn tất (KHÔNG tải sớm)
    await applyLineArtStyle();
    check();

    sessionStorage.setItem(marker, 'done');

    // 7. Chờ tranh đã chỉnh sửa xong MỚI tải xuống
    const result = await extractLineImage();

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
