import base64
import json
import struct
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

from catalog import CatalogStore, parse_level_bytes
from core import Store, png_bytes
from level_creator import (
    LevelCreatorManager,
    LevelCreatorSettings,
    generate_level_bytes,
    scan_level_pairs,
)
from server import make_server


def make_donut_pair(size=(160, 160)):
    """Create a colored & transparent-line pair with top/bottom distinct colors and a donut hole."""
    w, h = size
    color = Image.new('RGBA', (w, h), (255, 255, 255, 255))
    cdraw = ImageDraw.Draw(color)
    # Top half red, bottom half blue (in PIL top-down coordinates)
    cdraw.rectangle((0, 0, w - 1, h // 2 - 1), fill=(220, 40, 40, 255))
    cdraw.rectangle((0, h // 2, w - 1, h - 1), fill=(40, 90, 220, 255))
    # Inner box green
    cdraw.rectangle((45, 45, w - 45, h - 45), fill=(40, 180, 70, 255))

    line = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ldraw = ImageDraw.Draw(line)
    ldraw.line((0, h // 2, w - 1, h // 2), fill=(0, 0, 0, 255), width=4)
    ldraw.rectangle((45, 45, w - 45, h - 45), outline=(0, 0, 0, 255), width=4)
    return png_bytes(color), png_bytes(line)


class LevelCreatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / 'data'
        self.output_dir = self.root / 'output'
        self.fc_root = self.root / 'FillColoring'
        (self.fc_root / 'ServerData' / 'Pictures').mkdir(parents=True)
        self.output_dir.mkdir(parents=True)
        self.projects = Store(self.data_dir, output_dir=self.output_dir)
        self.catalog = CatalogStore(
            self.data_dir,
            output_dir=self.output_dir,
            fillcoloring_root=self.fc_root,
            projects_store=self.projects,
        )
        self.creator = LevelCreatorManager(self.data_dir, output_dir=self.output_dir, catalog_store=self.catalog)

    def tearDown(self):
        self.tmp.cleanup()

    def test_generate_level_bytes_parses_and_matches_unity_y_orientation(self):
        c_bytes, l_bytes = make_donut_pair((160, 160))
        res = generate_level_bytes(c_bytes, l_bytes, LevelCreatorSettings(), source_file='donut.png')
        parsed = parse_level_bytes(res['bytes'])
        self.assertEqual(parsed['width'], 160)
        self.assertEqual(parsed['height'], 160)
        self.assertGreaterEqual(parsed['regionCount'], 3)
        self.assertEqual(parsed['colorCount'], 3)

        # Verify bottom-to-top Y orientation: for each region, color at (numX, height-1-numY) in PIL matches palette color
        raw = res['bytes']
        cc = struct.unpack_from('<i', raw, 8)[0]
        off = 12
        colors = [struct.unpack_from('<3i', raw, off + i * 12) for i in range(cc)]
        off += cc * 12
        rc = struct.unpack_from('<i', raw, off)[0]
        off += 4
        with Image.open(__import__('io').BytesIO(c_bytes)) as cim:
            for _ in range(rc):
                cidx, _mx, _my, _rw, _rh, nx, ny, _nsz = struct.unpack_from('<8i', raw, off)
                off += 32
                pc = struct.unpack_from('<i', raw, off)[0]
                off += 4 + pc * 8
                tc = struct.unpack_from('<i', raw, off)[0]
                off += 4 + tc * 4
                if cidx >= 0:
                    pr, pg, pb, _ = cim.getpixel((nx, 159 - ny))
                    self.assertEqual(colors[cidx], (pr, pg, pb))

    def test_black_bg_white_line_and_ignore_white_regions(self):
        im_c = Image.new('RGBA', (100, 100), (255, 255, 255, 255))
        ImageDraw.Draw(im_c).rectangle((25, 25, 75, 75), fill=(255, 100, 50, 255))
        im_l = Image.new('RGBA', (100, 100), (0, 0, 0, 255))
        ImageDraw.Draw(im_l).rectangle((25, 25, 75, 75), outline=(255, 255, 255, 255), width=4)

        cfg = LevelCreatorSettings(ignore_white_regions=True, black_bg_white_line=True)
        res = generate_level_bytes(png_bytes(im_c), png_bytes(im_l), cfg)
        self.assertEqual(res['colorCount'], 1)
        self.assertGreaterEqual(res['regionCount'], 2)

    def test_scan_pairs_and_batch_auto_attach_to_catalog_and_push(self):
        c_bytes, l_bytes = make_donut_pair((120, 120))
        (self.output_dir / 'hero_colored_final.png').write_bytes(c_bytes)
        (self.output_dir / 'hero_line_final.png').write_bytes(l_bytes)
        sub = self.output_dir / 'nested_pack'
        sub.mkdir()
        (sub / 'picture_colored_final.png').write_bytes(c_bytes)
        (sub / 'picture_line_final.png').write_bytes(l_bytes)

        pairs = scan_level_pairs(self.output_dir)
        names = {p['name'] for p in pairs}
        self.assertEqual(names, {'hero', 'nested_pack'})

        # Import 'hero' into Catalog (starts without FileByte)
        self.catalog.import_output_pair(key='hero', tags=['animal'])
        self.assertFalse(self.catalog.state()['library'][0]['hasFileByte'])

        # Run batch LevelCreator -> auto-attaches hero_bytes.bytes to Catalog
        self.creator.start_batch({'autoAttachCatalog': True})
        for _ in range(200):
            st = self.creator.state()
            if st['job']['status'] != 'running':
                break
            time.sleep(0.05)
        job = self.creator.state()['job']
        self.assertEqual(job['status'], 'done', job)
        self.assertEqual(len(job['results']), 2)
        self.assertTrue(self.catalog.state()['library'][0]['hasFileByte'])

        # Now PUSH succeeds for hero_bytes!
        push_res = self.catalog.push_data(push_library=True, push_daily=False, push_explore=False)
        self.assertEqual(push_res['exportedCount'], 1)
        self.assertEqual(push_res['skipped'], [])

    def test_settings_reload_from_disk(self):
        self.creator.save_settings({'lineThreshold': 185, 'ignoreWhiteRegions': True})
        reloaded = LevelCreatorManager(self.data_dir, output_dir=self.output_dir, catalog_store=self.catalog)
        self.assertEqual(reloaded.state()['settings']['lineThreshold'], 185)
        self.assertTrue(reloaded.state()['settings']['ignoreWhiteRegions'])

    def test_http_creator_endpoints(self):
        c_bytes, l_bytes = make_donut_pair((100, 100))
        server = make_server(self.projects, port=0, catalog=self.catalog, creator=self.creator)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            port = server.server_port
            html = urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode('utf-8')
            token = html.split('name="app-token" content="')[1].split('"')[0]

            js = urllib.request.urlopen(f'http://127.0.0.1:{port}/level_creator.js').read()
            self.assertIn(b'Create Level Files', js)

            req = urllib.request.Request(
                f'http://127.0.0.1:{port}/api/creator/start-single',
                data=json.dumps({
                    'colored_data': base64.b64encode(c_bytes).decode(),
                    'line_data': base64.b64encode(l_bytes).decode(),
                    'filename': 'http_test',
                }).encode(),
                headers={'Content-Type': 'application/json', 'X-App-Token': token},
                method='POST',
            )
            urllib.request.urlopen(req).read()
            for _ in range(150):
                st = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/api/creator/state').read())
                if st['job']['status'] != 'running':
                    break
                time.sleep(0.05)
            self.assertEqual(st['job']['status'], 'done', st)
            self.assertEqual(st['job']['results'][0]['fileName'], 'http_test_bytes.bytes')
            self.assertTrue(Path(st['job']['results'][0]['path']).is_file())
        finally:
            server.shutdown()
            server.server_close()
