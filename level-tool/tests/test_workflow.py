import base64
import io
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from core import Store, WorkflowError, Gemini, png_bytes, transparent_line, protect_secret
from server import make_server


class FakeGemini:
    def __init__(self, fail=False, size=None):
        self.calls = 0
        self.fail = fail
        self.size = size

    def generate(self, key, model, prompt, image):
        self.calls += 1
        if self.fail:
            raise WorkflowError('Lỗi API thử nghiệm')
        return png_bytes(Image.new('RGB', self.size or image.size, 'white')), {'model': 'fake'}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.client = FakeGemini()
        self.store = Store(self.temp.name, self.client)
        self.store.config['mode'] = 'api'
        self.store.key = 'test-secret'
        self.raw = png_bytes(Image.new('RGB', (32, 32), 'white'))
        self.p = self.store.create('tranh mẫu', self.raw)
        self.pid = self.p['id']

    def tearDown(self):
        self.temp.cleanup()

    def wait(self):
        for _ in range(300):
            if self.store.jobs[self.pid]['status'] != 'running':
                return self.store.jobs[self.pid]
            time.sleep(.01)
        self.fail('Worker timeout')

    def run_stage(self, stage):
        self.store.run(self.pid, stage)
        job = self.wait()
        self.assertEqual(job['status'], 'done', job)

    def prepare(self):
        self.run_stage('patch')
        self.store.approve(self.pid, 'patch')

    def test_complete_export_and_restart(self):
        self.prepare()
        self.run_stage('finish')
        with self.assertRaises(WorkflowError):
            self.store.export(self.pid)
        self.store.approve(self.pid, 'color')
        project = self.store.export(self.pid)
        export = self.store.directory(self.pid) / project['exported']
        self.assertEqual(len(list(export.glob('*.png'))), 2)
        with Image.open(export / 'tranh mẫu_line_final.png') as image:
            self.assertEqual(image.mode, 'RGBA')
        restored = Store(self.temp.name).load(self.pid)
        self.assertEqual(restored['approved'], project['approved'])
        another = self.store.export(self.pid)
        self.assertNotEqual(another['exported'], project['exported'])
        self.assertTrue(export.exists())

    def test_approval_gate_and_invalidation(self):
        with self.assertRaises(WorkflowError): self.store.run(self.pid, 'color')
        self.prepare()
        self.run_stage('finish')
        self.store.approve(self.pid, 'color')
        before = self.store.load(self.pid)
        self.run_stage('patch')
        after = self.store.load(self.pid)
        self.assertNotIn('patch', after['approved'])
        self.assertNotIn('color', after['selected'])
        self.assertEqual(len(after['versions']['color']), 1)
        with self.assertRaises(WorkflowError):
            self.store.select(self.pid, 'color', before['selected']['color'])
        self.store.select(self.pid, 'patch', before['selected']['patch'])
        self.store.approve(self.pid, 'patch')
        self.store.select(self.pid, 'color', before['selected']['color'])
        self.assertEqual(self.store.load(self.pid)['selected']['color'], before['selected']['color'])

    def test_local_line_survives_api_failure(self):
        self.prepare()
        self.client.fail = True
        self.store.run(self.pid, 'finish')
        self.assertEqual(self.wait()['status'], 'error')
        project = self.store.load(self.pid)
        self.assertTrue(project['selected']['transparent'])
        self.assertFalse(project['versions']['color'])
        self.assertNotIn('test-secret', (self.store.directory(self.pid) / 'last-error.json').read_text(encoding='utf-8'))

    def test_no_key_local_step_and_import(self):
        self.store.key = ''
        self.store.import_version(self.pid, 'patch', self.raw)
        self.store.approve(self.pid, 'patch')
        self.run_stage('transparent')
        self.store.import_version(self.pid, 'color', self.raw)
        self.store.approve(self.pid, 'color')
        self.store.export(self.pid)
        with self.assertRaises(WorkflowError): self.store.run(self.pid, 'color')
        self.assertEqual(self.client.calls, 0)

    def test_dimensions_normalized_or_rejected_without_losing_raw(self):
        self.client.size = (64, 64)
        self.run_stage('patch')
        v = self.store.version(self.store.load(self.pid), 'patch')
        self.assertEqual(v['width'], 32)
        self.assertTrue(v['metadata']['resized_to_input'])
        self.client.size = (64, 32)
        self.store.run(self.pid, 'patch')
        self.assertEqual(self.wait()['status'], 'error')
        self.assertEqual(len(list((self.store.directory(self.pid) / 'raw').glob('*.png'))), 2)
        self.assertEqual(self.store.load(self.pid)['selected']['patch'], v['id'])

    def test_transparency_keeps_antialias_and_existing_alpha(self):
        image = Image.new('RGBA', (4,1))
        image.putdata([(255,255,255,255),(0,0,0,255),(128,128,128,255),(0,0,0,0)])
        result = transparent_line(image)
        self.assertEqual(list(result.getchannel('A').tobytes()), [0,255,127,0])
        self.assertEqual(transparent_line(result).tobytes(), result.tobytes())

    def test_duplicate_names_and_bad_paths(self):
        p2 = self.store.create('tranh mẫu', self.raw)
        self.assertNotEqual(self.pid, p2['id'])
        with self.assertRaises(WorkflowError): self.store.directory('../escape')
        with self.assertRaises(WorkflowError): self.store.create('..', self.raw)
        with self.assertRaises(WorkflowError): self.store.create('bad', b'not image')

    def test_busy_prevents_parallel_work_and_review(self):
        self.store.jobs[self.pid] = {'status':'running'}
        for call in [lambda:self.store.run(self.pid,'patch'), lambda:self.store.import_version(self.pid,'patch',self.raw), lambda:self.store.approve(self.pid,'patch')]:
            with self.assertRaises(WorkflowError): call()

    def test_settings_never_return_or_store_plaintext_key(self):
        result = self.store.save_settings({'api_key':'new-secret', 'remember':False})
        self.assertNotIn('new-secret', json.dumps(result))
        self.assertNotIn('new-secret', (Path(self.temp.name)/'settings.json').read_text(encoding='utf-8'))
        self.assertEqual(self.store.key, 'new-secret')

    def test_windows_secret_roundtrip(self):
        import os
        if os.name != 'nt': self.skipTest('Windows DPAPI')
        encrypted = protect_secret(b'test-api-key')
        self.assertNotIn(b'test-api-key', encrypted)
        self.assertEqual(protect_secret(encrypted, decrypt=True), b'test-api-key')

    def test_delete_and_cleanup(self):
        raw_dir = self.store.directory(self.pid) / 'raw'
        raw_dir.mkdir(exist_ok=True)
        (raw_dir / 'test_raw.png').write_bytes(b'test_raw_data')
        res = self.store.cleanup(self.pid, mode='raw')
        self.assertEqual(res['cleaned_items'], 1)
        self.assertEqual(res['freed_bytes'], len(b'test_raw_data'))
        self.assertFalse((raw_dir / 'test_raw.png').exists())
        res_del = self.store.delete(self.pid)
        self.assertTrue(res_del['deleted'])
        self.assertFalse(self.store.directory(self.pid).exists())


