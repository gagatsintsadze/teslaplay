import { bearing, distance, toRad } from '../core/geo';
import { isOneway, laneModel } from '../map/roadmodel';
import type { LngLat } from '../types';
export { isOneway };

/**
 * Lane-level road details from OpenStreetMap: lane counts, painted turn lanes (`turn:lanes`),
 * speed limits (`maxspeed`) and traffic lights, one zoom-14 tile (~1.8 km square in Georgia) at a time.
 *
 * Source, in order:
 *  1. Pre-built tiles for the whole country (`roads-data` branch, built weekly from the Geofabrik
 *     extract by .github/workflows/roads.yml) — a few KB each, instant, no rate limits
 *  2. Overpass, only when those aren't published yet (slow and rate-limited: 15–30 s per tile, 429s)
 * Tiles are kept in IndexedDB, so a known area shows instantly even offline.
 */

export const DETAIL_Z = 14;
const TTL = 30 * 864e5;
export const ROADS_DATA_URL = 'https://raw.githubusercontent.com/gagatsintsadze/teslaplay/roads-data/';
const ENDPOINTS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter'];
const HIGHWAYS = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$';
/** Tags kept per way (everything else Overpass returns is dropped before caching). */
const KEEP = ['highway', 'lanes', 'lanes:forward', 'lanes:backward', 'oneway', 'junction', 'turn:lanes', 'turn:lanes:forward',
  'turn:lanes:backward', 'maxspeed', 'maxspeed:forward', 'maxspeed:backward', 'divider', 'bridge', 'tunnel', 'layer'];

export interface RoadWay { id: number; g: LngLat[]; t: Record<string, string> }
export interface RoadTile { key: string; ways: RoadWay[]; signals: LngLat[]; crossings?: LngLat[]; time: number; /** Build stamp of the pre-built dataset it came from. */ built?: string }

export const tileKey = (x: number, y: number) => `${DETAIL_Z}/${x}/${y}`;

export function tileOf(p: LngLat, z = DETAIL_Z): [number, number] {
  const n = 2 ** z;
  const lat = toRad(p[1]);
  return [Math.floor(((p[0] + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n)];
}

function tileBbox(x: number, y: number, z = DETAIL_Z): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => { const m = Math.PI - (2 * Math.PI * j) / n; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m))); };
  return [lat(y + 1), lon(x), lat(y), lon(x + 1)]; // south, west, north, east
}

