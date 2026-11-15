"""Local image workflow. Immutable versions, explicit review, no automatic API retries."""
from __future__ import annotations

import base64
import copy
import ctypes
import io
import json
import os
import re
import shutil
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from browser_bridge import BrowserBridge, BrowserError, gemini_url

DEFAULT_MODEL = 'gemini-nano-banana-2.1'
ORIGIN_PROMPT = ('A beautiful peaceful natural landscape with mountains, a clear blue lake, green pine trees, '
                 'blooming flowers, cute anime style, clean vector lines, cel shading, bright and vivid colors, '
                 'landscape aspect ratio 3:2 (width:height).')
PATCH_PROMPT = ('Đây là ảnh đường nét đen. Các nét phác thảo khá tốt nhưng một số vùng chưa được bao kín do đường nét bị hở. '
                'Hãy nối hoặc kéo dài các đường nét đó để vá kín nét vẽ.')
COLOR_PROMPT = ('Color this exact repaired line-art coloring page with bright, harmonious flat colors '
                'and clean cel shading. Preserve every black outline, region boundary, object, position '
                'and canvas aspect ratio. Do not redraw or add/remove details. Return the colored image.')
AISTUDIO_COLOR_PROMPT = 'tô màu tranh sau'
CANVA_URL = 'https://www.canva.com/design/DAHa8kUkuLo/NKq0irljjr17Cx37SmYEQw/edit'
GLOBAL_OUTPUT_DIR = Path(r'F:\noichuagit\FillColoring_LevelData\output')

SUFFIX = {
    'origin': 'colored_origin',
    'source': 'line_notpatch',
    'patch': 'line_pathched',
    'color': 'colored_final',
    'transparent': 'line_final',
}


class WorkflowError(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(tmp, path)


def slug(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name).strip(' .')[:90]
    if not name or name in {'.', '..'}:
        raise WorkflowError('Hãy nhập tên tranh hợp lệ.')
    if name.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *[f'COM{i}' for i in range(10)], *[f'LPT{i}' for i in range(10)]}:
        name = '_' + name
    return name


def read_image(raw):
    if len(raw) > 18 * 1024 * 1024:
        raise WorkflowError('Ảnh quá lớn. Chọn ảnh nhỏ hơn 18 MB.')
    try:
        with Image.open(io.BytesIO(raw)) as im:
            if im.width * im.height > 24_000_000:
                raise WorkflowError('Ảnh quá lớn. Tối đa 24 triệu pixel.')
            return ImageOps.exif_transpose(im).convert('RGBA')
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise WorkflowError('Không đọc được ảnh. Hãy dùng PNG, JPEG hoặc WebP hợp lệ.') from exc


def white_rgb(im):
    rgba = im.convert('RGBA')
    bg = Image.new('RGBA', im.size, 'white')
    return Image.alpha_composite(bg, rgba).convert('RGB')


def transparent_line(im):
    # alpha = darkness on white: retains antialiasing and existing transparency,
    # including opaque white *inside* enclosed regions. Intended for monochrome line art.
    gray = ImageOps.grayscale(white_rgb(im))
    alpha = ImageOps.invert(gray)
    result = Image.new('RGBA', im.size, (0, 0, 0, 0))
    result.putalpha(alpha)
    return result


def png_bytes(im):
    out = io.BytesIO()
    im.save(out, format='PNG')
    return out.getvalue()


def protect_secret(value, decrypt=False):
    if os.name != 'nt':
        raise WorkflowError('Lưu khóa được mã hóa chỉ hỗ trợ Windows; hãy dùng khóa trong phiên này.')
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_byte))]

    buf = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    dest = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    fn = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                   ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(dest)):
        raise WorkflowError('Windows không thể mã hóa hoặc mở khóa API.')
    try:
        return ctypes.string_at(dest.pbData, dest.cbData)
    finally:
        kernel.LocalFree(dest.pbData)


