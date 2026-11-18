import base64
import io
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock

from PIL import Image
from browser_bridge import BrowserBridge, BrowserError, gemini_url, origin_url
from core import Store, png_bytes
from server import make_server
from test_workflow import artwork


AGENT = 'chrome-test-agent-0001'


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = BrowserBridge(timeout=3)
        self.bridge.poll(AGENT)
        self.raw = png_bytes(Image.new('RGB', (16,16), 'white'))
        self.results = []
        self.errors = []

    def start(self, pid='project'):
        def call():
            try:
                self.results.append(self.bridge.generate(pid,'patch','picture','test prompt',self.raw,
                    'https://gemini.google.com/u/2/app','test@example.com',lambda message:None))
            except BrowserError as exc:
                self.errors.append(str(exc))
        thread = threading.Thread(target=call)
        thread.start()
        for _ in range(100):
            if self.bridge.status()['pending']:
                break
            time.sleep(.01)
        return thread

    def test_roundtrip_single_claim_and_lease(self):
        thread = self.start()
        task = self.bridge.poll(AGENT)
        self.assertEqual(base64.b64decode(task['image']), self.raw)
        self.assertIsNone(self.bridge.poll(AGENT))
        with self.assertRaises(BrowserError):
            self.bridge.report(task['id'],'wrong',AGENT,image=base64.b64encode(self.raw).decode())
        with self.assertRaises(BrowserError):
            self.bridge.payload(task['id'],task['lease'],'other-agent-0001')
        self.assertEqual(self.bridge.payload(task['id'],task['lease'],AGENT)['id'],task['id'])
        self.bridge.report(task['id'],task['lease'],AGENT,image=base64.b64encode(self.raw).decode(),page_url='https://gemini.google.com/u/2/app/chat123')
        thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertFalse(self.errors)
        self.assertEqual(self.results[0][0],self.raw)
        self.assertFalse(self.results[0][1]['api_used'])
        self.assertEqual(self.bridge.status()['pending'],0)
        with self.assertRaises(BrowserError):
            self.bridge.report(task['id'],task['lease'],AGENT,image=base64.b64encode(self.raw).decode())

    def test_cancellation_wakes_waiter_and_rejects_late_result(self):
        thread = self.start()
        task = self.bridge.poll(AGENT)
        self.assertTrue(self.bridge.cancel('project'))
        thread.join(4)
        self.assertIn('hủy',self.errors[0])
        self.assertFalse(self.results)
        with self.assertRaises(BrowserError):
            self.bridge.payload(task['id'],task['lease'],AGENT)

    def test_disconnected_request_waits_and_recovers(self):
        self.bridge.last_seen = time.monotonic()-100
        thread = self.start()
        try:
            time.sleep(.6)
            self.assertTrue(thread.is_alive())
            self.assertFalse(self.errors)
            task = self.bridge.poll(AGENT)
            self.assertIsNotNone(task)
            self.bridge.report(task['id'], task['lease'], AGENT,
                              image=base64.b64encode(self.raw).decode())
            thread.join(4)
            self.assertEqual(self.results[0][0], self.raw)
        finally:
            self.bridge.cancel('project')
            thread.join(4)

    def test_background_alarm_gap_keeps_connection(self):
        self.bridge.last_seen = time.monotonic() - 65
        self.assertTrue(self.bridge.status()['connected'])
        self.assertFalse(BrowserBridge().status()['connected'])

    def test_reconnect_does_not_reissue_claimed_task(self):
        thread = self.start()
        try:
            task = self.bridge.poll(AGENT)
            self.bridge.last_seen = time.monotonic() - 100
            self.assertFalse(self.bridge.status()['connected'])
            self.assertIsNone(self.bridge.poll(AGENT))
            self.assertEqual(self.bridge.payload(task['id'], task['lease'], AGENT)['id'], task['id'])
        finally:
            self.bridge.cancel('project')
            thread.join(4)

    def test_coccoc_takeover_from_idle_chrome(self):
        bridge = BrowserBridge(timeout=3)
        chrome_agent = 'chrome-agent-9999'
        coccoc_agent = 'coccoc-agent-8888'
        bridge.poll(chrome_agent, browser='chrome', has_studio=False)
        self.assertEqual(bridge.status()['browser'], 'chrome')
        # Cốc Cốc with open studio tab takes over immediately
        bridge.poll(coccoc_agent, browser='coccoc', has_studio=True)
        self.assertEqual(bridge.status()['browser'], 'coccoc')
        self.assertEqual(bridge.agent, coccoc_agent)
        # Background Chrome cannot steal connection back while Cốc Cốc is active
        with self.assertRaises(BrowserError):
            bridge.poll(chrome_agent, browser='chrome', has_studio=False)

    def test_wrong_site_and_browser_rejected(self):
        with self.assertRaises(BrowserError): self.bridge.poll('another-browser-0001')
        for url in ['http://gemini.google.com/app','https://evil.test/app','https://gemini.google.com.evil.test/app','https://gemini.google.com@evil.test/app','https://gemini.google.com/u/2/app/old-chat']:
            with self.assertRaises(BrowserError): gemini_url(url)
        self.assertEqual(gemini_url('https://aistudio.google.com/u/2/prompts/12345'), 'https://aistudio.google.com/u/2/prompts/12345')
        self.assertIn('canva.com', gemini_url('https://www.canva.com/design/DAHa8kUkuLo/NKq0irljjr17Cx37SmYEQw/edit'))

    def test_origin_uses_empty_payload_and_configured_chat(self):
        def generate():
            self.results.append(self.bridge.generate('p', 'origin', 'new', 'text', self.raw,
                'https://aistudio.google.com/u/2/prompts/saved?foo=bar', '', lambda _: None))
        thread = threading.Thread(target=generate)
        thread.start()
        try:
            for _ in range(100):
                task = self.bridge.poll(AGENT)
                if task: break
                time.sleep(.01)
            self.assertEqual(task['image'], '')
            self.assertEqual(task['url'], 'https://aistudio.google.com/u/2/prompts/saved?foo=bar')
            self.bridge.report(task['id'], task['lease'], AGENT, image=base64.b64encode(self.raw).decode())
        finally:
            self.bridge.cancel('p')
            thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(origin_url('https://aistudio.google.com/prompts/saved'),
                         'https://aistudio.google.com/prompts/saved')

    def test_timeout_does_not_reissue(self):
        self.bridge.timeout=.1
        thread=self.start();task=self.bridge.poll(AGENT);thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertIn('thời gian',self.errors[0])
        self.assertIsNone(self.bridge.poll(AGENT))


