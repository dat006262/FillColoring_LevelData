import base64
import io
import json
import struct
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

from catalog import (
    APP_VERSION,
    CatalogStore,
    encode_thumbnail_jpg,
    parse_level_bytes,
    sanitize_picture_id,
)
from core import Store, WorkflowError, png_bytes
from server import make_server


def make_colored_png(size=(600, 800)):
    im = Image.new('RGBA', size, (255, 240, 220, 255))
    draw = ImageDraw.Draw(im)
    draw.rectangle((80, 100, size[0] - 80, size[1] - 100), fill=(90, 180, 120, 255), outline=(20, 20, 20, 255), width=6)
    return png_bytes(im)


def make_transparent_line_png(size=(600, 800)):
    im = Image.new('RGBA', size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    draw.rectangle((80, 100, size[0] - 80, size[1] - 100), outline=(0, 0, 0, 255), width=6)
    return png_bytes(im)


def make_valid_level_bytes(width=600, height=800, region_count=3):
    buf = bytearray()
    buf += struct.pack('<iii', width, height, 2)
    buf += struct.pack('<3i', 255, 0, 0)
    buf += struct.pack('<3i', 0, 255, 0)
    buf += struct.pack('<i', region_count)
    for i in range(region_count):
        buf += struct.pack('<8i', i % 2, 10, 10, 50, 50, 25, 25, 12)
        buf += struct.pack('<i', 3)
        buf += struct.pack('<6f', 10.0, 10.0, 60.0, 10.0, 60.0, 60.0)
        buf += struct.pack('<4i', 3, 0, 1, 2)
    buf += struct.pack('<i', 0)  # lineRegionCount = 0
    return bytes(buf)


class CatalogTests(unittest.TestCase):
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

    def tearDown(self):
        self.tmp.cleanup()

    def test_thumbnail_from_transparent_line_preserves_white_bg_and_256_box(self):
        raw_line = make_transparent_line_png((600, 800))
        jpg, w, h = encode_thumbnail_jpg(raw_line, max_size=256)
        self.assertEqual((w, h), (192, 256))
        with Image.open(io.BytesIO(jpg)) as thumb:
            self.assertEqual(thumb.mode, 'RGB')
            self.assertEqual(thumb.size, (192, 256))
            # Corner pixel (was transparent) must be white, not black
            r, g, b = thumb.getpixel((2, 2))
            self.assertGreater(r, 240)
            self.assertGreater(g, 240)
            self.assertGreater(b, 240)

    def test_level_bytes_parser_and_invalid_rejection(self):
        raw = make_valid_level_bytes(600, 800, 4)
        parsed = parse_level_bytes(raw)
        self.assertEqual(parsed['width'], 600)
        self.assertEqual(parsed['height'], 800)
        self.assertEqual(parsed['regionCount'], 4)
        with self.assertRaises(WorkflowError):
            parse_level_bytes(b'bad')

    def test_import_output_pair_sets_free_aspect_and_256_thumb(self):
        (self.output_dir / 'Mâm cơm 01_colored_final.png').write_bytes(make_colored_png((600, 800)))
        (self.output_dir / 'Mâm cơm 01_line_final.png').write_bytes(make_transparent_line_png((600, 800)))

        res = self.catalog.import_output_pair(key='Mâm cơm 01', tags=['Food', 'nature'])
        self.assertEqual(res['importedId'], sanitize_picture_id('Mâm cơm 01'))
        pic = res['state']['library'][0]
        self.assertEqual(pic['priceType'], 0)
        self.assertEqual(pic['price'], 0)
        self.assertEqual(pic['cachedTextureWidth'], 600)
        self.assertEqual(pic['cachedTextureHeight'], 800)
        self.assertAlmostEqual(pic['aspectRatio'], 1.333, places=3)
        self.assertTrue(pic['hasColor'])
        self.assertTrue(pic['hasThumbnail'])
        self.assertFalse(pic['hasFileByte'])
        self.assertEqual(pic['tags'], ['Food', 'nature'])

    def test_rename_daily_free_and_push_pull_roundtrip(self):
        (self.output_dir / 'fox_colored_final.png').write_bytes(make_colored_png((500, 500)))
        (self.output_dir / 'fox_line_final.png').write_bytes(make_transparent_line_png((500, 500)))
        (self.output_dir / 'pending_colored_final.png').write_bytes(make_colored_png((400, 400)))
        (self.output_dir / 'pending_line_final.png').write_bytes(make_transparent_line_png((400, 400)))

        self.catalog.import_output_pair(key='fox', tags=['animal'])
        self.catalog.import_output_pair(key='pending', tags=['nature'])

        # Rename fox_bytes -> animal_99_bytes
        lib = self.catalog.state()['library']
        lib[0]['id'] = 'animal_99_bytes'
        lib[0]['name'] = 'Fox 99'
        self.catalog.save_library(lib, renames=[{'from': 'fox_bytes', 'to': 'animal_99_bytes'}])
        self.assertTrue(self.catalog.state()['library'][0]['hasColor'])

        # Upload .bytes only for animal_99_bytes (pending_bytes stays without FileByte)
        self.catalog.upload_asset('animal_99_bytes', 'regions', make_valid_level_bytes(500, 500, 5), 'fox.bytes')

        # Daily entry must force Free / price 0 even if paid values sent
        self.catalog.save_daily({
            'defaultPicture': {'id': 'animal_99_bytes', 'name': 'Default', 'priceType': 2, 'price': 50},
            'entries': [{'year': 2026, 'month': 11, 'day': 24, 'picture': {'id': 'animal_99_bytes', 'priceType': 1, 'price': 20}}],
        })
        daily_state = self.catalog.state()['daily']
        self.assertEqual(daily_state['defaultPicture']['priceType'], 0)
        self.assertEqual(daily_state['entries'][0]['picture']['priceType'], 0)
        self.assertEqual(daily_state['entries'][0]['picture']['price'], 0)

        # Explore section with translations + link_textures
        self.catalog.save_explore({
            'sections': [{
                'name': 'Chủ đề nổi bật',
                'nameTranslations': [{'lang': 'EN', 'text': 'Featured Themes'}, {'lang': 'VN', 'text': 'Chủ đề nổi bật'}],
                'iconName': 'featured_icon',
                'albums': [{
                    'name': 'Động vật',
                    'nameTranslations': [{'lang': 'EN', 'text': 'Animals'}],
                    'description': 'Mô tả',
                    'descriptionTranslations': [{'lang': 'EN', 'text': 'Cute animals'}],
                    'coverPictureId': '',
                    'pictures': [{'id': 'animal_99_bytes'}],
                }],
            }]
        })
        self.catalog.link_textures()
        self.assertEqual(self.catalog.state()['explore']['sections'][0]['albums'][0]['pictures'][0]['cachedTextureWidth'], 500)

        # Push skips pending_bytes (no FileByte) and exports animal_99_bytes
        push_res = self.catalog.push_data(push_library=True, push_daily=True, push_explore=True)
        self.assertEqual(push_res['exportedCount'], 1)
        self.assertEqual(len(push_res['skipped']), 1)
        self.assertEqual(push_res['skipped'][0]['id'], 'pending_bytes')

        sd = self.fc_root / 'ServerData' / 'Pictures'
        self.assertTrue((sd / 'catalog.json').is_file())
        self.assertTrue((sd / 'daily.json').is_file())
        self.assertTrue((sd / 'explore.json').is_file())
        self.assertTrue((sd / 'pictures' / 'animal_99_bytes' / 'r1' / 'regions.bytes').is_file())

        # Verify catalog.json bundles explore with translations
        cat_json = json.loads((sd / 'catalog.json').read_text(encoding='utf-8'))
        self.assertTrue(cat_json['explore']['hasData'])
        self.assertEqual(cat_json['explore']['sections'][0]['nameTranslations'][0]['text'], 'Featured Themes')
        self.assertEqual(cat_json['explore']['sections'][0]['albums'][0]['descriptionTranslations'][0]['text'], 'Cute animals')

        # Fresh CatalogStore pulls from ServerData/Pictures cleanly
        fresh_data = self.root / 'fresh_data'
        fresh = CatalogStore(fresh_data, output_dir=self.output_dir, fillcoloring_root=self.fc_root)
        pull_res = fresh.pull_data(source='local')
        self.assertIn('catalog:local', pull_res['sources'])
        f_state = pull_res['state']
        self.assertEqual(len(f_state['library']), 1)
        self.assertEqual(f_state['library'][0]['id'], 'animal_99_bytes')
        self.assertTrue(f_state['library'][0]['hasFileByte'])
        self.assertEqual(len(f_state['daily']['entries']), 1)
        self.assertEqual(len(f_state['explore']['sections']), 1)
        self.assertEqual(f_state['explore']['sections'][0]['nameTranslations'][0]['text'], 'Featured Themes')
        self.assertEqual(f_state['explore']['sections'][0]['albums'][0]['nameTranslations'][0]['text'], 'Animals')

        # Also verify pulling Explore falls back to catalog.json['explore'] when explore.json is missing
        (sd / 'explore.json').unlink()
        fallback_store = CatalogStore(self.root / 'fallback_data', output_dir=self.output_dir, fillcoloring_root=self.fc_root)
        fb_res = fallback_store.pull_data(pull_library=False, pull_daily=False, pull_explore=True, source='local')
        self.assertIn('explore:catalog-explore', fb_res['sources'])
        self.assertEqual(fb_res['state']['explore']['sections'][0]['albums'][0]['descriptionTranslations'][0]['text'], 'Cute animals')

    def test_http_catalog_endpoints_and_csrf(self):
        (self.output_dir / 'sun_colored_final.png').write_bytes(make_colored_png((300, 300)))
        (self.output_dir / 'sun_line_final.png').write_bytes(make_transparent_line_png((300, 300)))

        server = make_server(self.projects, port=0, catalog=self.catalog)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            port = server.server_port
            html = urllib.request.urlopen(f'http://127.0.0.1:{port}/').read().decode('utf-8')
            token = html.split('name="app-token" content="')[1].split('"')[0]

            health = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health').read())
            self.assertEqual(health['app_version'], APP_VERSION)

            js = urllib.request.urlopen(f'http://127.0.0.1:{port}/catalog.js').read()
            self.assertIn(b'RemotePictureLibrary', js)

            req = urllib.request.Request(
                f'http://127.0.0.1:{port}/api/catalog/import-output',
                data=json.dumps({'key': 'sun', 'tags': ['nature']}).encode(),
                headers={'Content-Type': 'application/json', 'X-App-Token': token},
                method='POST',
            )
            imported = json.loads(urllib.request.urlopen(req).read())
            self.assertEqual(imported['importedId'], 'sun_bytes')

            thumb = urllib.request.urlopen(f'http://127.0.0.1:{port}/api/catalog/asset/sun_bytes/thumbnail').read()
            self.assertTrue(thumb.startswith(b'\xff\xd8'))  # JPEG

            # Upload .bytes over HTTP
            b64 = base64.b64encode(make_valid_level_bytes(300, 300, 2)).decode()
            up_req = urllib.request.Request(
                f'http://127.0.0.1:{port}/api/catalog/upload-asset',
                data=json.dumps({'pic_id': 'sun_bytes', 'kind': 'regions', 'data': b64, 'filename': 'sun.bytes'}).encode(),
                headers={'Content-Type': 'application/json', 'X-App-Token': token},
                method='POST',
            )
            up_res = json.loads(urllib.request.urlopen(up_req).read())
            self.assertEqual(up_res['regionCount'], 2)
        finally:
            server.shutdown()
            server.server_close()
