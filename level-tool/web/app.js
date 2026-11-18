'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="app-token"]').content;
let state = {projects: [], jobs: {}, settings: {}}, selected = localStorage.getItem('selected-project'), tab = 'source';
let signature = '', polling = false, mutation = false, overlaySerial = 0, overlayImage = null;
let loopState = { active: false, total: 10, current: 0, baseName: '', stopRequested: false, timer: null, prompt: '', lastFinishedPid: null };
const stageNames = {origin: 'Ảnh gốc', source: 'Line Canva', patch: 'Line đã vá', color: 'Ảnh màu', transparent: 'Line trong suốt'};
const current = () => state.projects.find(p => p.id === selected);
const version = (p, stage) => p?.versions[stage]?.find(v => v.id === p.selected[stage]);
const asset = (p, v) => `/asset/${p.id}/${v.id}`;
const busy = p => mutation || state.jobs[p?.id]?.status === 'running';

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').hidden = true, 7000);
}

async function api(path, body) {
  const response = await fetch('/api/' + path, body ? {method:'POST', headers:{'Content-Type':'application/json','X-App-Token':token}, body:JSON.stringify(body)} : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Không thể hoàn tất thao tác.');
  return result;
}

async function refresh(force=false) {
  if (polling) return;
  polling = true;
  try {
    const next = await api('state');
    $('connection').hidden = true;
    const sig = JSON.stringify(next);
    state = next;
    if (!current()) selected = state.projects[0]?.id;
    if (sig !== signature || force) { signature = sig; render(); }
    checkLoopProgress();
  } catch (_) { $('connection').hidden = false; }
  finally { polling = false; }
}

function renderLibrary() {
  const needle = $('search').value.trim().toLocaleLowerCase();
  $('projects').replaceChildren();
  $('count').textContent = state.projects.length;
  for (const p of state.projects.filter(p => p.name.toLocaleLowerCase().includes(needle))) {
    const button = document.createElement('button');
    button.className = 'project-item' + (p.id === selected ? ' active' : '');
    const vthumb = version(p,'transparent') || version(p,'color') || version(p,'patch') || version(p,'source') || version(p,'origin');
    const img = document.createElement('img');
    if (vthumb) img.src = asset(p, vthumb);
    img.alt = '';
    const text = document.createElement('div'), name = document.createElement('b'), status = document.createElement('small');
    name.textContent = p.name;
    status.textContent = state.jobs[p.id]?.status === 'running' ? 'Đang xử lý…' : p.exported ? 'Đã xuất bộ ảnh' : p.approved.color ? 'Sẵn sàng xuất' : p.approved.patch ? 'Đã duyệt line' : version(p,'patch') ? 'Chờ duyệt line' : version(p,'source') ? 'Chờ vá nét' : 'Chờ tạo line';
    text.append(name,status); button.append(img,text);
    button.onclick=()=> {
      selected=p.id;
      localStorage.setItem('selected-project',selected);
      tab=version(p,'color')?'color':version(p,'patch')?'patch':version(p,'source')?'source':version(p,'origin')?'origin':'source';
      render();
    };
    $('projects').append(button);
  }
}

function render() {
  renderLibrary();
  updateLoopUI();
  const browserMode = state.settings.mode !== 'api';
  const aiReady = browserMode ? state.browser?.connected : state.settings.has_key;
  $('key-notice').hidden = browserMode || state.settings.has_key;
  $('browser-notice').hidden = !browserMode;
  const bName = state.browser?.browser === 'coccoc' ? 'Cốc Cốc' : 'Chrome';
  $('browser-status').textContent = state.browser?.connected ? `${bName} đã kết nối · Gemini & Canva · Không dùng API key` : 'Chưa kết nối trình duyệt. Cài tiện ích rồi mở trang này trong Cốc Cốc (hoặc Chrome) đã đăng nhập Google & Canva.';
  const p = current();
  $('empty').hidden = !!p; $('workspace').hidden = !p; $('folder-button').hidden = !p; $('delete-button').hidden = !p;
  $('project-title').textContent = p?.name || 'Từ tranh gốc đến bộ level hoàn chỉnh';
  $('project-subtitle').textContent = p ? 'Tạo tranh gốc (AI Studio) → Tạo line (Canva) → Vá nét (Gemini) → Tô màu (AI Studio) → Xóa nền' : 'Quy trình 5 bước: AI Studio → Canva → Gemini → AI Studio → Xóa nền';
  if (!p) return;
  const locked=busy(p), approved=!!p.approved.patch, origin=version(p,'origin'), source=version(p,'source'), patch=version(p,'patch'), color=version(p,'color'), line=version(p,'transparent');
  for(const stage of ['origin','source','patch','color','transparent']) {
    const badge=$('badge-'+stage), v=version(p,stage);
    if (!badge) continue;
    badge.textContent = !v?'Chưa có':p.approved[stage]?'Đã duyệt':stage==='transparent'?'Đã xóa nền':(stage==='origin'||stage==='source')?'Đã có':'Chờ duyệt';
    badge.className='badge'+(p.approved[stage]||((stage==='transparent'||stage==='origin'||stage==='source')&&v)?' ok':'');
  }

  document.querySelectorAll('[data-run]').forEach(b=>{
    const act = b.dataset.run;
    if (act === 'origin' || act === 'all') b.disabled = locked || !aiReady;
    else if (act === 'canva-line') b.disabled = locked || !origin || !aiReady;
    else if (act === 'patch') b.disabled = locked || !source || !aiReady;
    else if (act === 'transparent') b.disabled = locked || !approved;
    else b.disabled = locked || !approved || !aiReady;
  });

  document.querySelectorAll('[data-approve]').forEach(b=>{
    b.disabled = locked || !version(p,b.dataset.approve) || !!p.approved[b.dataset.approve];
  });

  $('export-button').disabled = locked || !p.approved.color || !line || !approved;
  $('import-result').disabled = locked || !['origin','source','patch','color'].includes(tab) || (tab==='color'&&!approved);
  const job = state.jobs[p.id];
  $('job-status').hidden = !job;
  $('cancel-browser').hidden = !browserMode || job?.status !== 'running';
  const isJobRunning = job?.status === 'running';
  ['stop-job-header-btn', 'stop-job-bar-btn'].forEach(id => {
    const el = $(id);
    if (el) {
      el.disabled = !isJobRunning;
      el.style.cursor = isJobRunning ? 'pointer' : 'not-allowed';
      el.style.opacity = isJobRunning ? '1' : '0.42';
    }
  });
  if(job){$('job-status').textContent=jobMessage(p.id, job);$('job-status').className=job.status;}
  $('next-title').textContent = !origin && !source ? 'Bắt đầu bằng tạo tranh gốc hoặc tạo line' : !source ? 'Chuyển tranh sang nét vẽ trên Canva' : !patch ? 'Vá kín nét hở bằng Gemini' : !approved ? 'Kiểm tra nét rồi duyệt line' : !color ? 'Line đã duyệt — sẵn sàng tô màu' : !p.approved.color ? 'Kiểm tra ảnh màu trước khi xuất' : !line ? 'Xóa nền line để hoàn tất' : 'Bộ ảnh đã hoàn tất và sẵn sàng xuất';
  $('next-description').textContent = !approved ? 'Bước tô màu và xóa nền dùng đúng phiên bản line bạn chọn.' : 'Chạy 4 + 5 hoặc chạy riêng từng bước. Các phiên bản trước luôn được giữ lại.';
  $('export-status').hidden = !p.exported;
  if(p.exported){
    $('export-status').replaceChildren(document.createTextNode('Đã xuất kết quả vào F:\\noichuagit\\FillColoring_LevelData\\output '));
    const b=document.createElement('button');b.className='text-button';b.textContent='Mở thư mục Output';
    b.onclick=()=>act('open-folder',{output:true});
    $('export-status').append(b);
  }
  if ($('step1-prompt') && document.activeElement !== $('step1-prompt') && !$('step1-prompt').value) {
    $('step1-prompt').value = state.settings.origin_prompt || '';
  }
  renderPreview();
}

function renderPreview() {
  const p=current(); if(!p)return;
  document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-selected',String(b.dataset.tab===tab));});
  $('import-result').disabled = busy(p) || !['origin','source','patch','color'].includes(tab) || (tab==='color'&&!p.approved.patch);
  $('overlay-controls').hidden = tab!=='overlay'; $('version').hidden = tab==='overlay';
  $('preview').hidden=true; $('overlay').hidden=true; $('image-empty').hidden=false; $('image-empty').textContent='Kết quả sẽ xuất hiện tại đây.';
  $('zoom-button').disabled=true;
  $('version').replaceChildren();
  if(tab==='overlay'){
    $('image-info').textContent='Line màu đỏ chồng lên ảnh màu';
    $('review-note').textContent='Kiểm tra nét đỏ có trùng với biên vùng màu. AI có thể làm lệch hình dù cùng kích thước.';
    drawOverlay();return;
  }
  const record=version(p,tab);
  for(const v of p.versions[tab]||[]){
    const option=document.createElement('option');
    option.value=v.id;
    option.textContent=`v${v.number} · ${new Date(v.created_at).toLocaleString('vi-VN')}`;
    option.selected=v.id===record?.id;
    option.disabled=['color','transparent'].includes(tab)&&v.parent!==p.selected.patch;
    $('version').append(option);
  }
  $('version').disabled=busy(p)||!(p.versions[tab]?.length>1);
  $('image-info').textContent=record?`${stageNames[tab]} · ${record.width} × ${record.height} px · v${record.number}`:'Chưa có kết quả';
  $('review-note').textContent=tab==='origin'?'Ảnh màu gốc do AI Studio sinh ra hoặc do bạn tải lên.':tab==='source'?'Ảnh Canva gốc được giữ nguyên.':tab==='patch'?'Phóng lớn để kiểm tra vùng hở trước khi duyệt line.':tab==='color'?'Dùng Chồng kiểm tra để so ảnh màu với line đã duyệt.':'Nền caro chỉ để xem độ trong suốt, không nằm trong file PNG.';
  if(record?.metadata.resized_to_input)$('review-note').textContent+=' Ảnh AI đã được đưa về kích thước đầu vào cùng tỷ lệ.';
  if(record){$('preview').src=asset(p,record);$('preview').hidden=false;$('image-empty').hidden=true;$('zoom-button').disabled=false;}
}

function loadImage(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Không tải được ảnh xem trước.'));img.src=src;});}
async function drawOverlay(){
  const p=current(), patch=version(p,'patch'),color=version(p,'color'), serial=++overlaySerial;
  if(!patch||!color||color.parent!==patch.id){$('image-empty').textContent='Cần ảnh màu và line đã vá tương ứng để chồng kiểm tra.';return;}
  try{
    const [lineImg,colorImg]=await Promise.all([loadImage(asset(p,patch)),loadImage(asset(p,color))]);
    if(serial!==overlaySerial||selected!==p.id||tab!=='overlay')return;
    overlayImage={lineImg,colorImg}; paintOverlay();$('image-empty').hidden=true;$('overlay').hidden=false;$('zoom-button').disabled=false;
  }catch(e){toast(e.message);}
}

function paintOverlay(){
  if(!overlayImage)return;
  const {lineImg,colorImg}=overlayImage,c=$('overlay');c.width=lineImg.width;c.height=lineImg.height;
  const ctx=c.getContext('2d');ctx.drawImage(colorImg,0,0,c.width,c.height);
  const layer=document.createElement('canvas');layer.width=c.width;layer.height=c.height;const lx=layer.getContext('2d');lx.drawImage(lineImg,0,0);
  const pixels=lx.getImageData(0,0,c.width,c.height),opacity=Number($('opacity').value)/100;
  for(let i=0;i<pixels.data.length;i+=4){const d=pixels.data,lum=(.299*d[i]+.587*d[i+1]+.114*d[i+2]);d[i+3]=Math.round((255-lum)*(d[i+3]/255)*opacity);d[i]=235;d[i+1]=40;d[i+2]=81;}
  lx.putImageData(pixels,0,0);ctx.drawImage(layer,0,0);
}

function jobMessage(pid, job) {
  const iteration = localStorage.getItem('job-loop-' + pid);
  const steps = {
    origin: 'Bước 1 — Tạo tranh gốc (AI Studio)',
    source: 'Bước 2 — Tạo line (Canva)',
    patch: 'Bước 3 — Vá nét (Gemini)',
    color: 'Bước 4 — Tô màu',
    transparent: 'Bước 5 — Xóa nền',
    all: 'Đang chuẩn bị quy trình', finish: 'Đang chuẩn bị hoàn thiện'
  };
  const step = steps[job.step] || job.step || 'Không có dữ liệu bước';
  return (iteration ? `[Vòng lặp ${iteration}] ` : '') + `[${step}] ` + job.message;
}

async function act(path, extra={}) {
  if(mutation)return;
  const pid=selected;
  if (path === 'run') {
    if (loopState.active) localStorage.setItem('job-loop-' + pid, `${loopState.current}/${loopState.total}`);
    else localStorage.removeItem('job-loop-' + pid);
  }
  mutation=true;render();
  try{
    await api(path,{id:pid,...extra});
    if(path==='run'){
      tab=extra.action==='finish'?'color':(extra.action==='origin'?'origin':(extra.action==='canva-line'?'source':extra.action));
    }
    if(path==='approve')toast(extra.stage==='patch'?'Đã duyệt line. Có thể chạy bước 4 + 5.':'Đã duyệt ảnh màu.');
    if(path==='export')toast('Đã xuất toàn bộ ảnh ra folder F:\\noichuagit\\FillColoring_LevelData\\output.');
  }
  catch(e){toast(e.message);}
  finally{mutation=false;render();await refresh(true);}
}

function readFile(file){return new Promise((resolve,reject)=>{if(file.size>18*1024*1024)return reject(new Error('Ảnh vượt quá 18 MB.'));const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('Không đọc được file.'));reader.readAsDataURL(file);});}
function showImport(){$('import-dialog').showModal();}
function modeFields(){const web=$('processing-mode').value==='browser';$('browser-settings').hidden=!web;$('api-settings').hidden=web;$('forget-key').hidden=web;}

const settingFields = {
  'processing-mode':'mode', 'canva-url':'canva_url', 'browser-url':'browser_url',
  'aistudio-origin-url':'aistudio_origin_url', 'aistudio-url':'aistudio_url',
  'browser-email':'browser_email', 'model':'model', 'origin-prompt':'origin_prompt',
  'patch-prompt':'patch_prompt', 'color-prompt':'color_prompt',
  'aistudio-color-prompt':'aistudio_color_prompt'
};
let settingsQueue = Promise.resolve();
const settingTimers = new Map();
const settingsErrors = new Map();
function settingsStatus(message, error=false) {
  $('settings-save-status').textContent=message;
  $('settings-save-status').style.color=error?'#a04435':'#376c4f';
}
function persistSettings(values) {
  const save = settingsQueue.catch(()=>{}).then(async()=>{
    settingsStatus('Đang lưu cài đặt…');
    const result=await api('settings', values);
    // An older running server can silently ignore newly added fields.
    for(const key of Object.keys(values)) {
      if(['api_key','remember','forget_key'].includes(key)) continue;
      if(!(key in result)) throw new Error('Server đang chạy bản cũ, chưa lưu được '+key+'. Hãy khởi động lại server.');
    }
    state.settings=result;
    for(const key of Object.keys(values)) settingsErrors.delete(key);
    settingsStatus(settingsErrors.size ? [...settingsErrors.values()].join(' · ') : 'Đã lưu cài đặt.', settingsErrors.size>0);
    return result;
  });
  settingsQueue=save;
  return save.catch(error=>{
    for(const key of Object.keys(values)) settingsErrors.set(key,error.message);
    settingsStatus(error.message,true);
    throw error;
  });
}
function saveSetting(id) {
  clearTimeout(settingTimers.get(id));
  settingTimers.delete(id);
  return persistSettings({[settingFields[id]]:$(id).value.trim()}).catch(()=>{});
}
for(const id of Object.keys(settingFields)) {
  $(id).addEventListener('input',()=>{
    settingsStatus('Chưa lưu — đang nhập…');
    clearTimeout(settingTimers.get(id));
    settingTimers.set(id,setTimeout(()=>saveSetting(id),700));
  });
  $(id).addEventListener('change',()=>saveSetting(id));
}
$('remember-key').addEventListener('change',()=>{
  persistSettings({remember:$('remember-key').checked,api_key:$('api-key').value.trim()}).catch(()=>{});
});
$('api-key').addEventListener('change',()=>{
  persistSettings({api_key:$('api-key').value.trim(),remember:$('remember-key').checked}).catch(()=>{});
});
$('settings-dialog').addEventListener('close',()=>{
  for(const id of [...settingTimers.keys()]) saveSetting(id);
});

async function showSettings(){
  for(const id of [...settingTimers.keys()]) saveSetting(id);
  await settingsQueue.catch(()=>{});
  const s=state.settings;
  $('processing-mode').value=s.mode||'browser';
  $('canva-url').value=s.canva_url||'https://www.canva.com/design/DAHa8kUkuLo/NKq0irljjr17Cx37SmYEQw/edit';
  $('browser-url').value=s.browser_url||'https://gemini.google.com/u/2/app';
  $('aistudio-origin-url').value=s.aistudio_origin_url||'https://aistudio.google.com/u/2/prompts/new_chat';
  $('aistudio-url').value=s.aistudio_url||'https://aistudio.google.com/u/2/prompts/1wN9BKl3arwh3KcwLRU01EaNeB7JoSw7o';
  $('browser-email').value=s.browser_email||'mongnangthoi@gmail.com';
  modeFields();
  $('api-key').value='';
  $('key-state').textContent=s.key_error||(s.has_key?'Đã có khóa. Để trống nếu giữ khóa hiện tại.':'Chưa cấu hình API key.');
  $('remember-key').checked=s.saved_key;
  $('model').value=s.model;
  $('origin-prompt').value=s.origin_prompt||'A beautiful peaceful natural, square image, 1024 × 1024 px.';
  $('patch-prompt').value=s.patch_prompt;
  $('color-prompt').value=s.color_prompt;
  $('aistudio-color-prompt').value=s.aistudio_color_prompt||'tô màu tranh sau';
  $('data-path').textContent='Thư mục dữ liệu: '+s.data_path;
  $('settings-dialog').showModal();
}

['new-project','empty-import'].forEach(id=>$(id).onclick=showImport);
['settings-button','setup-key'].forEach(id=>$(id).onclick=showSettings);
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;renderPreview();});
document.querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>{
  const action = b.dataset.run;
  let prompt = undefined;
  if (action === 'origin' || action === 'all') {
    prompt = $('step1-prompt')?.value.trim() || state.settings.origin_prompt;
  }
  act('run', { action, prompt });
});
document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=()=>act('approve',{stage:b.dataset.approve}));
$('search').oninput=renderLibrary;
$('folder-button').onclick=()=>act('open-folder');
$('output-folder-button').onclick=()=>act('open-folder',{output:true});
$('delete-button').onclick=async()=>{const p=current();if(!p)return;if(!confirm(`Bạn có chắc chắn muốn xóa tranh "${p.name}" khỏi thư viện không?`))return;try{await api('delete',{id:p.id});selected=null;localStorage.removeItem('selected-project');toast('Đã xóa tranh.');await refresh(true);}catch(e){toast(e.message);}};
$('cleanup-raw-btn').onclick=async()=>{try{const res=await api('cleanup',{mode:'raw'});const mb=(res.freed_bytes/(1024*1024)).toFixed(1);toast(`Đã dọn dẹp ${res.cleaned_items} file thô (giải phóng ~${mb} MB).`);await refresh(true);}catch(e){toast(e.message);}};
$('cleanup-all-btn').onclick=async()=>{if(!confirm('CẢNH BÁO: Bạn có chắc chắn muốn xóa TẤT CẢ tranh trong thư viện không?'))return;try{const res=await api('cleanup',{mode:'all'});selected=null;localStorage.removeItem('selected-project');$('settings-dialog').close();toast(`Đã dọn dẹp sạch toàn bộ thư viện (${res.cleaned_items} tranh).`);await refresh(true);}catch(e){toast(e.message);}};
$('processing-mode').onchange=modeFields;