class Gemini:
    def generate(self, key, model, prompt, image):
        if not key:
            raise WorkflowError('Chưa có Gemini API key. Mở Cài đặt để nhập khóa.')
        model = model.removeprefix('models/')
        if not re.fullmatch(r'[A-Za-z0-9._-]+', model):
            raise WorkflowError('Tên model không hợp lệ.')
        payload = {'contents': [{'role': 'user', 'parts': [
            {'text': prompt}, {'inlineData': {'mimeType': 'image/png',
            'data': base64.b64encode(png_bytes(white_rgb(image))).decode()}}]}],
            'generationConfig': {'responseModalities': ['TEXT', 'IMAGE']}}
        req = urllib.request.Request(
            f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
            data=json.dumps(payload).encode(),
            headers={'Content-Type': 'application/json', 'x-goog-api-key': key}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=240) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            messages = {400: 'Yêu cầu hoặc model không phù hợp; kiểm tra tên model và quyền tạo ảnh.',
                        401: 'API key không hợp lệ.', 403: 'API key chưa có quyền truy cập hoặc chưa bật thanh toán.',
                        404: 'Không tìm thấy model. Chọn model tạo ảnh khác trong Cài đặt.',
                        429: 'Đã chạm hạn mức API. Kiểm tra quota hoặc thử lại sau.',
                        500: 'Gemini gặp lỗi máy chủ. Bạn có thể thử lại sau.',
                        503: 'Gemini đang quá tải. Bạn có thể thử lại sau.'}
            raise WorkflowError(f'Gemini HTTP {exc.code}: ' + messages.get(exc.code, 'Yêu cầu thất bại.')) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise WorkflowError('Kết nối Gemini bị gián đoạn hoặc quá 240 giây. Không tự gửi lại để tránh tính phí trùng.') from None
        except (ValueError, TypeError):
            raise WorkflowError('Gemini trả về dữ liệu không hợp lệ.') from None
        for candidate in result.get('candidates', []):
            for part in candidate.get('content', {}).get('parts', []):
                if part.get('thought'):
                    continue
                inline = part.get('inlineData') or part.get('inline_data') or {}
                if inline.get('data'):
                    try:
                        raw = base64.b64decode(inline['data'], validate=True)
                        read_image(raw)
                    except (ValueError, WorkflowError):
                        raise WorkflowError('Gemini trả về ảnh không đọc được.') from None
                    return raw, {'model': model, 'usage': result.get('usageMetadata', {})}
        reason = result.get('promptFeedback', {}).get('blockReason')
        if not reason:
            reason = ', '.join(c.get('finishReason', '') for c in result.get('candidates', []))
        raise WorkflowError('Gemini không trả về ảnh (' + str(reason or 'chỉ có văn bản')[:150] + '). Hãy sửa prompt hoặc thử model khác.')


