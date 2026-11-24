'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name="app-token"]')?.content || '';

  let lcState = null;
  let pollTimer = null;
  let singleColorFile = null;
  let singleLineFile = null;
  let singleFilename = '';
  let singleSelectedOutputKey = '';

  function showToast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(window.__catToastTimer);
    window.__catToastTimer = setTimeout(() => { t.hidden = true; }, 7000);
  }

  async function lcApi(path, body = null) {
    const opts = body !== null
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': token }, body: JSON.stringify(body) }
      : {};
    const res = await fetch('/api/creator/' + path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi Level Creator.');
    return data;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function btn(text, cls, onClick, disabled = false) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.disabled = disabled;
    if (onClick) b.onclick = onClick;
    return b;
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Không đọc được file ảnh.'));
      reader.readAsDataURL(file);
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function loadLevelCreatorState() {
    try {
      const prevStatus = lcState?.job?.status;
      lcState = await lcApi('state');
      renderCreator();
      if (lcState.job?.status === 'running') {
        schedulePoll();
      } else {
        stopPoll();
        if (prevStatus === 'running' && lcState.job?.status === 'done') {
          showToast(`✅ Đã tạo xong ${lcState.job.results?.length || 0} file .bytes!`);
          if (window.reloadCatalogState) window.reloadCatalogState();
        }
      }
    } catch (e) {
      showToast(e.message);
    }
  }
  window.loadLevelCreatorState = loadLevelCreatorState;

  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(loadLevelCreatorState, 700);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function saveSettingPatch(patch) {
    try {
      lcState = await lcApi('settings', patch);
      renderCreator();
    } catch (e) {
      showToast(e.message);
    }
  }

  function renderCreator() {
    const shell = $('creator-shell');
    if (!shell || !lcState) return;
    shell.replaceChildren();

    const s = lcState.settings || {};
    const pairs = lcState.pairs || [];
    const job = lcState.job || { status: 'idle' };
    const isRunning = job.status === 'running';

    // Top heading
    const top = el('div', 'cat-top-title');
    const titleWrap = el('div', '');
    titleWrap.append(el('div', 'eyebrow', 'LEVEL BYTE GENERATOR · PORTED FROM FILLCOLORING_LEVELTOOL'), el('h1', '', 'Level Creator'));
    top.append(titleWrap);
    shell.append(top);

    const mainBox = el('div', 'cat-box lc-panel');

    // Import Mode
    const modeRow = el('div', 'lc-row');
    modeRow.append(el('label', 'lc-label', 'Import Mode'));
    const modeSel = document.createElement('select');
    modeSel.disabled = isRunning;
    ['Batch', 'Single'].forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      opt.selected = (s.importMode || 'Batch') === m;
      modeSel.append(opt);
    });
    modeSel.onchange = () => saveSettingPatch({ importMode: modeSel.value });
    modeRow.append(modeSel);
    mainBox.append(modeRow);

    if ((s.importMode || 'Batch') === 'Batch') {
      mainBox.append(el('div', 'notice', 'ℹ Chọn thư mục chứa các cặp *_colored_final.png và *_line_final.png (hoặc picture_colored_final.png / picture_line_final.png).'));

      const chooseInRow = el('div', 'lc-btn-stack');
      chooseInRow.append(
        btn('Choose Input Folder', 'cat-btn cat-btn-neutral lc-wide-btn', async () => {
          try {
            const res = await lcApi('browse-folder', { target: 'batchInputFolder', initial: s.batchInputFolder || '' });
            if (res.state) { lcState = res.state; renderCreator(); }
          } catch (e) { showToast(e.message); }
        }, isRunning)
      );
      mainBox.append(chooseInRow);

      const inRow = el('div', 'lc-row');
      inRow.append(el('label', 'lc-label', 'Input'));
      const inWrap = el('div', 'lc-inline-ctrl');
      const inInput = document.createElement('input');
      inInput.type = 'text';
      inInput.value = s.batchInputFolder || '';
      inInput.placeholder = '<not selected>';
      inInput.disabled = isRunning;
      inInput.onchange = () => saveSettingPatch({ batchInputFolder: inInput.value.trim() });
      inWrap.append(
        inInput,
        btn('📁 Mở Input', 'cat-btn cat-btn-mini', () => lcApi('open-folder', { kind: 'input' }).catch(e => showToast(e.message)), isRunning)
      );
      inRow.append(inWrap);
      mainBox.append(inRow);

      const pairRow = el('div', 'lc-row');
      pairRow.append(el('label', 'lc-label', 'Pairs'));
      const pairVal = el('div', 'lc-pairs-summary',
        `${pairs.length} cặp hợp lệ` + (pairs.length ? `: ${pairs.slice(0, 6).map(p => p.name).join(', ')}${pairs.length > 6 ? '…' : ''}` : ''));
      pairRow.append(pairVal);
      mainBox.append(pairRow);
    } else {
      // Single Mode
      if (pairs.length > 0) {
        const quickRow = el('div', 'lc-row');
        quickRow.append(el('label', 'lc-label', 'Chọn nhanh từ Input'));
        const qSel = document.createElement('select');
        qSel.disabled = isRunning;
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '-- Hoặc chọn 2 file PNG bên dưới --';
        qSel.append(emptyOpt);
        pairs.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.name;
          opt.textContent = `${p.name} (${p.coloredFile} + ${p.lineFile})`;
          opt.selected = singleSelectedOutputKey === p.name;
          qSel.append(opt);
        });
        qSel.onchange = () => {
          singleSelectedOutputKey = qSel.value;
          if (singleSelectedOutputKey) {
            singleFilename = singleSelectedOutputKey;
            singleColorFile = null;
            singleLineFile = null;
          }
          renderCreator();
        };
        quickRow.append(qSel);
        mainBox.append(quickRow);
      }

      const ctRow = el('div', 'lc-row');
      ctRow.append(el('label', 'lc-label', 'Colored Texture'));
      const ctInp = document.createElement('input');
      ctInp.type = 'file';
      ctInp.accept = 'image/png,image/jpeg,image/webp';
      ctInp.disabled = isRunning;
      ctInp.onchange = () => {
        singleColorFile = ctInp.files[0] || null;
        if (singleColorFile) {
          singleSelectedOutputKey = '';
          if (!singleFilename) {
            singleFilename = singleColorFile.name.replace(/\.[^.]+$/, '').replace(/_(colored_final|color)$/i, '');
          }
        }
        renderCreator();
      };
      ctRow.append(ctInp);
      mainBox.append(ctRow);

      const ltRow = el('div', 'lc-row');
      ltRow.append(el('label', 'lc-label', 'Line Texture'));
      const ltInp = document.createElement('input');
      ltInp.type = 'file';
      ltInp.accept = 'image/png,image/jpeg,image/webp';
      ltInp.disabled = isRunning;
      ltInp.onchange = () => {
        singleLineFile = ltInp.files[0] || null;
        if (singleLineFile) singleSelectedOutputKey = '';
        renderCreator();
      };
      ltRow.append(ltInp);
      mainBox.append(ltRow);

      const fnRow = el('div', 'lc-row');
      fnRow.append(el('label', 'lc-label', 'Filename'));
      const fnInp = document.createElement('input');
      fnInp.type = 'text';
      fnInp.value = singleFilename;
      fnInp.placeholder = 'vd: animal_99';
      fnInp.disabled = isRunning;
      fnInp.oninput = () => { singleFilename = fnInp.value; };
      fnRow.append(fnInp);
      mainBox.append(fnRow);
    }

    mainBox.append(el('hr', 'lc-sep'));

    // Slider helper
    const addSliderRow = (label, key, min, max, step, val) => {
      const row = el('div', 'lc-row');
      row.append(el('label', 'lc-label', label));
      const wrap = el('div', 'lc-slider-wrap');
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      range.value = String(val);
      range.disabled = isRunning;

      const num = document.createElement('input');
      num.type = 'number';
      num.min = String(min);
      num.max = String(max);
      num.step = String(step);
      num.value = String(val);
      num.className = 'lc-num-box';
      num.disabled = isRunning;

      range.oninput = () => { num.value = range.value; };
      range.onchange = () => saveSettingPatch({ [key]: Number(range.value) });
      num.onchange = () => {
        const clamped = Math.max(min, Math.min(max, Number(num.value || 0)));
        range.value = String(clamped);
        saveSettingPatch({ [key]: clamped });
      };
      wrap.append(range, num);
      row.append(wrap);
      mainBox.append(row);
    };

    const addToggleRow = (label, key, checked) => {
      const row = el('div', 'lc-row');
      row.append(el('label', 'lc-label', label));
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'lc-checkbox';
      cb.checked = !!checked;
      cb.disabled = isRunning;
      cb.onchange = () => saveSettingPatch({ [key]: cb.checked });
      row.append(cb);
      mainBox.append(row);
    };

    const addNumberRow = (label, key, step, val) => {
      const row = el('div', 'lc-row');
      row.append(el('label', 'lc-label', label));
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = String(step);
      inp.value = String(val);
      inp.disabled = isRunning;
      inp.onchange = () => saveSettingPatch({ [key]: Number(inp.value || 0) });
      row.append(inp);
      mainBox.append(row);
    };

    addSliderRow('Line Darkness Threshold', 'lineThreshold', 0, 255, 1, s.lineThreshold ?? 200);
    addToggleRow('Ignore White Regions', 'ignoreWhiteRegions', s.ignoreWhiteRegions);
    addToggleRow('No Line Mode', 'noLineMode', s.noLineMode);
    addToggleRow('Black Background / White Line', 'blackBackgroundWhiteLineMode', s.blackBackgroundWhiteLineMode);
    addNumberRow('Region Size Threshold', 'regionSizeThreshold', 1, s.regionSizeThreshold ?? 24);
    addSliderRow('Triangle Area Threshold', 'triangleAreaThreshold', 0, 500, 1, s.triangleAreaThreshold ?? 70);
    addNumberRow('Color Merge Threshold', 'colorMergeThreshold', 0.01, s.colorMergeThreshold ?? 0.1);

    mainBox.append(el('hr', 'lc-sep'));

    // Output Folder
    const outRow = el('div', 'lc-row');
    outRow.append(el('label', 'lc-label', 'Output Folder'));
    const outWrap = el('div', 'lc-inline-ctrl');
    const outInp = document.createElement('input');
    outInp.type = 'text';
    outInp.value = s.outputFolder || '';
    outInp.disabled = isRunning;
    outInp.onchange = () => saveSettingPatch({ outputFolder: outInp.value.trim() });
    outWrap.append(
      outInp,
      btn('📁 Mở Output', 'cat-btn cat-btn-mini', () => lcApi('open-folder', { kind: 'output' }).catch(e => showToast(e.message)), isRunning)
    );
    outRow.append(outWrap);
    mainBox.append(outRow);

    const chooseOutBtn = btn('Choose Output Folder', 'cat-btn cat-btn-neutral lc-wide-btn', async () => {
      try {
        const res = await lcApi('browse-folder', { target: 'outputFolder', initial: s.outputFolder || '' });
        if (res.state) { lcState = res.state; renderCreator(); }
      } catch (e) { showToast(e.message); }
    }, isRunning);
    mainBox.append(chooseOutBtn);

    addToggleRow('Tự động gắn .bytes vào Catalog (trùng ID)', 'autoAttachCatalog', s.autoAttachCatalog !== false);

    // Primary Action / Progress
    if (isRunning) {
      const pct = Math.round((job.progress || 0) * 100);
      const progBox = el('div', 'lc-progress-box');
      const progBar = el('div', 'lc-progress-bar');
      const progFill = el('div', 'lc-progress-fill');
      progFill.style.width = `${pct}%`;
      progBar.append(progFill);
      progBox.append(
        el('div', 'lc-progress-text', `Đang xử lý [${(job.currentIndex || 0) + 1}/${job.totalFiles || 1}] ${job.currentFile || ''} · ${job.step || ''} (${pct}%)`),
        progBar
      );
      mainBox.append(progBox);
      mainBox.append(btn('Cancel', 'cat-btn cat-btn-clear lc-wide-btn', async () => {
        try {
          await lcApi('stop', {});
          showToast('Đang dừng Level Creator…');
        } catch (e) { showToast(e.message); }
      }));
    } else {
      mainBox.append(btn('Create Level Files', 'cat-btn cat-btn-push lc-wide-btn lc-create-btn', async () => {
        try {
          if ((s.importMode || 'Batch') === 'Batch') {
            lcState = await lcApi('start-batch', {});
          } else if (singleSelectedOutputKey) {
            const pair = pairs.find(p => p.name === singleSelectedOutputKey);
            if (!pair) throw new Error('Không tìm thấy cặp ảnh đã chọn.');
            lcState = await lcApi('start-single', {
              colored_path: pair.coloredPath,
              line_path: pair.linePath,
              filename: singleFilename || pair.name,
            });
          } else {
            if (!singleColorFile || !singleLineFile) {
              throw new Error('Hãy chọn đủ cả Colored Texture và Line Texture.');
            }
            const [colored_data, line_data] = await Promise.all([readAsBase64(singleColorFile), readAsBase64(singleLineFile)]);
            lcState = await lcApi('start-single', {
              colored_data,
              line_data,
              filename: singleFilename || 'level',
            });
          }
          renderCreator();
          schedulePoll();
        } catch (e) {
          showToast('❌ ' + e.message);
        }
      }));
    }

    if (job.status === 'error' && job.error) {
      mainBox.append(el('div', 'notice error', job.error));
    }

    shell.append(mainBox);

    // Results box
    if (job.results && job.results.length > 0) {
      const resBox = el('div', 'cat-box');
      resBox.append(el('h3', 'cat-section-title', `Kết quả tạo Level Byte (${job.results.length} file)`));
      const list = el('div', 'cat-list-wrap');
      job.results.forEach(item => {
        const row = el('div', 'cat-pic-card lc-result-row');
        const info = el('div', 'lc-result-info');
        info.append(
          el('strong', '', `📄 ${item.fileName}`),
          el('span', 'cat-meta-text', `${item.width}×${item.height} px · ${item.regionCount} vùng · ${item.colorCount} màu · ${formatBytes(item.size)}`)
        );
        const right = el('div', 'cat-pic-right');
        if (item.attachedCatalogId) {
          right.append(el('span', 'cat-pill ok', `Đã gắn: ${item.attachedCatalogId}`));
        }
        right.append(btn('➕ Gắn vào Catalog ID…', 'cat-btn cat-btn-mini', async () => {
          const suggested = item.name.toLowerCase().endsWith('_bytes') ? item.name : `${item.name}_bytes`;
          const picId = prompt('Nhập ID tranh trong Catalog muốn gắn file .bytes này:', item.attachedCatalogId || suggested);
          if (!picId || !picId.trim()) return;
          try {
            await lcApi('attach-catalog', { pic_id: picId.trim(), bytes_path: item.path });
            item.attachedCatalogId = picId.trim();
            renderCreator();
            if (window.reloadCatalogState) window.reloadCatalogState();
            showToast(`✅ Đã gắn ${item.fileName} vào tranh "${picId.trim()}"!`);
          } catch (e) { showToast(e.message); }
        }));
        row.append(info, right);
        list.append(row);
      });
      resBox.append(list);
      shell.append(resBox);
    }
  }

  if (localStorage.getItem('studio-view-mode') === 'creator') {
    loadLevelCreatorState();
  }
})();
