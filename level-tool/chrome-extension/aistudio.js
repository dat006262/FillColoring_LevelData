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

  const buttons = () => {
    const list = [
      ...document.querySelectorAll('button,[role="button"],[role="menuitem"],.mat-mdc-menu-item,mat-menu-item'),
      ...querySelectorAllDeep('button,[role="button"]', document)
    ];
    return [...new Set(list)].filter(visible);
  };

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
      if (/^(?:stop|dừng)(?:\s|$)|stop prompt|stop response|stop generating|cancel/i.test(l) || (el.textContent || '').trim().toLowerCase() === 'stop') {
        return true;
      }
      const icons = querySelectorAllDeep('mat-icon, svg', el);
      for (const icon of icons) {
        const txt = (icon.textContent || '').trim().toLowerCase();
        if (txt === 'stop' || txt === 'cancel' || txt === 'pause') return true;
        const iconName = (icon.getAttribute('data-mat-icon-name') || icon.getAttribute('aria-label') || '').toLowerCase();
        if (iconName.includes('stop') || iconName.includes('cancel')) return true;
      }
      return false;
    });
  };

  const isGeneratingStatus = () => {
    if (stopButton()) return true;
    const spinners = querySelectorAllDeep('mat-progress-spinner, mat-spinner, ms-progress-bar, mat-progress-bar, .spinner, [role="progressbar"], ms-loading-chunk', document);
    const active = spinners.find(el => {
      if (!visible(el)) return false;
      if (el.closest('nav, aside, header, .nav-pane, .side-bar')) return false;
      return true;
    });
    if (active) return true;
    const runBtn = runButton();
    if (runBtn) {
      const runTxt = label(runBtn).toLowerCase();
      if (/running|đang chạy|generating|đang tạo/i.test(runTxt) || runBtn.querySelector('mat-spinner, mat-progress-spinner')) {
        return true;
      }
    }
    return false;
  };

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
    if (el.closest('nav, aside, header, .user-avatar, ms-user-avatar, [role="banner"], .history, ms-history-panel')) {
      return false;
    }
    return true;
  }

  function getGeneratedImages(beforeElements, beforeSrcs, beforeTurns) {
    const all = querySelectorAllDeep('img');
    return all.filter(img => {
      if (!visible(img) || !isModelOutput(img)) return false;
      if (!img.complete || img.naturalWidth < 200 || img.naturalHeight < 200) return false;
      const src = img.currentSrc || img.src;
      if (!src) return false;
      if (beforeSrcs && beforeSrcs.has(src)) return false;
      if (beforeElements && beforeElements.has(img)) {
        if (beforeSrcs && beforeSrcs.has(src)) return false;
      }
      if (beforeTurns && beforeTurns.size > 0) {
        const turn = img.closest('ms-chat-turn, ms-model-turn, .model-turn, [data-role="model"], [data-turn-role="model"], ms-chunk-renderer');
        if (turn && beforeTurns.has(turn)) return false;
      }
      return true;
    });
  }

  async function retryInternalError(marker, previousErrors = new Set()) {
    check();
    const internalError = querySelectorAllDeep('*').some(el =>
      !previousErrors.has(el) && visible(el) && !el.closest('textarea, [contenteditable="true"], #fillcoloring-aistudio-status') &&
      /^An internal error has occurred\.?$/i.test((el.innerText || el.textContent || '').trim()));
    const retryKey = marker + '-internal-error-retry';
    if (!internalError) return false;
    if (sessionStorage.getItem(retryKey)) {
      throw new Error('AI Studio báo An internal error has occurred. Đã thử lại 1 lần nhưng vẫn lỗi.');
    }
    showStatus('AI Studio gặp lỗi nội bộ. Đang tự chạy lại (1/1)...');
    // Confirm the lease is still live before authorizing another submission.
    const answer = await message('aistudio-ready');
    check();
    if (!answer?.task || answer.task.id !== task.id) return false;
    sessionStorage.setItem(retryKey, '1');
    sessionStorage.removeItem(marker);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    location.replace(task.url);
    return true;
  }

  async function dismissWelcomePopup() {
    const welcomeDialog = () => querySelectorAllDeep('[role="dialog"], dialog, mat-dialog-container, .cdk-overlay-pane')
      .find(el => visible(el) && /Welcome to AI Studio/i.test(el.innerText || el.textContent || ''));
    const deadline = Date.now() + 10000;
    showStatus('Đang chờ kiểm tra popup chào mừng AI Studio (10 giây)...');
    while (Date.now() < deadline) {
      check();
      const dialog = welcomeDialog();
      if (dialog) {
        const button = querySelectorAllDeep('button, [role="button"]', dialog).find(el =>
          visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
          /^(Continue|Tiếp tục)$/i.test((el.innerText || el.textContent || '').trim()));
        if (button) {
          button.click();
          await waitFor(() => !welcomeDialog(), 10, 'Popup chào mừng AI Studio chưa đóng. Hãy bấm Continue rồi chạy lại.');
        }
      }
      await sleep(250);
    }
    if (welcomeDialog()) throw new Error('Không đóng được popup chào mừng AI Studio. Hãy bấm Continue rồi chạy lại.');
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
    await forceFocus();

    heartbeat = setInterval(() => message('aistudio-progress', { message: phase }).catch(() => { /* Retry heartbeat; only explicit cancellation stops work. */ }), 2000);

    showStatus('Đang kiểm tra tài khoản Google…');
    await dismissWelcomePopup();
    await verifyAccount();

    showStatus('Đang chờ ô nhập AI Studio, tối đa 120 giây...');
    try {
      await waitFor(editor, 120, 'Chưa thấy ô nhập AI Studio sau 120 giây.');
    } catch (error) {
      check();
      showStatus('Ô nhập chưa sẵn sàng. Đang mở tab mới để thử lại bước hiện tại...');
      const retry = await message('aistudio-reopen');
      if (retry?.retried) return;
      throw new Error('Đã mở lại AI Studio và chờ thêm 120 giây nhưng vẫn chưa thấy ô nhập. Kiểm tra đăng nhập trong tab AI Studio.');
    }

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
    await forceFocus();

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

    // Ghi lại toàn bộ ảnh và lượt chat ĐANG CÓ TRƯỚC KHI BẤM RUN
    // Tuyệt đối không lấy nhầm ảnh của các lượt tạo trước đó
    const previousErrors = new Set(querySelectorAllDeep('*').filter(el =>
      /^An internal error has occurred\.?$/i.test((el.innerText || el.textContent || '').trim())));
    const beforeRunElements = new Set(querySelectorAllDeep('img'));
    const beforeRunSrcs = new Set(querySelectorAllDeep('img').map(img => img.currentSrc || img.src).filter(Boolean));
    const beforeModelTurns = new Set(querySelectorAllDeep('ms-chat-turn, ms-model-turn, .model-turn, [data-role="model"], [data-turn-role="model"], ms-chunk-renderer'));

    check();
    if (task.stage === 'origin') {
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
    await forceFocus();

    showStatus('Đã nhấn Run. Đang chờ AI Studio khởi động xử lý…');

    // Chờ AI Studio bắt đầu tạo ảnh (chuyển sang trạng thái generating)
    let generationStarted = false;
    const startDeadline = Date.now() + 15000;
    while (Date.now() < startDeadline) {
      check();
      if (await retryInternalError(marker, previousErrors)) return;
      if (isGeneratingStatus()) {
        generationStarted = true;
        break;
      }
      await sleep(400);
    }

    showStatus('AI Studio đang xử lý và tạo ảnh màu…');

    // Chờ tạo ảnh: TUYỆT ĐỐI không lấy ảnh khi isGeneratingStatus() vẫn đang chạy!
    let stable = '', stableAt = 0, result = null;
    const deadline = Date.now() + 12 * 60 * 1000;
    const genStartTime = Date.now();

    while (Date.now() < deadline) {
      check();
      if (await retryInternalError(marker, previousErrors)) return;
      const generating = isGeneratingStatus();
      const elapsedSec = Math.floor((Date.now() - genStartTime) / 1000);

      if (generating) {
        generationStarted = true;
        showStatus(`AI Studio đang tạo ảnh… (${elapsedSec}s)`);
        stable = '';
        stableAt = 0;
      }
      if (elapsedSec % 4 === 0) {
        try { window.focus(); } catch (_) {}
      }
      if (!generating) {
        // AI Studio đã dừng tạo ảnh (không còn nút Stop, không còn spinner)
        if (generationStarted || elapsedSec >= 6) {
          showStatus(`AI Studio đã xử lý xong (${elapsedSec}s). Đang kiểm tra ảnh mới…`);
          const candidates = getGeneratedImages(beforeRunElements, beforeRunSrcs, beforeModelTurns);
          const candidate = candidates.at(-1);

          if (candidate && candidate.complete && candidate.naturalWidth >= 200 && candidate.naturalHeight >= 200) {
            const src = candidate.currentSrc || candidate.src;
            if (stable !== src) {
              stable = src;
              stableAt = Date.now();
            }
            // Chỉ khi ảnh mới giữ ổn định 2s SAU KHI tạo xong mới lấy
            if (Date.now() - stableAt >= 2000) {
              result = candidate;
              break;
            }
          } else {
            stable = '';
            stableAt = 0;
          }
        }
      }
      await sleep(1000);
    }

    if (!result && await retryInternalError(marker, previousErrors)) return;
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
    await forceFocus();
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
