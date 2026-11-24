"""Remote Picture Catalog management (v1.0.1) compatible with FillColoring Unity project."""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import threading
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from core import GLOBAL_OUTPUT_DIR, WorkflowError, atomic_json, now, read_image, white_rgb

APP_VERSION = '1.0.1'
DEFAULT_BASE_URL = 'https://coloruniverse-baa07.web.app/'
DEFAULT_FIREBASE_PROJECT = 'coloruniverse-baa07'
DEFAULT_FILLCOLORING_ROOT = Path(r'F:\noichuagit\FillColoring')
ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
PRICE_TYPE_NAMES = {0: 'Free', 1: 'Diamond', 2: 'Gold'}
SUPPORTED_LANGUAGES = ('EN', 'VN', 'CN_s', 'CN_t', 'FR', 'DE', 'ID', 'JP', 'KR', 'PT_BR', 'RU', 'ES_ES')


def _normalize_translations(entries: Any) -> list[dict[str, str]]:
    if not isinstance(entries, list):
        return []
    result = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        lang = str(item.get('lang') or '').strip()
        text = str(item.get('text') or '')
        if lang or text:
            result.append({'lang': lang, 'text': text})
    return result


def _build_explore_dto(explore_data: dict[str, Any] | None) -> dict[str, Any]:
    sections_out = []
    for s in (explore_data or {}).get('sections', []):
        if not isinstance(s, dict):
            continue
        albums_out = []
        for a in s.get('albums', []):
            if not isinstance(a, dict):
                continue
            pics = a.get('pictures', [])
            cover_id = str(a.get('coverPictureId') or (pics[0].get('id', '') if pics else ''))
            albums_out.append({
                'name': str(a.get('name') or ''),
                'nameTranslations': _normalize_translations(a.get('nameTranslations')),
                'description': str(a.get('description') or ''),
                'descriptionTranslations': _normalize_translations(a.get('descriptionTranslations')),
                'coverPictureId': cover_id,
                'pictures': [
                    {
                        'pictureId': str(p.get('id') or p.get('pictureId') or ''),
                        'name': str(p.get('name') or ''),
                        'width': int(p.get('cachedTextureWidth', p.get('width', 0)) or 0),
                        'height': int(p.get('cachedTextureHeight', p.get('height', 0)) or 0),
                        'tags': _normalize_tags(p.get('tags', [])),
                        'priceType': int(p.get('priceType', 0) or 0),
                        'price': max(0, int(p.get('price', 0) or 0)),
                    }
                    for p in pics if isinstance(p, dict)
                ],
            })
        sections_out.append({
            'name': str(s.get('name') or ''),
            'nameTranslations': _normalize_translations(s.get('nameTranslations')),
            'iconName': str(s.get('iconName') or ''),
            'albums': albums_out,
        })
    return {'hasData': len(sections_out) > 0, 'sections': sections_out}


def sanitize_picture_id(raw: str, ensure_bytes_suffix: bool = True) -> str:
    """Convert an arbitrary picture name into a valid RemotePictureCatalog ID."""
    normalized = unicodedata.normalize('NFKD', str(raw or ''))
    ascii_text = normalized.encode('ascii', 'ignore').decode('ascii')
    cleaned = re.sub(r'[^A-Za-z0-9_-]+', '_', ascii_text).strip('_-').lower()
    if not cleaned:
        cleaned = 'picture_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    if ensure_bytes_suffix and not cleaned.endswith('_bytes'):
        cleaned = f'{cleaned}_bytes'
    return cleaned[:128]


def validate_picture_id(pic_id: str) -> str:
    pic_id = str(pic_id or '').strip()
    if not ID_PATTERN.fullmatch(pic_id):
        raise WorkflowError('ID tranh chỉ được chứa chữ cái, số, "_" hoặc "-" (1-128 ký tự).')
    return pic_id