function updateLoopUI() {
  const isLooping = loopState.active;
  ['loop-start-header-btn', 'loop-start-bar-btn'].forEach(id => {
    const el = $(id);
    if (el) {
      el.hidden = isLooping;
      el.disabled = busy(current()) && !isLooping;
    }
  });
  ['loop-stop-header-btn', 'loop-stop-bar-btn'].forEach(id => {
    const el = $(id);
    if (el) {
      el.hidden = !isLooping;
      if (isLooping) {
        el.textContent = `🛑 Dừng lặp (${loopState.current}/${loopState.total})`;
      }
    }
  });
  const countInput = $('loop-count-input');
  if (countInput) countInput.disabled = isLooping;

  if (isLooping) {
    const p = current();
    const job = p ? state.jobs[p.id] : null;
    const msg = job ? jobMessage(p.id, job) : 'Đang chuẩn bị…';
    $('job-status').hidden = false;
    $('job-status').textContent = `[Bộ ${loopState.current}/${loopState.total}] ${msg}`;
    $('job-status').className = 'running';
  }
}

async function startLoop() {
  if (loopState.active) return;
  const countInput = $('loop-count-input');
  const count = parseInt(countInput?.value || '10', 10);
  if (isNaN(count) || count < 1) {
    toast('Hãy nhập số lần lặp hợp lệ (tối thiểu 1 lần).');
    return;
  }
  const total = Math.min(count, 100);

  const browserMode = state.settings.mode !== 'api';
  const aiReady = browserMode ? state.browser?.connected : state.settings.has_key;
  if (!aiReady) {
    const bName = state.browser?.browser === 'coccoc' ? 'Cốc Cốc' : 'trình duyệt (Cốc Cốc/Chrome)';
    toast(browserMode ? `Chưa kết nối ${bName}. Hãy giữ tab Studio mở trên ${bName} có cài tiện ích.` : 'Chưa cấu hình Gemini API key.');
    return;
  }

  const prompt = $('step1-prompt')?.value.trim() || state.settings.origin_prompt;
  const currentProj = current();
  const baseName = (currentProj?.name || 'level').replace(/_\d{2,}(_\d+)?$/, '').replace(/_\d+$/, '') || 'level';

  loopState = {
    active: true,
    total: total,
    current: 1,
    baseName: baseName,
    stopRequested: false,
    timer: null,
    prompt: prompt,
    lastFinishedPid: null,
    isRecovering: false
  };

  updateLoopUI();
  toast(`Bắt đầu chế độ lặp: Sẽ tự động tạo ${total} bộ tranh liên tục và xuất ra thư mục Output.`);

  if (currentProj && !version(currentProj, 'origin') && state.jobs[currentProj.id]?.status !== 'running') {
    await act('run', { action: 'all', prompt });
  } else {
    const ts = Date.now().toString().slice(-4);
    const name = `${baseName}_${String(loopState.current).padStart(2, '0')}_${ts}`;
    try {
      const p = await api('create', { name, image: '', stage: 'origin' });
      selected = p.id;
      tab = 'origin';
      localStorage.setItem('selected-project', selected);
      await refresh(true);
      await act('run', { action: 'all', prompt });
    } catch (e) {
      toast('Lỗi tạo tranh: ' + e.message);
      stopLoop(false);
    }
  }
}

