#!/usr/bin/env python3
"""
Teslaplay lane model — stage 2 of the road pipeline.

    python scripts/roads/lanes.py raw/ out/

Reads the raw way tiles written by build.py (centrelines + OSM tags) and builds an explicit
lane model for the whole country at once, the way HD-map vendors do, so the app never has to
offset lines at run time:

  * every way becomes one or more *parts*, split at junction nodes, each with a lane layout:
    lane width, left-edge offset, forward/backward lane counts, per-lane turn arrows
  * junction polygons: every road is cut back where it enters a junction, and the junction is
    the hull of the cut ends — markings stop at the cut, asphalt continues through the hull
  * carriageway polygons (asphalt), white markings (edge lines, lane dividers, centre lines,
    stop lines, zebra crossings — Georgian markings are white; only special lines are yellow),
    painted turn arrows, 3-D bridge parapets and tunnel portals

All geometry is computed in metres in a local frame and written back as lon/lat, so widths
are exact ground metres at every zoom. Output: out/14/<x>/<y>.json

  {"v": 3, "built": "...",
   "w": [ {id, c, g, lw, l, f, b, o, tf, tb, br, tu, ly, ms, mb, rb, cs, ce}, ... ],  lane records
   "s": [[lon, lat], ...],                 traffic lights
   "surf": [{id, g: ring, c, br, tu, ly}], asphalt
   "jn":   [{id, g: ring, ly}],            junction polygons
   "mk":   [{id, k, g: line, ly, br}],     markings  k = edge|div|cl1|cl2|stop|zebra
   "ar":   [{id, g: [lon,lat], a, r}],     turn arrows (a = turn key, r = bearing)
   "ex":   [{id, g: ring, b, h, k}],       extrusions: bridge parapets (k=rail), tunnel portals (k=portal)
  }

Lane record fields: c class, g reference line (lon/lat, full part, untrimmed), lw lane width (m),
l offset of the carriageway's left edge from g (m, right of travel positive), f/b forward/backward
lane counts, o oneway, tf/tb per-lane turn strings (left→right in each direction's travel
frame) or null, ms/mb speed limits, rb roundabout, cs/ce junction cut-back at start/end (m).
"""
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

Z = 14
STEP_M = 250

# Lane widths by road class (metres). Georgian practice: 3.75 on motorways, 3.5 on trunk/primary
# roads, 3.25 on city streets; narrow streets and service roads are narrower.
LANE_W = {'motorway': 3.75, 'trunk': 3.5, 'primary': 3.5, 'secondary': 3.25, 'tertiary': 3.25,
          'unclassified': 3.0, 'residential': 3.0, 'living_street': 2.75, 'service': 2.75, 'track': 2.5}
MIN_SURF = 4.0   # a one-lane residential street is still ~4 m of asphalt
EDGE_IN = 0.2    # edge line centre, metres in from the kerb
MITER_LIMIT = 3.0
MAX_CUT = 30.0
ARROW_AT = (12.0, 42.0)   # metres before the junction cut
TURNS = {'left', 'slight_left', 'sharp_left', 'through', 'right', 'slight_right', 'sharp_right', 'reverse', 'merge_to_left', 'merge_to_right'}


# ───────────────────────── geometry ─────────────────────────
def tile(lon, lat):
    n = 2 ** Z
    r = math.radians(max(-85.0, min(85.0, lat)))
    return (int((lon + 180) / 360 * n), int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n))


class Frame:
    """Local equirectangular metres around (lon0, lat0)."""
    def __init__(self, lon0, lat0):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = math.cos(math.radians(lat0)) * 111320.0
        self.ky = 110540.0

    def to_m(self, p):
        return ((p[0] - self.lon0) * self.kx, (p[1] - self.lat0) * self.ky)

    def to_ll(self, q):
        return [round(self.lon0 + q[0] / self.kx, 7), round(self.lat0 + q[1] / self.ky, 7)]


