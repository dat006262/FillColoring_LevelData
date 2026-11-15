'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="app-token"]').content;
let state = {projects: [], jobs: {}, settings: {}}, selected = localStorage.getItem('selected-project'), tab = 'source';
let signature = '', polling = false, mutation = false, overlaySerial = 0, overlayImage = null;
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
  const browserMode = state.settings.mode !== 'api';
  const aiReady = browserMode ? state.browser?.connected : state.settings.has_key;
  $('key-notice').hidden = browserMode || state.settings.has_key;
  $('browser-notice').hidden = !browserMode;
  $('browser-status').textContent = state.browser?.connected ? 'Chrome đã kết nối · Gemini & Canva · Không dùng API key' : 'Chưa kết nối Chrome. Cài tiện ích rồi mở trang này trong Chrome đã đăng nhập Google & Canva.';
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
    if (act === 'origin') b.disabled = locked || !aiReady;
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
  if(job){$('job-status').textContent=job.message;$('job-status').className=job.status;}
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

async function act(path, extra={}) {
  if(mutation)return;
  const pid=selected;mutation=true;render();
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

function showSettings(){
  const s=state.settings;
  $('processing-mode').value=s.mode||'browser';
  $('canva-url').value=s.canva_url||'https://www.canva.com/design/DAHa8kUkuLo/NKq0irljjr17Cx37SmYEQw/edit';
  $('browser-url').value=s.browser_url||'https://gemini.google.com/u/2/app';
  $('aistudio-url').value=s.aistudio_url||'https://aistudio.google.com/u/2/prompts/1wN9BKl3arwh3KcwLRU01EaNeB7JoSw7o';
  $('browser-email').value=s.browser_email||'mongnangthoi@gmail.com';
  modeFields();
  $('api-key').value='';
  $('key-state').textContent=s.key_error||(s.has_key?'Đã có khóa. Để trống nếu giữ khóa hiện tại.':'Chưa cấu hình API key.');
  $('remember-key').checked=s.saved_key;
  $('model').value=s.model;
  $('origin-prompt').value=s.origin_prompt||'A cute anime girl, pop-art anime style, clean vector lines, cel shading, bright and vivid colors, compact circular background frame, close-up portrait, square aspect ratio 1:1.';
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
  if (action === 'origin') {
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
$('cancel-browser').onclick=()=>act('cancel-browser');
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
    await api('settings',{
      mode:$('processing-mode').value,
      canva_url:$('canva-url').value,
      browser_url:$('browser-url').value,
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
  }catch(err){toast(err.message);}
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