function stopLoop(success=false) {
  if (!loopState.active && !loopState.timer && !loopState.isRecovering) return;
  const wasActive = loopState.active;
  loopState.active = false;
  loopState.stopRequested = true;
  loopState.isRecovering = false;
  if (loopState.timer) {
    clearTimeout(loopState.timer);
    loopState.timer = null;
  }
  updateLoopUI();
  if (wasActive && !success) {
    toast(`Đã dừng chế độ chạy lặp (tại bộ ${loopState.current}/${loopState.total}).`);
  }
}

async function checkLoopProgress() {
  if (!loopState.active || loopState.stopRequested || loopState.isRecovering || loopState.timer) return;

  const p = current();
  if (!p) return;
  const job = state.jobs[p.id];
  if (!job) return;

  // Khi gặp lỗi hoặc bị dừng ở bất kỳ bước nào:
  // Lấy số vòng lặp còn lại, tự động tạo mới bộ tranh và chạy lại từ Bước 1
  if (job.status === 'error' || job.status === 'cancelled') {
    if (loopState.stopRequested) return;

    const currentIter = loopState.current;
    const total = loopState.total;
    const remaining = total - currentIter + 1;

    loopState.isRecovering = true;
    toast(`⚠️ [Bộ ${currentIter}/${total}] bị dừng do lỗi ở bước: ${jobMessage(p.id, job)}. Tự động dọn dẹp, tạo tranh mới và chạy lại từ đầu sau 4 giây… (Còn lại ${remaining} bộ)`);

    // Hủy bỏ tác vụ treo nếu có trên server/bridge
    await api('cancel-browser', { id: p.id }).catch(() => {});

    loopState.timer = setTimeout(async () => {
      if (!loopState.active || loopState.stopRequested) {
        loopState.isRecovering = false;
        return;
      }
      try {
        const ts = Date.now().toString().slice(-4);
        const retryName = `${loopState.baseName}_${String(currentIter).padStart(2, '0')}_${ts}`;
        toast(`🔄 [Bộ ${currentIter}/${total}] Đang tạo mới "${retryName}" và chạy lại từ đầu (Bước 1 → 5)…`);
        const newProj = await api('create', { name: retryName, image: '', stage: 'origin' });
        selected = newProj.id;
        tab = 'origin';
        localStorage.setItem('selected-project', selected);
        await refresh(true);
        await act('run', { action: 'all', prompt: loopState.prompt });
      } catch (err) {
        toast(`Lỗi khi tạo mới bộ ${currentIter}: ${err.message}. Sẽ thử lại sau 5 giây…`);
      } finally {
        loopState.isRecovering = false;
        loopState.timer = null;
      }
    }, 4000);
    return;
  }

  if (job.status === 'done' && p.exported) {
    if (loopState.lastFinishedPid === p.id) return;
    loopState.lastFinishedPid = p.id;

    if (loopState.current >= loopState.total) {
      const totalDone = loopState.total;
      stopLoop(true);
      toast(`🎉 ĐÃ HOÀN TẤT TOÀN BỘ ${totalDone} BỘ TRANH! Đã xuất đủ 5 ảnh mỗi bộ ra thư mục Output.`);
      return;
    }

    const nextIter = loopState.current + 1;
    toast(`Bộ ${loopState.current}/${loopState.total} đã xong! Chuẩn bị tạo tiếp bộ ${nextIter}/${loopState.total} sau 3 giây…`);

    loopState.timer = setTimeout(async () => {
      if (!loopState.active || loopState.stopRequested) return;
      loopState.current = nextIter;
      updateLoopUI();

      try {
        const ts = Date.now().toString().slice(-4);
        const nextName = `${loopState.baseName}_${String(nextIter).padStart(2, '0')}_${ts}`;
        const newProj = await api('create', { name: nextName, image: '', stage: 'origin' });
        selected = newProj.id;
        tab = 'origin';
        localStorage.setItem('selected-project', selected);
        await refresh(true);
        await act('run', { action: 'all', prompt: loopState.prompt });
      } catch (err) {
        toast(`Lỗi khi tạo bộ ${nextIter}: ${err.message}`);
        stopLoop(false);
      } finally {
        loopState.timer = null;
      }
    }, 3000);
  }
}

