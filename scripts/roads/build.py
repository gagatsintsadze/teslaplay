#!/usr/bin/env python3
"""
Stage 1 of Teslaplay's road pipeline: pull the drivable roads out of an OpenStreetMap extract.

    python scripts/roads/build.py georgia-latest.osm.pbf raw/
    python scripts/roads/lanes.py raw/ out/          # stage 2: the lane model the app draws

Writes raw/14/<x>/<y>.json for every zoom-14 tile (~1.8 km in Georgia) that has data:

    {"v": 1, "w": [[way_id, {tags}, [[lon, lat], ...]], ...], "s": [[lon, lat], ...]}

- "w": every drivable road (motorway … living_street, incl. links and roundabouts) with only the tags
       the app draws from: lanes, turn lanes, speed limits, oneway/junction, bridge/tunnel/layer
- "s": traffic lights (highway=traffic_signals)
- "x": pedestrian crossings (highway=crossing) — drawn as zebra stripes

plus raw/meta.json. lanes.py turns these into the lane model (asphalt, junctions, markings, arrows)
published for the app. Run weekly by .github/workflows/roads.yml.
"""
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

import osmium

Z = 14
HIGHWAYS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
            'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}
RELEVANT_UNUSED = {'lanes', 'lanes:forward', 'lanes:backward', 'turn:lanes', 'turn:lanes:forward', 'turn:lanes:backward',
            'maxspeed', 'maxspeed:forward', 'maxspeed:backward'}
KEEP = ['highway', 'lanes', 'lanes:forward', 'lanes:backward', 'oneway', 'junction', 'turn:lanes', 'turn:lanes:forward',
        'turn:lanes:backward', 'maxspeed', 'maxspeed:forward', 'maxspeed:backward', 'divider', 'bridge', 'tunnel', 'layer',
        'width', 'placement', 'placement:forward', 'name',
        'change:lanes', 'change:lanes:forward', 'change:lanes:backward',
        'bus:lanes', 'bus:lanes:forward', 'bus:lanes:backward', 'psv:lanes', 'psv:lanes:forward', 'psv:lanes:backward',
        'lanes:bus', 'lanes:bus:forward', 'lanes:bus:backward', 'lanes:psv', 'lanes:psv:forward', 'lanes:psv:backward', 'busway']
STEP_M = 250  # sample long segments so a way is filed under every tile it crosses


def tile(lon, lat):
    n = 2 ** Z
    lat_r = math.radians(max(-85.0, min(85.0, lat)))
    return (int((lon + 180) / 360 * n), int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n))


def metres(a, b):
    kx = math.cos(math.radians((a[1] + b[1]) / 2)) * 111320
    return math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540)


class Collect(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.tiles = defaultdict(lambda: {'w': [], 's': [], 'x': []})
        self.ways = 0
        self.signals = 0

    def node(self, n):
        hw = n.tags.get('highway')
        if hw == 'traffic_signals' and n.location.valid():
            lon, lat = n.location.lon, n.location.lat
            self.tiles[tile(lon, lat)]['s'].append([round(lon, 6), round(lat, 6)])
            self.signals += 1
        elif hw == 'crossing' and n.location.valid() and n.tags.get('crossing') not in ('unmarked', 'no', 'informal'):
            lon, lat = n.location.lon, n.location.lat
            self.tiles[tile(lon, lat)]['x'].append([round(lon, 6), round(lat, 6)])

    def way(self, w):
        if w.tags.get('highway') not in HIGHWAYS:
            return
        try:
            coords = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return
        tags = {k: w.tags.get(k) for k in KEEP if k in w.tags}
        geom = [[round(lon, 6), round(lat, 6)] for lon, lat in coords]
        keys = set()
        for a, b in zip(coords, coords[1:]):
            keys.add(tile(*a))
            steps = int(metres(a, b) // STEP_M)
            for i in range(1, steps + 1):
                t = i / (steps + 1)
                keys.add(tile(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        keys.add(tile(*coords[-1]))
        for k in keys:
            self.tiles[k]['w'].append([w.id, tags, geom])
        self.ways += 1


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    *sources, out = sys.argv[1:]
    h = Collect()
    for src in sources:
        h.apply_file(src, locations=True)
    built = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    total = 0
    for (x, y), data in h.tiles.items():
        d = os.path.join(out, str(Z), str(x))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{y}.json'), 'w', encoding='utf-8') as f:
            json.dump({'v': 2, 'built': built, 'w': data['w'], 's': data['s'], 'x': data['x']}, f, ensure_ascii=False, separators=(',', ':'))
        total += 1
    meta = {'v': 1, 'z': Z, 'built': built, 'tiles': total, 'ways': h.ways, 'signals': h.signals,
            'sources': [os.path.basename(s) for s in sources],
            'license': 'Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)'}
    with open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=1)
    print(json.dumps(meta))


if __name__ == '__main__':
    main()
