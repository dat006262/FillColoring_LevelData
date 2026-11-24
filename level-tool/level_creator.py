"""Pure-Python port of FillColoring_LevelTool LevelCreatorWorker for generating .bytes level files."""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import struct
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageOps

from core import GLOBAL_OUTPUT_DIR, WorkflowError, atomic_json, now

SOURCE_FILE_MAGIC = 0x4D46434C  # LCFM
DEFAULT_LEVELS_DIR_NAME = 'generated_levels'

# Corner enum values matching LevelCreatorWorker.Corner
_NON = 0
_OTL = 1
_OTR = 2
_OBL = 3
_OBR = 4
_ITL = 5
_ITR = 6
_IBL = 7
_IBR = 8

_LOC_UNKNOWN = 0
_LOC_OUTSIDE = 1
_LOC_INSIDE = 2


@dataclass
class LevelCreatorSettings:
    line_threshold: int = 200
    ignore_white_regions: bool = False
    no_line_mode: bool = False
    black_bg_white_line: bool = False
    region_size_threshold: int = 24
    triangle_area_threshold: float = 70.0
    color_merge_threshold: float = 0.1

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> 'LevelCreatorSettings':
        d = data or {}
        return cls(
            line_threshold=max(0, min(255, int(d.get('lineThreshold', 200) if d.get('lineThreshold') is not None else 200))),
            ignore_white_regions=bool(d.get('ignoreWhiteRegions', False)),
            no_line_mode=bool(d.get('noLineMode', False)),
            black_bg_white_line=bool(d.get('blackBackgroundWhiteLineMode', False)),
            region_size_threshold=max(1, int(d.get('regionSizeThreshold', 24) if d.get('regionSizeThreshold') is not None else 24)),
            triangle_area_threshold=max(0.0, min(5000.0, float(d.get('triangleAreaThreshold', 70.0) if d.get('triangleAreaThreshold') is not None else 70.0))),
            color_merge_threshold=max(0.0, float(d.get('colorMergeThreshold', 0.1) if d.get('colorMergeThreshold') is not None else 0.1)),
        )


