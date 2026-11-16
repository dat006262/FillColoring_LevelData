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

from PIL import Image, ImageDraw
from core import Store, WorkflowError, Gemini, png_bytes, transparent_line, protect_secret, PATCH_PROMPT, validate_artwork, white_rgb, ORIGIN_PROMPT, LEGACY_ORIGIN_PROMPT
from server import make_server


EXAMPLE = Path(__file__).resolve().parents[2] / 'example'


def artwork(stage='patch', size=(32, 32)):
    image = Image.new('RGBA', size, 'white')
    draw = ImageDraw.Draw(image)
    w, h = size
    draw.rectangle((w//4, h//4, 3*w//4, 3*h//4),
                   fill='orange' if stage == 'color' else 'white', outline='black', width=2)
    return image



class FakeGemini:
    def __init__(self, fail=False, size=None):
        self.calls = 0
        self.fail = fail
        self.size = size

    def generate(self, key, model, prompt, image):
        self.calls += 1
        if self.fail:
            raise WorkflowError('Lỗi API thử nghiệm')
        size = self.size or (image.size if image else (1024, 1024))
        is_color = ('output requirement' in prompt.lower() or not image or 'tô màu' in prompt.lower() or 'color' in prompt.lower())
        return png_bytes(artwork('color' if is_color else 'patch', size)), {'model': 'fake'}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.client = FakeGemini()
        self.store = Store(self.temp.name, self.client)
        self.store.config['mode'] = 'api'
        self.store.key = 'test-secret'
        self.raw = png_bytes(artwork())
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
        self.store.import_version(self.pid, 'color', png_bytes(artwork('color')))
        self.store.approve(self.pid, 'color')
        self.store.export(self.pid)
        with self.assertRaises(WorkflowError): self.store.run(self.pid, 'color')
        self.assertEqual(self.client.calls, 0)


    def test_run_all_five_steps_pipeline(self):
        from core import SUFFIX
        p = self.store.create('test_auto_all', '', 'origin')
        self.store.run(p['id'], 'all')
        deadline = time.monotonic() + 10
        while p['id'] in self.store.jobs and self.store.jobs[p['id']]['status'] == 'running':
            time.sleep(0.05)
            if time.monotonic() > deadline:
                break
        res = self.store.jobs[p['id']]
        self.assertEqual(res['status'], 'done')
        project = self.store.load(p['id'])
        for stage in ('origin', 'source', 'patch', 'color', 'transparent'):
            self.assertTrue(project['selected'].get(stage), f"Missing selected {stage}")
        # Verify all 5 files in output_dir
        for stage, suffix in SUFFIX.items():
            expected_file = self.store.output_dir / f"test_auto_all_{suffix}.png"
            self.assertTrue(expected_file.exists(), f"File {expected_file} was not exported")

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

    def test_rejects_blank_results_preserves_previous_version_and_raw(self):
        self.prepare()
        before = self.store.load(self.pid)
        for fill in ('white', 'black', (0, 0, 0, 0)):
            with patch.object(self.client, 'generate', return_value=(
                    png_bytes(Image.new('RGBA', (32, 32), fill)), {})):
                self.store.run(self.pid, 'patch')
                self.assertEqual(self.wait()['status'], 'error')
                after = self.store.load(self.pid)
                self.assertEqual(after['selected'], before['selected'])
                self.assertEqual(after['approved'], before['approved'])
        self.assertEqual(len(list((self.store.directory(self.pid) / 'raw').glob('*.png'))), 4)

    def test_color_rejects_line_and_export_rechecks_old_files(self):
        self.prepare()
        with self.assertRaises(WorkflowError):
            self.store.import_version(self.pid, 'color', self.raw)
        self.run_stage('finish')
        self.store.approve(self.pid, 'color')
        p = self.store.load(self.pid)
        record = self.store.version(p, 'color')
        Image.new('RGB', (32, 32), 'white').save(self.store.directory(self.pid) / record['file'])
        with self.assertRaises(WorkflowError): self.store.export(self.pid)
        self.assertFalse(self.store.output_dir.exists())

    def test_examples_and_transparency_composite(self):
        for stage, filename in [('origin','picture_colored_origin.jpg'),
                                ('source','picture_line_notpatch.png'),
                                ('patch','picture_line_pathched.png'),
                                ('color','picture_colored_final.png'),
                                ('transparent','picture_line_final.png')]:
            with Image.open(EXAMPLE / filename) as image:
                validate_artwork(image, stage)
        with Image.open(EXAMPLE / 'picture_line_pathched.png') as image:
            result = transparent_line(image)
            validate_artwork(result, 'transparent')
            self.assertEqual(white_rgb(result).convert('L').tobytes(), white_rgb(image).convert('L').tobytes())

    def test_full_resolution_example_export(self):
        p = self.store.create('example-check', (EXAMPLE / 'picture_colored_origin.jpg').read_bytes(), 'origin')
        pid = p['id']
        self.store.import_version(pid, 'source', (EXAMPLE / 'picture_line_notpatch.png').read_bytes())
        self.store.import_version(pid, 'patch', (EXAMPLE / 'picture_line_pathched.png').read_bytes())
        self.store.approve(pid, 'patch')
        self.store.import_version(pid, 'color', (EXAMPLE / 'picture_colored_final.png').read_bytes())
        self.store.approve(pid, 'color')
        self.store.jobs[pid] = {'status': 'running'}
        self.store._worker(pid, 'transparent', '', self.store.config.copy())
        self.assertEqual(self.store.jobs[pid]['status'], 'done')
        self.store.export(pid)
        self.assertEqual(len(list(self.store.output_dir.glob('*.png'))), 5)
        for stage in ('color', 'transparent'):
            p = self.store.load(pid)
            record = self.store.version(p, stage)
            self.assertEqual((record['width'], record['height']), (1024, 1024))
            validate_artwork(self.store.image(p, record), stage)

    def test_origin_only_text_and_exact_square_output(self):
        # Even when this project already contains a source image, origin has no input.
        self.store.config['mode'] = 'browser'
        self.store.browser.status = lambda: {'connected': True}
        with patch.object(self.store.browser, 'generate', return_value=(
                png_bytes(artwork('color', (512,512))), {})) as generate:
            self.run_stage('origin')
            args = generate.call_args.args
            self.assertEqual(args[1], 'origin')
            self.assertEqual(args[4], b'')
            self.assertIn('1024 x 1024', args[3])
        p = self.store.load(self.pid)
        record = self.store.version(p, 'origin')
        self.assertEqual((record['width'], record['height']), (1024,1024))
        self.assertEqual(record['metadata']['original_size'], [512,512])
        self.assertIsNone(record['parent'])
        with patch.object(self.store.browser, 'generate', return_value=(
                png_bytes(artwork('color', (512,256))), {})):
            self.store.run(self.pid, 'origin')
            self.assertEqual(self.wait()['status'], 'error')
        self.assertEqual(self.store.load(self.pid)['selected']['origin'], record['id'])

    def test_old_default_migrates_but_custom_prompt_survives(self):
        path = Path(self.temp.name) / 'settings.json'
        path.write_text(json.dumps({'origin_prompt': LEGACY_ORIGIN_PROMPT}), encoding='utf-8')
        self.assertEqual(Store(self.temp.name).settings()['origin_prompt'], ORIGIN_PROMPT)
        path.write_text(json.dumps({'origin_prompt': 'A kitten'}), encoding='utf-8')
        self.assertEqual(Store(self.temp.name).settings()['origin_prompt'], 'A kitten')

    def test_separate_aistudio_urls_persist_and_route(self):
        origin = 'https://aistudio.google.com/u/1/prompts/origin-chat'
        color = 'https://aistudio.google.com/u/2/prompts/color-chat'
        self.store.save_settings({'aistudio_origin_url': origin, 'aistudio_url': color})
        restored = Store(self.temp.name)
        self.assertEqual(restored.config['aistudio_origin_url'], origin)
        self.assertEqual(restored.config['aistudio_url'], color)
        with self.assertRaises(WorkflowError):
            self.store.save_settings({'aistudio_origin_url': 'https://gemini.google.com/app'})
        self.store.config['mode'] = 'browser'
        self.store.browser.status = lambda: {'connected': True}
        with patch.object(self.store.browser, 'generate', return_value=(png_bytes(artwork('color')), {})) as generate:
            self.run_stage('origin')
            self.assertEqual(generate.call_args.args[5], origin)
            self.assertEqual(generate.call_args.args[4], b'')
            self.store.import_version(self.pid, 'source', self.raw)
            self.store.import_version(self.pid, 'patch', self.raw)
            self.store.approve(self.pid, 'patch')
            self.run_stage('color-aistudio')
            self.assertEqual(generate.call_args.args[5], color)
            self.assertTrue(generate.call_args.args[4])

    def test_source_change_invalidates_downstream(self):
        self.prepare()
        self.run_stage('finish')
        self.store.import_version(self.pid, 'source', self.raw)
        p = self.store.load(self.pid)
        self.assertEqual(set(p['selected']), {'source'})
        self.assertFalse(p['approved'])
        self.assertTrue(p['versions']['color'])

    def test_export_stays_inside_test_directory(self):
        self.prepare()
        self.run_stage('finish')
        self.store.approve(self.pid, 'color')
        self.store.export(self.pid)
        self.assertEqual(self.store.output_dir, Path(self.temp.name) / 'output')
        self.assertEqual(len(list(self.store.output_dir.glob('*.png'))), 4)

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

    def test_origin_api_without_input_image(self):
        response = {'candidates':[{'content':{'parts':[{'inlineData':{
            'data':base64.b64encode(png_bytes(artwork('color'))).decode()}}]}}]}
        with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as mock:
            Gemini().generate('secret','test','create a picture',None)
            parts = json.loads(mock.call_args.args[0].data)['contents'][0]['parts']
            self.assertEqual(parts, [{'text':'create a picture'}])

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
                data=json.dumps({'name':'test','image':base64.b64encode(png_bytes(artwork())).decode()}).encode()
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