def sha256_hex(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def gzip_bytes(raw: bytes) -> bytes:
    if len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B:
        return raw
    return gzip.compress(raw, compresslevel=9)


def parse_level_bytes(raw: bytes) -> dict[str, int]:
    """Validate and inspect FillColoring .bytes binary format (matching PictureLevelParser.cs)."""
    if not raw or len(raw) < 12:
        raise WorkflowError('File .bytes quá nhỏ hoặc rỗng.')
    data = raw
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        try:
            data = gzip.decompress(data)
        except Exception as exc:
            raise WorkflowError(f'Không giải nén được file .bytes: {exc}') from None

    offset = 0
    total = len(data)

    def read_int(min_val: int, max_val: int, label: str) -> int:
        nonlocal offset
        if offset + 4 > total:
            raise WorkflowError(f'File .bytes bị thiếu dữ liệu ({label}).')
        val = struct.unpack_from('<i', data, offset)[0]
        offset += 4
        if val < min_val or val > max_val:
            raise WorkflowError(f'Giá trị {label} không hợp lệ: {val}.')
        return val

    def skip_regions(count: int, color_count: int) -> None:
        nonlocal offset
        header_struct = struct.Struct('<8i')
        for idx in range(count):
            if offset + header_struct.size > total:
                raise WorkflowError(f'Thiếu header region {idx}.')
            c_idx, _mx, _my, rw, rh, _nx, _ny, _ns = header_struct.unpack_from(data, offset)
            offset += header_struct.size
            if c_idx < -1 or c_idx >= color_count or rw <= 0 or rh <= 0:
                raise WorkflowError(f'Region {idx} có thông số không hợp lệ.')
            point_count = read_int(0, 200000, 'point count')
            pts_bytes = point_count * 8
            if offset + pts_bytes > total:
                raise WorkflowError(f'Thiếu tọa độ điểm ở region {idx}.')
            offset += pts_bytes
            tri_count = read_int(0, 600000, 'triangle index count')
            if tri_count % 3 != 0:
                raise WorkflowError(f'Triangle count không chia hết cho 3 ở region {idx}.')
            tri_bytes = tri_count * 4
            if offset + tri_bytes > total:
                raise WorkflowError(f'Thiếu triangle indices ở region {idx}.')
            offset += tri_bytes

    width = read_int(1, 16384, 'image width')
    height = read_int(1, 16384, 'image height')
    color_count = read_int(0, 4096, 'color count')
    color_bytes = color_count * 12
    if offset + color_bytes > total:
        raise WorkflowError('Thiếu bảng màu trong file .bytes.')
    offset += color_bytes

    region_count = read_int(0, 100000, 'region count')
    skip_regions(region_count, color_count)
    line_region_count = read_int(0, 100000, 'line region count')
    skip_regions(line_region_count, color_count)

    if offset != total:
        magic = read_int(-2147483648, 2147483647, 'metadata magic')
        if magic != 0x4D46434C:
            raise WorkflowError('Metadata cuối file .bytes không đúng định dạng.')
        meta_len = read_int(0, total - offset, 'metadata length')
        if meta_len != total - offset:
            raise WorkflowError('Độ dài metadata cuối file .bytes không khớp.')

    return {
        'width': width,
        'height': height,
        'colorCount': color_count,
        'regionCount': region_count,
        'lineRegionCount': line_region_count,
    }


def encode_color_jpg(raw_image: bytes, quality: int = 85) -> tuple[bytes, int, int]:
    im = white_rgb(read_image(raw_image))
    out = io.BytesIO()
    im.save(out, format='JPEG', quality=quality)
    return out.getvalue(), im.width, im.height


def encode_thumbnail_jpg(raw_image: bytes, max_size: int = 256, quality: int = 85) -> tuple[bytes, int, int]:
    im = white_rgb(read_image(raw_image))
    scale = min(1.0, max_size / max(im.width, im.height)) if max_size > 0 else 1.0
    tw = max(1, round(im.width * scale))
    th = max(1, round(im.height * scale))
    if (tw, th) != im.size:
        im = im.resize((tw, th), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    im.save(out, format='JPEG', quality=quality)
    return out.getvalue(), tw, th


def find_firebase_executable() -> tuple[str, str | None]:
    local_app = os.environ.get('LOCALAPPDATA', '')
    app_data = os.environ.get('APPDATA', '')
    prog_files = os.environ.get('ProgramFiles', '')
    candidates = [
        Path(local_app) / r'Programs\nodejs\firebase.cmd',
        Path(app_data) / r'npm\firebase.cmd',
        Path(prog_files) / r'nodejs\firebase.cmd',
        Path(local_app) / r'Programs\nodejs\firebase.exe',
        Path(prog_files) / r'nodejs\firebase.exe',
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate), str(candidate.parent)
    which = shutil.which('firebase')
    if which:
        return which, str(Path(which).parent)
    return 'firebase', None


def _normalize_tags(tags: Any) -> list[str]:
    if not isinstance(tags, list):
        return []
    seen = set()
    result = []
    for tag in tags:
        clean = str(tag or '').strip()
        if clean and clean not in seen:
            seen.add(clean)
            result.append(clean)
    return result


def _normalize_picture(raw: dict[str, Any] | None, *, force_free: bool = False) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    pic_id = str(raw.get('id') or raw.get('ID') or raw.get('pictureId') or '').strip()
    price_type = 0 if force_free else int(raw.get('priceType', 0) or 0)
    if price_type not in PRICE_TYPE_NAMES:
        price_type = 0
    price = 0 if force_free else max(0, int(raw.get('price', 0) or 0))
    return {
        'id': pic_id,
        'name': str(raw.get('name') if raw.get('name') is not None else raw.get('Name', '') or ''),
        'tags': _normalize_tags(raw.get('tags', [])),
        'priceType': price_type,
        'price': price,
        'cachedTextureWidth': max(0, int(raw.get('cachedTextureWidth', raw.get('width', 0)) or 0)),
        'cachedTextureHeight': max(0, int(raw.get('cachedTextureHeight', raw.get('height', 0)) or 0)),
        'revision': max(1, int(raw.get('revision', 1) or 1)),
        'layoutVersion': max(1, int(raw.get('layoutVersion', 1) or 1)),
        'formatVersion': max(1, int(raw.get('formatVersion', 1) or 1)),
        'regionCount': max(0, int(raw.get('regionCount', 0) or 0)),
        'fileByteName': str(raw.get('fileByteName') or ''),
    }


def _empty_working() -> dict[str, Any]:
    return {
        'has_working': False,
        'pulled_at': None,
        'updated_at': None,
        'library': [],
        'daily': {'defaultPicture': None, 'entries': []},
        'explore': {'sections': []},
    }


class CatalogStore:
    """Manages local Working Copy, Output import, ServerData PULL/PUSH, and Firebase Hosting deploy."""

    def __init__(self, data_root: Path | str, output_dir: Path | str | None = None,
                 fillcoloring_root: Path | str | None = None, projects_store: Any = None):
        self.data_root = Path(data_root).resolve()
        self.root = self.data_root / 'remote_catalog'
        self.content_dir = self.root / 'content'
        self.root.mkdir(parents=True, exist_ok=True)
        self.content_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir = Path(output_dir).resolve() if output_dir is not None else GLOBAL_OUTPUT_DIR
        self.projects_store = projects_store
        self.lock = threading.RLock()

        default_fc = str(fillcoloring_root) if fillcoloring_root is not None else (
            str(DEFAULT_FILLCOLORING_ROOT) if DEFAULT_FILLCOLORING_ROOT.exists() else ''
        )
        self.config: dict[str, Any] = {
            'fillcoloring_root': default_fc,
            'base_url': DEFAULT_BASE_URL,
            'firebase_project': DEFAULT_FIREBASE_PROJECT,
            'thumb_max_size': 256,
            'jpeg_quality': 85,
        }
        cfg_path = self.root / 'settings.json'
        if cfg_path.exists():
            try:
                loaded = json.loads(cfg_path.read_text(encoding='utf-8'))
                if isinstance(loaded, dict):
                    self.config.update(loaded)
            except (OSError, ValueError):
                pass

        self.working: dict[str, Any] = _empty_working()
        work_path = self.root / 'working.json'
        if work_path.exists():
            try:
                loaded = json.loads(work_path.read_text(encoding='utf-8'))
                if isinstance(loaded, dict):
                    self.working.update(loaded)
            except (OSError, ValueError):
                pass

    def server_data_dir(self) -> Path | None:
        fc_root = str(self.config.get('fillcoloring_root') or '').strip()
        if not fc_root:
            return None
        return Path(fc_root) / 'ServerData' / 'Pictures'

    def settings(self) -> dict[str, Any]:
        sd = self.server_data_dir()
        return {
            **self.config,
            'working_dir': str(self.root),
            'content_dir': str(self.content_dir),
            'output_dir': str(self.output_dir),
            'server_data_dir': str(sd) if sd else '',
            'server_data_exists': bool(sd and sd.exists()),
            'catalog_json_exists': bool(sd and (sd / 'catalog.json').is_file()),
        }

    def save_settings(self, data: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            candidate = dict(self.config)
            if 'fillcoloring_root' in data:
                candidate['fillcoloring_root'] = str(data['fillcoloring_root'] or '').strip()
            if 'base_url' in data:
                url = str(data['base_url'] or '').strip()
                if url and not (url.startswith('https://') or url.startswith('http://')):
                    raise WorkflowError('Hosting Base URL phải bắt đầu bằng https:// hoặc http://.')
                candidate['base_url'] = (url.rstrip('/') + '/') if url else DEFAULT_BASE_URL
            if 'firebase_project' in data:
                proj = str(data['firebase_project'] or '').strip()
                if proj and not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', proj):
                    raise WorkflowError('Firebase Project ID không hợp lệ.')
                candidate['firebase_project'] = proj or DEFAULT_FIREBASE_PROJECT
            if 'thumb_max_size' in data:
                val = int(data['thumb_max_size'])
                if val < 64 or val > 1024:
                    raise WorkflowError('Kích thước thumbnail phải từ 64 đến 1024 px.')
                candidate['thumb_max_size'] = val
            if 'jpeg_quality' in data:
                q = int(data['jpeg_quality'])
                if q < 50 or q > 100:
                    raise WorkflowError('Chất lượng JPEG phải từ 50 đến 100.')
                candidate['jpeg_quality'] = q
            atomic_json(self.root / 'settings.json', candidate)
            self.config = candidate
            return self.settings()

    def _pic_dir(self, pic_id: str) -> Path:
        validate_picture_id(pic_id)
        return self.content_dir / pic_id

    def _asset_path(self, pic_id: str, kind: str) -> Path:
        ext = {'color': 'color.jpg', 'thumbnail': 'thumbnail.jpg', 'regions': 'regions.bytes'}.get(kind)
        if not ext:
            raise WorkflowError('Loại tài nguyên không hợp lệ.')
        return self._pic_dir(pic_id) / ext

    def _hydrate_picture(self, pic: dict[str, Any], *, force_free: bool = False) -> dict[str, Any]:
        item = _normalize_picture(pic, force_free=force_free)
        pid = item['id']
        has_color = has_thumb = has_bytes = False
        color_size = thumb_size = bytes_size = 0
        if pid and ID_PATTERN.fullmatch(pid):
            pdir = self.content_dir / pid
            cpath = pdir / 'color.jpg'
            tpath = pdir / 'thumbnail.jpg'
            rpath = pdir / 'regions.bytes'
            if cpath.is_file():
                has_color = True
                color_size = cpath.stat().st_size
            if tpath.is_file():
                has_thumb = True
                thumb_size = tpath.stat().st_size
            if rpath.is_file():
                has_bytes = True
                bytes_size = rpath.stat().st_size
                if not item['fileByteName']:
                    item['fileByteName'] = 'regions.bytes'
        item['hasColor'] = has_color
        item['hasThumbnail'] = has_thumb
        item['hasFileByte'] = has_bytes
        item['colorSize'] = color_size
        item['thumbnailSize'] = thumb_size
        item['fileByteSize'] = bytes_size
        w, h = item['cachedTextureWidth'], item['cachedTextureHeight']
        item['aspectRatio'] = round(h / w, 3) if w > 0 and h > 0 else 1.0
        return item

    def _save_working(self) -> None:
        self.working['has_working'] = True
        self.working['updated_at'] = now()
        atomic_json(self.root / 'working.json', self.working)

    def _collect_summary(self) -> dict[str, Any]:
        lib = self.working.get('library', [])
        daily_entries = self.working.get('daily', {}).get('entries', [])
        sections = self.working.get('explore', {}).get('sections', [])
        all_items: dict[str, dict[str, Any]] = {}
        for p in lib:
            h = self._hydrate_picture(p)
            if h['id']:
                all_items[h['id']] = h
        dp = self.working.get('daily', {}).get('defaultPicture')
        if dp:
            h = self._hydrate_picture(dp, force_free=True)
            if h['id'] and h['id'] not in all_items:
                all_items[h['id']] = h
        for e in daily_entries:
            h = self._hydrate_picture(e.get('picture'), force_free=True)
            if h['id'] and h['id'] not in all_items:
                all_items[h['id']] = h
        for sec in sections:
            for alb in sec.get('albums', []):
                for p in alb.get('pictures', []):
                    h = self._hydrate_picture(p)
                    if h['id'] and h['id'] not in all_items:
                        all_items[h['id']] = h
        ready = sum(1 for v in all_items.values() if v['hasColor'] and v['hasThumbnail'] and v['hasFileByte'])
        missing_bytes = [v['id'] for v in all_items.values() if not v['hasFileByte']]
        missing_color = [v['id'] for v in all_items.values() if not v['hasColor']]
        return {
            'libraryCount': len(lib),
            'dailyCount': len(daily_entries),
            'exploreSectionsCount': len(sections),
            'uniquePictures': len(all_items),
            'readyToPushCount': ready,
            'missingFileByteIds': sorted(missing_bytes),
            'missingColorIds': sorted(missing_color),
        }

    def scan_output_sources(self) -> list[dict[str, Any]]:
        """Scan Output folder and Studio projects for (_colored_final, _line_final) pairs."""
        with self.lock:
            existing_ids = {str(p.get('id', '')).lower() for p in self.working.get('library', [])}
            results: list[dict[str, Any]] = []
            seen_keys = set()

            if self.output_dir.exists():
                for color_file in sorted(self.output_dir.glob('*_colored_final.png'), key=lambda p: p.stat().st_mtime, reverse=True):
                    base = color_file.name[:-len('_colored_final.png')]
                    line_file = self.output_dir / f'{base}_line_final.png'
                    if not line_file.is_file():
                        continue
                    suggested_id = sanitize_picture_id(base, ensure_bytes_suffix=True)
                    try:
                        with Image.open(color_file) as im:
                            w, h = im.size
                    except OSError:
                        w, h = 0, 0
                    seen_keys.add(base.lower())
                    results.append({
                        'sourceType': 'output',
                        'key': base,
                        'name': base,
                        'suggestedId': suggested_id,
                        'alreadyInLibrary': suggested_id.lower() in existing_ids or base.lower() in existing_ids,
                        'width': w,
                        'height': h,
                        'colorFile': color_file.name,
                        'lineFile': line_file.name,
                    })

            if self.projects_store is not None:
                for proj in self.projects_store.list():
                    sel = proj.get('selected') or {}
                    cid = sel.get('color')
                    lid = sel.get('transparent')
                    if not cid or not lid:
                        continue
                    base = proj.get('name', '')
                    if base.lower() in seen_keys:
                        continue
                    c_rec = next((r for r in proj.get('versions', {}).get('color', []) if r['id'] == cid), None)
                    l_rec = next((r for r in proj.get('versions', {}).get('transparent', []) if r['id'] == lid), None)
                    if not c_rec or not l_rec:
                        continue
                    suggested_id = sanitize_picture_id(base, ensure_bytes_suffix=True)
                    results.append({
                        'sourceType': 'project',
                        'projectId': proj['id'],
                        'key': base,
                        'name': base,
                        'suggestedId': suggested_id,
                        'alreadyInLibrary': suggested_id.lower() in existing_ids or base.lower() in existing_ids,
                        'width': c_rec.get('width', 0),
                        'height': c_rec.get('height', 0),
                        'colorFile': c_rec['file'],
                        'lineFile': l_rec['file'],
                    })

            return results

    def state(self) -> dict[str, Any]:
        with self.lock:
            lib = [self._hydrate_picture(p) for p in self.working.get('library', [])]
            daily_raw = self.working.get('daily') or {}
            default_pic = self._hydrate_picture(daily_raw.get('defaultPicture'), force_free=True) if daily_raw.get('defaultPicture') else None
            entries = []
            for e in daily_raw.get('entries', []):
                entries.append({
                    'year': int(e.get('year', 0) or 0),
                    'month': int(e.get('month', 0) or 0),
                    'day': int(e.get('day', 0) or 0),
                    'picture': self._hydrate_picture(e.get('picture'), force_free=True),
                })
            sections = []
            for s in (self.working.get('explore') or {}).get('sections', []):
                albums = []
                for a in s.get('albums', []):
                    pics = [self._hydrate_picture(p) for p in a.get('pictures', [])]
                    albums.append({
                        'name': str(a.get('name') or ''),
                        'nameTranslations': _normalize_translations(a.get('nameTranslations')),
                        'description': str(a.get('description') or ''),
                        'descriptionTranslations': _normalize_translations(a.get('descriptionTranslations')),
                        'coverPictureId': str(a.get('coverPictureId') or (pics[0]['id'] if pics else '')),
                        'pictures': pics,
                    })
                sections.append({
                    'name': str(s.get('name') or ''),
                    'nameTranslations': _normalize_translations(s.get('nameTranslations')),
                    'iconName': str(s.get('iconName') or ''),
                    'albums': albums,
                })
            return {
                'appVersion': APP_VERSION,
                'hasWorking': bool(self.working.get('has_working')),
                'pulledAt': self.working.get('pulled_at'),
                'updatedAt': self.working.get('updated_at'),
                'settings': self.settings(),
                'library': lib,
                'daily': {'defaultPicture': default_pic, 'entries': entries},
                'explore': {'hasData': len(sections) > 0, 'sections': sections},
                'supportedLanguages': list(SUPPORTED_LANGUAGES),
                'summary': self._collect_summary(),
                'outputSources': self.scan_output_sources(),
            }

    def read_asset_bytes(self, pic_id: str, kind: str) -> bytes:
        path = self._asset_path(pic_id, kind)
        if not path.is_file():
            raise WorkflowError('Không tìm thấy file ảnh.')
        return path.read_bytes()

    def read_output_preview(self, filename: str) -> bytes:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+\.png', filename or ''):
            raise WorkflowError('Tên file không hợp lệ.')
        target = (self.output_dir / filename).resolve()
        if target.parent != self.output_dir or not target.is_file():
            raise WorkflowError('Không tìm thấy file trong Output.')
        return target.read_bytes()

    def _migrate_content_dir(self, old_id: str, new_id: str) -> None:
        if not old_id or not new_id or old_id == new_id:
            return
        if not ID_PATTERN.fullmatch(old_id) or not ID_PATTERN.fullmatch(new_id):
            return
        src = self.content_dir / old_id
        dst = self.content_dir / new_id
        if src.is_dir() and not dst.exists():
            shutil.copytree(src, dst)

    def save_library(self, pictures: list[dict[str, Any]], renames: list[dict[str, str]] | None = None) -> dict[str, Any]:
        if not isinstance(pictures, list):
            raise WorkflowError('Danh sách Library không hợp lệ.')
        with self.lock:
            for item in renames or []:
                self._migrate_content_dir(str(item.get('from', '')), str(item.get('to', '')))
            normalized = []
            seen_ids = set()
            for idx, p in enumerate(pictures):
                np = _normalize_picture(p)
                if np['id']:
                    validate_picture_id(np['id'])
                    key = np['id'].lower()
                    if key in seen_ids:
                        raise WorkflowError(f'Trùng ID tranh trong Library: {np["id"]} (dòng {idx + 1}).')
                    seen_ids.add(key)
                normalized.append(np)
            self.working['library'] = normalized
            self._save_working()
            return self.state()

    def save_daily(self, daily_data: dict[str, Any], renames: list[dict[str, str]] | None = None) -> dict[str, Any]:
        if not isinstance(daily_data, dict):
            raise WorkflowError('Dữ liệu Daily không hợp lệ.')
        with self.lock:
            for item in renames or []:
                self._migrate_content_dir(str(item.get('from', '')), str(item.get('to', '')))
            default_raw = daily_data.get('defaultPicture')
            default_pic = _normalize_picture(default_raw, force_free=True) if default_raw else None
            if default_pic and default_pic['id']:
                validate_picture_id(default_pic['id'])
            entries = []
            for e in daily_data.get('entries', []):
                if not isinstance(e, dict):
                    continue
                pic = _normalize_picture(e.get('picture'), force_free=True)
                if pic['id']:
                    validate_picture_id(pic['id'])
                entries.append({
                    'year': max(0, int(e.get('year', 0) or 0)),
                    'month': max(0, int(e.get('month', 0) or 0)),
                    'day': max(0, int(e.get('day', 0) or 0)),
                    'picture': pic,
                })
            self.working['daily'] = {'defaultPicture': default_pic, 'entries': entries}
            self._save_working()
            return self.state()

    def save_explore(self, explore_data: dict[str, Any], renames: list[dict[str, str]] | None = None) -> dict[str, Any]:
        if not isinstance(explore_data, dict):
            raise WorkflowError('Dữ liệu Explore không hợp lệ.')
        with self.lock:
            for item in renames or []:
                self._migrate_content_dir(str(item.get('from', '')), str(item.get('to', '')))
            sections = []
            for s in explore_data.get('sections', []):
                if not isinstance(s, dict):
                    continue
                albums = []
                for a in s.get('albums', []):
                    if not isinstance(a, dict):
                        continue
                    pics = []
                    for p in a.get('pictures', []):
                        np = _normalize_picture(p)
                        if np['id']:
                            validate_picture_id(np['id'])
                        pics.append(np)
                    albums.append({
                        'name': str(a.get('name') or ''),
                        'nameTranslations': _normalize_translations(a.get('nameTranslations')),
                        'description': str(a.get('description') or ''),
                        'descriptionTranslations': _normalize_translations(a.get('descriptionTranslations')),
                        'coverPictureId': str(a.get('coverPictureId') or (pics[0]['id'] if pics else '')),
                        'pictures': pics,
                    })
                sections.append({
                    'name': str(s.get('name') or ''),
                    'nameTranslations': _normalize_translations(s.get('nameTranslations')),
                    'iconName': str(s.get('iconName') or ''),
                    'albums': albums,
                })
            self.working['explore'] = {'hasData': len(sections) > 0, 'sections': sections}
            self._save_working()
            return self.state()

    def _for_each_picture_with_id(self, pic_id: str, fn) -> None:
        for p in self.working.get('library', []):
            if str(p.get('id', '')).lower() == pic_id.lower():
                fn(p)
        dp = self.working.get('daily', {}).get('defaultPicture')
        if dp and str(dp.get('id', '')).lower() == pic_id.lower():
            fn(dp)
        for e in self.working.get('daily', {}).get('entries', []):
            p = e.get('picture')
            if p and str(p.get('id', '')).lower() == pic_id.lower():
                fn(p)
        for s in self.working.get('explore', {}).get('sections', []):
            for a in s.get('albums', []):
                for p in a.get('pictures', []):
                    if str(p.get('id', '')).lower() == pic_id.lower():
                        fn(p)

    def upload_asset(self, pic_id: str, kind: str, raw_bytes: bytes, filename: str = '') -> dict[str, Any]:
        validate_picture_id(pic_id)
        if not raw_bytes:
            raise WorkflowError('File tải lên đang rỗng.')
        with self.lock:
            pdir = self._pic_dir(pic_id)
            pdir.mkdir(parents=True, exist_ok=True)
            quality = int(self.config.get('jpeg_quality', 85))
            thumb_max = int(self.config.get('thumb_max_size', 256))

            if kind == 'color':
                jpg, w, h = encode_color_jpg(raw_bytes, quality=quality)
                (pdir / 'color.jpg').write_bytes(jpg)
                def upd(p):
                    p['cachedTextureWidth'] = w
                    p['cachedTextureHeight'] = h
                self._for_each_picture_with_id(pic_id, upd)
                self._save_working()
                return {'ok': True, 'kind': kind, 'width': w, 'height': h, 'size': len(jpg), 'state': self.state()}

            if kind == 'thumbnail':
                jpg, w, h = encode_thumbnail_jpg(raw_bytes, max_size=thumb_max, quality=quality)
                (pdir / 'thumbnail.jpg').write_bytes(jpg)
                self._save_working()
                return {'ok': True, 'kind': kind, 'width': w, 'height': h, 'size': len(jpg), 'state': self.state()}

            if kind == 'thumbnail_from_color':
                cpath = pdir / 'color.jpg'
                if not cpath.is_file():
                    raise WorkflowError('Chưa có Colored Texture để tạo thumbnail.')
                jpg, w, h = encode_thumbnail_jpg(cpath.read_bytes(), max_size=thumb_max, quality=quality)
                (pdir / 'thumbnail.jpg').write_bytes(jpg)
                self._save_working()
                return {'ok': True, 'kind': 'thumbnail', 'width': w, 'height': h, 'size': len(jpg), 'state': self.state()}

            if kind == 'regions':
                parsed = parse_level_bytes(raw_bytes)
                gz = gzip_bytes(raw_bytes)
                (pdir / 'regions.bytes').write_bytes(gz)
                clean_name = Path(filename).name if filename else 'regions.bytes'
                def upd(p):
                    p['regionCount'] = parsed['regionCount']
                    p['fileByteName'] = clean_name
                    if not p.get('cachedTextureWidth'):
                        p['cachedTextureWidth'] = parsed['width']
                    if not p.get('cachedTextureHeight'):
                        p['cachedTextureHeight'] = parsed['height']
                self._for_each_picture_with_id(pic_id, upd)
                self._save_working()
                return {'ok': True, 'kind': kind, **parsed, 'size': len(gz), 'state': self.state()}

            raise WorkflowError('Loại asset không hợp lệ.')

    def clear_asset(self, pic_id: str, kind: str) -> dict[str, Any]:
        path = self._asset_path(pic_id, kind)
        with self.lock:
            path.unlink(missing_ok=True)
            if kind == 'thumbnail_from_color':
                cpath = pdir / 'color.jpg'
                if not cpath.is_file():
                    raise WorkflowError('Chưa có Colored Texture để tạo thumbnail.')
                jpg, w, h = encode_thumbnail_jpg(cpath.read_bytes(), max_size=thumb_max, quality=quality)
                (pdir / 'thumbnail.jpg').write_bytes(jpg)
                self._save_working()
                return {'ok': True, 'kind': 'thumbnail', 'width': w, 'height': h, 'size': len(jpg), 'state': self.state()}

            if kind == 'regions':
                def upd(p):
                    p['fileByteName'] = ''
                    p['regionCount'] = 0
                self._for_each_picture_with_id(pic_id, upd)
            self._save_working()
            return self.state()

    def cache_aspect(self, pic_id: str | None = None) -> dict[str, Any]:
        with self.lock:
            def cache_one(p):
                pid = str(p.get('id') or '')
                if pic_id and pid.lower() != pic_id.lower():
                    return
                if not pid or not ID_PATTERN.fullmatch(pid):
                    return
                cpath = self.content_dir / pid / 'color.jpg'
                if cpath.is_file():
                    with Image.open(cpath) as im:
                        p['cachedTextureWidth'] = im.width
                        p['cachedTextureHeight'] = im.height

            for p in self.working.get('library', []):
                cache_one(p)
            dp = self.working.get('daily', {}).get('defaultPicture')
            if dp:
                cache_one(dp)
            for e in self.working.get('daily', {}).get('entries', []):
                if e.get('picture'):
                    cache_one(e['picture'])
            for s in self.working.get('explore', {}).get('sections', []):
                for a in s.get('albums', []):
                    for p in a.get('pictures', []):
                        cache_one(p)
            self._save_working()
            return self.state()

    def link_textures(self) -> dict[str, Any]:
        """Match Daily & Explore entries against Library by ID (same as RemoteDataManager.AutoLinkMissingReferences)."""
        with self.lock:
            lib_map: dict[str, dict[str, Any]] = {}
            for p in self.working.get('library', []):
                pid = str(p.get('id') or '')
                if not pid:
                    continue
                lib_map[pid.lower()] = p
                raw = pid[:-6] if pid.lower().endswith('_bytes') else pid
                lib_map.setdefault(raw.lower(), p)

            linked = 0

            def sync_pic(p: dict[str, Any]) -> None:
                nonlocal linked
                pid = str(p.get('id') or '')
                if not pid:
                    return
                raw = pid[:-6] if pid.lower().endswith('_bytes') else pid
                src = lib_map.get(pid.lower()) or lib_map.get(raw.lower())
                if src:
                    changed = False
                    if not p.get('cachedTextureWidth') and src.get('cachedTextureWidth'):
                        p['cachedTextureWidth'] = src['cachedTextureWidth']
                        changed = True
                    if not p.get('cachedTextureHeight') and src.get('cachedTextureHeight'):
                        p['cachedTextureHeight'] = src['cachedTextureHeight']
                        changed = True
                    if not p.get('tags') and src.get('tags'):
                        p['tags'] = list(src['tags'])
                        changed = True
                    if not p.get('regionCount') and src.get('regionCount'):
                        p['regionCount'] = src['regionCount']
                        changed = True
                    if changed:
                        linked += 1

            dp = self.working.get('daily', {}).get('defaultPicture')
            if dp:
                sync_pic(dp)
            for e in self.working.get('daily', {}).get('entries', []):
                if e.get('picture'):
                    sync_pic(e['picture'])
            for s in self.working.get('explore', {}).get('sections', []):
                for a in s.get('albums', []):
                    for p in a.get('pictures', []):
                        sync_pic(p)
                    pics = a.get('pictures', [])
                    if not a.get('coverPictureId') and pics:
                        a['coverPictureId'] = pics[0].get('id', '')

            self._save_working()
            return {'linked': linked, 'state': self.state()}

    def import_output_pair(self, *, key: str | None = None, project_id: str | None = None,
                           pic_id: str | None = None, name: str | None = None,
                           tags: list[str] | None = None, target: str = 'library',
                           section_index: int = 0, album_index: int = 0) -> dict[str, Any]:
        """Import (_colored_final, _line_final) from Output or a Studio project into Working Copy."""
        with self.lock:
            color_bytes = line_bytes = None
            base_name = key or ''
            if project_id and self.projects_store is not None:
                proj = self.projects_store.load(project_id)
                base_name = base_name or proj.get('name', '')
                c_rec = self.projects_store.version(proj, 'color')
                l_rec = self.projects_store.version(proj, 'transparent')
                pdir = self.projects_store.directory(project_id)
                color_bytes = (pdir / c_rec['file']).read_bytes()
                line_bytes = (pdir / l_rec['file']).read_bytes()
            elif key:
                cpath = self.output_dir / f'{key}_colored_final.png'
                lpath = self.output_dir / f'{key}_line_final.png'
                if not cpath.is_file() or not lpath.is_file():
                    raise WorkflowError(f'Không tìm thấy cặp {key}_colored_final.png và {key}_line_final.png trong Output.')
                color_bytes = cpath.read_bytes()
                line_bytes = lpath.read_bytes()
            else:
                raise WorkflowError('Hãy chọn tranh từ Output hoặc Studio để nhập.')

            final_id = validate_picture_id(pic_id.strip() if pic_id else sanitize_picture_id(base_name, ensure_bytes_suffix=True))
            quality = int(self.config.get('jpeg_quality', 85))
            thumb_max = int(self.config.get('thumb_max_size', 256))

            color_jpg, w, h = encode_color_jpg(color_bytes, quality=quality)
            thumb_jpg, _tw, _th = encode_thumbnail_jpg(line_bytes, max_size=thumb_max, quality=quality)

            pdir = self._pic_dir(final_id)
            pdir.mkdir(parents=True, exist_ok=True)
            (pdir / 'color.jpg').write_bytes(color_jpg)
            (pdir / 'thumbnail.jpg').write_bytes(thumb_jpg)

            new_pic = _normalize_picture({
                'id': final_id,
                'name': name if name is not None else '',
                'tags': tags if tags is not None else [],
                'priceType': 0,  # Default Free
                'price': 0,
                'cachedTextureWidth': w,
                'cachedTextureHeight': h,
            }, force_free=(target == 'daily'))

            if target == 'library':
                lib = self.working.setdefault('library', [])
                existing = next((i for i, p in enumerate(lib) if str(p.get('id', '')).lower() == final_id.lower()), None)
                if existing is not None:
                    old = lib[existing]
                    new_pic['name'] = new_pic['name'] or old.get('name', '')
                    new_pic['tags'] = new_pic['tags'] or old.get('tags', [])
                    new_pic['priceType'] = old.get('priceType', 0)
                    new_pic['price'] = old.get('price', 0)
                    new_pic['regionCount'] = old.get('regionCount', 0)
                    new_pic['fileByteName'] = old.get('fileByteName', '')
                    lib[existing] = new_pic
                else:
                    lib.append(new_pic)
            elif target == 'daily':
                entries = self.working.setdefault('daily', {}).setdefault('entries', [])
                entries.append({'year': 0, 'month': 0, 'day': 0, 'picture': new_pic})
            elif target == 'explore':
                sections = self.working.setdefault('explore', {}).setdefault('sections', [])
                if not sections:
                    sections.append({'name': 'Section 1', 'nameTranslations': [], 'iconName': '', 'albums': []})
                sec = sections[max(0, min(section_index, len(sections) - 1))]
                albums = sec.setdefault('albums', [])
                if not albums:
                    albums.append({
                        'name': 'Album 1', 'nameTranslations': [],
                        'description': '', 'descriptionTranslations': [],
                        'coverPictureId': final_id, 'pictures': [],
                    })
                alb = albums[max(0, min(album_index, len(albums) - 1))]
                alb.setdefault('pictures', []).append(new_pic)
                if not alb.get('coverPictureId'):
                    alb['coverPictureId'] = final_id
            else:
                raise WorkflowError('Đích nhập không hợp lệ.')

            self._save_working()
            return {'importedId': final_id, 'width': w, 'height': h, 'state': self.state()}

    def _fetch_remote_bytes(self, rel_path: str) -> bytes:
        base_url = str(self.config.get('base_url') or DEFAULT_BASE_URL).rstrip('/')
        url = f'{base_url}/{rel_path.lstrip("/")}'
        req = urllib.request.Request(url, headers={'User-Agent': f'FillColoringStudio/{APP_VERSION}'})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            raise WorkflowError(f'Tải từ Hosting thất bại ({exc.code}): {url}') from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise WorkflowError(f'Không kết nối được Hosting ({url}): {exc}') from None

    def _load_json_source(self, filename: str, source: str) -> tuple[dict[str, Any] | None, str]:
        sd = self.server_data_dir()
        local_file = (sd / filename) if sd else None
        if source in ('auto', 'local') and local_file and local_file.is_file():
            return json.loads(local_file.read_text(encoding='utf-8')), 'local'
        if source == 'local':
            raise WorkflowError(f'Không tìm thấy {filename} tại {sd}.')
        try:
            raw = self._fetch_remote_bytes(filename)
            return json.loads(raw.decode('utf-8')), 'remote'
        except WorkflowError:
            if filename == 'catalog.json':
                raise
            return None, 'missing'

    def _pull_file(self, rel_path: str, dst: Path, source: str) -> None:
        sd = self.server_data_dir()
        local_file = (sd / rel_path) if sd else None
        if source in ('auto', 'local') and local_file and local_file.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(local_file, dst)
            return
        if source == 'local':
            return
        try:
            data = self._fetch_remote_bytes(rel_path)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
        except WorkflowError:
            pass

    def pull_data(self, *, pull_library: bool = True, pull_daily: bool = True,
                  pull_explore: bool = True, source: str = 'auto') -> dict[str, Any]:
        if source not in ('auto', 'local', 'remote'):
            raise WorkflowError('Nguồn Pull không hợp lệ.')
        with self.lock:
            pulled_sources = []
            catalog_cache = None

            if pull_library:
                catalog, src_used = self._load_json_source('catalog.json', source)
                catalog_cache = catalog
                pulled_sources.append(f'catalog:{src_used}')
                pictures = []
                for entry in (catalog or {}).get('pictures', []):
                    pid = validate_picture_id(entry.get('id', ''))
                    pdir = self._pic_dir(pid)
                    pdir.mkdir(parents=True, exist_ok=True)
                    for key, target_name in (('color', 'color.jpg'), ('thumbnail', 'thumbnail.jpg'), ('regions', 'regions.bytes')):
                        rel = (entry.get(key) or {}).get('path')
                        if rel:
                            self._pull_file(rel, pdir / target_name, source)
                    if entry.get('inLibrary', True):
                        pictures.append(_normalize_picture({
                            'id': pid,
                            'name': entry.get('name', ''),
                            'tags': entry.get('tags', []),
                            'priceType': entry.get('priceType', 0),
                            'price': entry.get('price', 0),
                            'cachedTextureWidth': entry.get('width', 0),
                            'cachedTextureHeight': entry.get('height', 0),
                            'revision': entry.get('revision', 1),
                            'layoutVersion': entry.get('layoutVersion', 1),
                            'formatVersion': entry.get('formatVersion', 1),
                            'regionCount': entry.get('regionCount', 0),
                            'fileByteName': 'regions.bytes' if (pdir / 'regions.bytes').is_file() else '',
                        }))
                self.working['library'] = pictures

            if pull_daily:
                daily_json, src_used = self._load_json_source('daily.json', source)
                if daily_json:
                    pulled_sources.append(f'daily:{src_used}')
                    dp = daily_json.get('defaultPicture')
                    entries = []
                    for e in daily_json.get('entries', []):
                        entries.append({
                            'year': int(e.get('year', 0) or 0),
                            'month': int(e.get('month', 0) or 0),
                            'day': int(e.get('day', 0) or 0),
                            'picture': _normalize_picture(e, force_free=True),
                        })
                    self.working['daily'] = {
                        'defaultPicture': _normalize_picture(dp, force_free=True) if dp else None,
                        'entries': entries,
                    }

            if pull_explore:
                try:
                    explore_json, src_used = self._load_json_source('explore.json', source)
                except WorkflowError:
                    explore_json, src_used = None, 'missing'
                if not explore_json or not explore_json.get('sections'):
                    if catalog_cache is None:
                        try:
                            catalog_cache, _ = self._load_json_source('catalog.json', source)
                        except WorkflowError:
                            catalog_cache = None
                    cat_explore = (catalog_cache or {}).get('explore')
                    if cat_explore and (cat_explore.get('hasData') or cat_explore.get('sections')):
                        explore_json = cat_explore
                        src_used = f'catalog-explore'
                if explore_json:
                    pulled_sources.append(f'explore:{src_used}')
                    sections = []
                    for s in explore_json.get('sections', []):
                        albums = []
                        for a in s.get('albums', []):
                            pics = [_normalize_picture(p) for p in a.get('pictures', [])]
                            albums.append({
                                'name': str(a.get('name') or ''),
                                'nameTranslations': _normalize_translations(a.get('nameTranslations')),
                                'description': str(a.get('description') or ''),
                                'descriptionTranslations': _normalize_translations(a.get('descriptionTranslations')),
                                'coverPictureId': str(a.get('coverPictureId') or (pics[0]['id'] if pics else '')),
                                'pictures': pics,
                            })
                        sections.append({
                            'name': str(s.get('name') or ''),
                            'nameTranslations': _normalize_translations(s.get('nameTranslations')),
                            'iconName': str(s.get('iconName') or ''),
                            'albums': albums,
                        })
                    self.working['explore'] = {'hasData': len(sections) > 0, 'sections': sections}

            self.working['pulled_at'] = now()
            self._save_working()
            return {'sources': pulled_sources, 'state': self.state()}

    def _resolve_server_asset(self, pic_id: str, rel_name: str, fallback_rel: str) -> bytes | None:
        local_working = self.content_dir / pic_id / rel_name
        if local_working.is_file():
            return local_working.read_bytes()
        sd = self.server_data_dir()
        if sd:
            existing = sd / fallback_rel
            if existing.is_file():
                return existing.read_bytes()
        return None

    def push_data(self, *, push_library: bool = True, push_daily: bool = True, push_explore: bool = True) -> dict[str, Any]:
        """Package Working Copy to ServerData/Pictures (catalog.json, daily.json, explore.json, pictures/<id>/r1/)."""
        with self.lock:
            sd = self.server_data_dir()
            if sd is None:
                raise WorkflowError('Chưa cấu hình đường dẫn project FillColoring trong tab General & Hosting.')
            sd.mkdir(parents=True, exist_ok=True)

            # Collect unique items across Library (inLibrary=True), Daily & Explore (inLibrary=False if absent)
            export_items: dict[str, tuple[dict[str, Any], bool]] = {}
            for p in self.working.get('library', []):
                pid = str(p.get('id') or '').strip()
                if pid:
                    export_items[pid.lower()] = (p, True)

            daily = self.working.get('daily') or {}
            if daily.get('defaultPicture'):
                dp = daily['defaultPicture']
                pid = str(dp.get('id') or '').strip()
                if pid and pid.lower() not in export_items:
                    export_items[pid.lower()] = (dp, False)
            for e in daily.get('entries', []):
                p = e.get('picture') or {}
                pid = str(p.get('id') or '').strip()
                if pid and pid.lower() not in export_items:
                    export_items[pid.lower()] = (p, False)

            for s in (self.working.get('explore') or {}).get('sections', []):
                for a in s.get('albums', []):
                    for p in a.get('pictures', []):
                        pid = str(p.get('id') or '').strip()
                        if pid and pid.lower() not in export_items:
                            export_items[pid.lower()] = (p, False)

            exported_entries = []
            skipped = []
            quality = int(self.config.get('jpeg_quality', 85))
            thumb_max = int(self.config.get('thumb_max_size', 256))

            for _key, (pic, in_library) in export_items.items():
                pid = validate_picture_id(pic['id'])
                rev = max(1, int(pic.get('revision', 1) or 1))
                prefix = f'pictures/{pid}/r{rev}/'

                raw_regions = self._resolve_server_asset(pid, 'regions.bytes', f'{prefix}regions.bytes')
                if not raw_regions:
                    skipped.append({'id': pid, 'reason': 'Thiếu FileByte (regions.bytes)'})
                    continue

                parsed = parse_level_bytes(raw_regions)
                gz_regions = gzip_bytes(raw_regions)

                color_bytes = self._resolve_server_asset(pid, 'color.jpg', f'{prefix}color.jpg')
                if not color_bytes:
                    skipped.append({'id': pid, 'reason': 'Thiếu ColoredTexture (color.jpg)'})
                    continue

                thumb_bytes = self._resolve_server_asset(pid, 'thumbnail.jpg', f'{prefix}thumbnail.jpg')
                if not thumb_bytes:
                    thumb_bytes, _, _ = encode_thumbnail_jpg(color_bytes, max_size=thumb_max, quality=quality)

                def write_server_file(rel: str, data: bytes) -> dict[str, Any]:
                    target = sd / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    return {'path': rel, 'size': len(data), 'sha256': sha256_hex(data)}

                entry = {
                    'id': pid,
                    'name': str(pic.get('name') or ''),
                    'revision': rev,
                    'layoutVersion': max(1, int(pic.get('layoutVersion', 1) or 1)),
                    'formatVersion': 1,
                    'width': parsed['width'],
                    'height': parsed['height'],
                    'regionCount': parsed['regionCount'],
                    'price': max(0, int(pic.get('price', 0) or 0)),
                    'priceType': int(pic.get('priceType', 0) or 0),
                    'tags': _normalize_tags(pic.get('tags', [])),
                    'inLibrary': bool(in_library),
                    'color': write_server_file(prefix + 'color.jpg', color_bytes),
                    'thumbnail': write_server_file(prefix + 'thumbnail.jpg', thumb_bytes),
                    'regions': write_server_file(prefix + 'regions.bytes', gz_regions),
                }
                exported_entries.append(entry)

            # Preserve existing inLibrary=False entries if doing a partial push without Daily/Explore loaded
            prev_cat = None
            if (sd / 'catalog.json').is_file():
                try:
                    prev_cat = json.loads((sd / 'catalog.json').read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    prev_cat = None

            if (not push_daily or not push_explore) and prev_cat:
                exported_ids = {e['id'].lower() for e in exported_entries}
                for prev in prev_cat.get('pictures', []):
                    prev_id = str(prev.get('id') or '').lower()
                    if prev_id and not prev.get('inLibrary', True) and prev_id not in exported_ids:
                        exported_entries.append(prev)
                        exported_ids.add(prev_id)

            explore_out = _build_explore_dto(self.working.get('explore'))
            if not push_explore and not explore_out['sections']:
                if (sd / 'explore.json').is_file():
                    try:
                        explore_out = _build_explore_dto(json.loads((sd / 'explore.json').read_text(encoding='utf-8')))
                    except (OSError, ValueError):
                        pass
                elif prev_cat and isinstance(prev_cat.get('explore'), dict):
                    explore_out = _build_explore_dto(prev_cat['explore'])

            # Write catalog.json (bundling explore metadata & translations)
            catalog_payload = {
                'schemaVersion': 1,
                'revision': datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S'),
                'pictures': exported_entries,
                'explore': explore_out,
            }
            atomic_json(sd / 'catalog.json', catalog_payload)

            if push_daily:
                def to_daily_dto(pic: dict[str, Any], year: int = 0, month: int = 0, day: int = 0) -> dict[str, Any]:
                    return {
                        'year': year,
                        'month': month,
                        'day': day,
                        'pictureId': str(pic.get('id') or ''),
                        'name': str(pic.get('name') or ''),
                        'width': int(pic.get('cachedTextureWidth', 0) or 0),
                        'height': int(pic.get('cachedTextureHeight', 0) or 0),
                        'tags': _normalize_tags(pic.get('tags', [])),
                        'priceType': 0,
                        'price': 0,
                    }

                daily_out = {
                    'defaultPicture': to_daily_dto(daily['defaultPicture']) if daily.get('defaultPicture') else None,
                    'entries': [
                        to_daily_dto(e.get('picture') or {}, int(e.get('year', 0) or 0), int(e.get('month', 0) or 0), int(e.get('day', 0) or 0))
                        for e in daily.get('entries', []) if e.get('picture')
                    ],
                }
                atomic_json(sd / 'daily.json', daily_out)

            if push_explore:
                atomic_json(sd / 'explore.json', explore_out)

            return {
                'exportedCount': len(exported_entries),
                'skipped': skipped,
                'serverDataDir': str(sd),
                'catalogRevision': catalog_payload['revision'],
            }

    def deploy_hosting(self) -> dict[str, Any]:
        fc_root = str(self.config.get('fillcoloring_root') or '').strip()
        if not fc_root or not Path(fc_root).is_dir():
            raise WorkflowError('Không tìm thấy thư mục FillColoring để Deploy Hosting.')
        if not (Path(fc_root) / 'firebase.json').is_file():
            raise WorkflowError(f'Không tìm thấy firebase.json trong {fc_root}.')

        project_id = str(self.config.get('firebase_project') or DEFAULT_FIREBASE_PROJECT).strip()
        firebase_exe, node_dir = find_firebase_executable()
        env = os.environ.copy()
        if node_dir and node_dir not in env.get('PATH', ''):
            env['PATH'] = node_dir + os.pathsep + env.get('PATH', '')

        cmd = ['cmd.exe', '/c', f'"{firebase_exe}" deploy --only hosting --project {project_id}'] if os.name == 'nt' else [
            firebase_exe, 'deploy', '--only', 'hosting', '--project', project_id
        ]
        try:
            proc = subprocess.run(
                cmd,
                cwd=fc_root,
                env=env,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=180,
            )
        except FileNotFoundError:
            raise WorkflowError('Không tìm thấy Firebase CLI (firebase). Hãy cài Node.js và firebase-tools.') from None
        except subprocess.TimeoutExpired:
            raise WorkflowError('Firebase Deploy vượt quá 180 giây.') from None

        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or '').strip()
            raise WorkflowError(f'Deploy Firebase thất bại (ExitCode {proc.returncode}):\n{detail[:800]}')
        return {
            'ok': True,
            'project': project_id,
            'baseUrl': self.config.get('base_url', DEFAULT_BASE_URL),
            'output': (proc.stdout or '').strip()[-1500:],
        }

    def clear_working(self) -> dict[str, Any]:
        with self.lock:
            shutil.rmtree(self.content_dir, ignore_errors=True)
            self.content_dir.mkdir(parents=True, exist_ok=True)
            self.working = _empty_working()
            (self.root / 'working.json').unlink(missing_ok=True)
            return self.state()
