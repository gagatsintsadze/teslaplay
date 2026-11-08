import { bearing, toRad } from '../core/geo';
import type { LngLat } from '../types';

/**
 * The lane model: pre-built, country-wide road detail from OpenStreetMap, one zoom-14 tile
 * (~1.8 km square in Georgia) at a time. Everything is computed offline by scripts/roads/lanes.py
 * — lane layouts, asphalt polygons, junction polygons, white markings, painted arrows, bridge
 * parapets and tunnel portals — in real metres, so the app only draws what it is given and
 * never offsets lines at run time (see docs in lanes.py for the tile format).
 *
 * Tiles are published on the `roads-data` branch by .github/workflows/roads.yml and kept in
 * IndexedDB, so a known area shows instantly, even offline.
 */

export const DETAIL_Z = 14;
export const ROADS_DATA_URL = 'https://raw.githubusercontent.com/gagatsintsadze/teslaplay/roads-data/';
const FORMAT = 3;

/** One drivable stretch of road between two junctions, with its lane layout. */
export interface LaneRecord {
  id: string;
  /** Road class (motorway … minor, service; `_link` suffix for ramps). */
  c: string;
  /** Reference line (the OSM way, in the direction of its forward lanes). */
  g: LngLat[];
  /** Lane width, metres. */
  lw: number;
  /** Offset of the carriageway's left edge from `g`, metres (right of travel positive, so negative). */
  l: number;
  /** Forward / backward lane counts (backward is 0 on one-way roads). */
  f: number;
  b: number;
  o: 0 | 1;
  /** Per-lane turn arrows, left → right in each direction's own travel frame (OSM `turn:lanes` values). */
  tf: string[] | null;
  tb: string[] | null;
  br: 0 | 1;
  tu: 0 | 1;
  ly: number;
  /** Speed limits, km/h: forward / backward. */
  ms: number | null;
  mb: number | null;
  rb: 0 | 1;
  /** Junction cut-back at the start / end of `g`, metres. */
  cs: number;
  ce: number;
  /** Height above ground per vertex of `g`, metres — only on bridges and their ramps. */
  hz?: number[];
  /** OSM change:lanes per lane (yes | no | not_left | not_right), forward / backward travel frames. */
  cf?: string[];
  cb?: string[];
  /** Bus/PSV lanes (1) per lane, forward / backward travel frames. */
  bf?: number[];
  bb?: number[];
  /** Junction connectivity for forward / backward travel: how this road's lanes feed each road it can leave by. */
  cn?: LaneConnection[];
  cnb?: LaneConnection[];
}

export interface LaneConnection {
  /** record id of the road left by, and its travel direction there ('f' | 'b') */
  to: string; d: 'f' | 'b';
  t: 'through' | 'left' | 'right' | 'uturn';
  /** [fromLane, toLane] pairs, travel frames (0 = leftmost) */
  m: [number, number][];
}

export interface RoadTile {
  key: string;
  built: string;
  time: number;
  lanes: LaneRecord[];
  /** Drawable features by kind (GeoJSON Feature arrays): surf, jn, mk, ar, ex, sig. */
  draw: Record<string, any[]>;
}

export interface RoadScene { surf: any; jn: any; mk: any; ar: any; ex: any; sh: any; sig: any; /** smooth 3-D strips (bridge tops, markings, parapets): {id, s, k, c, q:[[lon,lat,z]…]} */ m3: any[] }

export const tileKey = (x: number, y: number) => `${DETAIL_Z}/${x}/${y}`;

