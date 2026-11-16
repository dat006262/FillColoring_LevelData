from pathlib import Path
"""One-use leases between the local workflow and the Chrome content-script worker.

No Google credentials or internal Gemini HTTP endpoints are used here.
"""
import base64
import copy
import secrets
import threading
import time
import re
from urllib.parse import urlparse


class BrowserError(Exception):
    pass


def origin_url(value):
    """Validate the independently configured step-1 URL without replacing its chat."""
    checked = gemini_url(value)
    if urlparse(checked).netloc != 'aistudio.google.com':
        raise BrowserError('Bước 1 cần URL Google AI Studio.')
    return checked



def gemini_url(value):
    import re
    url = urlparse(value.strip())
    if url.scheme != 'https':
        raise BrowserError('URL phải bắt đầu bằng https://')
    if url.netloc == 'gemini.google.com':
        if not re.fullmatch(r'/(?:u/\d+/)?app/?', url.path):
            raise BrowserError('Dùng URL Gemini dạng https://gemini.google.com/u/2/app hoặc https://gemini.google.com/app.')
        return 'https://gemini.google.com' + url.path.rstrip('/')
    elif url.netloc == 'aistudio.google.com':
        if not url.path or url.path == '/':
            raise BrowserError('Dùng URL AI Studio dạng https://aistudio.google.com/prompts/... hoặc https://aistudio.google.com/u/2/prompts/...')
        return value.strip()
    elif url.netloc in ('www.canva.com', 'canva.com'):
        if '/design/' not in url.path:
            raise BrowserError('Dùng URL thiết kế Canva dạng https://www.canva.com/design/.../edit')
        return value.strip()
    else:
        raise BrowserError('Dùng URL Gemini (https://gemini.google.com/app), AI Studio (https://aistudio.google.com/prompts/...) hoặc Canva (https://www.canva.com/design/...)')


