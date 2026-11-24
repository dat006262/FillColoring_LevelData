'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name="app-token"]')?.content || '';
  const PRICE_LABELS = { 0: 'Free', 1: 'Diamond', 2: 'Gold' };
  const DEFAULT_SUPPORTED_LANGUAGES = ['EN', 'VN', 'CN_s', 'CN_t', 'FR', 'DE', 'ID', 'JP', 'KR', 'PT_BR', 'RU', 'ES_ES'];

  let catState = null;
  let activeView = localStorage.getItem('studio-view-mode') || 'studio';
  let activeTab = localStorage.getItem('catalog-main-tab') || 'library';
  let activeLibTag = localStorage.getItem('catalog-lib-tag') || 'All';
  let libSearch = '';
  let dailySearch = '';
  let dailyFilterYear = 0;
  let dailyFilterMonth = 0;
  let exploreSearch = '';
  let busyOp = false;
  let assetRev = Date.now();
  let pendingUpload = null; // { targetType, indices..., picId, kind }

  const expandedLib = new Set();
  const expandedDaily = new Set();
  let expandedDailyDefault = false;
  const expandedSections = new Set([0]);
  const expandedAlbums = new Set(['0:0']);
  const expandedExplorePics = new Set();
  const expandedTranslations = new Set();

  function showToast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(window.__catToastTimer);
    window.__catToastTimer = setTimeout(() => { t.hidden = true; }, 7000);
  }

  async function catApi(path, body = null) {
    const opts = body !== null
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': token }, body: JSON.stringify(body) }
      : {};
    const res = await fetch('/api/catalog/' + path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi thao tác Catalog.');
    return data;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function assetUrl(picId, kind) {
    return `/api/catalog/asset/${encodeURIComponent(picId)}/${kind}?v=${assetRev}`;
  }

  function previewSrc(pic) {
    if (!pic?.id) return '';
    if (pic.hasColor) return assetUrl(pic.id, 'color');
    if (pic.hasThumbnail) return assetUrl(pic.id, 'thumbnail');
    return '';
  }

  function switchView(mode) {
    activeView = mode === 'catalog' ? 'catalog' : 'studio';
    localStorage.setItem('studio-view-mode', activeView);
    const isCat = activeView === 'catalog';
    $('studio-view').hidden = isCat;
    $('catalog-view').hidden = !isCat;
    $('nav-studio-btn')?.classList.toggle('active', !isCat);
    $('nav-catalog-btn')?.classList.toggle('active', isCat);
    if (isCat) loadCatalogState();
  }

  function switchCatalogTab(tabName) {
    activeTab = tabName;
    localStorage.setItem('catalog-main-tab', activeTab);
    document.querySelectorAll('.cat-main-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.catTab === activeTab);
    });
    ['general', 'library', 'daily', 'explore'].forEach(name => {
      const panel = $('cat-tab-' + name);
      if (panel) panel.hidden = name !== activeTab;
    });
    renderCatalog();
  }

  async function loadCatalogState() {
    try {
      catState = await catApi('state');
      renderCatalog();
    } catch (e) {
      showToast(e.message);
    }
  }

  function renderHeader() {
    if (!catState) return;
    $('nav-catalog-count').textContent = catState.library?.length || 0;
    const badge = $('cat-mode-indicator');
    if (catState.hasWorking) {
      badge.textContent = `🟢 Data Mode: Working Copy (${catState.library.length} Library · ${catState.daily.entries.length} Daily · ${catState.explore.sections.length} Explore)`;
      badge.className = 'cat-mode-badge ok';
    } else {
      badge.textContent = '🟡 Data Mode: Chưa có Working Copy — Nhấn PULL DATA để nạp';
      badge.className = 'cat-mode-badge warn';
    }
    const times = [];
    if (catState.pulledAt) times.push('Pull: ' + new Date(catState.pulledAt).toLocaleString('vi-VN'));
    if (catState.updatedAt) times.push('Sửa: ' + new Date(catState.updatedAt).toLocaleString('vi-VN'));
    $('cat-sync-time').textContent = times.join(' · ');

    ['cat-pull-all', 'cat-push-all', 'cat-deploy-btn', 'cat-clear-working'].forEach(id => {
      const el = $(id);
      if (el) el.disabled = busyOp;
    });
  }

  function renderCatalog() {
    if (!catState) return;
    renderHeader();
    if (activeTab === 'general') renderGeneralTab();
    else if (activeTab === 'library') renderLibraryTab();
    else if (activeTab === 'daily') renderDailyTab();
    else if (activeTab === 'explore') renderExploreTab();
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
    b.disabled = disabled || busyOp;
    if (onClick) b.onclick = onClick;
    return b;
  }

  // ---------- TAB 0: General & Hosting ----------
  function renderGeneralTab() {
    const host = $('cat-tab-general');
    host.replaceChildren();
    const s = catState.settings || {};
    const sum = catState.summary || {};

    const deployBox = el('div', 'cat-box');
    deployBox.append(el('h3', 'cat-section-title', 'Firebase Hosting & Project Path'));

    const form = el('div', 'cat-form-grid');
    const makeInputRow = (label, id, value, placeholder = '', type = 'text') => {
      const row = el('div', 'cat-field-row');
      row.append(el('label', 'cat-field-label', label));
      const input = document.createElement('input');
      input.type = type;
      input.id = id;
      input.value = value ?? '';
      input.placeholder = placeholder;
      row.append(input);
      return { row, input };
    };

    const rRoot = makeInputRow('FillColoring Project Root', 'cfg-fc-root', s.fillcoloring_root, 'F:\\noichuagit\\FillColoring');
    const rUrl = makeInputRow('Hosting Base URL', 'cfg-base-url', s.base_url, 'https://coloruniverse-baa07.web.app/');
    const rProj = makeInputRow('Firebase Project ID', 'cfg-fb-proj', s.firebase_project, 'coloruniverse-baa07');
    const rThumb = makeInputRow('Thumbnail Max Size (px)', 'cfg-thumb-size', s.thumb_max_size ?? 256, '256', 'number');
    const rQual = makeInputRow('JPEG Quality (50-100)', 'cfg-jpg-qual', s.jpeg_quality ?? 85, '85', 'number');
    form.append(rRoot.row, rUrl.row, rProj.row, rThumb.row, rQual.row);
    deployBox.append(form);

    const statusLine = el('p', 'cat-meta-note',
      `ServerData: ${s.server_data_dir || '(Chưa cấu hình)'} · ` +
      (s.catalog_json_exists ? '✅ Đã có catalog.json' : '⚠️ Chưa thấy catalog.json tại ServerData'));
    deployBox.append(statusLine);

    const actions = el('div', 'cat-row-actions');
    actions.append(
      btn('💾 Lưu cấu hình Hosting', 'cat-btn cat-btn-push', async () => {
        try {
          await catApi('settings', {
            fillcoloring_root: rRoot.input.value.trim(),
            base_url: rUrl.input.value.trim(),
            firebase_project: rProj.input.value.trim(),
            thumb_max_size: Number(rThumb.input.value || 256),
            jpeg_quality: Number(rQual.input.value || 85),
          });
          showToast('Đã lưu cấu hình Catalog & Hosting.');
          await loadCatalogState();
        } catch (e) { showToast(e.message); }
      }),
      btn('📁 Open ServerData Folder', 'cat-btn cat-btn-neutral', () => catApi('open-folder', { kind: 'serverdata' }).catch(e => showToast(e.message))),
      btn('📁 Open Working Folder', 'cat-btn cat-btn-neutral', () => catApi('open-folder', { kind: 'working' }).catch(e => showToast(e.message))),
      btn('📁 Open Output Folder', 'cat-btn cat-btn-neutral', () => catApi('open-folder', { kind: 'output' }).catch(e => showToast(e.message)))
    );
    deployBox.append(actions);

    const sumBox = el('div', 'cat-box');
    sumBox.append(el('h3', 'cat-section-title', 'Thống kê & Kiểm tra sẵn sàng PUSH'));
    const statsGrid = el('div', 'cat-stats-grid');
    const addStat = (label, val, tone = '') => {
      const card = el('div', 'cat-stat-card ' + tone);
      card.append(el('strong', '', String(val)), el('span', '', label));
      statsGrid.append(card);
    };
    addStat('Library Pictures', sum.libraryCount ?? 0);
    addStat('Daily Scheduled', sum.dailyCount ?? 0);
    addStat('Explore Sections', sum.exploreSectionsCount ?? 0);
    addStat('Sẵn sàng PUSH (đủ 3 file)', sum.readyToPushCount ?? 0, 'ok');
    addStat('Chưa có FileByte (.bytes)', (sum.missingFileByteIds || []).length, (sum.missingFileByteIds || []).length ? 'warn' : 'ok');
    sumBox.append(statsGrid);

    if ((sum.missingFileByteIds || []).length > 0) {
      sumBox.append(el('p', 'cat-warn-note',
        `Các tranh đang thiếu FileByte (sẽ được giữ trong Working Copy và bỏ qua khi xuất catalog.json cho đến khi bạn bổ sung .bytes): ${sum.missingFileByteIds.join(', ')}`));
    }

    host.append(deployBox, sumBox);
  }

  // ---------- Shared Picture Card Renderer ----------
  function getAllLibraryTags() {
    const tags = new Set();
    for (const p of (catState?.library || [])) {
      for (const t of (p.tags || [])) {
        if (t && t.trim()) tags.add(t.trim());
      }
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  }

  function triggerUpload(picId, kind) {
    if (!picId) {
      showToast('Hãy nhập ID tranh trước khi tải file lên.');
      return;
    }
    const input = $('cat-asset-file');
    input.value = '';
    input.accept = kind === 'regions' ? '.bytes,.bin' : 'image/png,image/jpeg,image/webp';
    pendingUpload = { picId, kind };
    input.click();
  }

  function renderPictureCard({
    pic, titlePrefix = '', isExpanded, onToggle, onRemove, onCommit,
    forceFree = false, extraTopNode = null, datalistId = 'cat-tag-suggestions'
  }) {
    const card = el('div', 'cat-pic-card');
    const header = el('div', 'cat-pic-header');

    const titleText = titlePrefix + (pic.name || pic.id || 'New Picture');
    const toggleBtn = el('button', 'cat-foldout', (isExpanded ? '▼ ' : '▶ ') + titleText);
    toggleBtn.type = 'button';
    toggleBtn.onclick = onToggle;

    const badges = el('div', 'cat-pic-badges');
    if (forceFree || pic.priceType === 0) {
      badges.append(el('span', 'cat-pill free', 'Free'));
    } else {
      badges.append(el('span', 'cat-pill paid', `${PRICE_LABELS[pic.priceType] || 'Diamond'} ${pic.price || 0}`));
    }
    if (pic.cachedTextureWidth > 0 && pic.cachedTextureHeight > 0) {
      badges.append(el('span', 'cat-pill dim', `${pic.cachedTextureWidth}×${pic.cachedTextureHeight}`));
    }
    if (!pic.hasFileByte) {
      badges.append(el('span', 'cat-pill warn', 'Thiếu FileByte'));
    } else if (pic.regionCount > 0) {
      badges.append(el('span', 'cat-pill ok', `${pic.regionCount} vùng`));
    }

    const right = el('div', 'cat-pic-right');
    const thumbSrc = previewSrc(pic);
    if (thumbSrc) {
      const img = document.createElement('img');
      img.className = 'cat-card-thumb';
      img.src = thumbSrc;
      img.alt = pic.id || '';
      right.append(img);
    } else {
      right.append(el('div', 'cat-card-thumb empty', 'No img'));
    }
    right.append(btn('Remove', 'cat-btn cat-btn-remove', onRemove));

    header.append(toggleBtn, badges, right);
    card.append(header);

    if (!isExpanded) return card;

    const body = el('div', 'cat-pic-body');
    if (extraTopNode) body.append(extraTopNode);

    const grid = el('div', 'cat-detail-grid');

    // ID
    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.value = pic.id || '';
    idInput.placeholder = 'vd: animal_2_bytes';
    idInput.onchange = () => {
      const oldId = pic.id;
      const nextId = idInput.value.trim();
      if (nextId === oldId) return;
      pic.id = nextId;
      onCommit([{ from: oldId, to: nextId }]);
    };
    grid.append(el('label', 'cat-detail-label', 'ID'), idInput);

    // Name
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = pic.name || '';
    nameInput.placeholder = 'Tên hiển thị';
    nameInput.onchange = () => { pic.name = nameInput.value; onCommit(); };
    grid.append(el('label', 'cat-detail-label', 'Name'), nameInput);

    // File Byte
    const fbWrap = el('div', 'cat-asset-field');
    const fbInfo = el('span', 'cat-asset-status ' + (pic.hasFileByte ? 'ok' : 'warn'),
      pic.hasFileByte
        ? `📄 ${pic.fileByteName || 'regions.bytes'} (${formatBytes(pic.fileByteSize)}${pic.regionCount ? `, ${pic.regionCount} vùng` : ''})`
        : '⚠️ Chưa có FileByte (có thể bổ sung sau)');
    fbWrap.append(
      fbInfo,
      btn('Chọn .bytes', 'cat-btn cat-btn-mini', () => triggerUpload(pic.id, 'regions')),
      ...(pic.hasFileByte ? [btn('Xóa', 'cat-btn cat-btn-mini danger', async () => {
        try {
          catState = await catApi('clear-asset', { pic_id: pic.id, kind: 'regions' });
          renderCatalog();
          showToast(`Đã xóa FileByte của ${pic.id}.`);
        } catch (e) { showToast(e.message); }
      })] : [])
    );
    grid.append(el('label', 'cat-detail-label', 'File Byte'), fbWrap);

    // Colored Texture
    const ctWrap = el('div', 'cat-asset-field');
    if (pic.hasColor) {
      const cImg = document.createElement('img');
      cImg.className = 'cat-mini-tex';
      cImg.src = assetUrl(pic.id, 'color');
      ctWrap.append(cImg);
    }
    ctWrap.append(
      el('span', 'cat-asset-status ' + (pic.hasColor ? 'ok' : 'warn'),
        pic.hasColor ? `🎨 color.jpg (${formatBytes(pic.colorSize)})` : '⚠️ Chưa có Colored Texture'),
      btn('Chọn ảnh (_colored_final)', 'cat-btn cat-btn-mini', () => triggerUpload(pic.id, 'color'))
    );
    grid.append(el('label', 'cat-detail-label', 'Colored Texture'), ctWrap);

    // Thumbnail
    const thWrap = el('div', 'cat-asset-field');
    if (pic.hasThumbnail) {
      const tImg = document.createElement('img');
      tImg.className = 'cat-mini-tex';
      tImg.src = assetUrl(pic.id, 'thumbnail');
      thWrap.append(tImg);
    }
    thWrap.append(
      el('span', 'cat-asset-status ' + (pic.hasThumbnail ? 'ok' : 'warn'),
        pic.hasThumbnail ? `🖼️ thumbnail.jpg (${formatBytes(pic.thumbnailSize)})` : '⚠️ Chưa có Thumbnail'),
      btn('Chọn ảnh (_line_final → 256×256)', 'cat-btn cat-btn-mini', () => triggerUpload(pic.id, 'thumbnail')),
      ...(pic.hasColor ? [btn('Tạo từ Colored', 'cat-btn cat-btn-mini', async () => {
        try {
          const res = await catApi('upload-asset', { pic_id: pic.id, kind: 'thumbnail_from_color', data: '' });
          catState = res.state;
          assetRev = Date.now();
          renderCatalog();
          showToast(`Đã tạo thumbnail 256×256 (${res.width}×${res.height}) cho ${pic.id}.`);
        } catch (e) { showToast(e.message); }
      })] : [])
    );
    grid.append(el('label', 'cat-detail-label', 'Thumbnail'), thWrap);

    // Cached Width / Height
    const dimWrap = el('div', 'cat-dim-row');
    const wInput = document.createElement('input');
    wInput.type = 'number';
    wInput.min = '0';
    wInput.value = pic.cachedTextureWidth || 0;
    wInput.onchange = () => { pic.cachedTextureWidth = Math.max(0, Number(wInput.value || 0)); onCommit(); };

    const hInput = document.createElement('input');
    hInput.type = 'number';
    hInput.min = '0';
    hInput.value = pic.cachedTextureHeight || 0;
    hInput.onchange = () => { pic.cachedTextureHeight = Math.max(0, Number(hInput.value || 0)); onCommit(); };

    dimWrap.append(wInput, el('span', 'cat-dim-lbl', 'Cached Height'), hInput);
    grid.append(el('label', 'cat-detail-label', 'Cached Width'), dimWrap);

    // Aspect (H/W)
    const aspWrap = el('div', 'cat-dim-row');
    const ratio = (pic.cachedTextureWidth > 0 && pic.cachedTextureHeight > 0)
      ? (pic.cachedTextureHeight / pic.cachedTextureWidth).toFixed(3)
      : '1';
    aspWrap.append(
      el('span', 'cat-aspect-val', ratio),
      btn('Cache From ColoredTexture', 'cat-btn cat-btn-mini', async () => {
        try {
          catState = await catApi('cache-aspect', { pic_id: pic.id });
          renderCatalog();
          showToast(`Đã cập nhật kích thước cache cho ${pic.id}.`);
        } catch (e) { showToast(e.message); }
      }, !pic.hasColor)
    );
    grid.append(el('label', 'cat-detail-label', 'Aspect (H/W)'), aspWrap);

    // Tags
    const tagsWrap = el('div', 'cat-tags-editor');
    const chips = el('div', 'cat-tag-chips');
    for (let t = 0; t < (pic.tags || []).length; t++) {
      const chip = el('span', 'cat-tag-chip', pic.tags[t] + ' ');
      const del = el('button', 'cat-tag-del', '×');
      del.type = 'button';
      del.onclick = () => { pic.tags.splice(t, 1); onCommit(); };
      chip.append(del);
      chips.append(chip);
    }
    const addTagRow = el('div', 'cat-tag-add-row');
    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.placeholder = 'Thêm tag (vd: animal)…';
    tagInput.setAttribute('list', datalistId);
    const doAddTag = () => {
      const v = tagInput.value.trim();
      if (!v) return;
      pic.tags = pic.tags || [];
      if (!pic.tags.includes(v)) pic.tags.push(v);
      tagInput.value = '';
      onCommit();
    };
    tagInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doAddTag(); } };
    addTagRow.append(tagInput, btn('+ Tag', 'cat-btn cat-btn-mini', doAddTag));
    tagsWrap.append(chips, addTagRow);
    grid.append(el('label', 'cat-detail-label', `Tags (${(pic.tags || []).length})`), tagsWrap);

    // Price Type & Price
    const ptSelect = document.createElement('select');
    [[0, 'Free'], [1, 'Diamond'], [2, 'Gold']].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = String(val);
      opt.textContent = lbl;
      opt.selected = (forceFree ? 0 : (pic.priceType || 0)) === val;
      ptSelect.append(opt);
    });
    ptSelect.disabled = forceFree;
    ptSelect.onchange = () => { pic.priceType = Number(ptSelect.value); onCommit(); };
    grid.append(el('label', 'cat-detail-label', forceFree ? 'Price Type (Daily = Free)' : 'Price Type'), ptSelect);

    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.min = '0';
    priceInput.value = forceFree ? 0 : (pic.price || 0);
    priceInput.disabled = forceFree;
    priceInput.onchange = () => { pic.price = Math.max(0, Number(priceInput.value || 0)); onCommit(); };
    grid.append(el('label', 'cat-detail-label', 'Price'), priceInput);

    body.append(grid);
    card.append(body);
    return card;
  }

  function ensureTagDatalist() {
    let dl = $('cat-tag-suggestions');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'cat-tag-suggestions';
      document.body.append(dl);
    }
    dl.replaceChildren();
    for (const tag of getAllLibraryTags()) {
      const opt = document.createElement('option');
      opt.value = tag;
      dl.append(opt);
    }
  }

  // ---------- TAB 1: Picture Library ----------
  async function saveLibrary(renames = []) {
    try {
      catState = await catApi('library/save', { pictures: catState.library, renames });
      renderCatalog();
    } catch (e) {
      showToast(e.message);
      await loadCatalogState();
    }
  }

  function renderLibraryTab() {
    ensureTagDatalist();
    const host = $('cat-tab-library');
    host.replaceChildren();
    const pics = catState.library || [];

    // Sub-header
    const sub = el('div', 'cat-box');
    const subTop = el('div', 'cat-sub-top');
    subTop.append(el('strong', '', `Library Source: RemotePictureLibrary (${pics.length} pictures)`));
    sub.append(subTop);
    const subBtns = el('div', 'cat-row-actions');
    subBtns.append(
      btn('📥 PULL Library Data', 'cat-btn cat-btn-pull', () => runPull({ library: true, daily: false, explore: false })),
      btn('📤 PUSH Library Data', 'cat-btn cat-btn-push', () => runPush({ library: true, daily: false, explore: false }))
    );
    sub.append(subBtns);
    host.append(sub);

    // Tag grid
    const tags = ['All', ...getAllLibraryTags()];
    if (!tags.includes(activeLibTag)) activeLibTag = 'All';
    const tagGrid = el('div', 'cat-tag-grid');
    for (const t of tags) {
      const b = btn(t, 'cat-tag-btn' + (t === activeLibTag ? ' active' : ''), () => {
        activeLibTag = t;
        localStorage.setItem('catalog-lib-tag', t);
        renderLibraryTab();
      });
      tagGrid.append(b);
    }
    host.append(tagGrid);

    const visible = pics.filter(p => {
      const tagOk = activeLibTag === 'All' || (p.tags || []).some(t => t.toLowerCase() === activeLibTag.toLowerCase());
      if (!tagOk) return false;
      if (!libSearch.trim()) return true;
      const q = libSearch.trim().toLowerCase();
      return (p.id || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q);
    });

    // Toolbar
    const bar = el('div', 'cat-box');
    const barTitleRow = el('div', 'cat-sub-top');
    barTitleRow.append(el('strong', '', `Tag: ${activeLibTag} (${visible.length} tranh)`));
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'cat-search-input';
    searchInput.placeholder = 'Tìm theo ID / Name…';
    searchInput.value = libSearch;
    searchInput.oninput = () => { libSearch = searchInput.value; renderLibraryListOnly(); };
    barTitleRow.append(searchInput);
    bar.append(barTitleRow);

    const toolBtns = el('div', 'cat-toolbar-grid');
    toolBtns.append(
      btn('＋ Add Picture', 'cat-btn cat-btn-neutral', async () => {
        const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
        const newPic = {
          id: 'picture_' + stamp,
          name: 'New Picture',
          tags: activeLibTag !== 'All' ? [activeLibTag] : [],
          priceType: 0, // Default Free
          price: 0,
          cachedTextureWidth: 0,
          cachedTextureHeight: 0,
        };
        catState.library.push(newPic);
        expandedLib.add(newPic.id);
        await saveLibrary();
      }),
      btn('📥 Import từ Output', 'cat-btn cat-btn-pull', () => openImportDialog('library')),
      btn('Expand All', 'cat-btn cat-btn-neutral', () => {
        visible.forEach((p, idx) => expandedLib.add(p.id || `idx:${idx}`));
        renderLibraryListOnly();
      }),
      btn('Collapse All', 'cat-btn cat-btn-neutral', () => {
        visible.forEach((p, idx) => expandedLib.delete(p.id || `idx:${idx}`));
        renderLibraryListOnly();
      }),
      btn('Cache Aspect (All)', 'cat-btn cat-btn-neutral', async () => {
        try {
          catState = await catApi('cache-aspect', {});
          renderCatalog();
          showToast('Đã cache kích thước từ ColoredTexture cho toàn bộ tranh.');
        } catch (e) { showToast(e.message); }
      }),
      btn('🗑️ Remove All', 'cat-btn cat-btn-clear', async () => {
        if (!confirm(`Xóa TẤT CẢ ${pics.length} tranh trong Picture Library?`)) return;
        catState.library = [];
        expandedLib.clear();
        await saveLibrary();
        showToast('Đã xóa toàn bộ tranh trong Picture Library.');
      }, pics.length === 0)
    );
    bar.append(toolBtns);
    host.append(bar);

    const listWrap = el('div', 'cat-list-wrap');
    listWrap.id = 'cat-lib-list';
    host.append(listWrap);
    renderLibraryListOnly();
  }

  function renderLibraryListOnly() {
    const listWrap = $('cat-lib-list');
    if (!listWrap || !catState) return;
    listWrap.replaceChildren();
    const pics = catState.library || [];
    const visible = pics
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => {
        const tagOk = activeLibTag === 'All' || (p.tags || []).some(t => t.toLowerCase() === activeLibTag.toLowerCase());
        if (!tagOk) return false;
        if (!libSearch.trim()) return true;
        const q = libSearch.trim().toLowerCase();
        return (p.id || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q);
      });

    if (pics.length === 0) {
      listWrap.append(el('div', 'notice', "Thư viện hiện chưa có bức tranh nào. Hãy nhấn '📥 PULL Library Data', '＋ Add Picture' hoặc '📥 Import từ Output'."));
      return;
    }
    if (visible.length === 0) {
      listWrap.append(el('div', 'notice', `Không có bức tranh nào khớp bộ lọc "${activeLibTag}".`));
      return;
    }

    for (const { p, idx } of visible) {
      const key = p.id || `idx:${idx}`;
      listWrap.append(renderPictureCard({
        pic: p,
        isExpanded: expandedLib.has(key),
        onToggle: () => {
          if (expandedLib.has(key)) expandedLib.delete(key);
          else expandedLib.add(key);
          renderLibraryListOnly();
        },
        onRemove: async () => {
          if (!confirm(`Xóa tranh "${p.name || p.id}" khỏi Library?`)) return;
          catState.library.splice(idx, 1);
          await saveLibrary();
        },
        onCommit: async (renames = []) => {
          if (renames.length && renames[0].to) {
            expandedLib.delete(renames[0].from);
            expandedLib.add(renames[0].to);
          }
          await saveLibrary(renames);
        },
      }));
    }
  }

  // ---------- TAB 2: Picture Daily ----------
  async function saveDaily(renames = []) {
    try {
      catState = await catApi('daily/save', { daily: catState.daily, renames });
      renderCatalog();
    } catch (e) {
      showToast(e.message);
      await loadCatalogState();
    }
  }

  function renderDailyTab() {
    ensureTagDatalist();
    const host = $('cat-tab-daily');
    host.replaceChildren();
    const daily = catState.daily || { defaultPicture: null, entries: [] };
    const entries = daily.entries || [];

    const sub = el('div', 'cat-box');
    sub.append(el('strong', '', `Daily Source: RemotePictureDaily (${entries.length} scheduled days)`));
    const subBtns = el('div', 'cat-row-actions');
    subBtns.append(
      btn('📥 PULL Daily Data', 'cat-btn cat-btn-pull', () => runPull({ library: false, daily: true, explore: false })),
      btn('📤 PUSH Daily Data', 'cat-btn cat-btn-push', () => runPush({ library: false, daily: true, explore: false }))
    );
    sub.append(subBtns);
    host.append(sub);

    // Default Picture
    if (!daily.defaultPicture) {
      const dpBox = el('div', 'cat-box');
      dpBox.append(btn('⭐ Tạo Default Picture (unassigned days)', 'cat-btn cat-btn-neutral', async () => {
        daily.defaultPicture = { id: 'daily_default', name: 'Default Daily', tags: [], priceType: 0, price: 0 };
        expandedDailyDefault = true;
        await saveDaily();
      }));
      host.append(dpBox);
    } else {
      host.append(renderPictureCard({
        pic: daily.defaultPicture,
        titlePrefix: '⭐ Default Picture: ',
        forceFree: true,
        isExpanded: expandedDailyDefault,
        onToggle: () => { expandedDailyDefault = !expandedDailyDefault; renderDailyTab(); },
        onRemove: async () => { daily.defaultPicture = null; await saveDaily(); },
        onCommit: async (renames = []) => saveDaily(renames),
      }));
    }

    // Toolbar + Filters
    const bar = el('div', 'cat-box');
    const row1 = el('div', 'cat-toolbar-grid');
    row1.append(
      btn('Add Daily Picture', 'cat-btn cat-btn-push', async () => {
        let next = new Date();
        for (const e of entries) {
          if (e.year > 0 && e.month > 0 && e.day > 0) {
            const d = new Date(e.year, e.month - 1, e.day);
            if (d >= next) next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
          }
        }
        const y = next.getFullYear(), m = next.getMonth() + 1, d = next.getDate();
        const pad = n => String(n).padStart(2, '0');
        entries.push({
          year: y, month: m, day: d,
          picture: { id: `daily_${y}${pad(m)}${pad(d)}`, name: `Daily ${y}-${pad(m)}-${pad(d)}`, tags: [], priceType: 0, price: 0 }
        });
        expandedDaily.add(entries.length - 1);
        await saveDaily();
      }),
      btn('📥 Import từ Output', 'cat-btn cat-btn-pull', () => openImportDialog('daily')),
      btn('Expand All', 'cat-btn cat-btn-neutral', () => { entries.forEach((_, i) => expandedDaily.add(i)); renderDailyTab(); }),
      btn('Collapse All', 'cat-btn cat-btn-neutral', () => { expandedDaily.clear(); renderDailyTab(); }),
      btn('Sort by Date', 'cat-btn cat-btn-neutral', async () => {
        entries.sort((a, b) => {
          const da = (a.year && a.month && a.day) ? new Date(a.year, a.month - 1, a.day).getTime() : Infinity;
          const db = (b.year && b.month && b.day) ? new Date(b.year, b.month - 1, b.day).getTime() : Infinity;
          return da - db;
        });
        await saveDaily();
      }),
      btn('🔗 Link Textures', 'cat-btn cat-btn-pull', async () => {
        try {
          const res = await catApi('link-textures', {});
          catState = res.state;
          renderCatalog();
          showToast(`Đã liên kết thông tin từ Library cho ${res.linked} tranh.`);
        } catch (e) { showToast(e.message); }
      }),
      btn('🗑️ Remove All', 'cat-btn cat-btn-clear', async () => {
        if (!confirm(`Xóa TẤT CẢ ${entries.length} ngày trong Picture Daily?`)) return;
        catState.daily.entries = [];
        expandedDaily.clear();
        await saveDaily();
        showToast('Đã xóa toàn bộ danh sách Picture Daily.');
      }, entries.length === 0)
    );

    const filterRow = el('div', 'cat-filter-row');
    const sInput = document.createElement('input');
    sInput.type = 'search'; sInput.placeholder = 'Tìm ngày / ID / Name…'; sInput.value = dailySearch;
    sInput.oninput = () => { dailySearch = sInput.value; renderDailyListOnly(); };

    const yInput = document.createElement('input');
    yInput.type = 'number'; yInput.placeholder = 'Year'; yInput.value = dailyFilterYear || ''; yInput.style.width = '85px';
    yInput.onchange = () => { dailyFilterYear = Number(yInput.value || 0); renderDailyListOnly(); };

    const mInput = document.createElement('input');
    mInput.type = 'number'; mInput.placeholder = 'Month'; mInput.value = dailyFilterMonth || ''; mInput.style.width = '75px';
    mInput.onchange = () => { dailyFilterMonth = Number(mInput.value || 0); renderDailyListOnly(); };

    filterRow.append(sInput, yInput, mInput, btn('Clear Filter', 'cat-btn cat-btn-mini', () => {
      dailySearch = ''; dailyFilterYear = 0; dailyFilterMonth = 0; renderDailyTab();
    }));
    bar.append(row1, filterRow);
    host.append(bar);

    const listWrap = el('div', 'cat-list-wrap');
    listWrap.id = 'cat-daily-list';
    host.append(listWrap);
    renderDailyListOnly();
  }

  function renderDailyListOnly() {
    const listWrap = $('cat-daily-list');
    if (!listWrap || !catState) return;
    listWrap.replaceChildren();
    const entries = catState.daily?.entries || [];

    // Date validation warnings
    const seenDates = new Set();
    const warnings = [];
    entries.forEach((e, idx) => {
      if (e.year === 0 && e.month === 0 && e.day === 0) return;
      const dt = new Date(e.year, e.month - 1, e.day);
      const valid = dt.getFullYear() === e.year && dt.getMonth() === e.month - 1 && dt.getDate() === e.day;
      if (!valid) warnings.push(`Entry ${idx + 1}: Ngày không hợp lệ ${e.year}-${e.month}-${e.day}.`);
      else {
        const key = `${e.year}-${e.month}-${e.day}`;
        if (seenDates.has(key)) warnings.push(`Entry ${idx + 1}: Trùng ngày ${key}.`);
        seenDates.add(key);
      }
    });
    if (warnings.length) {
      listWrap.append(el('div', 'notice error', warnings.join(' | ')));
    }

    const pad = n => String(n).padStart(2, '0');
    let visibleCount = 0;
    entries.forEach((entry, idx) => {
      if (dailyFilterYear > 0 && entry.year !== dailyFilterYear) return;
      if (dailyFilterMonth > 0 && entry.month !== dailyFilterMonth) return;
      const pic = entry.picture || {};
      const dateStr = (entry.year > 0 && entry.month > 0 && entry.day > 0)
        ? `${entry.year}-${pad(entry.month)}-${pad(entry.day)}`
        : 'Unscheduled';
      if (dailySearch.trim()) {
        const q = dailySearch.trim().toLowerCase();
        if (!dateStr.toLowerCase().includes(q) && !(pic.id || '').toLowerCase().includes(q) && !(pic.name || '').toLowerCase().includes(q)) {
          return;
        }
      }
      visibleCount++;

      const dateRow = el('div', 'cat-date-row');
      dateRow.append(el('strong', '', 'Date: '));
      const mkNum = (val, w, fn) => {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.value = val || 0; inp.style.width = w;
        inp.onchange = () => { fn(Math.max(0, Number(inp.value || 0))); saveDaily(); };
        return inp;
      };
      dateRow.append(
        mkNum(entry.year, '72px', v => { entry.year = v; }),
        el('span', '', '/'),
        mkNum(entry.month, '56px', v => { entry.month = v; }),
        el('span', '', '/'),
        mkNum(entry.day, '56px', v => { entry.day = v; }),
        btn('Today', 'cat-btn cat-btn-mini', () => {
          const t = new Date();
          entry.year = t.getFullYear(); entry.month = t.getMonth() + 1; entry.day = t.getDate();
          saveDaily();
        }),
        btn('Clear Date', 'cat-btn cat-btn-mini', () => {
          entry.year = 0; entry.month = 0; entry.day = 0; saveDaily();
        })
      );

      listWrap.append(renderPictureCard({
        pic,
        titlePrefix: `[${dateStr}] `,
        forceFree: true,
        extraTopNode: dateRow,
        isExpanded: expandedDaily.has(idx),
        onToggle: () => {
          if (expandedDaily.has(idx)) expandedDaily.delete(idx);
          else expandedDaily.add(idx);
          renderDailyListOnly();
        },
        onRemove: async () => { entries.splice(idx, 1); await saveDaily(); },
        onCommit: async (renames = []) => saveDaily(renames),
      }));
    });

    if (visibleCount === 0) {
      listWrap.append(el('div', 'notice', entries.length === 0 ? "Chưa có tranh Daily nào. Nhấn 'Add Daily Picture' để thêm." : 'Không có tranh nào khớp bộ lọc.'));
    }
  }

  // ---------- TAB 3: Picture Explore ----------
  async function saveExplore(renames = []) {
    try {
      catState = await catApi('explore/save', { explore: catState.explore, renames });
      renderCatalog();
    } catch (e) {
      showToast(e.message);
      await loadCatalogState();
    }
  }

  function renderExploreTab() {
    ensureTagDatalist();
    const host = $('cat-tab-explore');
    host.replaceChildren();
    const sections = catState.explore?.sections || [];

    const sub = el('div', 'cat-box');
    sub.append(el('strong', '', `Explore Source: RemotePictureExplore (${sections.length} sections)`));
    const subBtns = el('div', 'cat-row-actions');
    subBtns.append(
      btn('📥 PULL Explore Data', 'cat-btn cat-btn-pull', () => runPull({ library: false, daily: false, explore: true })),
      btn('📤 PUSH Explore Data', 'cat-btn cat-btn-push', () => runPush({ library: false, daily: false, explore: true }))
    );
    sub.append(subBtns);
    host.append(sub);

    const bar = el('div', 'cat-box');
    const row1 = el('div', 'cat-toolbar-grid');
    row1.append(
      btn('+ Add Section', 'cat-btn cat-btn-push', async () => {
        sections.push({ name: `Section ${sections.length + 1}`, nameTranslations: [], iconName: '', albums: [] });
        expandedSections.add(sections.length - 1);
        await saveExplore();
      }),
      btn('Expand All', 'cat-btn cat-btn-neutral', () => {
        sections.forEach((s, si) => {
          expandedSections.add(si);
          (s.albums || []).forEach((a, ai) => {
            expandedAlbums.add(`${si}:${ai}`);
            (a.pictures || []).forEach((_, pi) => expandedExplorePics.add(`${si}:${ai}:${pi}`));
          });
        });
        renderExploreTab();
      }),
      btn('Collapse All', 'cat-btn cat-btn-neutral', () => {
        expandedSections.clear(); expandedAlbums.clear(); expandedExplorePics.clear(); renderExploreTab();
      }),
      btn('🔗 Link Textures', 'cat-btn cat-btn-pull', async () => {
        try {
          const res = await catApi('link-textures', {});
          catState = res.state;
          renderCatalog();
          showToast(`Đã liên kết thông tin từ Library cho ${res.linked} tranh.`);
        } catch (e) { showToast(e.message); }
      }),
      btn('🗑️ Remove All', 'cat-btn cat-btn-clear', async () => {
        if (!confirm(`Xóa TẤT CẢ ${sections.length} Section (và toàn bộ Album/Tranh) trong Picture Explore?`)) return;
        catState.explore.sections = [];
        expandedSections.clear();
        expandedAlbums.clear();
        expandedExplorePics.clear();
        await saveExplore();
        showToast('Đã xóa toàn bộ danh sách Picture Explore.');
      }, sections.length === 0)
    );
    const searchRow = el('div', 'cat-filter-row');
    const sInput = document.createElement('input');
    sInput.type = 'search'; sInput.placeholder = 'Tìm tranh trong Explore theo ID / Name…'; sInput.value = exploreSearch;
    sInput.oninput = () => { exploreSearch = sInput.value; renderExploreSectionsOnly(); };
    searchRow.append(sInput);
    bar.append(row1, searchRow);
    host.append(bar);

    const wrap = el('div', 'cat-list-wrap');
    wrap.id = 'cat-explore-list';
    host.append(wrap);
    renderExploreSectionsOnly();
  }

  function renderTranslationDrawer({ entries, setEntries, label, multiline = false, fallbackText = '', expandKey }) {
    const langs = catState?.supportedLanguages || DEFAULT_SUPPORTED_LANGUAGES;
    const list = Array.isArray(entries) ? entries : [];
    const filled = list.filter(e => e && String(e.text || '').trim().length > 0).length;
    const isOpen = expandedTranslations.has(expandKey);

    const box = el('div', 'cat-trans-box');
    const head = el('div', 'cat-trans-head');
    const fold = el('button', 'cat-foldout cat-trans-fold', `${isOpen ? '▼' : '▶'} 🌐 ${label} (${filled}/${langs.length})`);
    fold.type = 'button';
    fold.onclick = () => {
      if (isOpen) expandedTranslations.delete(expandKey);
      else expandedTranslations.add(expandKey);
      renderExploreSectionsOnly();
    };
    const initBtn = btn('Init 12 Langs', 'cat-btn cat-btn-mini', () => {
      const next = [...list];
      for (const lang of langs) {
        const exists = next.some(r => r && String(r.lang || '').trim().toLowerCase() === lang.toLowerCase());
        if (!exists) {
          next.push({ lang, text: lang === 'EN' ? String(fallbackText || '') : '' });
        }
      }
      setEntries(next);
      expandedTranslations.add(expandKey);
      saveExplore();
    });
    head.append(fold, initBtn);
    box.append(head);

    if (!isOpen) return box;

    const body = el('div', 'cat-trans-body');
    if (list.length === 0) {
      body.append(el('p', 'cat-meta-note', "Chưa có bản dịch riêng. Sẽ dùng text mặc định phía trên. Nhấn 'Init 12 Langs' để nhập bản dịch đi kèm catalog."));
    } else {
      list.forEach((row, idx) => {
        const rWrap = el('div', 'cat-trans-row');
        const langInp = document.createElement('input');
        langInp.type = 'text';
        langInp.className = 'cat-trans-lang';
        langInp.value = row.lang || '';
        langInp.placeholder = 'EN';
        langInp.onchange = () => { row.lang = langInp.value.trim(); saveExplore(); };

        const textInp = multiline ? document.createElement('textarea') : document.createElement('input');
        if (multiline) textInp.rows = 2;
        else textInp.type = 'text';
        textInp.className = 'cat-trans-text';
        textInp.value = row.text || '';
        textInp.onchange = () => { row.text = textInp.value; saveExplore(); };

        const delBtn = btn('×', 'cat-btn cat-btn-mini danger', () => {
          list.splice(idx, 1);
          setEntries(list);
          saveExplore();
        });
        rWrap.append(langInp, textInp, delBtn);
        body.append(rWrap);
      });
    }
    body.append(btn('+ Add Language Row', 'cat-btn cat-btn-mini', () => {
      const next = [...list, { lang: 'EN', text: '' }];
      setEntries(next);
      expandedTranslations.add(expandKey);
      saveExplore();
    }));
    box.append(body);
    return box;
  }

  function renderExploreSectionsOnly() {
    const wrap = $('cat-explore-list');
    if (!wrap || !catState) return;
    wrap.replaceChildren();
    const sections = catState.explore?.sections || [];
    if (sections.length === 0) {
      wrap.append(el('div', 'notice', "Chưa có Section nào. Nhấn '+ Add Section' để tạo Section mới."));
      return;
    }

    sections.forEach((sec, si) => {
      const secBox = el('div', 'cat-sec-card');
      const secHead = el('div', 'cat-pic-header');
      const secOpen = expandedSections.has(si);
      const secFold = el('button', 'cat-foldout', `${secOpen ? '▼' : '▶'} 📁 Section: ${sec.name || `Section ${si + 1}`} (${(sec.albums || []).length} albums)`);
      secFold.type = 'button';
      secFold.onclick = () => {
        if (secOpen) expandedSections.delete(si); else expandedSections.add(si);
        renderExploreSectionsOnly();
      };
      const secRight = el('div', 'cat-pic-right');
      secRight.append(
        btn('+ Add Album', 'cat-btn cat-btn-mini', async () => {
          sec.albums = sec.albums || [];
          sec.albums.push({
            name: `Album ${sec.albums.length + 1}`, nameTranslations: [],
            description: '', descriptionTranslations: [],
            coverPictureId: '', pictures: [],
          });
          expandedSections.add(si);
          expandedAlbums.add(`${si}:${sec.albums.length - 1}`);
          await saveExplore();
        }),
        btn('Remove', 'cat-btn cat-btn-remove', async () => {
          if (!confirm(`Xóa Section "${sec.name}"?`)) return;
          sections.splice(si, 1);
          await saveExplore();
        })
      );
      secHead.append(secFold, secRight);
      secBox.append(secHead);

      if (secOpen) {
        const secBody = el('div', 'cat-sec-body');
        const secFields = el('div', 'cat-detail-grid');
        const sName = document.createElement('input');
        sName.value = sec.name || '';
        sName.onchange = () => { sec.name = sName.value; saveExplore(); };
        const sIcon = document.createElement('input');
        sIcon.value = sec.iconName || '';
        sIcon.placeholder = 'Tên icon sprite (tùy chọn)';
        sIcon.onchange = () => { sec.iconName = sIcon.value; saveExplore(); };
        secFields.append(el('label', 'cat-detail-label', 'Section Name'), sName);
        secBody.append(secFields);
        secBody.append(renderTranslationDrawer({
          entries: sec.nameTranslations,
          setEntries: next => { sec.nameTranslations = next; },
          label: 'Section Name Translations',
          multiline: false,
          fallbackText: sec.name || '',
          expandKey: `sec:${si}:name`,
        }));
        const secIconGrid = el('div', 'cat-detail-grid');
        secIconGrid.append(el('label', 'cat-detail-label', 'Icon Name'), sIcon);
        secBody.append(secIconGrid);

        (sec.albums || []).forEach((alb, ai) => {
          const albKey = `${si}:${ai}`;
          const albOpen = expandedAlbums.has(albKey);
          const albBox = el('div', 'cat-alb-card');
          const albHead = el('div', 'cat-pic-header');
          const albFold = el('button', 'cat-foldout', `${albOpen ? '▼' : '▶'} 💿 Album: ${alb.name || `Album ${ai + 1}`} (${(alb.pictures || []).length} pictures)`);
          albFold.type = 'button';
          albFold.onclick = () => {
            if (albOpen) expandedAlbums.delete(albKey); else expandedAlbums.add(albKey);
            renderExploreSectionsOnly();
          };
          const albRight = el('div', 'cat-pic-right');
          albRight.append(
            btn('+ Add Picture', 'cat-btn cat-btn-mini', async () => {
              alb.pictures = alb.pictures || [];
              alb.pictures.push({ id: '', name: '', tags: [], priceType: 0, price: 0, cachedTextureWidth: 0, cachedTextureHeight: 0 });
              expandedAlbums.add(albKey);
              expandedExplorePics.add(`${albKey}:${alb.pictures.length - 1}`);
              await saveExplore();
            }),
            btn('Remove', 'cat-btn cat-btn-remove', async () => {
              if (!confirm(`Xóa Album "${alb.name}"?`)) return;
              sec.albums.splice(ai, 1);
              await saveExplore();
            })
          );
          albHead.append(albFold, albRight);
          albBox.append(albHead);

          if (albOpen) {
            const albBody = el('div', 'cat-alb-body');
            const albNameGrid = el('div', 'cat-detail-grid');
            const aName = document.createElement('input'); aName.value = alb.name || '';
            aName.onchange = () => { alb.name = aName.value; saveExplore(); };
            albNameGrid.append(el('label', 'cat-detail-label', 'Album Name'), aName);
            albBody.append(albNameGrid);

            albBody.append(renderTranslationDrawer({
              entries: alb.nameTranslations,
              setEntries: next => { alb.nameTranslations = next; },
              label: 'Album Name Translations',
              multiline: false,
              fallbackText: alb.name || '',
              expandKey: `alb:${albKey}:name`,
            }));

            const albDescGrid = el('div', 'cat-detail-grid');
            const aDesc = document.createElement('textarea'); aDesc.rows = 2; aDesc.value = alb.description || '';
            aDesc.onchange = () => { alb.description = aDesc.value; saveExplore(); };
            albDescGrid.append(el('label', 'cat-detail-label', 'Description'), aDesc);
            albBody.append(albDescGrid);

            albBody.append(renderTranslationDrawer({
              entries: alb.descriptionTranslations,
              setEntries: next => { alb.descriptionTranslations = next; },
              label: 'Description Translations',
              multiline: true,
              fallbackText: alb.description || '',
              expandKey: `alb:${albKey}:desc`,
            }));

            const albCovGrid = el('div', 'cat-detail-grid');
            const covRow = el('div', 'cat-dim-row');
            const aCov = document.createElement('input'); aCov.value = alb.coverPictureId || '';
            aCov.placeholder = 'Cover Picture ID';
            aCov.onchange = () => { alb.coverPictureId = aCov.value.trim(); saveExplore(); };
            covRow.append(aCov, btn('Auto Cover (1st Pic)', 'cat-btn cat-btn-mini', () => {
              const first = (alb.pictures || [])[0];
              if (first?.id) { alb.coverPictureId = first.id; saveExplore(); }
            }));
            albCovGrid.append(el('label', 'cat-detail-label', 'Cover Picture ID'), covRow);
            albBody.append(albCovGrid);

            const q = exploreSearch.trim().toLowerCase();
            (alb.pictures || []).forEach((pic, pi) => {
              if (q && !(pic.id || '').toLowerCase().includes(q) && !(pic.name || '').toLowerCase().includes(q)) return;
              const pKey = `${albKey}:${pi}`;
              albBody.append(renderPictureCard({
                pic,
                titlePrefix: '🖼️ ',
                isExpanded: expandedExplorePics.has(pKey),
                onToggle: () => {
                  if (expandedExplorePics.has(pKey)) expandedExplorePics.delete(pKey);
                  else expandedExplorePics.add(pKey);
                  renderExploreSectionsOnly();
                },
                onRemove: async () => { alb.pictures.splice(pi, 1); await saveExplore(); },
                onCommit: async (renames = []) => saveExplore(renames),
              }));
            });
            albBox.append(albBody);
          }
          secBody.append(albBox);
        });
        secBox.append(secBody);
      }
      wrap.append(secBox);
    });
  }

  // ---------- PULL / PUSH / DEPLOY ----------
  async function runPull({ library, daily, explore }) {
    if (busyOp) return;
    const source = $('cat-pull-source')?.value || 'auto';
    busyOp = true;
    renderHeader();
    showToast('📥 Đang PULL dữ liệu về Working Copy…');
    try {
      const res = await catApi('pull', { library, daily, explore, source });
      catState = res.state;
      assetRev = Date.now();
      showToast(`✅ PULL thành công (${(res.sources || []).join(', ')})!`);
    } catch (e) {
      showToast('❌ Lỗi PULL: ' + e.message);
    } finally {
      busyOp = false;
      renderCatalog();
    }
  }

  async function runPush({ library, daily, explore }) {
    if (busyOp) return;
    busyOp = true;
    renderHeader();
    showToast('📤 Đang đóng gói PUSH sang ServerData/Pictures…');
    try {
      const res = await catApi('push', { library, daily, explore });
      const skippedCount = (res.skipped || []).length;
      const msg = skippedCount
        ? `✅ Đã PUSH ${res.exportedCount} tranh sang ServerData/Pictures (bỏ qua ${skippedCount} tranh chưa có FileByte).`
        : `✅ Đã PUSH toàn bộ ${res.exportedCount} tranh sang ServerData/Pictures!`;
      showToast(msg);
      await loadCatalogState();
    } catch (e) {
      showToast('❌ Lỗi PUSH: ' + e.message);
    } finally {
      busyOp = false;
      renderCatalog();
    }
  }

  async function runDeploy() {
    if (busyOp) return;
    if (!confirm('Deploy toàn bộ thư mục ServerData/Pictures lên Firebase Hosting (coloruniverse-baa07)?')) return;
    busyOp = true;
    renderHeader();
    showToast('🚀 Đang Deploy lên Firebase Hosting… Vui lòng chờ trong giây lát.');
    try {
      const res = await catApi('deploy', {});
      showToast(`🎉 Deploy Firebase Hosting thành công! (${res.baseUrl})`);
    } catch (e) {
      showToast('❌ Lỗi Deploy: ' + e.message);
    } finally {
      busyOp = false;
      renderCatalog();
    }
  }

  // ---------- Import from Output / Studio Dialog ----------
  async function openImportDialog(defaultTarget = 'library') {
    await loadCatalogState();
    $('cat-import-target').value = defaultTarget;
    const list = $('cat-output-list');
    list.replaceChildren();
    const sources = catState?.outputSources || [];
    if (!sources.length) {
      list.append(el('div', 'notice', 'Chưa thấy cặp (_colored_final.png & _line_final.png) nào trong Output hoặc Studio. Hãy chạy xuất bộ ảnh ở tab Tạo Level trước.'));
    } else {
      for (const item of sources) {
        const row = el('label', 'cat-output-item');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !item.alreadyInLibrary;
        cb.dataset.sourceType = item.sourceType;
        cb.dataset.key = item.key;
        if (item.projectId) cb.dataset.projectId = item.projectId;

        const img = document.createElement('img');
        if (item.sourceType === 'output') {
          img.src = `/api/catalog/output-preview/${encodeURIComponent(item.colorFile)}`;
        }
        img.alt = item.name;

        const info = el('div', 'cat-output-info');
        info.append(
          el('b', '', `${item.name} → ID: ${item.suggestedId}`),
          el('small', '', `${item.width}×${item.height} px · ${item.sourceType === 'output' ? 'Output' : 'Studio Project'}${item.alreadyInLibrary ? ' · (Đã có trong Library — sẽ cập nhật ảnh)' : ''}`)
        );
        row.append(cb, img, info);
        list.append(row);
      }
    }
    $('cat-import-dialog').showModal();
  }

  window.importProjectToCatalog = async function (project) {
    if (!project) return;
    try {
      const res = await catApi('import-output', { project_id: project.id, target: 'library' });
      catState = res.state;
      assetRev = Date.now();
      expandedLib.add(res.importedId);
      showToast(`✅ Đã đưa "${res.importedId}" (${res.width}×${res.height}) vào Remote Catalog (Free, tạo sẵn thumbnail 256×256)!`);
      switchView('catalog');
      switchCatalogTab('library');
    } catch (e) {
      showToast(e.message);
    }
  };

  // ---------- Event Wiring ----------
  $('nav-studio-btn')?.addEventListener('click', () => switchView('studio'));
  $('nav-catalog-btn')?.addEventListener('click', () => switchView('catalog'));

  document.querySelectorAll('.cat-main-tab').forEach(btnEl => {
    btnEl.addEventListener('click', () => switchCatalogTab(btnEl.dataset.catTab));
  });

  $('cat-pull-all')?.addEventListener('click', () => runPull({ library: true, daily: true, explore: true }));
  $('cat-push-all')?.addEventListener('click', () => runPush({ library: true, daily: true, explore: true }));
  $('cat-deploy-btn')?.addEventListener('click', runDeploy);
  $('cat-clear-working')?.addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ Working Copy cục bộ trong Studio? (Không xóa dữ liệu trong FillColoring/ServerData)')) return;
    try {
      catState = await catApi('clear-working', {});
      renderCatalog();
      showToast('Đã xóa sạch Working Copy.');
    } catch (e) { showToast(e.message); }
  });

  $('cat-import-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const checked = [...$('cat-output-list').querySelectorAll('input[type="checkbox"]:checked')];
    if (!checked.length) { showToast('Hãy chọn ít nhất 1 tranh để nhập.'); return; }
    const target = $('cat-import-target').value;
    const rawTags = $('cat-import-tags').value.split(',').map(s => s.trim()).filter(Boolean);
    $('cat-import-submit').disabled = true;
    try {
      let count = 0;
      for (const cb of checked) {
        const res = await catApi('import-output', {
          key: cb.dataset.sourceType === 'output' ? cb.dataset.key : undefined,
          project_id: cb.dataset.projectId || undefined,
          tags: rawTags,
          target,
        });
        catState = res.state;
        expandedLib.add(res.importedId);
        count++;
      }
      assetRev = Date.now();
      $('cat-import-dialog').close();
      renderCatalog();
      showToast(`✅ Đã nhập ${count} tranh vào ${target} (Free, tạo thumbnail 256×256 từ _line_final).`);
    } catch (err) {
      showToast(err.message);
    } finally {
      $('cat-import-submit').disabled = false;
    }
  });

  $('cat-asset-file')?.addEventListener('change', async () => {
    const file = $('cat-asset-file').files[0];
    const req = pendingUpload;
    pendingUpload = null;
    if (!file || !req) return;
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Không đọc được file.'));
        reader.readAsDataURL(file);
      });
      const res = await catApi('upload-asset', {
        pic_id: req.picId,
        kind: req.kind,
        filename: file.name,
        data: b64,
      });
      catState = res.state;
      assetRev = Date.now();
      renderCatalog();
      showToast(`✅ Đã cập nhật ${req.kind} cho ${req.picId}.`);
    } catch (e) {
      showToast(e.message);
    }
  });

  // Initial load
  loadCatalogState();
  switchView(activeView);
  switchCatalogTab(activeTab);
})();