export function tileOf(p: LngLat, z = DETAIL_Z): [number, number] {
  const n = 2 ** z;
  const lat = toRad(p[1]);
  return [Math.floor(((p[0] + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n)];
}

// ───────────────────────── IndexedDB cache ─────────────────────────
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('teslaplay-lanes', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('tiles');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbp;
}
async function idbGet(key: string): Promise<RoadTile | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const r = d.transaction('tiles').objectStore('tiles').get(key);
      r.onsuccess = () => resolve((r.result as RoadTile) || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function idbPut(tile: RoadTile) {
  const d = await db();
  if (!d) return;
  try { d.transaction('tiles', 'readwrite').objectStore('tiles').put(tile, tile.key); } catch { /* quota / private mode */ }
}

// ───────────────────────── service ─────────────────────────
export class RoadDetails {
  readonly tiles = new Map<string, RoadTile>();
  private queue: { key: string; x: number; y: number; prio: number }[] = [];
  private inflight = new Set<string>();
  private failed = new Map<string, number>();
  private listeners: ((t: RoadTile) => void)[] = [];
  /** The dataset's build stamp, or null when no usable dataset is published. */
  private meta: Promise<string | null>;
  /** Where the lane model comes from right now (Settings → Map services). */
  source = 'loading';

  constructor(private dataUrl = ROADS_DATA_URL) {
    this.meta = fetch(`${dataUrl}meta.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (!m || typeof m.built !== 'string') { this.source = 'not published'; return null; }
        if ((m.v || 0) < FORMAT) { this.source = `dataset v${m.v} is older than the app (v${FORMAT}) — rebuilding`; return null; }
        this.source = `pre-built lane model (OpenStreetMap ${m.built.slice(0, 10)})`;
        return m.built as string;
      }, () => { this.source = 'unreachable'; return null; });
  }

  onTile(cb: (t: RoadTile) => void) { this.listeners.push(cb); }

  /** Make sure these tiles get loaded (lower `prio` first: the view before the route ahead). */
  request(tiles: [number, number][], prio: number) {
    for (const [x, y] of tiles) {
      const key = tileKey(x, y);
      if (this.tiles.has(key) || this.inflight.has(key)) continue;
      if ((this.failed.get(key) || 0) > Date.now()) continue;
      const q = this.queue.find((e) => e.key === key);
      if (q) q.prio = Math.min(q.prio, prio);
      else this.queue.push({ key, x, y, prio });
    }
    this.queue.sort((a, b) => a.prio - b.prio);
    this.pump();
  }

  /** The tile under `center` and its eight neighbours. */
  around(center: LngLat): [number, number][] {
    const [x, y] = tileOf(center);
    const out: [number, number][] = [[x, y]];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) out.push([x + dx, y + dy]);
    return out;
  }

  /** Tiles a route passes through, in driving order. */
  along(coords: LngLat[], max = 60): [number, number][] {
    const seen = new Set<string>();
    const out: [number, number][] = [];
    for (const c of coords) {
      const t = tileOf(c);
      const k = t.join('/');
      if (!seen.has(k)) { seen.add(k); out.push(t); if (out.length >= max) break; }
    }
    return out;
  }

  /** Everything drawable in these tiles, de-duplicated (a road crossing a tile edge is in both). */
  scene(keys: string[]): RoadScene {
    const out: Record<string, any[]> = { surf: [], jn: [], mk: [], ar: [], ex: [], sh: [], sig: [], m3: [] };
    const seen = new Set<string>();
    for (const k of keys) {
      const t = this.tiles.get(k);
      if (!t) continue;
      for (const kind of Object.keys(out)) {
        for (const f of t.draw[kind] || []) {
          const id = `${kind}:${(f.properties || f).id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out[kind].push(f);
        }
      }
    }
    const fc = (features: any[]) => ({ type: 'FeatureCollection', features });
    return { surf: fc(out.surf), jn: fc(out.jn), mk: fc(out.mk), ar: fc(out.ar), ex: fc(out.ex), sh: fc(out.sh), sig: fc(out.sig), m3: out.m3 };
  }

  /** Lane records in the tile under `p` (empty when it isn't loaded). */
  lanesAt(p: LngLat): LaneRecord[] {
    const t = this.tiles.get(tileKey(...tileOf(p)));
    return t ? t.lanes : [];
  }

  /** Is the tile under `p` loaded? */
  has(p: LngLat): boolean { return this.tiles.has(tileKey(...tileOf(p))); }

  private pump() {
    while (this.inflight.size < 6 && this.queue.length) {
      const job = this.queue.shift()!;
      this.inflight.add(job.key);
      this.load(job.x, job.y).then((t) => {
        if (!t) return;
        this.tiles.set(t.key, t);
        this.listeners.forEach((cb) => cb(t));
      }, (e) => {
        console.warn('[roads] tile', job.key, e);
        this.failed.set(job.key, Date.now() + 5 * 60e3);
      }).then(() => { this.inflight.delete(job.key); this.pump(); });
    }
  }

  private async load(x: number, y: number): Promise<RoadTile | null> {
    const key = tileKey(x, y);
    const built = await this.meta;
    const cached = await idbGet(key);
    if (!built) return cached && cached.lanes ? cached : null;
    if (cached && cached.built === built && cached.lanes) return cached;
    try {
      const r = await fetch(`${this.dataUrl}${DETAIL_Z}/${x}/${y}.json`);
      if (r.status === 404) { const empty: RoadTile = { key, built, time: Date.now(), lanes: [], draw: {} }; idbPut(empty); return empty; }
      if (!r.ok) throw new Error(`roads ${r.status}`);
      const tile = parseTile(key, built, await r.json());
      idbPut(tile);
      return tile;
    } catch (e) {
      if (cached && cached.lanes) return cached;
      throw e;
    }
  }

  /**
   * Posted limit (km/h) of the road at `p` for a car heading `heading` (degrees), from any loaded
   * tile; null when unknown. Nearest tagged road within 18 m running the same way.
   */
  speedLimitAt(p: LngLat, heading: number | null): number | null {
    let best: { d: number; v: number | null } | null = null;
    for (const w of this.lanesAt(p)) {
      if (w.ms === null && w.mb === null) continue;
      for (let i = 0; i < w.g.length - 1; i++) {
        const d = segDistance(p, w.g[i], w.g[i + 1]);
        if (d > 18 || (best && d >= best.d)) continue;
        let forward = true;
        if (heading !== null) {
          const b = bearing(w.g[i], w.g[i + 1]);
          const diff = Math.abs(((heading - b + 540) % 360) - 180);
          if (diff > 40 && diff < 140) continue; // crossing road
          forward = diff <= 90;
          if (!forward && w.o) continue;
        }
        best = { d, v: forward ? w.ms : w.mb };
      }
    }
    return best ? best.v : null;
  }
}

/** Tile JSON (see lanes.py) → lane records + GeoJSON features per kind. */
export function parseTile(key: string, built: string, j: any): RoadTile {
  const draw: Record<string, any[]> = { surf: [], jn: [], mk: [], ar: [], ex: [], sh: [], sig: [], m3: [] };
  const poly = (kind: string, props: (f: any) => any) => {
    for (const f of j[kind] || []) draw[kind].push({ type: 'Feature', properties: { id: f.id, ...props(f) }, geometry: { type: 'Polygon', coordinates: [f.g] } });
  };
  poly('surf', (f) => ({ c: f.c, br: f.br, tu: f.tu, ly: f.ly }));
  poly('jn', (f) => ({ ly: f.ly }));
  poly('ex', (f) => ({ k: f.k, b: f.b, h: f.h, s: f.s || f.id, c: f.c || '' }));
  poly('sh', (f) => ({ s: f.s }));
  for (const f of j.m3 || []) draw.m3.push(f);
  for (const f of j.mk || []) draw.mk.push({ type: 'Feature', properties: { id: f.id, k: f.k, ly: f.ly, br: f.br }, geometry: { type: 'LineString', coordinates: f.g } });
  for (const f of j.ar || []) draw.ar.push({ type: 'Feature', properties: { id: f.id, icon: `ta:${f.a}`, rot: f.r }, geometry: { type: 'Point', coordinates: f.g } });
  for (const s of j.s || []) draw.sig.push({ type: 'Feature', properties: { id: `${s[0]},${s[1]}` }, geometry: { type: 'Point', coordinates: s } });
  return { key, built, time: Date.now(), lanes: (j.w || []) as LaneRecord[], draw };
}

export function segDistance(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = Math.cos(toRad(p[1])) * 111320;
  const ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