def _rgb_to_lab(r8: int, g8: int, b8: int) -> tuple[float, float, float]:
    """Match BizzyBeeGames.ColorUtils.RGBToLAB (CIE76)."""
    def lin(v: float) -> float:
        return ((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92

    r, g, b = lin(r8 / 255.0), lin(g8 / 255.0), lin(b8 / 255.0)
    x = r * 0.412453 + g * 0.357580 + b * 0.180423
    y = r * 0.212671 + g * 0.715160 + b * 0.072169
    z = r * 0.019334 + g * 0.119193 + b * 0.950227

    def f(t: float) -> float:
        return t ** (1.0 / 3.0) if t > 0.008856 else (7.787 * t) + (16.0 / 116.0)

    fx = f(x / 95.047)
    fy = f(y / 100.0)
    fz = f(z / 108.883)
    return (116.0 * fy) - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)


def _color_diff_lab(lab1: tuple[float, float, float], lab2: tuple[float, float, float]) -> float:
    dl = lab2[0] - lab1[0]
    da = lab2[1] - lab1[1]
    db = lab2[2] - lab1[2]
    return math.sqrt(dl * dl + da * da + db * db)


def _find_number_location(region_pixels_flat: bytearray, rw: int, rh: int) -> tuple[int, int, int, int]:
    """Largest inscribed rectangle in region (maximizing min(w, h), matching LevelCreatorWorker.FindNumberLocation)."""
    histogram = [0] * rw
    best = (0, 0, 0, 0)
    best_min_dim = 0

    for row in range(rh):
        row_off = row * rw
        for col in range(rw):
            histogram[col] = histogram[col] + 1 if region_pixels_flat[row_off + col] else 0

        stack: list[int] = []
        i = 0
        while i < rw:
            if not stack or histogram[stack[-1]] <= histogram[i]:
                stack.append(i)
                i += 1
            else:
                top_idx = stack.pop()
                x0 = 0 if not stack else stack[-1] + 1
                y0 = row - histogram[top_idx] + 1
                x1 = i - 1
                y1 = row
                md = min(x1 - x0, y1 - y0)
                if md > best_min_dim:
                    best_min_dim = md
                    best = (x0, y0, x1, y1)

        while stack:
            top_idx = stack.pop()
            x0 = 0 if not stack else stack[-1] + 1
            y0 = row - histogram[top_idx] + 1
            x1 = rw - 1
            y1 = row
            md = min(x1 - x0, y1 - y0)
            if md > best_min_dim:
                best_min_dim = md
                best = (x0, y0, x1, y1)

    return best


def _mark_cells(start_x: int, start_y: int, rw: int, rh: int,
                contains: bytearray, loc: bytearray, inside_idx: list[int],
                marker: list[int], cur_marker: int,
                target_loc: int, target_inside_idx: int) -> bool:
    stack = [(start_x, start_y)]
    collected: list[int] = []
    while stack:
        cx, cy = stack.pop()
        if cx < 0 or cy < 0 or cx >= rw or cy >= rh:
            continue
        idx = cy * rw + cx
        if contains[idx] or marker[idx] == cur_marker:
            continue
        marker[idx] = cur_marker
        collected.append(idx)
        stack.append((cx - 1, cy))
        stack.append((cx + 1, cy))
        stack.append((cx, cy - 1))
        stack.append((cx, cy + 1))

    region_marked = len(collected) > 4
    if region_marked:
        for idx in collected:
            loc[idx] = target_loc
            inside_idx[idx] = target_inside_idx
    else:
        for idx in collected:
            contains[idx] = 1
    return region_marked


def _get_corners(rw: int, rh: int, contains: bytearray, loc: bytearray, inside_idx: list[int],
                 area_index: int) -> tuple[list[bytearray], tuple[int, int]] | tuple[None, None]:
    found_start = False
    start = (0, 0)
    corners = [bytearray(rh + 1) for _ in range(rw + 1)]

    x_start = 0 if area_index == -1 else 1
    y_start = 0 if area_index == -1 else 1
    x_end = rw + 1 if area_index == -1 else rw
    y_end = rh + 1 if area_index == -1 else rh

    for x in range(x_start, x_end):
        col = corners[x]
        for y in range(y_start, y_end):
            if area_index == -1:
                a = 1 if (x < rw and y < rh and (contains[y * rw + x] or loc[y * rw + x] == _LOC_INSIDE)) else 0
                b = 1 if (x < rw and y > 0 and (contains[(y - 1) * rw + x] or loc[(y - 1) * rw + x] == _LOC_INSIDE)) else 0
                c = 1 if (x > 0 and y > 0 and (contains[(y - 1) * rw + (x - 1)] or loc[(y - 1) * rw + (x - 1)] == _LOC_INSIDE)) else 0
                d = 1 if (x > 0 and y < rh and (contains[y * rw + (x - 1)] or loc[y * rw + (x - 1)] == _LOC_INSIDE)) else 0
            else:
                a = 1 if (x < rw and y < rh and (contains[y * rw + x] or inside_idx[y * rw + x] != area_index)) else 0
                b = 1 if (x < rw and y > 0 and (contains[(y - 1) * rw + x] or inside_idx[(y - 1) * rw + x] != area_index)) else 0
                c = 1 if (x > 0 and y > 0 and (contains[(y - 1) * rw + (x - 1)] or inside_idx[(y - 1) * rw + (x - 1)] != area_index)) else 0
                d = 1 if (x > 0 and y < rh and (contains[y * rw + (x - 1)] or inside_idx[y * rw + (x - 1)] != area_index)) else 0

            t = a + b + c + d
            corner = _NON
            if t == 2 and ((b == 1 and d == 1) or (a == 1 and c == 1)):
                return None, None
            elif t == 1:
                if a == 1:
                    corner = _OBL
                elif b == 1:
                    corner = _OTL
                elif c == 1:
                    corner = _OTR
                elif d == 1:
                    corner = _OBR
            elif t == 3:
                if a == 0:
                    corner = _IBL
                elif b == 0:
                    corner = _ITL
                elif c == 0:
                    corner = _ITR
                elif d == 0:
                    corner = _IBR

            if not found_start and corner != _NON:
                start = (x, y)
                found_start = True
            col[y] = corner

    return (corners, start) if found_start else (None, None)


def _get_points(corners: list[bytearray], start: tuple[int, int], is_inside: bool) -> list[tuple[float, float]] | None:
    is_start = True
    x_dir, y_dir = 1, 0
    x_pos, y_pos = start
    looking_for = (_IBL,) if is_inside else (_OBL,)
    verts: list[tuple[float, float]] = []
    max_steps = len(corners) * len(corners[0]) * 4 + 16
    steps = 0

    while steps < max_steps:
        steps += 1
        if x_pos < 0 or x_pos >= len(corners) or y_pos < 0 or y_pos >= len(corners[x_pos]):
            return None
        if not is_start and x_pos == start[0] and y_pos == start[1]:
            break

        corner = corners[x_pos][y_pos]
        if corner in looking_for:
            verts.append((float(x_pos), float(y_pos)))
            if is_start:
                is_start = False
                x_dir, y_dir = 0, 1
                looking_for = (_ITL, _OTR) if is_inside else (_OTL, _ITR)
            else:
                if corner == _OBL:
                    if y_dir == -1:
                        x_dir, y_dir, looking_for = 1, 0, (_OBR, _ITR)
                    elif x_dir == -1:
                        x_dir, y_dir, looking_for = 0, 1, (_OTL, _ITR)
                elif corner == _OTL:
                    if y_dir == 1:
                        x_dir, y_dir, looking_for = 1, 0, (_OTR, _IBR)
                    elif x_dir == -1:
                        x_dir, y_dir, looking_for = 0, -1, (_OBL, _IBR)
                elif corner == _OTR:
                    if y_dir == 1:
                        x_dir, y_dir, looking_for = -1, 0, (_OTL, _IBL)
                    elif x_dir == 1:
                        x_dir, y_dir, looking_for = 0, -1, (_OBR, _IBL)
                elif corner == _OBR:
                    if y_dir == -1:
                        x_dir, y_dir, looking_for = -1, 0, (_OBL, _ITL)
                    elif x_dir == 1:
                        x_dir, y_dir, looking_for = 0, 1, (_OTR, _ITL)
                elif corner == _IBL:
                    if y_dir == -1:
                        x_dir, y_dir, looking_for = 1, 0, (_IBR, _OTR)
                    elif x_dir == -1:
                        x_dir, y_dir, looking_for = 0, 1, (_ITL, _OTR)
                elif corner == _ITL:
                    if y_dir == 1:
                        x_dir, y_dir, looking_for = 1, 0, (_ITR, _OBR)
                    elif x_dir == -1:
                        x_dir, y_dir, looking_for = 0, -1, (_IBL, _OBR)
                elif corner == _ITR:
                    if y_dir == 1:
                        x_dir, y_dir, looking_for = -1, 0, (_ITL, _OBL)
                    elif x_dir == 1:
                        x_dir, y_dir, looking_for = 0, -1, (_IBR, _OBL)
                elif corner == _IBR:
                    if y_dir == -1:
                        x_dir, y_dir, looking_for = -1, 0, (_IBL, _OTL)
                    elif x_dir == 1:
                        x_dir, y_dir, looking_for = 0, 1, (_ITR, _OTL)
        x_pos += x_dir
        y_pos += y_dir

    return verts if len(verts) >= 3 else None


def _remove_close_points(points: list[tuple[float, float]], threshold: float = 1.0) -> None:
    i = 0
    while i < len(points) and len(points) > 3:
        v1 = points[i]
        nxt = (i + 1) % len(points)
        v2 = points[nxt]
        dx = v2[0] - v1[0]
        dy = v2[1] - v1[1]
        if dx * dx + dy * dy <= threshold * threshold:
            points[i] = ((v1[0] + v2[0]) * 0.5, (v1[1] + v2[1]) * 0.5)
            points.pop(nxt)
        i += 1


def _smooth_points(points: list[tuple[float, float]], threshold: float = 20.0) -> None:
    n = len(points)
    if n < 3:
        return
    t2 = threshold * threshold
    for _ in range(3):
        for i in range(n):
            v1 = points[i]
            v2 = points[(i + 1) % n]
            v3 = points[n - 1 if i == 0 else i - 1]
            d12 = (v2[0] - v1[0]) ** 2 + (v2[1] - v1[1]) ** 2
            d13 = (v3[0] - v1[0]) ** 2 + (v3[1] - v1[1]) ** 2
            if d12 <= t2 and d13 <= t2:
                points[i] = (
                    v1[0] * 0.5 + v2[0] * 0.25 + v3[0] * 0.25,
                    v1[1] * 0.5 + v2[1] * 0.25 + v3[1] * 0.25,
                )


def _lines_intersect_pt(l1a: tuple[float, float], l1b: tuple[float, float],
                        l2a: tuple[float, float], l2b: tuple[float, float]) -> tuple[bool, tuple[float, float]]:
    if (min(l1a[0], l1b[0]) > max(l2a[0], l2b[0]) or
            max(l1a[0], l1b[0]) < min(l2a[0], l2b[0]) or
            min(l1a[1], l1b[1]) > max(l2a[1], l2b[1]) or
            max(l1a[1], l1b[1]) < min(l2a[1], l2b[1])):
        return False, (0.0, 0.0)

    l1ax_l2ax = l1a[0] - l2a[0]
    l1ay_l2ay = l1a[1] - l2a[1]
    l1bx_l1ax = l1b[0] - l1a[0]
    l1by_l1ay = l1b[1] - l1a[1]
    l2bx_l2ax = l2b[0] - l2a[0]
    l2by_l2ay = l2b[1] - l2a[1]

    dem = l2by_l2ay * l1bx_l1ax - l2bx_l2ax * l1by_l1ay
    if abs(dem) < 1e-12:
        return False, (0.0, 0.0)

    a = (l2bx_l2ax * l1ay_l2ay - l2by_l2ay * l1ax_l2ax) / dem
    b = (l1bx_l1ax * l1ay_l2ay - l1by_l1ay * l1ax_l2ax) / dem
    if 0.0 <= a <= 1.0 and 0.0 <= b <= 1.0:
        return True, (l1a[0] + a * l1bx_l1ax, l1a[1] + a * l1by_l1ay)
    return False, (0.0, 0.0)


def _bridge_holes(all_points: list[list[tuple[float, float]]],
                  leftmost_pts: list[tuple[float, float]],
                  leftmost_idx: list[int]) -> list[tuple[float, float]]:
    points = list(all_points[0])
    for i in range(1, len(all_points)):
        lmp = leftmost_pts[i]
        edge_pt = (0.0, lmp[1])
        best_x = -1e30
        best_pt = (0.0, 0.0)
        insert_idx = -1
        n = len(points)
        for j in range(n):
            p1 = points[j]
            p2 = points[(j + 1) % n]
            ok, ip = _lines_intersect_pt(lmp, edge_pt, p1, p2)
            if ok and ip[0] > best_x:
                best_x = ip[0]
                best_pt = ip
                insert_idx = j + 1
        if insert_idx < 0:
            continue

        hole_pts = all_points[i]
        start = leftmost_idx[i]
        seq = [best_pt]
        idx = start
        m = len(hole_pts)
        # Replicate Unity's Insert(iPointIndex, ...) order (which prepends in reverse)
        while True:
            seq.append(hole_pts[idx])
            idx = (idx + 1) % m
            if idx == start:
                break
        seq.append(hole_pts[start])
        seq.append(best_pt)
        # Each Insert(iPointIndex, x) shifts subsequent inserts right, so seq ends up reversed in points
        seq.reverse()
        points[insert_idx:insert_idx] = seq
    return points


def _vec_close(p1: tuple[float, float], p2: tuple[float, float]) -> bool:
    dx = p1[0] - p2[0]
    dy = p1[1] - p2[1]
    return dx * dx + dy * dy < 1e-10


def _norm_vec(dx: float, dy: float) -> tuple[float, float]:
    mag = math.hypot(dx, dy)
    if mag < 1e-10:
        return (0.0, 0.0)
    return (dx / mag, dy / mag)


def _trim_points(points: list[tuple[float, float]]) -> None:
    i = 0
    while i < len(points):
        n = len(points)
        if n < 3:
            break
        p_try = points[i]
        r_pt = points[(i + 1) % n]
        l_pt = points[n - 1 if i == 0 else i - 1]

        if _vec_close(l_pt, r_pt) or _vec_close(l_pt, p_try) or _vec_close(r_pt, p_try):
            points.pop(i)
            i = 0
            continue

        n1 = _norm_vec(p_try[0] - l_pt[0], p_try[1] - l_pt[1])
        n2 = _norm_vec(r_pt[0] - p_try[0], r_pt[1] - p_try[1])
        n3 = _norm_vec(p_try[0] - r_pt[0], p_try[1] - r_pt[1])
        if _vec_close(n1, n2) or _vec_close(n1, n3):
            points.pop(i)
            i = 0
            continue

        if n >= 6:
            p1b = points[(i + 4) % n]
            p2b = points[(i + 3) % n]
            p3b = points[(i + 2) % n]
            if _vec_close(l_pt, p1b) and _vec_close(p_try, p2b) and _vec_close(r_pt, p3b):
                index = (i + 4) % len(points)
                for _ in range(5):
                    points.pop(index)
                    index = (len(points) - 1) if index == 0 else (index - 1)
                    if not points:
                        break
                    index %= len(points)
                i = 0
                continue
            p4 = points[(i + 2) % n]
            p5 = points[(i + 3) % n]
            if _vec_close(l_pt, p5) and _vec_close(p_try, p4):
                index = (i + 3) % len(points)
                for _ in range(4):
                    points.pop(index)
                    index = (len(points) - 1) if index == 0 else (index - 1)
                    if not points:
                        break
                    index %= len(points)
                i = 0
                continue
        i += 1


def _triangulate_ear_clipping(points: list[tuple[float, float]]) -> tuple[list[tuple[float, float]], list[int]]:
    pts = list(points)
    tri_pts: list[tuple[float, float]] = []
    i = 0
    trim_flag = True
    safe_count = 0

    while pts:
        if safe_count > len(pts) * 2:
            break
        if trim_flag:
            safe_count = 0
            _trim_points(pts)
            trim_flag = False
        else:
            safe_count += 1

        n = len(pts)
        if n < 3:
            break

        i = i % n
        p0 = pts[i]
        p1 = pts[(i + 1) % n]
        p2 = pts[n - 1 if i == 0 else i - 1]

        if n == 3:
            tri_pts.extend((p0, p1, p2))
            break

        # IsClockwise: sum((p[j].x - p[i].x) * (p[j].y + p[i].y)) > 0
        cw_sum = ((p1[0] - p0[0]) * (p1[1] + p0[1]) +
                  (p2[0] - p1[0]) * (p2[1] + p1[1]) +
                  (p0[0] - p2[0]) * (p0[1] + p2[1]))
        if cw_sum > 0.0:
            # ContainsAnyOtherPoint check
            rmin_x = min(p0[0], p1[0], p2[0])
            rmin_y = min(p0[1], p1[1], p2[1])
            rmax_x = max(p0[0], p1[0], p2[0])
            rmax_y = max(p0[1], p1[1], p2[1])

            p0x, p0y = p0
            p1x, p1y = p1
            p2x, p2y = p2
            blocked = False

            for k in range(n):
                pt = pts[k]
                if pt != p0 and pt != p1 and pt != p2:
                    px, py = pt
                    if rmin_x <= px <= rmax_x and rmin_y <= py <= rmax_y:
                        d1 = (px - p1x) * (p0y - p1y) - (p0x - p1x) * (py - p1y)
                        d2 = (px - p2x) * (p1y - p2y) - (p1x - p2x) * (py - p2y)
                        d3 = (px - p0x) * (p2y - p0y) - (p2x - p0x) * (py - p0y)
                        if d1 != 0.0 and d2 != 0.0 and d3 != 0.0:
                            if not (((d1 < 0.0) or (d2 < 0.0) or (d3 < 0.0)) and ((d1 > 0.0) or (d2 > 0.0) or (d3 > 0.0))):
                                blocked = True
                                break

                pt2 = pts[(k + 1) % n]
                # Segment intersection against the 3 triangle edges (strict 0 < a < 1 and 0 < b < 1)
                smin_x = pt[0] if pt[0] < pt2[0] else pt2[0]
                smax_x = pt2[0] if pt[0] < pt2[0] else pt[0]
                if smax_x < rmin_x or smin_x > rmax_x:
                    continue
                smin_y = pt[1] if pt[1] < pt2[1] else pt2[1]
                smax_y = pt2[1] if pt[1] < pt2[1] else pt[1]
                if smax_y < rmin_y or smin_y > rmax_y:
                    continue

                l1bx_l1ax = pt2[0] - pt[0]
                l1by_l1ay = pt2[1] - pt[1]
                for ea, eb in ((p0, p1), (p0, p2), (p1, p2)):
                    l2bx_l2ax = eb[0] - ea[0]
                    l2by_l2ay = eb[1] - ea[1]
                    dem = l2by_l2ay * l1bx_l1ax - l2bx_l2ax * l1by_l1ay
                    if abs(dem) < 1e-12:
                        continue
                    l1ax_l2ax = pt[0] - ea[0]
                    l1ay_l2ay = pt[1] - ea[1]
                    a = (l2bx_l2ax * l1ay_l2ay - l2by_l2ay * l1ax_l2ax) / dem
                    if 0.0 < a < 1.0:
                        b = (l1bx_l1ax * l1ay_l2ay - l1by_l1ay * l1ax_l2ax) / dem
                        if 0.0 < b < 1.0:
                            blocked = True
                            break
                if blocked:
                    break

            if not blocked:
                tri_pts.extend((p0, p1, p2))
                safe_count = 0
                pts.pop(i)
                trim_flag = True
                continue
        i += 1

    # Deduplicate vertices into (unique_points, indices)
    unique_pts: list[tuple[float, float]] = []
    pt_map: dict[tuple[float, float], int] = {}
    indices: list[int] = []
    for pt in tri_pts:
        idx = pt_map.get(pt)
        if idx is None:
            idx = len(unique_pts)
            unique_pts.append(pt)
            pt_map[pt] = idx
        indices.append(idx)
    return unique_pts, indices


def _triangle_area(points: list[tuple[float, float]], triangles: list[int]) -> float:
    area = 0.0
    n_pts = len(points)
    for i in range(0, len(triangles) - 2, 3):
        a, b, c = triangles[i], triangles[i + 1], triangles[i + 2]
        if 0 <= a < n_pts and 0 <= b < n_pts and 0 <= c < n_pts:
            p, q, r = points[a], points[b], points[c]
            area += abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) * 0.5
    return area