class BrowserWorkflowTests(unittest.TestCase):
    def test_browser_without_key_and_never_calls_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            api_client=Mock()
            store=Store(tmp,api_client)
            store.key=''
            self.assertEqual(store.config['mode'],'browser')
            store.browser.poll(AGENT)
            raw=png_bytes(artwork())
            project=store.create('web-test',raw)
            pid=project['id']
            for action in ['patch','color']:
                store.run(pid,action)
                task=None
                for _ in range(100):
                    task=store.browser.poll(AGENT)
                    if task:break
                    time.sleep(.01)
                self.assertIsNotNone(task)
                store.browser.report(task['id'],task['lease'],AGENT,image=base64.b64encode(png_bytes(artwork('color' if action == 'color' else 'patch'))).decode(),page_url='https://gemini.google.com/app/test')
                for _ in range(100):
                    if store.jobs[pid]['status']!='running':break
                    time.sleep(.01)
                self.assertEqual(store.jobs[pid]['status'],'done',store.jobs[pid])
                store.approve(pid,action)
            store.run(pid,'transparent')
            for _ in range(100):
                if store.jobs[pid]['status']!='running':break
                time.sleep(.01)
            self.assertTrue(store.export(pid)['exported'])
            api_client.generate.assert_not_called()

    def test_browser_error_never_falls_back_to_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            api_client=Mock()
            store=Store(tmp,api_client);store.key='present-but-must-not-be-used'
            store.browser.poll(AGENT)
            p=store.create('fail',png_bytes(artwork()))
            store.run(p['id'],'patch')
            for _ in range(100):
                task=store.browser.poll(AGENT)
                if task:break
                time.sleep(.01)
            store.browser.report(task['id'],task['lease'],AGENT,error='Gemini web hết hạn mức')
            for _ in range(100):
                if store.jobs[p['id']]['status']!='running':break
                time.sleep(.01)
            self.assertEqual(store.jobs[p['id']]['status'],'error')
            self.assertFalse(store.load(p['id'])['versions']['patch'])
            api_client.generate.assert_not_called()

    def test_http_extension_scope_and_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            server=make_server(Store(tmp),0)
            t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
            url=f'http://127.0.0.1:{server.server_port}'
            try:
                page=urllib.request.urlopen(url).read().decode()
                token=page.split('name="app-token" content="')[1].split('"')[0]
                headers={'Content-Type':'application/json','X-App-Token':token,'Origin':'chrome-extension://'+'a'*32}
                request=urllib.request.Request(url+'/api/browser/poll',data=json.dumps({'agent':AGENT}).encode(),headers=headers)
                self.assertIsNone(json.load(urllib.request.urlopen(request))['task'])
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(urllib.request.Request(url+'/api/settings',data=b'{"mode":"api"}',headers=headers))
                self.assertEqual(denied.exception.code,403)
                headers['X-App-Token']='wrong'
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(urllib.request.Request(url+'/api/browser/poll',data=b'{}',headers=headers))
                self.assertEqual(denied.exception.code,403)
            finally:server.shutdown();server.server_close();t.join()


if __name__=='__main__':unittest.main()