['stop-job-header-btn','stop-job-bar-btn','cancel-browser'].forEach(id=>{
  const el = $(id);
  if (el) el.onclick = () => { stopLoop(false); act('cancel-browser'); };
});
['loop-start-header-btn', 'loop-start-bar-btn'].forEach(id => {
  const el = $(id);
  if (el) el.onclick = startLoop;
});
['loop-stop-header-btn', 'loop-stop-bar-btn'].forEach(id => {
  const el = $(id);
  if (el) el.onclick = () => stopLoop(false);
});
$('export-button').onclick=()=>act('export');
$('version').onchange=()=>act('select',{stage:tab,version:$('version').value});
$('opacity').oninput=paintOverlay;
$('zoom-button').onclick=()=>{$('zoom-image').src=tab==='overlay'?$('overlay').toDataURL():$('preview').src;$('zoom-dialog').showModal();};

$('import-form').onsubmit=async e=>{
  e.preventDefault();
  const files=[...$('new-files').files];
  const stage=$('new-stage').value;
  $('import-submit').disabled=true;
  try{
    if (!files.length) {
      const name = $('new-name').value.trim() || 'level_' + Date.now();
      const p = await api('create', { name, image: '', stage: 'origin' });
      selected = p.id;
      tab = 'origin';
      localStorage.setItem('selected-project', selected);
      toast('Đã tạo tranh mới. Bạn có thể bấm "Tạo ảnh AI Studio" để sinh tranh màu gốc.');
    } else {
      let imported=0;
      for(const file of files){
        const name=files.length===1&&$('new-name').value.trim()?$('new-name').value.trim():file.name.replace(/\.[^.]+$/,'').replace(/_(colored_origin|line_notpatch|line_pathched|line_final|colored_final)$/i,'');
        const p=await api('create',{name,image:await readFile(file),stage});
        selected=p.id;imported++;
      }
      tab=stage;
      localStorage.setItem('selected-project',selected);
      toast(`Đã nhập ${imported} tranh.`);
    }
    $('import-dialog').close();$('import-form').reset();
  } catch(err){
    toast(err.message);
  } finally {
    $('import-submit').disabled=false;
    await refresh(true);
  }
};

