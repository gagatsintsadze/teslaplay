import type { LngLat, LngLatBounds } from '../types';

const R = 6371008.8;
const D2R = Math.PI / 180;
export const toRad = (d: number) => d * D2R;
export const toDeg = (r: number) => r / D2R;

/** Great-circle distance in metres. */
export function distance(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a→b in degrees [0, 360). */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalize360(toDeg(Math.atan2(y, x)));
}

export const normalize360 = (a: number) => ((a % 360) + 360) % 360;
export const normalize180 = (a: number) => { const n = normalize360(a); return n > 180 ? n - 360 : n; };
/** Signed smallest difference b − a in degrees, (−180, 180]. */
export const angleDiff = (a: number, b: number) => normalize180(b - a);
export const lerpAngle = (a: number, b: number, t: number) => normalize360(a + angleDiff(a, b) * t);

export function destination(p: LngLat, brg: number, dist: number): LngLat {
  const δ = dist / R;
  const θ = toRad(brg);
  const φ1 = toRad(p[1]);
  const λ1 = toRad(p[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [normalize180(toDeg(λ2)), toDeg(φ2)];
}

export const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function cumulative(coords: LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) out[i] = out[i - 1] + distance(coords[i - 1], coords[i]);
  return out;
}

function segmentAt(cum: number[], d: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  if (d <= 0) return 0;
  if (d >= cum[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  return lo;
}

/** Point at distance `d` along a polyline, plus local bearing. */
export function pointAt(coords: LngLat[], cum: number[], d: number): { coord: LngLat; seg: number; bearing: number } {
  if (coords.length === 1) return { coord: coords[0], seg: 0, bearing: 0 };
  const seg = segmentAt(cum, d);
  const a = coords[seg];
  const b = coords[seg + 1] || a;
  const len = cum[seg + 1] - cum[seg];
  const t = len > 0 ? Math.min(1, Math.max(0, (d - cum[seg]) / len)) : 0;
  return { coord: lerp(a, b, t), seg, bearing: bearing(a, b) };
}

/** Average heading of the polyline over [d1, d2] (robust to tiny zig-zags). */
export function bearingBetween(coords: LngLat[], cum: number[], d1: number, d2: number): number {
  return bearing(pointAt(coords, cum, d1).coord, pointAt(coords, cum, d2).coord);
}

export interface Projection { d: number; offset: number; coord: LngLat; seg: number }

/** Nearest point on the polyline to `p`, restricted to the distance window [fromD, toD]. */
export function projectOnRoute(coords: LngLat[], cum: number[], p: LngLat, fromD = 0, toD = Infinity): Projection | null {
  const kx = Math.cos(toRad(p[1])) * R * D2R;
  const ky = R * D2R;
  let best: Projection | null = null;
  const start = Math.max(0, segmentAt(cum, fromD));
  for (let i = start; i < coords.length - 1; i++) {
    if (cum[i] > toD) break;
    const ax = (coords[i][0] - p[0]) * kx;
    const ay = (coords[i][1] - p[1]) * ky;
    const bx = (coords[i + 1][0] - p[0]) * kx;
    const by = (coords[i + 1][1] - p[1]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const off = Math.sqrt(qx * qx + qy * qy);
    if (!best || off < best.offset) {
      best = { d: cum[i] + t * (cum[i + 1] - cum[i]), offset: off, coord: lerp(coords[i], coords[i + 1], t), seg: i };
    }
  }
  return best;
}

export function boundsOf(coords: LngLat[]): LngLatBounds {
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [[w, n], [e, s]];
}

export function padBounds(b: LngLatBounds, minSpanDeg = 0.004): LngLatBounds {
  let [[w, n], [e, s]] = b;
  if (e - w < minSpanDeg) { const c = (e + w) / 2; w = c - minSpanDeg / 2; e = c + minSpanDeg / 2; }
  if (n - s < minSpanDeg) { const c = (n + s) / 2; s = c - minSpanDeg / 2; n = c + minSpanDeg / 2; }
  return [[w, n], [e, s]];
}

export const boundsCenter = (b: LngLatBounds): LngLat => [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];

/** Douglas–Peucker simplification with tolerance in metres (iterative, safe for long routes). */
export function simplify(coords: LngLat[], tol: number): LngLat[] {
  if (coords.length <= 2) return coords.slice();
  const lat0 = toRad(coords[0][1]);
  const kx = Math.cos(lat0) * R * D2R;
  const ky = R * D2R;
  const xs = coords.map((c) => c[0] * kx);
  const ys = coords.map((c) => c[1] * ky);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const dx = xs[b] - xs[a];
    const dy = ys[b] - ys[a];
    const l2 = dx * dx + dy * dy || 1e-9;
    for (let i = a + 1; i < b; i++) {
      let t = ((xs[i] - xs[a]) * dx + (ys[i] - ys[a]) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const ex = xs[a] + t * dx - xs[i];
      const ey = ys[a] + t * dy - ys[i];
      const d2 = ex * ex + ey * ey;
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (idx > 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/** Google encoded polyline (lat,lng order) — used by Open Charge Map's `polyline` filter. */
export function encodePolyline(coords: LngLat[], precision = 5): string {
  const f = Math.pow(10, precision);
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  const enc = (v: number) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of coords) {
    const la = Math.round(lat * f);
    const ln = Math.round(lng * f);
    out += enc(la - lastLat) + enc(ln - lastLng);
    lastLat = la;
    lastLng = ln;
  }
  return out;
}

/** `n` evenly spaced samples along the polyline (n ≥ 2), including both ends. */
export function sampleAlong(coords: LngLat[], cum: number[], n: number): { coord: LngLat; d: number }[] {
  const total = cum[cum.length - 1];
  const out: { coord: LngLat; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1);
    out.push({ coord: pointAt(coords, cum, d).coord, d });
  }
  return out;
}

/** Sub-polyline between two distances. */
export function slice(coords: LngLat[], cum: number[], fromD: number, toD: number): LngLat[] {
  if (toD <= fromD) return [pointAt(coords, cum, fromD).coord];
  const a = pointAt(coords, cum, fromD);
  const b = pointAt(coords, cum, toD);
  const out: LngLat[] = [a.coord];
  for (let i = a.seg + 1; i <= b.seg; i++) out.push(coords[i]);
  out.push(b.coord);
  return out;
}

/** Like slice(), also returning a per-vertex value interpolated from `vals` (one per input vertex). */
export function sliceWith(coords: LngLat[], cum: number[], vals: number[], fromD: number, toD: number): { coords: LngLat[]; vals: number[] } {
  const at = (d: number) => { const p = pointAt(coords, cum, d); const i = p.seg; const t = (cum[i + 1] - cum[i]) > 0 ? Math.max(0, Math.min(1, (d - cum[i]) / (cum[i + 1] - cum[i]))) : 0; return { coord: p.coord, seg: i, v: vals[i] + ((vals[i + 1] ?? vals[i]) - vals[i]) * t }; };
  if (toD <= fromD) { const a = at(fromD); return { coords: [a.coord], vals: [a.v] }; }
  const a = at(fromD), b = at(toD);
  const out: LngLat[] = [a.coord], vs: number[] = [a.v];
  for (let i = a.seg + 1; i <= b.seg; i++) { out.push(coords[i]); vs.push(vals[i]); }
  out.push(b.coord); vs.push(b.v);
  return { coords: out, vals: vs };
}

/** Linear distance from a point to the nearest vertex-sampled position of a polyline (coarse, fast). */
export function nearestSample(samples: { coord: LngLat; d: number }[], p: LngLat) {
  let best = samples[0];
  let bestD = Infinity;
  for (const s of samples) {
    const dd = distance(s.coord, p);
    if (dd < bestD) { bestD = dd; best = s; }
  }
  return { sample: best, dist: bestD };
}

/** Shift a polyline sideways: positive metres to the right of travel, per vertex (miter joins). */
export function offsetLine(coords: LngLat[], offsets: number[]): LngLat[] {
  if (coords.length < 2 || offsets.every((o) => !o)) return coords;
  const out: LngLat[] = [];
  for (let i = 0; i < coords.length; i++) {
    const o = offsets[i] || 0;
    if (!o) { out.push(coords[i]); continue; }
    const prv = coords[Math.max(0, i - 1)], nxt = coords[Math.min(coords.length - 1, i + 1)];
    const b1 = i > 0 ? bearing(prv, coords[i]) : bearing(coords[i], nxt);
    const b2 = i < coords.length - 1 ? bearing(coords[i], nxt) : b1;
    const turn = angleDiff(b1, b2);
    const dir = normalize360(b1 + turn / 2 + 90);
    const miter = Math.min(1.6, 1 / Math.max(0.3, Math.cos(toRad(turn / 2))));
    out.push(destination(coords[i], dir, o * miter));
  }
  return out;
}

/** Ray-cast point-in-polygon on a lon/lat ring. */
export function pointInRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