// ───────────────────────── IndexedDB cache ─────────────────────────
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('teslaplay-roads', 1);
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
  private endpoint = 0;
  /** The pre-built dataset's build stamp, or null when it isn't published (→ Overpass). */
  private meta: Promise<string | null>;
  /** Where tiles come from right now (Settings → Map services). */
  source = 'loading';

  constructor(private dataUrl = ROADS_DATA_URL) {
    this.meta = fetch(`${dataUrl}meta.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        const built = m && typeof m.built === 'string' ? m.built : null;
        this.source = built ? `pre-built (OpenStreetMap ${built.slice(0, 10)})` : 'Overpass (live)';
        return built;
      }, () => { this.source = 'Overpass (live)'; return null; });
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

  /** Tiles a route passes through, in driving order (capped so a long trip doesn't flood Overpass). */
  along(coords: LngLat[], max = 40): [number, number][] {
    const seen = new Set<string>();
    const out: [number, number][] = [];
    let last: LngLat | null = null;
    for (const c of coords) {
      if (last && distance(last, c) < 250) continue;
      last = c;
      const t = tileOf(c);
      const k = t.join('/');
      if (!seen.has(k)) { seen.add(k); out.push(t); if (out.length >= max) break; }
    }
    return out;
  }

  private parallel = 2;

  private pump() {
    while (this.inflight.size < this.parallel && this.queue.length) {
      const job = this.queue.shift()!;
      this.inflight.add(job.key);
      this.load(job.x, job.y).then((t) => {
        this.tiles.set(t.key, t);
        this.listeners.forEach((cb) => cb(t));
      }, (e) => {
        console.warn('[roads] tile', job.key, e);
        this.failed.set(job.key, Date.now() + 5 * 60e3);
      }).then(() => { this.inflight.delete(job.key); this.pump(); });
    }
  }

  private async load(x: number, y: number): Promise<RoadTile> {
    const key = tileKey(x, y);
    const cached = await idbGet(key);
    const built = await this.meta;
    if (built) {
      this.parallel = 6; // static files: no need to be gentle
      if (cached && cached.built === built) return cached;
      try {
        const r = await fetch(`${this.dataUrl}${DETAIL_Z}/${x}/${y}.json`);
        if (r.status === 404) { const empty: RoadTile = { key, ways: [], signals: [], time: Date.now(), built }; idbPut(empty); return empty; }
        if (!r.ok) throw new Error(`roads ${r.status}`);
        const j = await r.json();
        const tile: RoadTile = {
          key, built, time: Date.now(),
          ways: (j.w || []).map((w: any[]) => ({ id: w[0], t: w[1], g: w[2] })),
          signals: j.s || [],
          crossings: j.x || [],
        };
        idbPut(tile);
        return tile;
      } catch (e) {
        if (cached) return cached;
        throw e;
      }
    }
    if (cached && Date.now() - cached.time < TTL) return cached;
    const [s, w, n, e] = tileBbox(x, y);
    const q = `[out:json][timeout:60][bbox:${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}];`
      + `(way[highway~"${HIGHWAYS}"];node[highway=traffic_signals];node[highway=crossing][crossing!=unmarked];);out geom qt;`;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
      const ep = ENDPOINTS[(this.endpoint + attempt) % ENDPOINTS.length];
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 75000);
        const r = await fetch(ep, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ac.signal });
        clearTimeout(timer);
        if (!r.ok) throw new Error(`Overpass ${r.status}`);
        const j = await r.json();
        const tile = compact(key, j.elements || []);
        idbPut(tile);
        return tile;
      } catch (err) {
        lastErr = err;
        this.endpoint = (this.endpoint + 1) % ENDPOINTS.length; // try the other server next time
      }
    }
    if (cached) return cached; // stale beats nothing
    throw lastErr;
  }

  /**
   * Metres to shift each route vertex to the right so the line sits in the lanes of travel instead of
   * on the road's centre line: half the forward carriageway on two-way roads, 0 on one-way roads and
   * where the road is unknown. `heading` per vertex comes from the route itself.
   */
  driveSideOffsets(coords: LngLat[]): number[] { return this.driveBands(coords).map((b) => b.off); }

  /** Per vertex: metres to shift right, and width (m) of the carriageway the car drives in (0 = unknown). */
  driveBands(coords: LngLat[]): { off: number; w: number }[] {
    const out: { off: number; w: number }[] = coords.map(() => ({ off: 0, w: 0 }));
    let tile: RoadTile | undefined;
    let key = '';
    for (let i = 0; i < coords.length; i++) {
      const p = coords[i];
      const k = tileKey(...tileOf(p));
      if (k !== key) { key = k; tile = this.tiles.get(k); }
      if (!tile) continue;
      const nxt = coords[Math.min(i + 1, coords.length - 1)], prv = coords[Math.max(i - 1, 0)];
      const h = bearing(prv, nxt);
      let best: { d: number; off: number; w: number } | null = null;
      for (const w of tile.ways) {
        const m = laneModel(w.t);
        if (!m || m.tunnel) continue;
        // Signed distance from the route vertex to the way's centre line (positive = vertex is right of it),
        // in the direction of travel, so the band lands on the road however far the router's line is from OSM's.
        const near = nearestOnWay(p, w.g, h, 12, !m.oneway);
        if (!near || (best && near.d >= best.d)) continue;
        // One-way: centre the band on the carriageway. Two-way: on the forward lanes.
        // Two-way roads driven against the way's direction use its backward lanes.
        const lanes = m.oneway ? m.F + m.B : near.along ? m.F : m.B;
        best = { d: near.d, off: -near.signed + (m.oneway ? 0 : (lanes * m.lw) / 2), w: lanes * m.lw };
      }
      if (best) out[i] = { off: best.off, w: best.w };
    }
    // Smooth single-vertex gaps so the band doesn't zig-zag between matched and unmatched ways.
    for (let i = 1; i < out.length - 1; i++) {
      if (!out[i].w && out[i - 1].w && out[i + 1].w) out[i] = { off: (out[i - 1].off + out[i + 1].off) / 2, w: (out[i - 1].w + out[i + 1].w) / 2 };
    }
    return out;
  }

  /**
   * Posted limit (km/h) of the road at `p` for a car heading `heading` (degrees), from any loaded
   * tile; null when unknown. Matches the nearest tagged way within 18 m running the same way.
   */
  speedLimitAt(p: LngLat, heading: number | null): number | null {
    const key = tileKey(...tileOf(p));
    const tile = this.tiles.get(key);
    if (!tile) return null;
    let best: { d: number; v: number | null } | null = null;
    for (const w of tile.ways) {
      const t = w.t;
      if (!t.maxspeed && !t['maxspeed:forward'] && !t['maxspeed:backward']) continue;
      for (let i = 0; i < w.g.length - 1; i++) {
        const d = segDistance(p, w.g[i], w.g[i + 1]);
        if (d > 18 || (best && d >= best.d)) continue;
        let forward = true;
        if (heading !== null) {
          const b = bearing(w.g[i], w.g[i + 1]);
          const diff = Math.abs(((heading - b + 540) % 360) - 180);
          if (diff > 40 && diff < 140) continue; // crossing road
          forward = diff <= 90;
          if (!forward && isOneway(t) === 1) continue;
        }
        const v = parseSpeed((forward ? t['maxspeed:forward'] : t['maxspeed:backward']) || t.maxspeed);
        best = { d, v };
      }
    }
    return best ? best.v : null;
  }
}

function compact(key: string, elements: any[]): RoadTile {
  const ways: RoadWay[] = [];
  const signals: LngLat[] = [];
  const crossings: LngLat[] = [];
  for (const el of elements) {
    if (el.type === 'node' && typeof el.lon === 'number') (el.tags && el.tags.highway === 'crossing' ? crossings : signals).push([+el.lon.toFixed(6), +el.lat.toFixed(6)]);
    else if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length > 1) {
      const t: Record<string, string> = {};
      for (const k of KEEP) if (el.tags && el.tags[k] !== undefined) t[k] = String(el.tags[k]);
      ways.push({ id: el.id, g: el.geometry.map((p: any) => [+p.lon.toFixed(6), +p.lat.toFixed(6)] as LngLat), t });
    }
  }
  return { key, ways, signals, crossings, time: Date.now() };
}

/** "50" / "60 mph" / "GE:urban" → km/h (null when unknown or unlimited). */
export function parseSpeed(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?/i.exec(v.trim());
  if (m) return Math.round(+m[1] * (m[2] && /mph/i.test(m[2]) ? 1.609 : 1));
  const zone: Record<string, number> = { urban: 60, rural: 90, motorway: 110, living_street: 20 };
  const z = /:(\w+)$/.exec(v);
  return z && zone[z[1]] ? zone[z[1]] : null;
}

/**
 * Nearest segment of `g` running within ±60° of `heading` (or against it too, when `eitherWay`):
 * distance and signed offset of `p` from it (positive = p is right of the direction of travel).
 */
function nearestOnWay(p: LngLat, g: LngLat[], heading: number, max: number, eitherWay: boolean): { d: number; signed: number; along: boolean } | null {
  let best: { d: number; signed: number; along: boolean } | null = null;
  for (let i = 0; i < g.length - 1; i++) {
    const d = segDistance(p, g[i], g[i + 1]);
    if (d > max || (best !== null && d >= best.d)) continue;
    const segB = bearing(g[i], g[i + 1]);
    const diff = Math.abs(((heading - segB + 540) % 360) - 180);
    const along = diff <= 60, against = diff >= 120;
    if (!along && !(eitherWay && against)) continue;
    // Direction of travel along this segment: with its geometry when the car heads that way.
    const travelB = along ? segB : segB + 180;
    const side = Math.sign(Math.sin(toRad(bearing(g[i], p) - travelB)));
    best = { d, signed: side * d, along };
  }
  return best;
}

function segDistance(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = Math.cos(toRad(p[1])) * 111320;
  const ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