def seglen(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def plen(pts):
    return sum(seglen(a, b) for a, b in zip(pts, pts[1:]))


def dedupe(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if seglen(out[-1], p) > 0.05:
            out.append(p)
    return out


def sub(pts, s, e):
    """Part of a metric polyline between distances s and e along it (clamped)."""
    L = plen(pts)
    s = max(0.0, min(s, L))
    e = max(s, min(e, L))
    out, acc = [], 0.0
    started = False
    for a, b in zip(pts, pts[1:]):
        d = seglen(a, b)
        if d == 0:
            continue
        if not started and acc + d >= s:
            t = (s - acc) / d
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            started = True
        if started:
            if acc + d >= e:
                t = (e - acc) / d
                out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                break
            out.append(b)
        acc += d
    if len(out) < 2:
        return None
    return dedupe(out) if len(dedupe(out)) >= 2 else None


def point_at(pts, s):
    """Point and unit direction at distance s along a metric polyline."""
    acc = 0.0
    for a, b in zip(pts, pts[1:]):
        d = seglen(a, b)
        if d == 0:
            continue
        if acc + d >= s or (a, b) == (pts[-2], pts[-1]):
            t = max(0.0, min(1.0, (s - acc) / d))
            u = ((b[0] - a[0]) / d, (b[1] - a[1]) / d)
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), u
        acc += d
    a, b = pts[-2], pts[-1]
    d = seglen(a, b) or 1.0
    return b, ((b[0] - a[0]) / d, (b[1] - a[1]) / d)


def offset(pts, d):
    """Offset a metric polyline by d metres (positive = right of travel). Mitred, bevelled when
    the mitre would exceed MITER_LIMIT × d. Identical to offsetLine() in the app."""
    if abs(d) < 1e-9:
        return list(pts)
    n = len(pts)
    normals = []
    for a, b in zip(pts, pts[1:]):
        L = seglen(a, b) or 1.0
        normals.append(((b[1] - a[1]) / L, -(b[0] - a[0]) / L))
    out = []
    for i, p in enumerate(pts):
        if i == 0:
            nx, ny = normals[0]
            out.append((p[0] + nx * d, p[1] + ny * d))
        elif i == n - 1:
            nx, ny = normals[-1]
            out.append((p[0] + nx * d, p[1] + ny * d))
        else:
            n1, n2 = normals[i - 1], normals[i]
            dot = n1[0] * n2[0] + n1[1] * n2[1]
            k = 1 + dot
            if k > 1 / (MITER_LIMIT * MITER_LIMIT) * 2 and k > 1e-6:
                mx, my = (n1[0] + n2[0]) / k, (n1[1] + n2[1]) / k
                out.append((p[0] + mx * d, p[1] + my * d))
            else:
                out.append((p[0] + n1[0] * d, p[1] + n1[1] * d))
                out.append((p[0] + n2[0] * d, p[1] + n2[1] * d))
    return out


def ribbon(pts, left, right):
    """Polygon ring between offsets `left` and `right` of a metric polyline."""
    a = offset(pts, left)
    b = offset(pts, right)
    ring = a + b[::-1]
    ring.append(ring[0])
    return ring


def bearing(u):
    return (math.degrees(math.atan2(u[0], u[1])) + 360) % 360


def hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


# ───────────────────────── lane layout from tags ─────────────────────────
def to_int(v, default=None):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def base_class(hw):
    hw = hw or ''
    if hw.endswith('_link'):
        hw = hw[:-5]
    if hw in ('unclassified', 'residential'):
        return 'minor'
    return hw if hw in LANE_W or hw == 'minor' else 'minor'


def speed(v):
    if not v:
        return None
    v = v.strip().lower()
    if v in ('none', 'signals', 'walk'):
        return None
    try:
        n = float(v.split()[0].replace('mph', ''))
    except ValueError:
        return None
    return int(round(n * 1.609)) if 'mph' in v else int(round(n))


def turns(v):
    if not v:
        return None
    out = []
    for lane in v.split('|'):
        keys = []
        for k in lane.split(';'):
            k = k.strip()
            if k in TURNS:
                keys.append(k)
            elif k == 'slight_left' or k == 'slight_right':
                keys.append(k)
        out.append(';'.join(keys) if keys else 'none')
    return out


def layout(tags):
    hw = tags.get('highway', '')
    cls = base_class(hw)
    link = hw.endswith('_link')
    rb = tags.get('junction') in ('roundabout', 'circular')
    ow = tags.get('oneway')
    oneway = ow in ('yes', '1', 'true', '-1', 'reverse') or rb or (hw == 'motorway' and ow not in ('no', '0', 'false'))
    reversed_ = ow in ('-1', 'reverse')
    lanes = to_int(tags.get('lanes'))
    lf, lb = to_int(tags.get('lanes:forward')), to_int(tags.get('lanes:backward'))
    if oneway:
        n = lanes or lf or lb or (1 if (link or rb or cls in ('minor', 'living_street', 'service', 'track')) else 2)
        f, b = n, 0
    else:
        if lf is not None and lb is not None:
            f, b = max(lf, 0), max(lb, 0)
        elif lanes is not None:
            if lf is not None:
                f, b = lf, max(lanes - lf, 0)
            elif lb is not None:
                b, f = lb, max(lanes - lb, 0)
            else:
                f, b = (lanes + 1) // 2, lanes // 2
        else:
            f = b = 1
        if f == 0 and b == 0:
            f = b = 1
        if f == 0 or b == 0:   # tagged two-way but all lanes one direction: treat as oneway
            oneway, f, b = True, max(f, b), 0
    n = f + b
    lw = LANE_W.get(cls, 3.0)
    if link:
        lw = max(lw - 0.25, 3.0)
    if n == 1 and not oneway:
        lw = max(lw, MIN_SURF)
    width_tag = tags.get('width')
    try:
        if width_tag:
            w = float(width_tag.split()[0].replace('m', ''))
            if 2.0 <= w <= 60.0:
                lw = max(2.4, min(w / n, 4.5))
    except ValueError:
        pass
    W = n * lw
    if W < MIN_SURF:
        lw = MIN_SURF / n
        W = MIN_SURF
    # where the OSM way runs relative to the lanes (placement=*); default: middle of the carriageway
    left = -W / 2
    pl = tags.get('placement') or tags.get('placement:forward')
    if pl and ':' in pl:
        kind, _, idx = pl.partition(':')
        i = to_int(idx)
        if i and 1 <= i <= n:
            if kind == 'middle_of':
                left = -((i - 1) * lw + lw / 2)
            elif kind == 'left_of':
                left = -((i - 1) * lw)
            elif kind == 'right_of':
                left = -(i * lw)
    tf = turns(tags.get('turn:lanes:forward') or (tags.get('turn:lanes') if oneway or b == 0 else None))
    tb = turns(tags.get('turn:lanes:backward'))
    if tf and len(tf) != f:
        tf = None
    if tb and len(tb) != b:
        tb = None
    ms = speed(tags.get('maxspeed:forward') or tags.get('maxspeed'))
    mb = speed(tags.get('maxspeed:backward') or tags.get('maxspeed'))
    layer = to_int(tags.get('layer'), 0) or 0
    bridge = tags.get('bridge') not in (None, 'no')
    tunnel = tags.get('tunnel') not in (None, 'no') or tags.get('tunnel') == 'building_passage'
    if bridge and layer <= 0:
        layer = 1
    if tunnel and layer >= 0:
        layer = -1
    return dict(c=cls, link=link, rb=rb, o=oneway, rev=reversed_, f=f, b=b, lw=round(lw, 3), l=round(left, 3), W=W,
                tf=tf, tb=tb, ms=ms, mb=mb, ly=layer, br=bridge, tu=tunnel)


# ───────────────────────── model ─────────────────────────
class Part:
    __slots__ = ('id', 'lay', 'll', 'frame', 'm', 'L', 'cs', 'ce', 'n0', 'n1', 'signals', 'crossings', 'tiles', 'h', 'cum')

    def __init__(self, pid, lay, ll):
        self.id = pid
        self.lay = lay
        self.ll = ll
        self.frame = Frame(ll[0][0], ll[0][1])
        self.m = dedupe([self.frame.to_m(p) for p in ll])
        self.L = plen(self.m)
        self.cs = self.ce = 0.0
        self.n0 = key(ll[0])
        self.n1 = key(ll[-1])
        self.cum = [0.0]
        for a, b in zip(self.m, self.m[1:]):
            self.cum.append(self.cum[-1] + seglen(a, b))
        self.h = [0.0] * len(self.m)   # height above local ground per vertex of m (structures)
        self.signals = []    # along positions of traffic lights on this part
        self.crossings = []  # along positions of zebra crossings
        self.tiles = set()

    def densify(self, step=10.0):
        """Insert vertices so no segment is longer than `step` (structures need vertices to carry a height profile)."""
        if max((seglen(a, b) for a, b in zip(self.m, self.m[1:])), default=0) <= step:
            return
        ll = [self.ll[0]]
        for a, b in zip(self.ll, self.ll[1:]):
            d = seglen(self.frame.to_m(a), self.frame.to_m(b))
            n = int(d // step)
            for i in range(1, n + 1):
                t = i / (n + 1)
                ll.append([round(a[0] + (b[0] - a[0]) * t, 7), round(a[1] + (b[1] - a[1]) * t, 7)])
            ll.append(b)
        self.ll = ll
        self.m = dedupe([self.frame.to_m(q) for q in ll])
        self.L = plen(self.m)
        self.cum = [0.0]
        for a, b in zip(self.m, self.m[1:]):
            self.cum.append(self.cum[-1] + seglen(a, b))
        self.h = [0.0] * len(self.m)


def key(p):
    return (round(p[0], 6), round(p[1], 6))


def load_raw(raw):
    ways, signals, crossings = {}, set(), set()
    for root, _, files in os.walk(raw):
        for fn in files:
            if not fn.endswith('.json') or fn == 'meta.json':
                continue
            with open(os.path.join(root, fn), encoding='utf-8') as f:
                d = json.load(f)
            for w in d.get('w', []):
                ways[w[0]] = w
            for s in d.get('s', []):
                signals.add(key(s))
            for x in d.get('x', []):
                crossings.add(key(x))
    return ways, signals, crossings


def build(raw):
    ways, signals, crossings = load_raw(raw)
    # node usage: how many way incidences per node (interior points count too)
    use = defaultdict(int)
    for wid, (_, tags, geom) in ways.items():
        seen = set()
        for p in geom:
            k = key(p)
            if k in seen:
                continue
            seen.add(k)
            use[k] += 1
    parts = []
    for wid, (_, tags, geom) in ways.items():
        lay = layout(tags)
        if lay['rev']:
            geom = geom[::-1]
        # split at junction nodes (shared with another way) — interior nodes only
        cut_idx = [0] + [i for i in range(1, len(geom) - 1) if use[key(geom[i])] > 1] + [len(geom) - 1]
        for pi, (a, b) in enumerate(zip(cut_idx, cut_idx[1:])):
            ll = geom[a:b + 1]
            if len(ll) < 2:
                continue
            part = Part(f'{wid}.{pi}', lay, ll)
            if part.L < 0.5:
                continue
            parts.append(part)
    # junction nodes: parts ending there
    ends = defaultdict(list)   # node -> [(part, at_end)]
    for p in parts:
        ends[p.n0].append((p, False))
        ends[p.n1].append((p, True))
    # cut-backs
    for node, lst in ends.items():
        if len(lst) < 2:
            continue
        dirs = []   # unit direction of each part pointing away from the node
        for p, at_end in lst:
            m = p.m
            u = (m[-2][0] - m[-1][0], m[-2][1] - m[-1][1]) if at_end else (m[1][0] - m[0][0], m[1][1] - m[0][1])
            L = math.hypot(*u) or 1.0
            dirs.append((u[0] / L, u[1] / L))
        if len(lst) == 2:
            # a plain join of two parts of the same road: no junction unless the widths differ a lot
            (pa, _), (pb, _) = lst
            if abs(pa.lay['W'] - pb.lay['W']) < 0.6:
                continue
        for i, (p, at_end) in enumerate(lst):
            cut = 0.0
            for j, (q, _) in enumerate(lst):
                if i == j:
                    continue
                dot = max(-1.0, min(1.0, dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1]))
                th = math.acos(dot)
                if th > math.radians(150):
                    continue  # the road continues straight through: no cut against it
                s = max(math.sin(th), 0.2)
                c = (q.lay['W'] / 2) / s
                if q.lay['W'] < 0.7 * p.lay['W']:
                    # A minor road joining a major one: the major road keeps its markings right up to
                    # the side road's kerb line, as nav maps draw it; only the side road is cut back.
                    c = min(c + 0.3, q.lay['W'] + 1.5)
                else:
                    if th < math.radians(90):
                        c += (p.lay['W'] / 2) / max(math.tan(th), 0.2)
                    c = min(c, 2.0 * (p.lay['W'] + q.lay['W']))
                cut = max(cut, c)
            cut = min(cut, MAX_CUT, p.L * 0.45)
            if at_end:
                p.ce = max(p.ce, cut)
            else:
                p.cs = max(p.cs, cut)
    # signals / crossings on parts
    for p in parts:
        last = len(p.ll) - 1
        for i, ll in enumerate(p.ll):
            k = key(ll)
            if k in signals:
                p.signals.append((along_of(p, ll), i == 0, i == last))
            if k in crossings:
                p.crossings.append(along_of(p, ll))
    solve_heights(parts, ends)
    return parts, ends, signals


def along_of(p, ll):
    q = p.frame.to_m(ll)
    best, acc, bestd = 0.0, 0.0, 1e9
    for a, b in zip(p.m, p.m[1:]):
        d = seglen(a, b)
        if d:
            t = max(0.0, min(1.0, ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (d * d)))
            x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            dd = math.hypot(q[0] - x, q[1] - y)
            if dd < bestd:
                bestd, best = dd, acc + d * t
        acc += d
    return best


# ───────────────────────── structures: heights ─────────────────────────
LEVEL_H = 6.0      # metres per OSM layer: ~5 m clearance + a 1 m deck
GRADE = 0.06       # approach ramps climb at 6 %
DECK_T = 0.9       # deck slab thickness
SLICE = 6.0        # the deck body under the smooth top is sliced this long on ramps
PIER_EVERY = 28.0


def h_at(p, s):
    """Height of part p at distance s along it (linear between vertices)."""
    cum, h = p.cum, p.h
    if s <= 0:
        return h[0]
    for i in range(1, len(cum)):
        if cum[i] >= s:
            t = (s - cum[i - 1]) / max(1e-9, cum[i] - cum[i - 1])
            return h[i - 1] + (h[i] - h[i - 1]) * t
    return h[-1]


def solve_heights(parts, ends):
    """
    OSM has no heights, only `layer`. Bridges are put at 6 m per layer; the roads leading up to
    them are tapered from the deck down to the ground at 6 % (the Yandex/Apple look of real ramps),
    stopping at the first junction with other roads. When a bridge starts straight out of a junction
    (OSM often begins `bridge=yes` at the abutment with no mapped approach), the last part of the
    bridge itself carries the slope. Tunnels stay at ground and are drawn dimmed.
    """
    bridges = [p for p in parts if p.lay['br']]
    for p in bridges:
        p.densify()
        H = LEVEL_H * max(1, p.lay['ly'])
        p.h = [H] * len(p.m)

    def continuation(node, frm):
        """The non-structure part that carries straight on from `frm` at `node`, or None."""
        best = None
        m = frm.m
        u = (m[-2][0] - m[-1][0], m[-2][1] - m[-1][1]) if frm.n1 == node else (m[1][0] - m[0][0], m[1][1] - m[0][1])
        L = math.hypot(*u) or 1.0
        u = (u[0] / L, u[1] / L)   # pointing away from the node, along frm
        for q, at_end in ends.get(node, []):
            if q is frm or q.lay['br'] or q.lay['tu'] or any(q.h):
                continue
            mq = q.m
            v = (mq[-2][0] - mq[-1][0], mq[-2][1] - mq[-1][1]) if at_end else (mq[1][0] - mq[0][0], mq[1][1] - mq[0][1])
            Lv = math.hypot(*v) or 1.0
            v = (v[0] / Lv, v[1] / Lv)
            dot = u[0] * v[0] + u[1] * v[1]
            if dot < -0.6 and (best is None or dot < best[0]):
                best = (dot, q, at_end)
        return best

    for p in bridges:
        H = p.h[0]
        need = H / GRADE
        for node, at_end in ((p.n0, False), (p.n1, True)):
            # chain of approach parts, each walked from the node outwards
            chain = []
            total = 0.0
            cur, cur_node = p, node
            while total < need and len(chain) < 8:
                c = continuation(cur_node, cur)
                if not c:
                    break
                _, q, q_at_end = c
                if not any(q.h):
                    q.densify()
                chain.append((q, q_at_end))
                total += q.L
                cur, cur_node = q, (q.n0 if q_at_end else q.n1)
                if len(ends.get(cur_node, [])) != 2:
                    break   # a junction with other roads: the ramp must be on the ground there
            if total < 25.0:
                # no usable approach: slope down on the bridge itself (its last 40 %)
                ramp = min(need, p.L * 0.4)
                for i, cum in enumerate(p.cum):
                    d = (p.L - cum) if at_end else cum
                    if d < ramp:
                        p.h[i] = min(p.h[i], H * d / ramp)
                if total == 0:
                    continue
            ramp = min(need, total)
            s0 = 0.0
            for q, q_at_end in chain:
                for i, cum in enumerate(q.cum):
                    d = s0 + ((q.L - cum) if q_at_end else cum)   # distance from the bridge end
                    q.h[i] = max(q.h[i], max(0.0, H * (1 - d / ramp)))
                s0 += q.L
    # smooth the kinks slightly (one pass of neighbour averaging on interior vertices)
    for p in parts:
        if any(p.h) and len(p.h) > 2:
            h = p.h[:]
            for i in range(1, len(h) - 1):
                p.h[i] = (h[i - 1] + 2 * h[i] + h[i + 1]) / 4


def slices(p):
    """[(s0, s1)] along the trimmed core of an elevated part: whole where flat, SLICE-long on ramps."""
    out = []
    s0 = p.cs
    end = p.L - p.ce
    while s0 < end - 0.5:
        s1 = min(end, s0 + SLICE)
        # extend the slice while the height stays flat
        while s1 < end - 0.5 and abs(h_at(p, s1 + SLICE) - h_at(p, s0)) < 0.05:
            s1 = min(end, s1 + SLICE)
        out.append((s0, s1))
        s0 = s1
    return out


def rect(fr, q, u, along0, along1, off0, off1):
    """Quad on the part's frame: along the direction u from q, between lateral offsets."""
    n = (u[1], -u[0])

    def pt(a, o):
        return fr.to_ll((q[0] + u[0] * a + n[0] * o, q[1] + u[1] * a + n[1] * o))
    return [pt(along0, off0), pt(along1, off0), pt(along1, off1), pt(along0, off1), pt(along0, off0)]


def strip_pts(p, s0, s1, step):
    """Sample distances along p between s0 and s1: every `step` metres plus the part's own vertices."""
    out = {round(s0, 3), round(s1, 3)}
    s = s0 + step
    while s < s1 - 0.3:
        out.add(round(s, 3))
        s += step
    for c in p.cum:
        if s0 + 0.3 < c < s1 - 0.3:
            out.add(round(c, 3))
    return sorted(out)


def samples(p, s0, s1, step):
    """[(s, q, n)] along p: point and mitred unit normal (right of travel, scaled so offsets keep their width)."""
    ss = strip_pts(p, s0, s1, step)
    pts = [point_at(p.m, sd)[0] for sd in ss]
    out = []
    for i, sd in enumerate(ss):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        if i == 0:
            d = (pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
        elif i == len(pts) - 1:
            d = (pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1])
        else:
            d1 = (pts[i][0] - a[0], pts[i][1] - a[1])
            d2 = (b[0] - pts[i][0], b[1] - pts[i][1])
            l1 = math.hypot(*d1) or 1.0
            l2 = math.hypot(*d2) or 1.0
            d = (d1[0] / l1 + d2[0] / l2, d1[1] / l1 + d2[1] / l2)
            # mitre: the bisector normal must be scaled by 1/cos(θ/2) = 2/|d1̂+d2̂| … capped
            L = math.hypot(*d)
            if L < 1e-6:
                d = d1
            else:
                k = min(3.0, 2.0 / L)
                n = (d[1] / L * k, -d[0] / L * k)
                out.append((sd, pts[i], n))
                continue
        L = math.hypot(*d) or 1.0
        out.append((sd, pts[i], (d[1] / L, -d[0] / L)))
    return out


def emit_structure(p, rec, add):
    """
    An elevated road part. The sloped surfaces — deck top, lane markings, parapets — are emitted as
    3-D triangle strips with a height per vertex ('m3'), so ramps are smooth; the deck body under
    them, the piers and the shadow are fill-extrusion slabs/fills (flat tops, sliced on ramps).
    """
    lay = p.lay
    fr = p.frame
    N = lay['f'] + lay['b']
    lw, left = lay['lw'], lay['l']
    right = left + N * lw
    sid = p.id
    cls = rec['c']
    s0, s1 = p.cs, p.L - p.ce
    if s1 - s0 < 1.0:
        return

    def vtx(sm, off, dz):
        sd, q, n = sm
        ll = fr.to_ll((q[0] + n[0] * off, q[1] + n[1] * off))
        return [ll[0], ll[1], round(h_at(p, sd) + dz, 2)]

    def ribbon3(sa, sb, off_a, off_b, dz, step=4.0):
        pts = []
        for sm in samples(p, sa, sb, step):
            pts.append(vtx(sm, off_a, dz))
            pts.append(vtx(sm, off_b, dz))
        return pts

    def wall3(sa, sb, off, dz0, dz1, step=4.0):
        pts = []
        for sm in samples(p, sa, sb, step):
            pts.append(vtx(sm, off, dz0))
            pts.append(vtx(sm, off, dz1))
        return pts

    def m3(kid, kind, pts, extra=None):
        f = {'id': f'{sid}{kid}', 'k': kind, 'q': pts, 's': sid}
        if extra:
            f.update(extra)
        add('m3', f, [[x[0], x[1]] for x in pts])

    # deck top (asphalt) and its markings, smooth
    m3('t', 'deck', ribbon3(s0, s1, left - 0.45, right + 0.45, 0.0), {'c': cls})
    ms0, ms1 = s0 + 0.2, s1 - 0.2
    if ms1 - ms0 > 1:
        for off in (left + EDGE_IN, right - EDGE_IN):
            m3(f'e{"L" if off < 0 else "R"}', 'dmk', ribbon3(ms0, ms1, off - 0.08, off + 0.08, 0.12))
        for i in range(1, N):
            off = left + i * lw
            centre = lay['b'] and i == lay['b']
            if centre and not (lay['f'] == 1 and lay['b'] == 1):
                for o in (off - 0.15, off + 0.15):
                    m3(f'c{i}{int(o * 10)}', 'dmk', ribbon3(ms0, ms1, o - 0.08, o + 0.08, 0.12))
                continue
            dash, gap = (3.0, 6.0) if centre else (3.0, 9.0)
            a = ms0 - (ms0 % (dash + gap))
            while a < ms1:
                d0, d1 = max(a, ms0), min(a + dash, ms1)
                if d1 - d0 > 0.4:
                    m3(f'm{i}{int(a)}', 'dmk', ribbon3(d0, d1, off - 0.08, off + 0.08, 0.12, step=8.0))
                a += dash + gap
    # parapets: vertical walls where the deck is up, with a thin cap
    rs = [sd for sd in strip_pts(p, s0, s1, 4.0) if h_at(p, sd) >= 1.0]
    if len(rs) >= 2:
        ra, rb = rs[0], rs[-1]
        for off in (left - 0.3, right + 0.3):
            tag = "L" if off < 0 else "R"
            m3(f'r{tag}', 'rail', wall3(ra, rb, off - 0.15, 0.0, 1.0) if off < 0 else wall3(ra, rb, off + 0.15, 0.0, 1.0))
            m3(f'rc{tag}', 'rail', ribbon3(ra, rb, off - 0.15, off + 0.15, 1.0))
    # deck body (sides) as slabs under the top, piers, shadow
    pier_next = PIER_EVERY / 2
    for k, (a, b) in enumerate(slices(p)):
        ha, hb = h_at(p, a), h_at(p, b)
        h = min(ha, hb)
        seg = sub(p.m, a, b)
        if seg is None:
            continue
        top = max(0.1, h - 0.35)
        base = max(0.0, max(ha, hb) - DECK_T)
        if top > base + 0.05:
            deck = [fr.to_ll(q) for q in ribbon(seg, left - 0.45, right + 0.45)]
            add('ex', {'id': f'{sid}d{k}', 'g': deck, 'b': round(base, 2), 'h': round(top, 2), 'k': 'deck', 's': sid, 'c': cls}, deck)
        hm = (ha + hb) / 2
        if hm >= 1.0:
            dx, dy = 0.45 * hm, -0.35 * hm
            sh = [fr.to_ll((q[0] + dx, q[1] + dy)) for q in ribbon(seg, left - 0.6, right + 0.6)]
            add('sh', {'id': f'{sid}s{k}', 'g': sh, 's': sid}, sh)
        while pier_next < b:
            if pier_next >= a and hm >= 3.5:
                q, u = point_at(p.m, pier_next)
                half = min(2.2, (right - left) * 0.3)
                ring = rect(fr, q, u, -0.8, 0.8, (left + right) / 2 - half, (left + right) / 2 + half)
                add('ex', {'id': f'{sid}p{int(pier_next)}', 'g': ring, 'b': 0, 'h': round(max(0.0, h_at(p, pier_next) - DECK_T), 2), 'k': 'pier', 's': sid}, ring)
            pier_next += PIER_EVERY


# ───────────────────────── features ─────────────────────────
def emit(parts, ends, signals):
    feats = defaultdict(dict)   # tile -> {kind: [features]}

    def add(kind, f, pts_ll):
        keys = set()
        for p in pts_ll:
            keys.add(tile(p[0], p[1]))
        for k in keys:
            feats[k].setdefault(kind, []).append(f)

    for p in parts:
        lay = p.lay
        fr = p.frame
        m = p.m
        N = lay['f'] + lay['b']
        lw, left = lay['lw'], lay['l']
        right = left + N * lw
        W = lay['W']
        # record
        keys = set()
        for a, b in zip(p.ll, p.ll[1:]):
            keys.add(tile(*a))
            steps = int(seglen(fr.to_m(a), fr.to_m(b)) // STEP_M)
            for i in range(1, steps + 1):
                t = i / (steps + 1)
                keys.add(tile(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        keys.add(tile(*p.ll[-1]))
        rec = {'id': p.id, 'c': lay['c'] + ('_link' if lay['link'] else ''), 'g': p.ll, 'lw': lw, 'l': left, 'f': lay['f'], 'b': lay['b'],
               'o': 1 if lay['o'] else 0, 'tf': lay['tf'], 'tb': lay['tb'], 'br': 1 if lay['br'] else 0, 'tu': 1 if lay['tu'] else 0,
               'ly': lay['ly'], 'ms': lay['ms'], 'mb': lay['mb'], 'rb': 1 if lay['rb'] else 0, 'cs': round(p.cs, 1), 'ce': round(p.ce, 1)}
        elevated = max(p.h) > 0.3
        if elevated:
            # heights along g (same vertices as m, which was de-duplicated from ll: map by nearest cum)
            rec['hz'] = [round(h_at(p, along_of(p, q)), 1) for q in p.ll]
        for k in keys:
            feats[k].setdefault('w', []).append(rec)
        core = sub(m, p.cs, p.L - p.ce)
        if core is None:
            core = sub(m, 0, p.L)
        if core is None:
            continue
        if elevated:
            emit_structure(p, rec, add)
            continue
        # asphalt between the cuts
        ring = [fr.to_ll(q) for q in ribbon(core, left, right)]
        add('surf', {'id': p.id, 'g': ring, 'c': rec['c'], 'br': rec['br'], 'tu': rec['tu'], 'ly': lay['ly']}, ring)
        # markings (clear of the junction by 0.3 m)
        mk_core = sub(m, p.cs + 0.3, p.L - p.ce - 0.3)
        if mk_core is not None:
            flags = {'ly': lay['ly'], 'br': rec['br']}

            seq = [0]

            def line(kind, off, src=mk_core, extra=None):
                pts = [fr.to_ll(q) for q in offset(src, off)]
                seq[0] += 1
                f = {'id': f'{p.id}m{seq[0]}', 'k': kind, 'g': pts, **flags}
                if extra:
                    f.update(extra)
                add('mk', f, pts)
            if lay['tu']:
                line('tedge', left - 0.1)
                line('tedge', right + 0.1)
            line('edge', left + EDGE_IN)
            line('edge', right - EDGE_IN)
            for i in range(1, N):
                off = left + i * lw
                if lay['b'] and i == lay['b']:
                    if lay['f'] == 1 and lay['b'] == 1:
                        line('cl1', off)
                    else:
                        line('cl2', off - 0.15)
                        line('cl2', off + 0.15)
                else:
                    line('div', off)
        # stop lines: before the junction cut on the approach lanes, at traffic lights
        for along, at_start, at_end in p.signals:
            if lay['f'] and (at_end or not (at_start or at_end)):
                s = (p.L - p.ce - 1.0) if at_end else along - 1.5
                stop(p, s, left + lay['b'] * lw, right, 'stop', add)
            if lay['b'] and (at_start or not (at_start or at_end)):
                s = (p.cs + 1.0) if at_start else along + 1.5
                stop(p, s, left, left + lay['b'] * lw, 'stop', add)
        # zebra crossings across the whole carriageway
        for along in p.crossings:
            if 1.5 < along < p.L - 1.5 or p.L < 3:
                stop(p, along, left - 0.3, right + 0.3, 'zebra', add)
        # painted turn arrows before the end (forward) / after the start (backward)
        if lay['tf']:
            for dist in ARROW_AT:
                s = p.L - p.ce - dist
                if s < p.cs + 6:
                    break
                q, u = point_at(m, s)
                for i, t in enumerate(lay['tf']):
                    if t == 'none':
                        continue
                    off = left + (lay['b'] + i + 0.5) * lw
                    pt = fr.to_ll((q[0] + u[1] * off, q[1] - u[0] * off))
                    add('ar', {'id': f'{p.id}f{i}{int(dist)}', 'g': pt, 'a': t, 'r': round(bearing(u), 1)}, [pt])
        if lay['tb']:
            for dist in ARROW_AT:
                s = p.cs + dist
                if s > p.L - p.ce - 6:
                    break
                q, u = point_at(m, s)
                ub = (-u[0], -u[1])
                for j, t in enumerate(lay['tb']):
                    if t == 'none':
                        continue
                    i = lay['b'] - 1 - j
                    off = left + (i + 0.5) * lw
                    pt = fr.to_ll((q[0] + u[1] * off, q[1] - u[0] * off))
                    add('ar', {'id': f'{p.id}b{j}{int(dist)}', 'g': pt, 'a': t, 'r': round(bearing(ub), 1)}, [pt])
    # junction polygons
    for node, lst in ends.items():
        if len(lst) < 2:
            continue
        # tunnel portals: a tunnel part meets a surface part here
        tun = [(p, e) for p, e in lst if p.lay['tu']]
        if tun and len(tun) < len(lst):
            for p, at_end in tun:
                fr = p.frame
                m = p.m
                if len(m) < 2:
                    continue
                L = plen(m)
                q, u = point_at(m, (L - 0.5) if at_end else 0.5)
                if at_end:
                    u = (-u[0], -u[1])  # pointing into the tunnel
                portal(p, fr, q, u, add)
        if all((p.ce if at_end else p.cs) == 0 for p, at_end in lst):
            continue  # plain join, nothing was cut
        guides(node, lst, add)
        p0 = lst[0][0]
        fr = p0.frame
        pts = [fr.to_m(node)]
        ly = 0
        for p, at_end in lst:
            m = dedupe([fr.to_m(q) for q in p.ll])
            if len(m) < 2:
                continue
            L = plen(m)
            s = (L - p.ce) if at_end else p.cs
            q, u = point_at(m, s)
            lay = p.lay
            N = lay['f'] + lay['b']
            for off in (lay['l'], lay['l'] + N * lay['lw']):
                pts.append((q[0] + u[1] * off, q[1] - u[0] * off))
            # and the kerb corners at the node itself so the hull covers the asphalt up to it
            qn, un = point_at(m, L if at_end else 0.0)
            for off in (lay['l'], lay['l'] + N * lay['lw']):
                pts.append((qn[0] + un[1] * off * 0.5, qn[1] - un[0] * off * 0.5))
            ly = max(ly, lay['ly']) if lay['ly'] >= 0 else min(ly, lay['ly'])
        if len(pts) < 3:
            continue
        h = hull(pts)
        if len(h) < 3:
            continue
        ring = [fr.to_ll(q) for q in h] + [fr.to_ll(h[0])]
        jid = f'j{node[0]}_{node[1]}'
        hj = max(h_at(p, p.L if at_end else 0.0) for p, at_end in lst)
        if hj > 0.3:
            add('ex', {'id': jid, 'g': ring, 'b': round(max(0.0, hj - DECK_T), 2), 'h': round(hj, 2), 'k': 'deck', 's': jid, 'c': lst[0][0].lay['c']}, ring)
        else:
            add('jn', {'id': jid, 'g': ring, 'ly': ly}, ring)
    # traffic lights
    for s in signals:
        add('s', [s[0], s[1]], [s])
    return feats


def guides(node, lst, add):
    """
    Lines across a junction between a road and its straight continuation: same-direction lane
    dividers continue as dotted guide lines (line 1.7), the centre line continues as itself, and
    the kerb-side edge line continues on the side where no road joins (a T-junction's far side).
    """
    ends = []
    for p, at_end in lst:
        m = p.m
        u = (m[-2][0] - m[-1][0], m[-2][1] - m[-1][1]) if at_end else (m[1][0] - m[0][0], m[1][1] - m[0][1])
        L = math.hypot(*u) or 1.0
        u = (u[0] / L, u[1] / L)                      # pointing away from the node
        lay = p.lay
        N = lay['f'] + lay['b']
        sgn = -1 if at_end else 1                     # way-frame offset → "away" frame
        lines = []                                    # (kind, away-offset)
        for i in range(1, N):
            off = lay['l'] + i * lay['lw']
            if lay['b'] and i == lay['b']:
                if lay['f'] == 1 and lay['b'] == 1:
                    lines.append(('cl1', off * sgn))
                else:
                    lines.append(('cl2', (off - 0.15) * sgn))
                    lines.append(('cl2', (off + 0.15) * sgn))
            else:
                lines.append(('guide', off * sgn))
        lines.append(('edge', (lay['l'] + EDGE_IN) * sgn))
        lines.append(('edge', (lay['l'] + N * lay['lw'] - EDGE_IN) * sgn))
        s = (p.L - p.ce) if at_end else p.cs
        q, d = point_at(m, s)
        ends.append((p, at_end, u, lines, q, h_at(p, s)))
    for a in range(len(ends)):
        for b in range(a + 1, len(ends)):
            pa, ea, ua, la, qa, ha = ends[a]
            pb, eb, ub, lb, qb, hb = ends[b]
            dot = ua[0] * ub[0] + ua[1] * ub[1]
            if dot > -0.8 or abs(ha - hb) > 0.3 or ha > 0.3:
                continue  # only straight continuations, on the ground
            na = (ua[1], -ua[0])
            nb = (ub[1], -ub[0])
            gap = math.hypot(qa[0] - qb[0], qa[1] - qb[1])
            if gap < 2.0 or gap > 40:
                continue
            # which side of this through-road do the other roads join? (positive = right of ua)
            joined = {1: False, -1: False}
            for c in range(len(ends)):
                if c in (a, b):
                    continue
                uc = ends[c][2]
                side = ua[0] * uc[1] - ua[1] * uc[0]
                joined[1 if side < 0 else -1] = True
            fr = pa.frame
            for k, (kind, off) in enumerate(la):
                match = [o for kk, o in lb if kk == kind and abs(o + off) < 0.3]
                if not match:
                    continue
                if kind == 'edge' and joined[1 if off > 0 else -1]:
                    continue   # roads join on this side: the kerb line is broken here
                o2 = match[0]
                p1 = (qa[0] + na[0] * off, qa[1] + na[1] * off)
                p2 = (qb[0] + nb[0] * o2, qb[1] + nb[1] * o2)
                pts = [fr.to_ll(p1), fr.to_ll(p2)]
                add('mk', {'id': f'g{node[0]}_{node[1]}_{pa.id}_{k}', 'k': kind, 'g': pts, 'ly': pa.lay['ly'], 'br': 0}, pts)


def stop(p, s, off_a, off_b, kind, add):
    if s <= 0 or s >= p.L:
        return
    q, u = point_at(p.m, s)
    a = (q[0] + u[1] * off_a, q[1] - u[0] * off_a)
    b = (q[0] + u[1] * off_b, q[1] - u[0] * off_b)
    pts = [p.frame.to_ll(a), p.frame.to_ll(b)]
    add('mk', {'id': f'{p.id}{kind}{int(s)}', 'k': kind, 'g': pts, 'ly': p.lay['ly'], 'br': 1 if p.lay['br'] else 0}, pts)


def portal(p, fr, q, u, add):
    """Tunnel mouth: two posts and a stepped arch, as fill-extrusion slabs (base b, top h)."""
    lay = p.lay
    N = lay['f'] + lay['b']
    half = N * lay['lw'] / 2 + 0.6
    cx = lay['l'] + N * lay['lw'] / 2   # carriageway centre offset from the way
    n = (u[1], -u[0])                    # right normal

    def pt(along, off):
        return fr.to_ll((q[0] + u[0] * along + n[0] * (cx + off), q[1] + u[1] * along + n[1] * (cx + off)))

    def slab(sid, a0, a1, o0, o1, b, h):
        ring = [pt(a0, o0), pt(a1, o0), pt(a1, o1), pt(a0, o1), pt(a0, o0)]
        add('ex', {'id': f'{p.id}{sid}', 'g': ring, 'b': round(b, 2), 'h': round(h, 2), 'k': 'portal'}, ring)
    H = 5.6   # clear height at the crown
    depth = 3.0
    slab('pL', 0, depth, -half - 1.2, -half + 0.3, 0, H + 1.2)
    slab('pR', 0, depth, half - 0.3, half + 1.2, 0, H + 1.2)
    # a stretch of roof behind the portal so the entrance reads as a covered opening
    slab('roof', depth, min(14.0, max(4.0, p.L * 0.3)), -half - 0.6, half + 0.6, H + 0.4, H + 1.0)
    slab('wL', depth, min(14.0, max(4.0, p.L * 0.3)), -half - 0.6, -half + 0.1, 0, H + 0.4)
    slab('wR', depth, min(14.0, max(4.0, p.L * 0.3)), half - 0.1, half + 0.6, 0, H + 0.4)
    steps = 9
    for i in range(steps):
        o0 = -half + 0.3 + (2 * half - 0.6) * i / steps
        o1 = -half + 0.3 + (2 * half - 0.6) * (i + 1) / steps
        mid = (o0 + o1) / 2 / (half - 0.3)
        base = max(2.6, H * math.sqrt(max(0.0, 1 - mid * mid)))
        slab(f'a{i}', 0, depth, o0 - 0.02, o1 + 0.02, base, H + 1.2)


# ───────────────────────── main ─────────────────────────
def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    raw, out = sys.argv[1], sys.argv[2]
    parts, ends, signals = build(raw)
    feats = emit(parts, ends, signals)
    built = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    try:
        with open(os.path.join(raw, 'meta.json'), encoding='utf-8') as f:
            meta = json.load(f)
    except OSError:
        meta = {}
    total = 0
    for (x, y), data in feats.items():
        d = os.path.join(out, str(Z), str(x))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{y}.json'), 'w', encoding='utf-8') as f:
            json.dump({'v': 3, 'built': built, **data}, f, ensure_ascii=False, separators=(',', ':'))
        total += 1
    meta.update({'v': 3, 'z': Z, 'built': built, 'tiles': total, 'parts': len(parts), 'signals': len(signals),
                 'license': 'Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)'})
    with open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=1)
    print(json.dumps(meta))


if __name__ == '__main__':
    main()
