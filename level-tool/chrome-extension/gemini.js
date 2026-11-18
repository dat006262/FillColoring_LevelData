/* Operates visible UI only. No private endpoints, cookie extraction, or API fallback.
 * Gemini selectors may change; unknown UI stops with a recoverable message.
 */
(() => {
  'use strict';
  if (window.__fillColoringBridgeLoaded) return;
  window.__fillColoringBridgeLoaded = true;
  let task = null, cancelled = false, phase = 'Đang mở Gemini…', heartbeat = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
  
  function querySelectorAllDeep(selector, root = document) {
    let results = [];
    try {
      if (root.querySelectorAll) results.push(...root.querySelectorAll(selector));
    } catch (_) {}
    const all = root.querySelectorAll ? [...root.querySelectorAll('*')] : [];
    for (const el of all) {
      if (el.shadowRoot) {
        results.push(...querySelectorAllDeep(selector, el.shadowRoot));
      }
    }
    return results;
  }

  const buttons = () => [
    ...document.querySelectorAll('button,[role="button"],[role="menuitem"],.mat-mdc-menu-item,mat-menu-item')
  ].filter(visible);

  const findButton = regex => buttons().find(el => regex.test(label(el)));

  const editor = () => [
    ...document.querySelectorAll('rich-textarea [contenteditable="true"],div[contenteditable="true"][role="textbox"],.ql-editor[contenteditable="true"]')
  ].find(visible);

  const send = () => findButton(/^(?:send(?: message)?|gửi(?: tin nhắn)?)(?:\s|$)|gửi lời nhắc|^gửi$|^send$/i);
  const stopping = () => findButton(/stop response|stop generating|dừng câu trả lời|dừng tạo|ngừng tạo/i);
  const responseRoots = () => [
    ...document.querySelectorAll('model-response,[data-message-author-role="model"],.model-response')
  ].filter(visible);

  async function message(type, extra = {}) {
    const answer = await chrome.runtime.sendMessage({ type, id: task?.id, ...extra });
    if (answer?.cancelled) cancelled = true;
    if (answer?.error) throw new Error(answer.error);
    return answer;
  }

  async function forceFocus() {
    try {
      window.focus();
      await chrome.runtime.sendMessage({ type: 'force-focus', id: task?.id }).catch(() => {});
    } catch (_) {}
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
    const banner = document.getElementById('fillcoloring-status');
    if (banner) banner.textContent = 'FillColoring · ' + text;
  }

  function accountLabel() {
    return [...document.querySelectorAll('a[aria-label],button[aria-label]')]
      .map(el => el.getAttribute('aria-label') || '').filter(t => /google account|tài khoản google/i.test(t)).join(' ');
  }

  function findEmails() {
    const text = (document.body ? document.body.innerText : '') + ' ' +
      [...document.querySelectorAll('*')].map(el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')].filter(Boolean).join(' ')).join(' ');
    const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    return [...new Set(matches.map(e => e.toLowerCase()))];
  }

  async function verifyAccount() {
    if (!task.email) return;

    await waitFor(() => document.body && (accountLabel() || findEmails().length || editor()), 15, 'Trang Gemini chưa tải xong.');

    const emailLower = task.email.toLowerCase();
    const foundEmails = findEmails();
    if (foundEmails.includes(emailLower)) return;

    const pageHtml = document.documentElement ? document.documentElement.innerHTML.toLowerCase() : '';
    if (pageHtml.includes(emailLower)) return;

    const known = accountLabel().toLowerCase();
    if (known.includes(emailLower)) return;

    const otherEmails = foundEmails.filter(e => !e.includes('google.com') && !e.includes('gstatic.com') && !e.includes('googleapis.com'));
    if (editor()) {
      return;
    }
    if (otherEmails.length > 0 && !otherEmails.includes(emailLower)) {
      console.warn(`Tab Gemini đang mở tài khoản ${otherEmails[0]} (cài đặt: ${task.email}).`);
      return;
    }

    if (accountLabel()) {
      return;
    }

    throw new Error('Chưa đăng nhập Google trên Gemini. Hãy đăng nhập tài khoản ' + task.email + ' rồi thử lại.');
  }

  function quotaMessage() {
    const text = responseRoots().map(el => el.innerText).join(' ');
    const patterns = [
      /you(?:'ve| have) reached[^.\n]{0,180}/i,
      /đã đạt (?:đến )?giới hạn[^.\n]{0,180}/i,
      /không thể tạo (?:thêm )?ảnh[^.\n]{0,180}/i,
      /can(?:not|'t) generate (?:any more|more) images[^.\n]{0,180}/i
    ];
    return patterns.map(p => text.match(p)?.[0]).find(Boolean);
  }

  function findFileInput(root = document) {
    const inputs = querySelectorAllDeep('input[type="file"]', root);
    return inputs.find(visible) || inputs[0] || null;
  }

  function findPlusButton() {
    const box = editor();
    const all = buttons();

    // 1. Check aria-label / title / text
    const regex = /công cụ|tools?|menu.*công cụ|thêm|add|\+|plus|tải (?:tệp|tập tin)|upload|đính kèm|attachment/i;
    const byLabel = all.find(el => regex.test(label(el)));
    if (byLabel) return byLabel;

    // 2. Button with text '+' or SVG/icon with 'add'
    const byIcon = all.find(el => {
      const txt = (el.textContent || '').trim();
      if (txt === '+' || txt === 'add') return true;
      const icon = el.querySelector('svg, mat-icon');
      return icon && ((icon.textContent || '').trim() === 'add' || (icon.getAttribute('data-icon') || '').includes('add'));
    });
    if (byIcon) return byIcon;

    // 3. Button with popup menu
    const byPopup = all.find(el => el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-haspopup') === 'true');
    if (byPopup) return byPopup;

    // 4. Fallback: Any button to the left of the editor in the prompt container
    if (box) {
      const boxRect = box.getBoundingClientRect();
      const container = box.closest('form, [role="region"], mat-form-field, .input-area, .chat-input')
        || box.parentElement?.parentElement?.parentElement;
      if (container) {
        const leftBtns = [...container.querySelectorAll('button,[role="button"]')].filter(visible).filter(b => {
          const r = b.getBoundingClientRect();
          return r.left < boxRect.left && r.width > 10 && r.height > 10;
        });
        if (leftBtns.length) return leftBtns[0];
      }
    }
    return null;
  }

  function findUploadMenuItem() {
    const items = buttons();
    return items.find(el => /tải (?:tệp|tập tin) lên|tải (?:tệp|tập tin)|upload (?:file|from computer)/i.test(label(el)));
  }

  async function attach() {
    const oldImages = new Set([...document.images].map(img => img.currentSrc || img.src));
    const bytes = Uint8Array.from(atob(task.image), c => c.charCodeAt(0));
    const file = new File([bytes], task.filename, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);

    showStatus('Đang mở ô tải ảnh…');

    // 1. Look for existing file input
    let input = findFileInput();

    // 2. If no file input yet, open tools menu if needed
    if (!input) {
      let uploadItem = findUploadMenuItem();
      if (!uploadItem) {
        const plusBtn = findPlusButton();
        if (plusBtn) {
          plusBtn.click();
          await sleep(600);
          uploadItem = findUploadMenuItem();
        }
      }

      // Check again after opening menu
      input = findFileInput();

      // 3. If still no input, try finding inside/around the uploadItem or click it with capture listener
      if (!input && uploadItem) {
        input = uploadItem.querySelector('input[type="file"]')
          || uploadItem.closest('label')?.querySelector('input[type="file"]')
          || uploadItem.parentElement?.querySelector('input[type="file"]');

        if (!input) {
          // Listen during capture phase to catch input.click() and prevent native OS file dialog
          let capturedInput = null;
          const onCaptureClick = (e) => {
            if (e.target && (e.target.tagName === 'INPUT' || e.target instanceof HTMLInputElement) && e.target.type === 'file') {
              e.preventDefault();
              e.stopPropagation();
              capturedInput = e.target;
            }
          };
          window.addEventListener('click', onCaptureClick, true);
          try {
            uploadItem.click();
            await sleep(400);
          } finally {
            window.removeEventListener('click', onCaptureClick, true);
          }
          if (capturedInput) input = capturedInput;
        }
      }

      // Check one more time anywhere in the document/shadow DOM
      if (!input) input = findFileInput();
    }

    let attached = false;

    // A) If file input is found, set files and fire change/input events
    if (input) {
      try {
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        attached = true;
      } catch (err) {
        console.warn('Set input.files failed, trying fallback:', err);
      }
    }

    // B) Also try Drag & Drop and Paste on the editor / container as backup
    const box = editor();
    const promptContainer = box?.closest('form, [role="region"], mat-form-field, .input-area') || box?.parentElement;

    if (!attached && box) {
      try {
        const dropTarget = promptContainer || box;
        dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      } catch (_) {}

      try {
        box.focus();
        box.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      } catch (_) {}
    }

    // Close any opened menus by focusing the editor
    if (box) {
      await sleep(300);
      box.focus();
      box.click();
    }

    // Wait for attachment preview thumbnail or file name to appear
    showStatus('Đang chờ Gemini nhận ảnh đính kèm…');
    await waitFor(() => {
      const thumbnails = [...document.querySelectorAll('img')].filter(img =>
        visible(img) && !img.closest('model-response') && img.naturalWidth >= 100 && !oldImages.has(img.currentSrc || img.src)
      );
      const filename = [...document.querySelectorAll('[title],[aria-label]')].some(el =>
        (el.getAttribute('title') || el.getAttribute('aria-label') || '').includes(task.filename)
      );
      const chips = [...document.querySelectorAll('attachment-chip,[role="progressbar"],.attachment-container,.file-preview,.uploaded-image')].filter(visible);
      return thumbnails.length || filename || chips.length;
    }, 60, 'Gemini chưa nhận ảnh đính kèm. Chưa gửi prompt; kiểm tra tab Gemini.');

    if (editor()) editor().click();
  }

  async function run() {
    const marker = 'fillcoloring-submitted-' + task.id;
    const existing = sessionStorage.getItem(marker);
    if (existing) throw new Error('Tab đã xử lý yêu cầu này trước đó. Không gửi lại để tránh tạo ảnh trùng; xem kết quả trong tab.');
    const banner = document.createElement('div');
    banner.id = 'fillcoloring-status';
    Object.assign(banner.style, {
      position: 'fixed', bottom: '12px', left: '12px', zIndex: '2147483647',
      background: '#443469', color: 'white', padding: '12px 18px', borderRadius: '10px',
      font: '13px Segoe UI, sans-serif', maxWidth: '520px', pointerEvents: 'none'
    });
    document.body.append(banner);
    await forceFocus();
    heartbeat = setInterval(() => message('gemini-progress', { message: phase }).catch(() => { /* Retry heartbeat; only explicit cancellation stops work. */ }), 2000);
    showStatus('Đang kiểm tra tài khoản Google…');
    await verifyAccount();
    await waitFor(editor, 40, 'Chưa thấy ô nhập Gemini. Hãy hoàn tất đăng nhập hoặc thông báo mở đầu trong tab.');
    if (responseRoots().length) throw new Error('Tab không phải cuộc trò chuyện mới. Chưa gửi ảnh để tránh trộn hội thoại.');
    showStatus('Đang tải ảnh line vào Gemini…');
    await attach();
    check();
    const box = editor();
    if (!box) throw new Error('Không tìm thấy ô nhập prompt.');
    box.focus();
    await forceFocus();
    // Clear any residual content before typing prompt
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, task.prompt);
    if (!box.textContent.includes(task.prompt.slice(0, 30))) {
      box.textContent = task.prompt;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const submit = await waitFor(() => {
      const b = send();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 60, 'Nút Gửi chưa sẵn sàng; ảnh có thể chưa tải xong.');
    check();
    sessionStorage.setItem(marker, 'sent');
    submit.click();
    await forceFocus();
    showStatus(task.stage === 'patch' ? 'Gemini đang vá nét…' : 'Gemini đang tô màu…');
    let stable = '', stableAt = 0, result = null;
    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      check();
      const quota = quotaMessage();
      if (quota) throw new Error('Gemini web: ' + quota);
      const roots = responseRoots();
      const images = roots.flatMap(root => [...root.querySelectorAll('generated-image img,.generated-image img,img')])
        .filter(img => visible(img) && img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256);
      const candidate = images.at(-1);
      if (candidate && !stopping()) {
        const src = candidate.currentSrc || candidate.src;
        if (stable !== src) { stable = src; stableAt = Date.now(); }
        if (Date.now() - stableAt > 4000) { result = candidate; break; }
      } else { stable = ''; stableAt = 0; }
      try { window.focus(); } catch (_) {}
      await sleep(1000);
    }
    if (!result) throw new Error('Gemini chưa trả về ảnh sau 12 phút. Xem tab; không tự gửi lại prompt.');
    showStatus('Đang đưa ảnh kết quả về Studio…');
    clearInterval(heartbeat);
    heartbeat = null;
    const url = result.currentSrc || result.src;
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const canvas = document.createElement('canvas');
      canvas.width = result.naturalWidth;
      canvas.height = result.naturalHeight;
      canvas.getContext('2d').drawImage(result, 0, 0);
      await message('gemini-result', { image: canvas.toDataURL('image/png').split(',')[1] });
    } else {
      await message('gemini-result', { url });
    }
    showStatus('Đã lưu ảnh vào Studio. Quay lại công cụ để duyệt kết quả.');
  }

  async function start() {
    for (let i = 0; i < 15; i++) {
      const answer = await chrome.runtime.sendMessage({ type: 'gemini-ready' }).catch(() => null);
      if (answer?.task) { task = answer.task; break; }
      await sleep(1000);
    }
    if (!task) return;
    await forceFocus();
    try {
      await run();
    } catch (error) {
      showStatus(error.message);
      if (!cancelled) await message('gemini-error', { error: error.message }).catch(() => {});
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  start();
})();
