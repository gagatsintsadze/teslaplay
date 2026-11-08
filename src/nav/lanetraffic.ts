import { bearing, destination, distance, offsetLine } from '../core/geo';
import type { LaneRecord, RoadDetails } from '../services/roads';
import type { LngLat } from '../types';

/**
 * Live traffic on the lanes. Mapbox's traffic lines follow Mapbox's own road geometry, which sits a
 * few metres off the OpenStreetMap roads the lane model is built from, so at street zoom they are
 * matched to lane records instead and painted as polygons over the lanes of the direction they
 * describe (a Mapbox traffic line runs in its direction of travel). The worst congestion seen on a
 * road section wins.
 */

const RANK: Record<string, number> = { low: 0, moderate: 1, heavy: 2, severe: 3 };

export function trafficOnLanes(features: { congestion: string; coords: LngLat[] }[], roads: RoadDetails): any {
  const hits = new Map<string, { rec: LaneRecord; forward: boolean; congestion: string }>();
  for (const f of features) {
    if (!(f.congestion in RANK)) continue;
    const c = f.coords;
    for (let i = 0; i < c.length - 1; i++) {
      const segLen = distance(c[i], c[i + 1]);
      const h = bearing(c[i], c[i + 1]);
      // sample every ~20 m along the segment (and at least its midpoint)
      const n = Math.max(1, Math.floor(segLen / 20));
      for (let k = 0; k < n; k++) {
        const p = destination(c[i], h, segLen * (k + 0.5) / n);
        const m = match(p, h, roads.lanesAt(p));
        if (!m) continue;
        const key = `${m.rec.id}:${m.forward ? 'f' : 'b'}`;
        const prev = hits.get(key);
        if (!prev || RANK[f.congestion] > RANK[prev.congestion]) hits.set(key, { rec: m.rec, forward: m.forward, congestion: f.congestion });
      }
    }
  }
  const out: any[] = [];
  for (const h of hits.values()) {
    const r = h.rec;
    const n = r.f + r.b;
    // lanes of this direction, in the way's frame (right of the reference line positive)
    const left = h.forward ? r.l + r.b * r.lw : r.l;
    const right = h.forward ? r.l + n * r.lw : r.l + r.b * r.lw;
    const g = r.g; // the whole section, junctions included, so the colour runs through the joints
    if (g.length < 2) continue;
    const a = offsetLine(g, g.map(() => left + 0.15));
    const b = offsetLine(g, g.map(() => right - 0.15));
    out.push({ type: 'Feature', properties: { congestion: h.congestion }, geometry: { type: 'Polygon', coordinates: [[...a, ...b.reverse(), a[0]]] } });
  }
  return { type: 'FeatureCollection', features: out };
}

function match(p: LngLat, heading: number, recs: LaneRecord[]): { rec: LaneRecord; forward: boolean } | null {
  let best: { rec: LaneRecord; forward: boolean; d: number } | null = null;
  for (const r of recs) {
    for (let i = 0; i < r.g.length - 1; i++) {
      const d = segDist(p, r.g[i], r.g[i + 1]);
      if (d > 14 || (best && d >= best.d)) continue;
      const diff = Math.abs(((heading - bearing(r.g[i], r.g[i + 1]) + 540) % 360) - 180);
      if (diff <= 50) best = { rec: r, forward: true, d };
      else if (diff >= 130 && r.b > 0) best = { rec: r, forward: false, d };
    }
  }
  return best;
}

function segDist(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = Math.cos((p[1] * Math.PI) / 180) * 111320, ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** The part of a line between `cs` metres from its start and `ce` metres from its end. */
export function trim(g: LngLat[], cs: number, ce: number): LngLat[] {
  const cum = [0];
  for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + distance(g[i - 1], g[i]));
  const L = cum[cum.length - 1];
  const s = Math.min(cs, L * 0.45), e = Math.max(s + 1, L - Math.min(ce, L * 0.45));
  const at = (d: number): LngLat => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    return [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * t, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * t];
  };
  const out: LngLat[] = [at(s)];
  for (let i = 0; i < g.length; i++) if (cum[i] > s && cum[i] < e) out.push(g[i]);
  out.push(at(e));
  return out;
}