class BrowserBridge:
    def __init__(self, timeout=900):
        self.lock = threading.RLock()
        self.timeout = timeout
        self.last_seen = 0
        self.agent = None
        self.requests = {}

    def status(self):
        with self.lock:
            return {'connected': time.monotonic() - self.last_seen < 12,
                    'pending': sum(not r['event'].is_set() for r in self.requests.values())}

    def poll(self, agent):
        if not isinstance(agent, str) or len(agent) < 10 or len(agent) > 100:
            raise BrowserError('Mã kết nối Chrome không hợp lệ.')
        with self.lock:
            if self.agent and self.agent != agent and self.status()['connected']:
                raise BrowserError('Một phiên Chrome khác đang kết nối. Đóng trang Studio ở phiên đó trước.')
            self.agent = agent
            self.last_seen = time.monotonic()
            # A claimed operation is never reissued: do not submit duplicate prompts
            # after extension/service-worker reload or a lost response.
            if any(r['claimed'] and not r['event'].is_set() for r in self.requests.values()):
                return None
            for request in self.requests.values():
                if not request['event'].is_set() and not request['claimed']:
                    request['claimed'] = True
                    request['agent'] = agent
                    return copy.deepcopy(request['payload'])
            return None

    def report(self, task_id, lease, agent, message=None, image=None, error=None, page_url=None):
        with self.lock:
            request = self.requests.get(task_id)
            if not request or request['payload']['lease'] != lease or request['agent'] != agent:
                raise BrowserError('Tác vụ trình duyệt không còn hợp lệ.')
            if request['event'].is_set():
                return {'accepted': False, 'cancelled': True}
            self.last_seen = time.monotonic()
            if page_url:
                parsed = urlparse(page_url)
                if parsed.scheme != 'https' or parsed.netloc not in ('gemini.google.com', 'aistudio.google.com', 'www.canva.com', 'canva.com'):
                    raise BrowserError('Kết quả không đến từ Gemini, Google AI Studio hoặc Canva.')
                request['page_url'] = page_url[:1000]
            if image is not None:
                try:
                    raw = base64.b64decode(image, validate=True)
                except (ValueError, TypeError):
                    raise BrowserError('Ảnh từ trình duyệt không hợp lệ.') from None
                if not raw or len(raw) > 18 * 1024 * 1024:
                    raise BrowserError('Ảnh từ trình duyệt trống hoặc vượt 18 MB.')
                request['result'] = raw
                request['event'].set()
            elif error:
                request['error'] = str(error)[:1000]
                request['event'].set()
            if message:
                request['message'] = str(message)[:500]
            return {'accepted': True, 'cancelled': False}

    def payload(self, task_id, lease, agent):
        with self.lock:
            request = self.requests.get(task_id)
            if (not request or request['event'].is_set() or request['payload']['lease'] != lease
                    or request['agent'] != agent):
                raise BrowserError('Tác vụ đã kết thúc hoặc không thuộc phiên Chrome này.')
            return copy.deepcopy(request['payload'])

    def cancel(self, project_id):
        with self.lock:
            found = False
            for request in self.requests.values():
                if request['payload']['project_id'] == project_id and not request['event'].is_set():
                    request['error'] = 'Đã hủy chờ trình duyệt. Nếu prompt đã gửi, AI có thể vẫn xử lý trong tab riêng.'
                    request['event'].set()
                    found = True
            return found

    def generate(self, project_id, stage, name, prompt, png, url, email, progress):
        if stage == 'origin':
            png = b''
            url = origin_url(url)
        with self.lock:
            if not self.status()['connected']:
                raise BrowserError('Chưa kết nối tiện ích Chrome. Mở Studio trong Chrome đã cài tiện ích và giữ tab đó mở.')
            task_id = secrets.token_hex(12)
            request = {'payload': {'id': task_id, 'lease': secrets.token_urlsafe(24),
                                  'project_id': project_id, 'stage': stage,
                                  'filename': f'{name}_{stage}_input.png', 'prompt': prompt,
                                  'image': base64.b64encode(png).decode() if png else '',
                                  'url': gemini_url(url), 'email': email},
                       'event': threading.Event(), 'claimed': False, 'agent': None,
                       'message': 'Đang chờ Chrome nhận ảnh…', 'result': None, 'error': None,
                       'page_url': None}
            self.requests[task_id] = request
        deadline = time.monotonic() + self.timeout
        task_start = time.time()
        downloads_dir = Path.home() / 'Downloads'
        try:
            while not request['event'].wait(.5):
                progress(request['message'])
                if stage == 'source' and 'canva.com' in url and downloads_dir.exists():
                    try:
                        for entry in sorted(downloads_dir.glob('*.png'), key=lambda e: e.stat().st_mtime, reverse=True):
                            if entry.is_file() and entry.stat().st_mtime >= task_start - 2:
                                s1 = entry.stat().st_size
                                if s1 > 5000:
                                    time.sleep(0.3)
                                    if entry.stat().st_size == s1:
                                        raw_bytes = entry.read_bytes()
                                        try:
                                            from core import validate_artwork, read_image
                                            validate_artwork(read_image(raw_bytes), 'source')
                                            request['result'] = raw_bytes
                                            request['page_url'] = url
                                            request['event'].set()
                                            break
                                        except Exception:
                                            continue
                    except Exception:
                        pass
                if time.monotonic() >= deadline:
                    raise BrowserError('Hết thời gian chờ phản hồi AI (15 phút). Xem tab trình duyệt; công cụ không tự gửi lại prompt.')
                # Before claim it is safe to stop if the only bridge page was closed.
                if not request['claimed'] and not self.status()['connected']:
                    raise BrowserError('Mất kết nối Chrome trước khi gửi ảnh. Mở lại tab Studio rồi chạy lại.')
            if request['error']:
                raise BrowserError(request['error'])
            if 'canva.com' in url:
                processor = 'canva-browser'
            elif 'aistudio.google.com' in url:
                processor = 'aistudio-browser'
            else:
                processor = 'gemini-browser'
            return request['result'], {'processor': processor, 'page_url': request['page_url'],
                                       'account': email, 'api_used': False}
        finally:
            with self.lock:
                request['event'].set()
                self.requests.pop(task_id, None)