$('settings-form').onsubmit=async e=>{
  e.preventDefault();
  try{
    for(const timer of settingTimers.values()) clearTimeout(timer);
    settingTimers.clear();
    await persistSettings({
      mode:$('processing-mode').value,
      canva_url:$('canva-url').value,
      browser_url:$('browser-url').value,
      aistudio_origin_url:$('aistudio-origin-url').value,
      aistudio_url:$('aistudio-url').value,
      browser_email:$('browser-email').value,
      api_key:$('api-key').value,
      remember:$('remember-key').checked,
      model:$('model').value,
      origin_prompt:$('origin-prompt').value,
      patch_prompt:$('patch-prompt').value,
      color_prompt:$('color-prompt').value,
      aistudio_color_prompt:$('aistudio-color-prompt').value
    });
    $('api-key').value='';
    $('settings-dialog').close();
    toast('Đã lưu cài đặt.');
    await refresh(true);
  }catch(err){settingsStatus(err.message,true);}
};

$('forget-key').onclick=async()=>{try{await api('settings',{forget_key:true});await refresh(true);showSettings();toast('Đã quên API key.');}catch(e){toast(e.message);}};
$('import-result').onclick=()=>{$('result-file').value='';$('result-file').dataset.stage=tab;$('result-file').dataset.project=selected;$('result-file').click();};
$('result-file').onchange=async()=>{
  const file=$('result-file').files[0];
  if(!file)return;
  try{
    await api('import',{id:$('result-file').dataset.project,stage:$('result-file').dataset.stage,image:await readFile(file)});
    toast('Đã nhập phiên bản mới.');
    await refresh(true);
  }catch(e){toast(e.message);}
};

refresh();
setInterval(()=>refresh(),1500);