class Store:
    def __init__(self, root, client=None):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.client = client or Gemini()
        self.browser = BrowserBridge()
        self.jobs = {}
        self.config = {'model': DEFAULT_MODEL, 'origin_prompt': ORIGIN_PROMPT,
                       'patch_prompt': PATCH_PROMPT, 'color_prompt': COLOR_PROMPT,
                       'aistudio_color_prompt': AISTUDIO_COLOR_PROMPT,
                       'mode': 'browser', 'browser_url': 'https://gemini.google.com/u/2/app',
                       'aistudio_url': 'https://aistudio.google.com/u/2/prompts/1wN9BKl3arwh3KcwLRU01EaNeB7JoSw7o',
                       'canva_url': CANVA_URL,
                       'browser_email': 'mongnangthoi@gmail.com'}
        self.key = os.environ.get('GEMINI_API_KEY', '')
        config_path = self.root / 'settings.json'
        if config_path.exists():
            self.config.update(json.loads(config_path.read_text(encoding='utf-8')))
        secret = self.root / 'api-key.dpapi'
        self.key_error = ''
        if secret.exists() and not self.key:
            try:
                self.key = protect_secret(secret.read_bytes(), decrypt=True).decode()
            except Exception:
                self.key_error = 'Khóa đã lưu không mở được trên tài khoản Windows này. Hãy nhập lại.'

    def settings(self):
        return {**self.config, 'has_key': bool(self.key), 'saved_key': (self.root / 'api-key.dpapi').exists(),
                'key_error': self.key_error, 'data_path': str(self.root)}

    def save_settings(self, data):
        with self.lock:
            candidate = dict(self.config)
            if 'mode' in data:
                if data['mode'] not in ('browser', 'api'):
                    raise WorkflowError('Chế độ xử lý không hợp lệ.')
                candidate['mode'] = data['mode']
            if 'browser_url' in data:
                try:
                    candidate['browser_url'] = gemini_url(data['browser_url'].strip())
                except (BrowserError, AttributeError) as exc:
                    raise WorkflowError(str(exc)) from None
            if 'aistudio_url' in data:
                val = str(data['aistudio_url']).strip()
                if val:
                    try:
                        candidate['aistudio_url'] = gemini_url(val)
                    except (BrowserError, AttributeError) as exc:
                        raise WorkflowError(str(exc)) from None
                else:
                    candidate['aistudio_url'] = ''
            if 'canva_url' in data:
                val = str(data['canva_url']).strip()
                if val:
                    try:
                        candidate['canva_url'] = gemini_url(val)
                    except (BrowserError, AttributeError) as exc:
                        raise WorkflowError(str(exc)) from None
                else:
                    candidate['canva_url'] = CANVA_URL
            if 'browser_email' in data:
                email = str(data['browser_email']).strip().lower()
                if email and (not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or len(email) > 254):
                    raise WorkflowError('Email Google không hợp lệ.')
                candidate['browser_email'] = email
            for field in ('model', 'origin_prompt', 'patch_prompt', 'color_prompt', 'aistudio_color_prompt'):
                if field in data:
                    value = str(data[field]).strip()
                    if not value or len(value) > 12000:
                        raise WorkflowError('Model và prompt không được để trống hoặc quá dài.')
                    candidate[field] = value
            self.config = candidate
            if data.get('forget_key'):
                self.key = ''
                (self.root / 'api-key.dpapi').unlink(missing_ok=True)
            elif data.get('api_key', '').strip():
                self.key = data['api_key'].strip()
                self.key_error = ''
            if not data.get('forget_key') and data.get('remember') and self.key:
                (self.root / 'api-key.dpapi').write_bytes(protect_secret(self.key.encode()))
            elif 'remember' in data and not data['remember']:
                (self.root / 'api-key.dpapi').unlink(missing_ok=True)
            atomic_json(self.root / 'settings.json', self.config)
            return self.settings()

    def directory(self, pid):
        if not re.fullmatch(r'[a-f0-9]{12}', str(pid)):
            raise WorkflowError('Mã tranh không hợp lệ.')
        return self.root / 'projects' / pid

    def load(self, pid):
        try:
            return json.loads((self.directory(pid) / 'project.json').read_text(encoding='utf-8'))
        except FileNotFoundError:
            raise WorkflowError('Không tìm thấy tranh.') from None

    def save(self, project):
        project['updated_at'] = now()
        atomic_json(self.directory(project['id']) / 'project.json', project)

    def list(self):
        with self.lock:
            result = []
            for path in (self.root / 'projects').glob('*/project.json'):
                try:
                    result.append(json.loads(path.read_text(encoding='utf-8')))
                except (OSError, ValueError):
                    continue
            return sorted(result, key=lambda p: p['updated_at'], reverse=True)

    def add_version(self, project, stage, image, parent=None, metadata=None):
        versions = project['versions'][stage]
        vid = uuid.uuid4().hex[:12]
        file = f'assets/{project["name"]}_{SUFFIX[stage]}_v{len(versions)+1:03d}_{vid}.png'
        path = self.directory(project['id']) / file
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path, format='PNG')
        record = {'id': vid, 'file': file, 'stage': stage, 'number': len(versions)+1,
                  'parent': parent, 'width': image.width, 'height': image.height,
                  'created_at': now(), 'metadata': metadata or {}}
        versions.append(record)
        project['selected'][stage] = vid
        project['exported'] = None
        return record

    def create(self, name, raw=None, stage='source'):
        if stage not in ('origin', 'source', 'patch'):
            raise WorkflowError('Chỉ nhập ảnh màu gốc, line Canva hoặc line đã vá.')
        with self.lock:
            project = {'id': uuid.uuid4().hex[:12], 'name': slug(name), 'created_at': now(),
                       'versions': {k: [] for k in SUFFIX}, 'selected': {}, 'approved': {}, 'exported': None}
            if raw:
                image = read_image(raw)
                if stage == 'origin':
                    self.add_version(project, 'origin', image, metadata={'imported': True})
                elif stage == 'source':
                    self.add_version(project, 'source', image, metadata={'imported': True})
                elif stage == 'patch':
                    self.add_version(project, 'source', image, metadata={'imported': True})
                    self.add_version(project, 'patch', image, project['selected']['source'], {'imported': True})
            self.save(project)
            return project

    def version(self, project, stage, vid=None):
        vid = vid or project['selected'].get(stage)
        for record in project['versions'].get(stage, []):
            if record['id'] == vid:
                return record
        raise WorkflowError('Chưa có ảnh cho bước này.')

    def image(self, project, record):
        return read_image((self.directory(project['id']) / record['file']).read_bytes())

    def ensure_idle(self, pid):
        if self.jobs.get(pid, {}).get('status') == 'running':
            raise WorkflowError('Tranh này đang xử lý. Hãy chờ bước hiện tại hoàn tất.')

    def invalidate(self, project, stage):
        if stage == 'patch':
            project['approved'].pop('patch', None)
            project['approved'].pop('color', None)
            project['selected'].pop('color', None)
            project['selected'].pop('transparent', None)
        elif stage == 'color':
            project['approved'].pop('color', None)
        project['exported'] = None

    def select(self, pid, stage, vid):
        with self.lock:
            self.ensure_idle(pid)
            project = self.load(pid)
            record = self.version(project, stage, vid)
            if stage in ('color', 'transparent') and record['parent'] != project['selected'].get('patch'):
                raise WorkflowError('Ảnh thuộc một phiên bản line khác. Hãy chọn lại line tương ứng trước.')
            if stage not in SUFFIX:
                raise WorkflowError('Không thể chọn phiên bản của bước này.')
            if project['selected'].get(stage) != vid:
                self.invalidate(project, stage)
                project['selected'][stage] = vid
                self.save(project)
            return project

    def approve(self, pid, stage):
        with self.lock:
            self.ensure_idle(pid)
            if stage not in ('patch', 'color'):
                raise WorkflowError('Bước duyệt không hợp lệ.')
            project = self.load(pid)
            record = self.version(project, stage)
            if stage == 'color':
                self.approved_patch(project)
                if record['parent'] != project['selected']['patch']:
                    raise WorkflowError('Ảnh màu không thuộc line hiện tại.')
            project['approved'][stage] = record['id']
            self.save(project)
            return project

    def approved_patch(self, project):
        patch = self.version(project, 'patch')
        if project['approved'].get('patch') != patch['id']:
            raise WorkflowError('Hãy kiểm tra và duyệt ảnh line đã vá trước.')
        return patch

    def import_version(self, pid, stage, raw):
        if stage not in ('origin', 'source', 'patch', 'color'):
            raise WorkflowError('Chỉ hỗ trợ nhập ảnh màu gốc, line Canva, line đã vá hoặc ảnh màu.')
        image = read_image(raw)
        with self.lock:
            self.ensure_idle(pid)
            project = self.load(pid)
            parent = None
            if stage == 'patch':
                parent = self.version(project, 'source')
            elif stage == 'color':
                parent = self.approved_patch(project)
            elif stage == 'source' and project.get('selected', {}).get('origin'):
                try:
                    parent = self.version(project, 'origin')
                except Exception:
                    parent = None
            self.invalidate(project, stage)
            self.add_version(project, stage, image, parent['id'] if parent else None, {'imported': True})
            self.save(project)
            return project

    def run(self, pid, action, prompt=None):
        with self.lock:
            self.ensure_idle(pid)
            allowed_actions = ('origin', 'canva-line', 'patch', 'color', 'color-gemini', 'color-aistudio', 'transparent', 'finish')
            if action not in allowed_actions:
                raise WorkflowError('Thao tác không hợp lệ.')
            project = self.load(pid)
            if action in ('color', 'color-gemini', 'color-aistudio', 'transparent', 'finish'):
                self.approved_patch(project)
            elif action == 'canva-line':
                if not project['selected'].get('origin'):
                    raise WorkflowError('Chưa có ảnh màu gốc để tạo nét Canva. Hãy chạy bước 1 hoặc tải ảnh màu lên trước.')
            elif action == 'patch':
                if not project['selected'].get('source'):
                    raise WorkflowError('Chưa có ảnh nét cơ bản để vá. Hãy chạy bước 2 hoặc tải ảnh nét lên trước.')
            if action != 'transparent':
                if self.config['mode'] == 'api' and not self.key:
                    raise WorkflowError('Mở Cài đặt và nhập Gemini API key để chạy bước AI.')
                if self.config['mode'] == 'browser' and not self.browser.status()['connected']:
                    raise WorkflowError('Chưa kết nối tiện ích Chrome. Mở Hướng dẫn kết nối trong Cài đặt.')
            settings = copy.deepcopy(self.config)
            if prompt and isinstance(prompt, str) and prompt.strip():
                p_text = prompt.strip()
                if action == 'origin':
                    settings['origin_prompt'] = p_text
                elif action == 'patch':
                    settings['patch_prompt'] = p_text
                elif action in ('color', 'color-gemini'):
                    settings['color_prompt'] = p_text
                elif action == 'color-aistudio':
                    settings['aistudio_color_prompt'] = p_text
            key = self.key
            self.jobs[pid] = {'status': 'running', 'step': action, 'message': 'Đang chuẩn bị…', 'started_at': now()}
            thread = threading.Thread(target=self._worker, args=(pid, action, key, settings), daemon=True)
            thread.start()
            return dict(self.jobs[pid])

    def _worker(self, pid, action, key, config):
        try:
            steps = ['transparent', 'color-aistudio'] if action == 'finish' else [action]
            for act in steps:
                if act == 'origin':
                    stage = 'origin'
                elif act == 'canva-line':
                    stage = 'source'
                elif act == 'patch':
                    stage = 'patch'
                elif act == 'transparent':
                    stage = 'transparent'
                else:
                    stage = 'color'

                with self.lock:
                    msg = {
                        'origin': 'Google AI Studio đang tạo tranh màu gốc…',
                        'canva-line': 'Canva đang chuyển tranh sang nét đen…',
                        'patch': 'Gemini đang vá nét…',
                        'color-aistudio': 'AI Studio đang tô màu…',
                        'color-gemini': 'Gemini đang tô màu…',
                        'color': 'AI Studio đang tô màu…' if config.get('aistudio_url') else 'Gemini đang tô màu…',
                        'transparent': 'Đang xóa nền trên máy…'
                    }.get(act, 'Đang xử lý…')
                    self.jobs[pid].update(step=stage, message=msg)
                    project = self.load(pid)
                    if act == 'origin':
                        parent = None
                        source = None
                    elif act == 'canva-line':
                        parent = self.version(project, 'origin')
                        source = self.image(project, parent)
                    elif act == 'patch':
                        parent = self.version(project, 'source')
                        source = self.image(project, parent)
                    else:
                        parent = self.approved_patch(project)
                        source = self.image(project, parent)

                metadata = {'processor': 'local-darkness-alpha'}
                if stage == 'transparent':
                    image = transparent_line(source)
                else:
                    if act == 'origin':
                        prompt = config.get('origin_prompt', ORIGIN_PROMPT)
                        target_url = config.get('aistudio_url') or 'https://aistudio.google.com'
                    elif act == 'canva-line':
                        prompt = ''
                        target_url = config.get('canva_url', CANVA_URL)
                    elif stage == 'patch':
                        prompt = config.get('patch_prompt', PATCH_PROMPT)
                        target_url = config.get('browser_url', 'https://gemini.google.com/app')
                    elif act == 'color-gemini':
                        prompt = config.get('color_prompt', COLOR_PROMPT)
                        target_url = config.get('browser_url', 'https://gemini.google.com/app')
                    else:  # color-aistudio or color
                        prompt = config.get('aistudio_color_prompt', AISTUDIO_COLOR_PROMPT)
                        target_url = config.get('aistudio_url') or config.get('browser_url', 'https://gemini.google.com/app')

                    if config['mode'] == 'browser':
                        def progress(message):
                            with self.lock:
                                self.jobs[pid]['message'] = message
                        in_bytes = png_bytes(white_rgb(source)) if source else b''
                        raw, metadata = self.browser.generate(
                            pid, stage, project['name'], prompt, in_bytes,
                            target_url, config['browser_email'], progress)
                    else:
                        if act == 'canva-line':
                            raise WorkflowError('Canva chỉ chạy qua tiện ích Chrome (chế độ browser).')
                        raw, metadata = self.client.generate(key, config['model'], prompt, source)

                    raw_rel = f'raw/{stage}_{uuid.uuid4().hex}.png'
                    raw_path = self.directory(pid) / raw_rel
                    raw_path.parent.mkdir(exist_ok=True)
                    image = read_image(raw)
                    image.save(raw_path, format='PNG')
                    metadata.update(prompt=prompt, raw_file=raw_rel, original_size=list(image.size))
                    if source and image.size != source.size:
                        ratio_error = abs((image.width / image.height) / (source.width / source.height) - 1)
                        if ratio_error > .01:
                            raise WorkflowError(f'AI đổi tỷ lệ ảnh. Ảnh trả về được giữ tại {raw_rel}. Hãy thử lại với prompt giữ tỷ lệ.')
                        image = image.resize(source.size, Image.Resampling.LANCZOS)
                        metadata['resized_to_input'] = True
                with self.lock:
                    project = self.load(pid)
                    self.invalidate(project, stage)
                    self.add_version(project, stage, image, parent['id'] if parent else None, metadata)
                    self.save(project)
            with self.lock:
                self.jobs[pid].update(status='done', message='Xử lý xong. Hãy xem và duyệt kết quả.', finished_at=now())
        except Exception as exc:
            message = str(exc) if isinstance(exc, (WorkflowError, BrowserError)) else 'Xử lý thất bại. Kiểm tra file đầu vào và quyền ghi thư mục dữ liệu.'
            with self.lock:
                self.jobs[pid].update(status='error', message=message, finished_at=now())
                atomic_json(self.directory(pid) / 'last-error.json', self.jobs[pid])

    def export(self, pid):
        with self.lock:
            self.ensure_idle(pid)
            project = self.load(pid)
            patch = self.approved_patch(project)
            color = self.version(project, 'color')
            line = self.version(project, 'transparent')
            if project['approved'].get('color') != color['id']:
                raise WorkflowError('Hãy duyệt ảnh màu trước khi xuất bộ ảnh.')
            if color['parent'] != patch['id'] or line['parent'] != patch['id']:
                raise WorkflowError('Ảnh màu và ảnh line phải cùng một phiên bản line đã vá.')
            if (color['width'], color['height']) != (line['width'], line['height']):
                raise WorkflowError('Kích thước hai ảnh cuối không khớp.')
            export_id = datetime.now().strftime('%Y%m%d_%H%M%S') + '_' + uuid.uuid4().hex[:6]
            relative = f'exports/{export_id}'
            directory = self.directory(pid) / relative
            directory.mkdir(parents=True)
            for record in (color, line):
                (directory / f'{project["name"]}_{SUFFIX[record["stage"]]}.png').write_bytes(
                    (self.directory(pid) / record['file']).read_bytes())
            atomic_json(directory / 'manifest.json', {'name': project['name'], 'exported_at': now(),
                        'patch': patch['id'], 'color': color['id'], 'line': line['id'],
                        'width': line['width'], 'height': line['height']})

            # Export directly to global output directory F:\noichuagit\FillColoring_LevelData\output
            global_out = GLOBAL_OUTPUT_DIR
            global_out.mkdir(parents=True, exist_ok=True)
            for record in (color, line):
                (global_out / f'{project["name"]}_{SUFFIX[record["stage"]]}.png').write_bytes(
                    (self.directory(pid) / record['file']).read_bytes())
            for stage_name in ('origin', 'source', 'patch'):
                if project['selected'].get(stage_name):
                    try:
                        rec = self.version(project, stage_name)
                        (global_out / f'{project["name"]}_{SUFFIX[stage_name]}.png').write_bytes(
                            (self.directory(pid) / rec['file']).read_bytes())
                    except Exception:
                        pass
            project['exported'] = relative
            self.save(project)
            return project

    def delete(self, pid):
        with self.lock:
            self.ensure_idle(pid)
            pdir = self.directory(pid)
            if pdir.exists():
                shutil.rmtree(pdir, ignore_errors=True)
            self.jobs.pop(pid, None)
            return {'deleted': True, 'id': pid}

    def cleanup(self, pid=None, mode='raw'):
        with self.lock:
            freed_bytes = 0
            count = 0
            projects_dir = self.root / 'projects'
            targets = [self.directory(pid)] if (pid and re.fullmatch(r'[a-f0-9]{12}', str(pid))) else list(projects_dir.glob('*'))
            for pdir in targets:
                if not pdir.is_dir():
                    continue
                if mode == 'all':
                    shutil.rmtree(pdir, ignore_errors=True)
                    count += 1
                elif mode == 'raw':
                    raw_dir = pdir / 'raw'
                    if raw_dir.exists():
                        for f in list(raw_dir.glob('*')):
                            if f.is_file():
                                try:
                                    freed_bytes += f.stat().st_size
                                    f.unlink(missing_ok=True)
                                    count += 1
                                except Exception:
                                    pass
            if mode == 'all':
                self.jobs.clear()
            return {'mode': mode, 'cleaned_items': count, 'freed_bytes': freed_bytes}