def generate_level_bytes(
    colored_image: bytes | Path | Image.Image,
    line_image: bytes | Path | Image.Image,
    settings: LevelCreatorSettings | None = None,
    *,
    source_file: str = '',
    progress_cb: Callable[[str, float], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Generate FillColoring-compatible level .bytes binary from a (colored, line) pair."""
    cfg = settings or LevelCreatorSettings()

    def _open_rgba(src: bytes | Path | Image.Image) -> Image.Image:
        if isinstance(src, Image.Image):
            im = ImageOps.exif_transpose(src).convert('RGBA')
        elif isinstance(src, (bytes, bytearray)):
            with Image.open(io_bytes := __import__('io').BytesIO(src)) as opened:
                im = ImageOps.exif_transpose(opened).convert('RGBA')
        else:
            with Image.open(src) as opened:
                im = ImageOps.exif_transpose(opened).convert('RGBA')
        # Match Unity Texture2D.GetPixels() bottom-to-top Y axis!
        return ImageOps.flip(im)

    if progress_cb:
        progress_cb('LoadingTextures', 0.05)

    color_im = _open_rgba(colored_image)
    line_im = _open_rgba(line_image)
    if color_im.size != line_im.size:
        raise WorkflowError(
            f'Kích thước ảnh màu ({color_im.width}×{color_im.height}) và ảnh line ({line_im.width}×{line_im.height}) không khớp.'
        )

    width, height = color_im.size
    total_px = width * height
    color_raw = color_im.tobytes()
    line_raw = line_im.tobytes()

    # Build line alpha map (matching TextureChangeHelper + CreateLineImage)
    alpha_map = bytearray(total_px)
    if cfg.black_bg_white_line:
        for i in range(total_px):
            off = i * 4
            alpha_map[i] = round((line_raw[off] + line_raw[off + 1] + line_raw[off + 2]) / 3.0)
    else:
        for i in range(total_px):
            off = i * 4
            a = line_raw[off + 3]
            if a < 255:
                alpha_map[i] = a
            else:
                gray = round(0.299 * line_raw[off] + 0.587 * line_raw[off + 1] + 0.114 * line_raw[off + 2])
                alpha_map[i] = max(0, min(255, 255 - gray))

    if progress_cb:
        progress_cb('GatheringRegions', 0.15)

    marked = bytearray(total_px)
    line_thresh = cfg.line_threshold
    raw_regions: list[dict[str, Any]] = []

    # Loop order x then y (matching LevelCreatorWorker.ProcessTextures)
    for x in range(width):
        if cancel_check and cancel_check():
            raise WorkflowError('Đã hủy tạo level byte.')
        for y in range(height):
            start_idx = y * width + x
            if marked[start_idx] or alpha_map[start_idx] >= line_thresh:
                continue

            stack = [start_idx]
            pixels_in_region: list[tuple[int, int]] = []
            num_transparent = 0

            while stack:
                idx = stack.pop()
                if marked[idx]:
                    continue
                marked[idx] = 1
                a_val = alpha_map[idx]
                px = idx % width
                py = idx // width
                if a_val < line_thresh:
                    pixels_in_region.append((px, py))
                    if a_val == 0:
                        num_transparent += 1
                    if px + 1 < width and not marked[idx + 1]:
                        stack.append(idx + 1)
                    if px - 1 >= 0 and not marked[idx - 1]:
                        stack.append(idx - 1)
                    if py + 1 < height and not marked[idx + width]:
                        stack.append(idx + width)
                    if py - 1 >= 0 and not marked[idx - width]:
                        stack.append(idx - width)
                elif cfg.no_line_mode:
                    pixels_in_region.append((px, py))

            if num_transparent < cfg.region_size_threshold:
                continue

            min_x = min(p[0] for p in pixels_in_region)
            max_x = max(p[0] for p in pixels_in_region)
            min_y = min(p[1] for p in pixels_in_region)
            max_y = max(p[1] for p in pixels_in_region)
            rw = max_x - min_x + 1
            rh = max_y - min_y + 1

            # Local occupancy grids
            contains = bytearray(rw * rh)
            num_mask = bytearray(rw * rh)
            for px, py in pixels_in_region:
                lidx = (py - min_y) * rw + (px - min_x)
                contains[lidx] = 1
                if alpha_map[py * width + px] < line_thresh:
                    num_mask[lidx] = 1

            bounds = _find_number_location(num_mask, rw, rh)
            naw = bounds[2] - bounds[0]
            nah = bounds[3] - bounds[1]
            num_x = min_x + bounds[0] + (naw // 2)
            num_y = min_y + bounds[1] + (nah // 2)
            num_size = min(naw, nah)

            c_off = (num_y * width + num_x) * 4
            cr, cg, cb, ca = color_raw[c_off], color_raw[c_off + 1], color_raw[c_off + 2], color_raw[c_off + 3]

            raw_regions.append({
                'minX': min_x,
                'minY': min_y,
                'width': rw,
                'height': rh,
                'numX': num_x,
                'numY': num_y,
                'numSize': num_size,
                'rgba': (cr, cg, cb, ca),
                'contains': contains,
            })

    # ProcessRegions: contour tracing + hole bridging + triangulation
    final_regions: list[dict[str, Any]] = []
    total_r = max(1, len(raw_regions))
    for r_idx, reg in enumerate(raw_regions):
        if cancel_check and cancel_check():
            raise WorkflowError('Đã hủy tạo level byte.')
        if progress_cb and (r_idx % 5 == 0 or r_idx == total_r - 1):
            progress_cb(f'Triangulation ({r_idx + 1}/{len(raw_regions)})', 0.25 + 0.65 * ((r_idx + 1) / total_r))

        rw, rh = reg['width'], reg['height']
        contains = bytearray(reg['contains'])
        loc = bytearray(rw * rh)
        inside_idx = [-1] * (rw * rh)
        marker = [0] * (rw * rh)
        cur_marker = 1

        # Outside cells from boundary
        for x in range(rw):
            for y in (0, rh - 1):
                idx = y * rw + x
                if not contains[idx] and marker[idx] != cur_marker:
                    _mark_cells(x, y, rw, rh, contains, loc, inside_idx, marker, cur_marker, _LOC_OUTSIDE, -1)
        for y in range(rh):
            for x in (0, rw - 1):
                idx = y * rw + x
                if not contains[idx] and marker[idx] != cur_marker:
                    _mark_cells(x, y, rw, rh, contains, loc, inside_idx, marker, cur_marker, _LOC_OUTSIDE, -1)

        # Inside holes
        cur_marker = 2
        num_inside = 0
        for x in range(rw):
            for y in range(rh):
                idx = y * rw + x
                if not contains[idx] and loc[idx] == _LOC_UNKNOWN:
                    if _mark_cells(x, y, rw, rh, contains, loc, inside_idx, marker, cur_marker, _LOC_INSIDE, num_inside):
                        num_inside += 1

        all_pts: list[list[tuple[float, float]]] = []
        leftmost_pts: list[tuple[float, float]] = []
        leftmost_idx: list[int] = []
        failed_contour = False

        for area_i in range(-1, num_inside):
            corners, start = _get_corners(rw, rh, contains, loc, inside_idx, area_i)
            if corners is None or start is None:
                if area_i == -1:
                    failed_contour = True
                    break
                continue
            pts = _get_points(corners, start, area_i >= 0)
            if not pts:
                if area_i == -1:
                    failed_contour = True
                    break
                continue
            _remove_close_points(pts, 1.0)
            _smooth_points(pts, 20.0)
            lm_i = min(range(len(pts)), key=lambda k: pts[k][0])
            lm_p = pts[lm_i]
            if area_i <= 0:
                all_pts.append(pts)
                leftmost_pts.append(lm_p)
                leftmost_idx.append(lm_i)
            else:
                ins = 1
                while ins < len(leftmost_pts) and lm_p[0] > leftmost_pts[ins][0]:
                    ins += 1
                all_pts.insert(ins, pts)
                leftmost_pts.insert(ins, lm_p)
                leftmost_idx.insert(ins, lm_i)

        if failed_contour or not all_pts:
            continue

        merged_pts = _bridge_holes(all_pts, leftmost_pts, leftmost_idx)
        tri_pts, tri_idx = _triangulate_ear_clipping(merged_pts)
        if not tri_pts or not tri_idx:
            continue

        if cfg.triangle_area_threshold > 0.0 and _triangle_area(tri_pts, tri_idx) < cfg.triangle_area_threshold:
            continue

        reg['points'] = tri_pts
        reg['triangles'] = tri_idx
        final_regions.append(reg)

    # Rebuild colors palette and colorIndex for surviving regions
    colors_rgb: list[tuple[int, int, int]] = []
    colors_lab: list[tuple[float, float, float]] = []
    for reg in final_regions:
        cr, cg, cb, ca = reg['rgba']
        no_color = (ca < 255) or (cfg.ignore_white_regions and cr == 255 and cg == 255 and cb == 255)
        if no_color:
            reg['colorIndex'] = -1
            continue
        rgb = (cr, cg, cb)
        if not colors_rgb:
            colors_rgb.append(rgb)
            colors_lab.append(_rgb_to_lab(cr, cg, cb))
            reg['colorIndex'] = 0
            continue
        if rgb in colors_rgb:
            reg['colorIndex'] = colors_rgb.index(rgb)
            continue
        lab = _rgb_to_lab(cr, cg, cb)
        best_i = 0
        best_diff = 1e30
        for ci, c_lab in enumerate(colors_lab):
            diff = _color_diff_lab(lab, c_lab)
            if diff < best_diff:
                best_diff = diff
                best_i = ci
        if best_diff <= cfg.color_merge_threshold:
            reg['colorIndex'] = best_i
        else:
            reg['colorIndex'] = len(colors_rgb)
            colors_rgb.append(rgb)
            colors_lab.append(lab)

    # Serialize to FillColoring binary format
    buf = bytearray()
    buf += struct.pack('<3i', width, height, len(colors_rgb))
    for r, g, b in colors_rgb:
        buf += struct.pack('<3i', r, g, b)
    buf += struct.pack('<i', len(final_regions))
    for reg in final_regions:
        buf += struct.pack(
            '<8i',
            reg['colorIndex'],
            reg['minX'],
            reg['minY'],
            reg['width'],
            reg['height'],
            reg['numX'],
            reg['numY'],
            reg['numSize'],
        )
        pts = reg['points']
        buf += struct.pack('<i', len(pts))
        for px, py in pts:
            buf += struct.pack('<2f', px, py)
        tris = reg['triangles']
        buf += struct.pack('<i', len(tris))
        if tris:
            buf += struct.pack(f'<{len(tris)}i', *tris)

    buf += struct.pack('<i', 0)  # lineRegionCount = 0

    if source_file:
        sf_bytes = source_file.encode('utf-8')
        buf += struct.pack('<2i', SOURCE_FILE_MAGIC, len(sf_bytes))
        buf += sf_bytes

    if progress_cb:
        progress_cb('Done', 1.0)

    return {
        'bytes': bytes(buf),
        'width': width,
        'height': height,
        'colorCount': len(colors_rgb),
        'regionCount': len(final_regions),
    }


def scan_level_pairs(folder: Path | str) -> list[dict[str, Any]]:
    """Scan a folder for (colored, line) image pairs matching LevelCreatorWindow + Studio Output conventions."""
    root = Path(folder)
    if not root.is_dir():
        return []

    all_pngs: list[Path] = []
    try:
        all_pngs = sorted(root.rglob('*.png'))
    except OSError:
        all_pngs = sorted(root.glob('*.png'))

    seen: set[str] = set()
    pairs: list[dict[str, Any]] = []
    for file in all_pngs:
        stem = file.stem
        lower = stem.lower()
        if lower.endswith('_line_final') or lower.endswith('picture_line_final') or lower.endswith('_line_lineblack') or lower.endswith('_line_notpatch') or lower.endswith('_line_pathched'):
            continue

        line_path: Path | None = None
        level_name = stem

        if lower == 'picture_colored_final':
            cand = file.with_name('picture_line_final.png')
            if cand.is_file():
                line_path = cand
                level_name = file.parent.name or stem
        elif lower.endswith('_picture_colored_final'):
            prefix = stem[:-len('_picture_colored_final')]
            cand = file.with_name(f'{prefix}_picture_line_final.png')
            if cand.is_file():
                line_path = cand
                level_name = prefix
        elif lower.endswith('picture_colored_final'):
            prefix = stem[:-len('picture_colored_final')]
            cand = file.with_name(f'{prefix}picture_line_final.png')
            if cand.is_file():
                line_path = cand
                level_name = prefix.rstrip('_-') or stem
        elif lower.endswith('_colored_final'):
            prefix = stem[:-len('_colored_final')]
            cand = file.with_name(f'{prefix}_line_final.png')
            if cand.is_file():
                line_path = cand
                level_name = prefix
        elif lower.endswith('_color'):
            prefix = stem[:-len('_color')]
            for suffix in ('_line_Lineblack.png', '_line_final.png', '_line.png'):
                cand = file.with_name(f'{prefix}{suffix}')
                if cand.is_file():
                    line_path = cand
                    level_name = prefix
                    break
        else:
            cand = file.with_name(f'{stem}_line_Lineblack.png')
            if cand.is_file():
                line_path = cand

        if line_path and line_path.is_file():
            key = str(file.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            pairs.append({
                'name': level_name,
                'coloredPath': str(file),
                'linePath': str(line_path),
                'coloredFile': file.name,
                'lineFile': line_path.name,
            })

    return pairs


class LevelCreatorManager:
    """Manages LevelCreator settings, batch scanning, background generation jobs, and optional Catalog attachment."""

    def __init__(self, data_root: Path | str, output_dir: Path | str | None = None, catalog_store: Any = None):
        self.data_root = Path(data_root).resolve()
        self.output_dir = Path(output_dir).resolve() if output_dir is not None else GLOBAL_OUTPUT_DIR
        self.default_out_folder = self.data_root / DEFAULT_LEVELS_DIR_NAME
        self.default_out_folder.mkdir(parents=True, exist_ok=True)
        self.catalog_store = catalog_store
        self.lock = threading.RLock()
        self.cancel_requested = False
        self.job: dict[str, Any] = {
            'status': 'idle',
            'step': '',
            'progress': 0.0,
            'currentFile': '',
            'currentIndex': 0,
            'totalFiles': 0,
            'results': [],
            'error': '',
        }
        self.config: dict[str, Any] = {
            'importMode': 'Batch',
            'batchInputFolder': str(self.output_dir),
            'outputFolder': str(self.default_out_folder),
            'lineThreshold': 200,
            'ignoreWhiteRegions': False,
            'noLineMode': False,
            'blackBackgroundWhiteLineMode': False,
            'regionSizeThreshold': 24,
            'triangleAreaThreshold': 70.0,
            'colorMergeThreshold': 0.1,
            'autoAttachCatalog': True,
        }
        cfg_path = self.data_root / 'level_creator_settings.json'
        if cfg_path.is_file():
            try:
                loaded = json.loads(cfg_path.read_text(encoding='utf-8'))
                if isinstance(loaded, dict):
                    self.config.update(loaded)
            except (OSError, ValueError):
                pass

    def state(self) -> dict[str, Any]:
        with self.lock:
            folder = str(self.config.get('batchInputFolder') or '')
            pairs = scan_level_pairs(folder) if folder else []
            return {
                'settings': dict(self.config),
                'pairs': pairs,
                'job': dict(self.job),
            }

    def save_settings(self, data: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            c = dict(self.config)
            if 'importMode' in data and data['importMode'] in ('Single', 'Batch'):
                c['importMode'] = data['importMode']
            if 'batchInputFolder' in data:
                c['batchInputFolder'] = str(data['batchInputFolder'] or '').strip()
            if 'outputFolder' in data:
                val = str(data['outputFolder'] or '').strip()
                c['outputFolder'] = val or str(self.default_out_folder)
            if 'autoAttachCatalog' in data:
                c['autoAttachCatalog'] = bool(data['autoAttachCatalog'])
            parsed = LevelCreatorSettings.from_dict({**c, **data})
            c.update({
                'lineThreshold': parsed.line_threshold,
                'ignoreWhiteRegions': parsed.ignore_white_regions,
                'noLineMode': parsed.no_line_mode,
                'blackBackgroundWhiteLineMode': parsed.black_bg_white_line,
                'regionSizeThreshold': parsed.region_size_threshold,
                'triangleAreaThreshold': parsed.triangle_area_threshold,
                'colorMergeThreshold': parsed.color_merge_threshold,
            })
            atomic_json(self.data_root / 'level_creator_settings.json', c)
            self.config = c
            return self.state()

    def stop(self) -> dict[str, Any]:
        with self.lock:
            self.cancel_requested = True
            return dict(self.job)

    def _attach_to_catalog(self, level_name: str, raw_bytes: bytes, filename: str) -> str | None:
        if self.catalog_store is None:
            return None
        from catalog import sanitize_picture_id
        st = self.catalog_store.state()
        candidates = {level_name.lower(), sanitize_picture_id(level_name, ensure_bytes_suffix=True).lower()}
        if not level_name.lower().endswith('_bytes'):
            candidates.add(f'{level_name.lower()}_bytes')
        matched_ids: list[str] = []
        for p in st.get('library', []):
            if str(p.get('id') or '').lower() in candidates:
                matched_ids.append(p['id'])
        for e in (st.get('daily') or {}).get('entries', []):
            pid = str((e.get('picture') or {}).get('id') or '')
            if pid.lower() in candidates and pid not in matched_ids:
                matched_ids.append(pid)
        for sec in (st.get('explore') or {}).get('sections', []):
            for alb in sec.get('albums', []):
                for p in alb.get('pictures', []):
                    pid = str(p.get('id') or '')
                    if pid.lower() in candidates and pid not in matched_ids:
                        matched_ids.append(pid)
        for pid in matched_ids:
            self.catalog_store.upload_asset(pid, 'regions', raw_bytes, filename=filename)
        return matched_ids[0] if matched_ids else None

    def start_batch(self, params: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            if self.job.get('status') == 'running':
                raise WorkflowError('Level Creator đang chạy. Hãy chờ hoàn tất hoặc bấm Cancel.')
            self.save_settings(params)
            in_folder = str(self.config.get('batchInputFolder') or '').strip()
            out_folder = Path(str(self.config.get('outputFolder') or self.default_out_folder))
            pairs = scan_level_pairs(in_folder)
            if not pairs:
                raise WorkflowError('Không tìm thấy cặp ảnh (*_colored_final.png & *_line_final.png) nào trong thư mục Input.')
            out_folder.mkdir(parents=True, exist_ok=True)
            cfg = LevelCreatorSettings.from_dict(self.config)
            auto_attach = bool(self.config.get('autoAttachCatalog', True))

            self.cancel_requested = False
            self.job = {
                'status': 'running',
                'step': 'LoadingTextures',
                'progress': 0.0,
                'currentFile': pairs[0]['name'],
                'currentIndex': 0,
                'totalFiles': len(pairs),
                'results': [],
                'error': '',
            }

        def worker() -> None:
            results: list[dict[str, Any]] = []
            try:
                for idx, pair in enumerate(pairs):
                    if self.cancel_requested:
                        raise WorkflowError('Đã hủy tạo level byte.')
                    with self.lock:
                        self.job.update(currentIndex=idx, currentFile=pair['name'])

                    def on_prog(step: str, frac: float) -> None:
                        with self.lock:
                            self.job['step'] = step
                            self.job['progress'] = round((idx + frac) / len(pairs), 4)

                    res = generate_level_bytes(
                        Path(pair['coloredPath']),
                        Path(pair['linePath']),
                        cfg,
                        source_file=pair['coloredFile'],
                        progress_cb=on_prog,
                        cancel_check=lambda: self.cancel_requested,
                    )
                    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', pair['name']).strip(' .') or f'level_{idx + 1}'
                    base_out_name = safe_name if safe_name.lower().endswith('_bytes') else f'{safe_name}_bytes'
                    out_file = out_folder / f'{base_out_name}.bytes'
                    out_file.write_bytes(res['bytes'])

                    attached_id = None
                    if auto_attach:
                        try:
                            attached_id = self._attach_to_catalog(pair['name'], res['bytes'], out_file.name)
                        except Exception:
                            attached_id = None

                    results.append({
                        'name': pair['name'],
                        'fileName': out_file.name,
                        'path': str(out_file),
                        'width': res['width'],
                        'height': res['height'],
                        'regionCount': res['regionCount'],
                        'colorCount': res['colorCount'],
                        'size': len(res['bytes']),
                        'attachedCatalogId': attached_id,
                    })
                    with self.lock:
                        self.job['results'] = list(results)

                with self.lock:
                    self.job.update(status='done', step='Completed', progress=1.0, results=results)
            except Exception as exc:
                msg = str(exc) if isinstance(exc, WorkflowError) else f'Lỗi tạo level byte: {exc}'
                with self.lock:
                    self.job.update(status='error', error=msg, results=results)

        threading.Thread(target=worker, daemon=True).start()
        return self.state()

    def create_single(
        self,
        *,
        colored_bytes: bytes | None = None,
        line_bytes: bytes | None = None,
        colored_path: str | None = None,
        line_path: str | None = None,
        filename: str = '',
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            if self.job.get('status') == 'running':
                raise WorkflowError('Level Creator đang chạy.')
            if params:
                self.save_settings(params)
            cfg = LevelCreatorSettings.from_dict(self.config)
            out_folder = Path(str(self.config.get('outputFolder') or self.default_out_folder))
            out_folder.mkdir(parents=True, exist_ok=True)
            auto_attach = bool(self.config.get('autoAttachCatalog', True))

            c_src: bytes | Path = colored_bytes if colored_bytes else Path(colored_path or '')
            l_src: bytes | Path = line_bytes if line_bytes else Path(line_path or '')
            if isinstance(c_src, Path) and not c_src.is_file():
                raise WorkflowError('Hãy chọn ảnh Colored Texture hợp lệ.')
            if isinstance(l_src, Path) and not l_src.is_file():
                raise WorkflowError('Hãy chọn ảnh Line Texture hợp lệ.')

            clean_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', (filename or 'level').strip()).strip(' .') or 'level'
            base_out_name = clean_name if clean_name.lower().endswith('_bytes') else f'{clean_name}_bytes'
            src_label = Path(colored_path).name if colored_path else f'{clean_name}_colored_final.png'

            self.cancel_requested = False
            self.job = {
                'status': 'running',
                'step': 'LoadingTextures',
                'progress': 0.0,
                'currentFile': clean_name,
                'currentIndex': 0,
                'totalFiles': 1,
                'results': [],
                'error': '',
            }

        def worker() -> None:
            try:
                def on_prog(step: str, frac: float) -> None:
                    with self.lock:
                        self.job['step'] = step
                        self.job['progress'] = round(frac, 4)

                res = generate_level_bytes(
                    c_src,
                    l_src,
                    cfg,
                    source_file=src_label,
                    progress_cb=on_prog,
                    cancel_check=lambda: self.cancel_requested,
                )
                out_file = out_folder / f'{base_out_name}.bytes'
                out_file.write_bytes(res['bytes'])

                attached_id = None
                if auto_attach:
                    try:
                        attached_id = self._attach_to_catalog(clean_name, res['bytes'], out_file.name)
                    except Exception:
                        attached_id = None

                item = {
                    'name': clean_name,
                    'fileName': out_file.name,
                    'path': str(out_file),
                    'width': res['width'],
                    'height': res['height'],
                    'regionCount': res['regionCount'],
                    'colorCount': res['colorCount'],
                    'size': len(res['bytes']),
                    'attachedCatalogId': attached_id,
                }
                with self.lock:
                    self.job.update(status='done', step='Completed', progress=1.0, results=[item])
            except Exception as exc:
                msg = str(exc) if isinstance(exc, WorkflowError) else f'Lỗi tạo level byte: {exc}'
                with self.lock:
                    self.job.update(status='error', error=msg)

        threading.Thread(target=worker, daemon=True).start()
        return self.state()
