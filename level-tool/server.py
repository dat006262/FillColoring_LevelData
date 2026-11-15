from __future__ import annotations

import argparse
import hashlib
import base64
import json
import mimetypes
import os
import re
import secrets
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from core import Store, WorkflowError, GLOBAL_OUTPUT_DIR
from browser_bridge import BrowserError

HERE = Path(__file__).resolve().parent
SERVER_REVISION = hashlib.sha256(b''.join((HERE / name).read_bytes() for name in
    ('server.py', 'core.py', 'browser_bridge.py'))).hexdigest()


def make_server(store, port=0):
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, body, status=200, mime='application/json; charset=utf-8'):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def valid_host(self):
            return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

        def do_GET(self):
            if not self.valid_host():
                return self.send({'error': 'Host không hợp lệ.'}, 403)
            path = urllib.parse.urlparse(self.path).path
            try:
                if path == '/api/health':
                    return self.send({'app': 'FillColoring Studio', 'version': 3,
                                      'revision': SERVER_REVISION, 'pid': os.getpid()})
                if path == '/api/state':
                    with store.lock:
                        return self.send({'projects': store.list(), 'jobs': store.jobs, 'settings': store.settings(),
                                          'browser': store.browser.status()})
                if path.startswith('/asset/'):
                    parts = path.split('/')
                    if len(parts) != 4:
                        raise WorkflowError('Đường dẫn ảnh không hợp lệ.')
                    with store.lock:
                        project = store.load(parts[2])
                        records = [r for versions in project['versions'].values() for r in versions]
                        record = next((r for r in records if r['id'] == parts[3]), None)
                        if not record:
                            raise WorkflowError('Không tìm thấy ảnh.')
                        return self.send((store.directory(project['id']) / record['file']).read_bytes(), mime='image/png')
                files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css',
                         '/browser-help': 'browser-help.html'}
                if path not in files:
                    return self.send({'error': 'Không tìm thấy.'}, 404)
                file = HERE / 'web' / files[path]
                body = file.read_bytes()
                if path == '/':
                    body = body.replace(b'__APP_TOKEN__', token.encode())
                self.send(body, mime=mimetypes.guess_type(file.name)[0] + '; charset=utf-8')
            except WorkflowError as exc:
                self.send({'error': str(exc)}, 400)
            except Exception:
                self.send({'error': 'Không đọc được dữ liệu cục bộ.'}, 500)

        def do_POST(self):
            origin = self.headers.get('Origin')
            path = urllib.parse.urlparse(self.path).path
            extension_origin = bool(origin and re.fullmatch(r'chrome-extension://[a-p]{32}', origin))
            if not self.valid_host() or self.headers.get('X-App-Token') != token or (
                origin and origin != f'http://127.0.0.1:{self.server.server_port}'
                and not (extension_origin and path.startswith('/api/browser/'))):
                return self.send({'error': 'Phiên không hợp lệ. Hãy tải lại trang.'}, 403)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length <= 0 or length > 26 * 1024 * 1024:
                    raise WorkflowError('Dữ liệu tải lên quá lớn hoặc trống.')
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise WorkflowError('Yêu cầu không hợp lệ.')
                pid = data.get('id')
                if path == '/api/browser/poll':
                    result = {'task': store.browser.poll(data.get('agent'))}
                elif path == '/api/browser/payload':
                    result = {'task': store.browser.payload(data.get('task_id'), data.get('lease'), data.get('agent'))}
                elif path == '/api/browser/report':
                    result = store.browser.report(data.get('task_id'), data.get('lease'), data.get('agent'),
                        message=data.get('message'), image=data.get('image'), error=data.get('error'), page_url=data.get('page_url'))
                elif path == '/api/cancel-browser':
                    result = {'cancelled': store.browser.cancel(pid)}
                elif path == '/api/settings':
                    result = store.save_settings(data)
                elif path == '/api/create':
                    raw = base64.b64decode(data['image'], validate=True) if data.get('image') else None
                    result = store.create(data['name'], raw, data.get('stage', 'source'))
                elif path == '/api/import':
                    result = store.import_version(pid, data['stage'], base64.b64decode(data['image'], validate=True))
                elif path == '/api/run':
                    result = store.run(pid, data['action'], data.get('prompt'))
                elif path == '/api/approve':
                    result = store.approve(pid, data['stage'])
                elif path == '/api/select':
                    result = store.select(pid, data['stage'], data['version'])
                elif path == '/api/export':
                    result = store.export(pid)
                elif path == '/api/delete':
                    result = store.delete(pid)
                elif path == '/api/cleanup':
                    result = store.cleanup(pid, data.get('mode', 'raw'))
                elif path == '/api/open-folder':
                    if data.get('output'):
                        folder = store.output_dir
                        folder.mkdir(parents=True, exist_ok=True)
                    else:
                        project = store.load(pid)
                        folder = store.directory(pid)
                        if data.get('export') and project.get('exported'):
                            folder = folder / project['exported']
                    os.startfile(str(folder))
                    result = {'ok': True}
                else:
                    return self.send({'error': 'Không tìm thấy.'}, 404)
                self.send(result)
            except (WorkflowError, BrowserError) as exc:
                self.send({'error': str(exc)}, 400)
            except (ValueError, KeyError, TypeError):
                self.send({'error': 'Dữ liệu yêu cầu không hợp lệ.'}, 400)
            except Exception:
                self.send({'error': 'Không thể hoàn tất thao tác. Kiểm tra quyền ghi dữ liệu.'}, 500)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--data', type=Path, default=HERE / 'data')
    parser.add_argument('--output', type=Path, default=GLOBAL_OUTPUT_DIR)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    store = Store(args.data, output_dir=args.output)
    server = make_server(store, args.port)
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'FillColoring Studio: {url}', flush=True)
    if not args.no_browser:
        threading.Timer(.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
