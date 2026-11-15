/* Operates visible Google AI Studio prompt UI.
 * Connects with FillColoring Studio on the local machine.
 */
(() => {
  'use strict';
  if (window.__fillColoringAiStudioBridgeLoaded) return;
  window.__fillColoringAiStudioBridgeLoaded = true;

  let task = null, cancelled = false, phase = 'Đang mở Google AI Studio…', heartbeat = null;
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

  const editor = () => {
    const list = [...document.querySelectorAll('textarea, div[contenteditable="true"], ms-prompt-input textarea, .prompt-textarea, rich-textarea [contenteditable="true"]')].filter(visible);
    return list.at(-1) || null;
  };

  const runButton = () => {
    return buttons().find(el => {
      const l = label(el).toLowerCase();
      return /^(?:run|chạy)(?:\s|$)|run prompt/i.test(l) || (el.textContent || '').trim().toLowerCase() === 'run';
    });
  };

  const stopButton = () => {
    return buttons().find(el => {
      const l = label(el).toLowerCase();
      return /^(?:stop|dừng)(?:\s|$)|cancel/i.test(l) || (el.textContent || '').trim().toLowerCase() === 'stop';
    });
  };

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
    const banner = document.getElementById('fillcoloring-aistudio-status');
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

    await waitFor(() => document.body && (accountLabel() || findEmails().length || editor()), 15, 'Trang AI Studio chưa tải xong.');

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
      console.warn(`Tab AI Studio đang mở tài khoản ${otherEmails[0]} (cài đặt: ${task.email}).`);
      return;
    }

    if (accountLabel()) {
      return;
    }

    throw new Error('Chưa đăng nhập Google trên AI Studio. Hãy đăng nhập tài khoản ' + task.email + ' rồi thử lại.');
  }

  function findFileInput(root = document) {
    const inputs = querySelectorAllDeep('input[type="file"]', root);
    return inputs.find(visible) || inputs[0] || null;
  }

  async function attach() {
    const oldImages = new Set([...document.images].map(img => img.currentSrc || img.src));
    const oldTiles = new Set(document.querySelectorAll('ms-media-chunk, .media-chunk, .file-chip, [role="figure"]'));
    const bytes = Uint8Array.from(atob(task.image), c => c.charCodeAt(0));
    const file = new File([bytes], task.filename, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);

    showStatus('Đang mở ô tải ảnh AI Studio…');

    let input = findFileInput();
    if (!input) {
      // Find Insert / Add media button in AI Studio
      const insertBtn = findButton(/insert|thêm|đính kèm|tải lên|upload|\bfile\b|\bmedia\b|add files/i);
      if (insertBtn) {
        insertBtn.click();
        await sleep(500);
        input = findFileInput();
        if (!input) {
          const fileOption = findButton(/file|tệp|upload from computer|tải từ máy/i);
          if (fileOption) {
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
              fileOption.click();
              await sleep(400);
            } finally {
              window.removeEventListener('click', onCaptureClick, true);
            }
            if (capturedInput) input = capturedInput;
          }
        }
      }
      if (!input) input = findFileInput();
    }

    let attached = false;
    if (input) {
      try {
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        attached = true;
      } catch (err) {
        console.warn('Set input.files failed, trying drag/paste fallback:', err);
      }
    }

    const box = editor();
    const promptArea = box?.closest('form, [role="region"], .prompt-box, ms-prompt-input, .input-area') || box?.parentElement;

    if (!attached && box) {
      try {
        const dropTarget = promptArea || box;
        dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      } catch (_) {}

      try {
        box.focus();
        box.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      } catch (_) {}
    }

    showStatus('Đang chờ AI Studio nhận ảnh đính kèm…');
    await waitFor(() => {
      const thumbnails = [...document.querySelectorAll('img')].filter(img =>
        visible(img) && img.naturalWidth >= 80 && !oldImages.has(img.currentSrc || img.src)
      );
      const filename = [...document.querySelectorAll('[title],[aria-label]')].some(el =>
        (el.getAttribute('title') || el.getAttribute('aria-label') || '').includes(task.filename)
      );
      const mediaTiles = [...document.querySelectorAll('ms-media-chunk, .media-chunk, .file-chip, [role="figure"]')].filter(el => visible(el) && !oldTiles.has(el));
      return thumbnails.length || filename || mediaTiles.length;
    }, 60, 'AI Studio chưa nhận ảnh đính kèm. Kiểm tra tab AI Studio.');

    if (box) box.focus();
  }

  function isModelOutput(el) {
    if (el.closest('ms-prompt-input, .prompt-box, .input-area, ms-composer, form, .user-turn, [data-role="user"], [data-turn-role="user"]')) {
      return false;
    }
    if (el.closest('nav, aside, header, .user-avatar, ms-user-avatar, [role="banner"]')) {
      return false;
    }
    return true;
  }

  function getGeneratedImages(beforeRunImages) {
    const all = querySelectorAllDeep('img');
    return all.filter(img => {
      if (!visible(img) || !img.complete || img.naturalWidth < 200 || img.naturalHeight < 200) return false;
      const src = img.currentSrc || img.src;
      if (beforeRunImages.has(src)) return false;
      if (!isModelOutput(img)) return false;
      return true;
    });
  }

  async function run() {
    if (task.stage === 'origin') {
      // Respect the step-1 chat selected in settings, but never attach an image.
      task.image = '';
    }
    const marker = 'fillcoloring-aistudio-submitted-' + task.id;
    if (sessionStorage.getItem(marker)) {
      throw new Error('Tab đã xử lý yêu cầu này trước đó. Không gửi lại để tránh tạo ảnh trùng.');
    }

    const banner = document.createElement('div');
    banner.id = 'fillcoloring-aistudio-status';
    Object.assign(banner.style, {
      position: 'fixed', bottom: '12px', left: '12px', zIndex: '2147483647',
      background: '#1a73e8', color: 'white', padding: '12px 18px', borderRadius: '10px',
      font: '13px Segoe UI, sans-serif', maxWidth: '520px', pointerEvents: 'none'
    });
    document.body.append(banner);

    heartbeat = setInterval(() => message('aistudio-progress', { message: phase }).catch(() => { cancelled = true; }), 2000);

    showStatus('Đang kiểm tra tài khoản Google…');
    await verifyAccount();

    await waitFor(editor, 40, 'Chưa thấy ô nhập AI Studio. Hãy hoàn tất đăng nhập trong tab.');

    if (task.stage !== 'origin' && task.image) {
      showStatus('Đang tải ảnh vào AI Studio…');
      await attach();
      check();
    } else {
      showStatus('Đang chuẩn bị nhập prompt tạo ảnh mới…');
    }

    const box = editor();
    if (!box) throw new Error('Không tìm thấy ô nhập prompt.');
    box.focus();

    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
      box.value = task.prompt;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, task.prompt);
      if (!box.textContent.includes(task.prompt.slice(0, 30))) {
        box.textContent = task.prompt;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    const runBtn = await waitFor(() => {
      const b = runButton();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 40, 'Nút Run chưa sẵn sàng; ảnh có thể chưa tải xong.');

    // Crucial: record all images on the page (including the uploaded line art thumbnail)
    // BEFORE clicking Run, so the uploaded line art is NEVER mistaken for the AI output!
    const beforeRunImages = new Set([...document.images].map(img => img.currentSrc || img.src));

    check();
    if (task.stage === 'origin') {
      // Inspect only the active composer. Saved chats contain media in old turns,
      // which are not attachments to the prompt we are about to submit.
      const composer = box.closest('ms-prompt-input, .prompt-box, .input-area') || box.parentElement;
      if (!composer) throw new Error('Không xác định được vùng nhập prompt AI Studio.');
      const media = querySelectorAllDeep('ms-media-chunk, .media-chunk, .file-chip, ms-image-chunk', composer).filter(visible);
      const files = querySelectorAllDeep('input[type="file"]', composer).some(el => el.files?.length);
      if (media.length || files) {
        throw new Error('Bước 1 chỉ gửi chữ nhưng ô nhập hiện tại còn ảnh/tệp đính kèm. Hãy gỡ tệp trong ô nhập rồi chạy lại.');
      }
    }
    sessionStorage.setItem(marker, 'sent');
    runBtn.click();

    showStatus('AI Studio đang xử lý và tạo ảnh màu…');

    // Wait for generation: run button becomes disabled/stop button appears, then completes
    await sleep(3000);
    let stable = '', stableAt = 0, result = null;
    const deadline = Date.now() + 12 * 60 * 1000;

    while (Date.now() < deadline) {
      check();
      const stopping = stopButton();
      const spinner = querySelectorAllDeep('mat-progress-spinner, ms-progress-bar, .spinner', document).find(el => {
        if (!visible(el)) return false;
        if (el.closest('nav, aside, header, .nav-pane, .side-bar')) return false;
        return true;
      });
      const isGenerating = !!(stopping || spinner);

      const candidates = getGeneratedImages(beforeRunImages);
      const candidate = candidates.at(-1);

      if (candidate) {
        const src = candidate.currentSrc || candidate.src;
        if (stable !== src) {
          stable = src;
          stableAt = Date.now();
        }
        const waitTime = isGenerating ? 4000 : 1500;
        if (Date.now() - stableAt >= waitTime) {
          result = candidate;
          break;
        }
      } else {
        stable = '';
        stableAt = 0;
      }
      await sleep(1000);
    }

    if (!result) throw new Error('AI Studio chưa trả về ảnh sau 12 phút. Xem tab AI Studio.');

    showStatus('Đang đưa ảnh kết quả về Studio…');
    clearInterval(heartbeat);
    heartbeat = null;

    const url = result.currentSrc || result.src;
    let imageBase64 = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = result.naturalWidth;
      canvas.height = result.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(result, 0, 0);
      imageBase64 = canvas.toDataURL('image/png').split(',')[1];
    } catch (_) {
      imageBase64 = null;
    }
    if (!imageBase64) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (resp.ok) {
          const blob = await resp.blob();
          const reader = new FileReader();
          imageBase64 = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
      } catch (_) {}
    }

    if (imageBase64) {
      await message('aistudio-result', { image: imageBase64 });
    } else {
      await message('aistudio-result', { url });
    }

    showStatus('Đã lưu ảnh vào Studio. Quay lại công cụ để duyệt kết quả.');
  }

  async function start() {
    for (let i = 0; i < 15; i++) {
      const answer = await chrome.runtime.sendMessage({ type: 'aistudio-ready' }).catch(() => null);
      if (answer?.task) { task = answer.task; break; }
      await sleep(1000);
    }
    if (!task) return;
    try {
      await run();
    } catch (error) {
      showStatus(error.message);
      if (!cancelled) await message('aistudio-error', { error: error.message }).catch(() => {});
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  start();
})();