class APITests(unittest.TestCase):
    def test_gemini_request_and_skip_thought_image(self):
        real = png_bytes(Image.new('RGB',(8,8),'white'))
        thought = png_bytes(Image.new('RGB',(8,8),'black'))
        response={'candidates':[{'content':{'parts':[
            {'thought':True,'inlineData':{'data':base64.b64encode(thought).decode()}},
            {'inlineData':{'data':base64.b64encode(real).decode()}}]}}]}
        captured = []
        def fake(request, timeout):
            captured.append(request)
            return io.BytesIO(json.dumps(response).encode())
        with patch('urllib.request.urlopen', fake):
            raw,_=Gemini().generate('secret','test-image','prompt',Image.new('RGB',(8,8),'white'))
        self.assertEqual(raw, real)
        self.assertNotIn('secret', captured[0].full_url)
        self.assertEqual(json.loads(captured[0].data)['generationConfig']['responseModalities'], ['TEXT','IMAGE'])

    def test_no_image_response_and_no_retry(self):
        response={'candidates':[{'finishReason':'NO_IMAGE','content':{'parts':[{'text':'No image'}]}}]}
        with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as mock:
            with self.assertRaisesRegex(WorkflowError,'NO_IMAGE'):
                Gemini().generate('secret','test','prompt',Image.new('RGB',(8,8)))
            self.assertEqual(mock.call_count,1)
        with patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError('url',429,'bad',{},None)) as mock:
            with self.assertRaisesRegex(WorkflowError,'429'):
                Gemini().generate('secret','test','prompt',Image.new('RGB',(8,8)))
            self.assertEqual(mock.call_count,1)

    def test_local_http_csrf_and_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            server=make_server(Store(tmp),0)
            worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
            url=f'http://127.0.0.1:{server.server_port}'
            try:
                page=urllib.request.urlopen(url).read().decode()
                token=page.split('name="app-token" content="')[1].split('"')[0]
                data=json.dumps({'name':'test','image':base64.b64encode(png_bytes(Image.new('RGB',(8,8)))).decode()}).encode()
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(urllib.request.Request(url+'/api/create',data=data))
                self.assertEqual(caught.exception.code,403)
                req=urllib.request.Request(url+'/api/create',data=data,headers={'X-App-Token':token,'Content-Type':'application/json'})
                result=json.load(urllib.request.urlopen(req))
                self.assertEqual(result['name'],'test')
                req=urllib.request.Request(url+'/api/settings',data=b'{}',headers={'X-App-Token':token,'Origin':'https://evil.invalid'})
                with self.assertRaises(urllib.error.HTTPError) as caught: urllib.request.urlopen(req)
                self.assertEqual(caught.exception.code,403)
            finally:
                server.shutdown();server.server_close();worker.join()


if __name__=='__main__': unittest.main()
