import { bearing, destination, normalize360, toRad } from '../core/geo';
import type { LaneRecord, RoadDetails } from '../services/roads';
import type { LngLat, Maneuver } from '../types';

/**
 * Puts the route on its lanes. The router (Mapbox) returns a line down the middle of the road;
 * here every vertex is matched to a lane record from the pre-built lane model and moved to the
 * centre of the lanes the car should be in, with the band's width alongside:
 *
 *  - by default the band covers every lane of the direction of travel (one-way: the whole
 *    carriageway; two-way: the forward or backward lanes, whichever the route runs along)
 *  - approaching a turn it narrows to the lanes that lead there: Mapbox's lane flags when it
 *    sent them, else OSM `turn:lanes`
 *  - lane changes are blended in over the vertices before the turn
 *  - where no lane record is within reach (no data) the vertex stays where the router put it
 *
 * The result has exactly one point per route vertex, so the puck and the route's distances stay in step.
 */

const MATCH_M = 16;      // how far a route vertex may be from a reference line to count
const LEAD_M = 180;      // start moving into the turn lanes this far before the manoeuvre
const BLEND_M = 90;      // lane changes are spread over this distance

export interface LanePlacement { coords: LngLat[]; widths: number[] }

interface Match { rec: LaneRecord; forward: boolean; signed: number; d: number }

/** Lane offsets from the reference line in the frame of travel (right positive), leftmost lane first. */
function laneCentres(r: LaneRecord, forward: boolean): number[] {
  const out: number[] = [];
  if (forward) {
    for (let k = 0; k < r.f; k++) out.push(r.l + (r.b + k + 0.5) * r.lw);
  } else {
    for (let k = 0; k < r.b; k++) out.push(-(r.l + (r.b - 1 - k + 0.5) * r.lw));
  }
  return out;
}

const turnsOf = (r: LaneRecord, forward: boolean) => (forward ? r.tf : r.tb);

/** Which lanes lead into this manoeuvre (indices in the travel frame), or null for "any". */
function lanesFor(m: Maneuver, rec: LaneRecord, forward: boolean): [number, number] | null {
  const n = forward ? rec.f : rec.b;
  if (n <= 1) return null;
  if (m.lanes && m.lanes.length === n) {
    const valid = m.lanes.map((l, i) => (l.valid ? i : -1)).filter((i) => i >= 0);
    if (valid.length && valid.length < n) return [Math.min(...valid), Math.max(...valid)];
    return null;
  }
  const turns = turnsOf(rec, forward);
  if (!turns) {
    // No arrows painted: a turn is made from the lane on that side.
    if (/left/.test(m.type) || m.type === 'uturn') return [0, 0];
    if (/right/.test(m.type)) return [n - 1, n - 1];
    return null;
  }
  const want: RegExp | null = /left/.test(m.type) || m.type === 'uturn' ? /left|reverse/ : /right/.test(m.type) ? /right/ : m.type === 'straight' || m.type === 'depart' || m.type === 'arrive' ? null : null;
  if (!want) return null;
  const idx = turns.map((t, i) => (want.test(t) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length || idx.length === n) return null;
  return [Math.min(...idx), Math.max(...idx)];
}

function nearest(p: LngLat, heading: number, recs: LaneRecord[]): Match | null {
  const kx = Math.cos(toRad(p[1])) * 111320, ky = 110540;
  let best: Match | null = null;
  for (const r of recs) {
    if (r.tu && r.c === 'service') continue;
    const g = r.g;
    for (let i = 0; i < g.length - 1; i++) {
      const ax = (g[i][0] - p[0]) * kx, ay = (g[i][1] - p[1]) * ky;
      const bx = (g[i + 1][0] - p[0]) * kx, by = (g[i + 1][1] - p[1]) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(px, py);
      if (d > MATCH_M || (best && d >= best.d - 0.01)) continue;
      const segB = normalize360((Math.atan2(dx, dy) * 180) / Math.PI);
      const diff = Math.abs(((heading - segB + 540) % 360) - 180);
      const along = diff <= 55;
      const against = diff >= 125 && !r.o && r.b > 0;
      if (!along && !against) continue;
      // Side of the vertex relative to the direction of travel: cross(segment dir, vertex − foot).
      const cross = dx * -py - dy * -px; // (dx,dy) × (−px,−py): vertex is at the origin, foot at (px,py)
      let signed = (cross < 0 ? 1 : -1) * d; // right of the way's direction is positive
      if (!along) signed = -signed;
      best = { rec: r, forward: along, signed, d };
    }
  }
  return best;
}

export function placeOnLanes(coords: LngLat[], cum: number[], maneuvers: Maneuver[], roads: RoadDetails): LanePlacement {
  const n = coords.length;
  const widths = new Array<number>(n).fill(0);
  const offs = new Array<number>(n).fill(0);
  const matches: (Match | null)[] = new Array(n).fill(null);
  const target: ([number, number] | null)[] = new Array(n).fill(null);
  // Which manoeuvre each vertex is approaching (for its lane choice).
  let mi = 0;
  for (let i = 0; i < n; i++) {
    const p = coords[i];
    const h = bearing(coords[Math.max(0, i - 1)], coords[Math.min(n - 1, i + 1)]);
    const m = nearest(p, h, roads.lanesAt(p));
    matches[i] = m;
    while (mi < maneuvers.length && maneuvers[mi].at < cum[i] - 1) mi++;
    const mv = maneuvers[mi];
    if (m && mv && mv.at - cum[i] <= LEAD_M && mv.at - cum[i] >= -1) target[i] = lanesFor(mv, m.rec, m.forward);
  }
  // Lane choice → offset of the band centre and its width, per vertex.
  for (let i = 0; i < n; i++) {
    const m = matches[i];
    if (!m) continue;
    const centres = laneCentres(m.rec, m.forward);
    if (!centres.length) { matches[i] = null; continue; }
    const t = target[i];
    const lo = t ? Math.max(0, t[0]) : 0;
    const hi = t ? Math.min(centres.length - 1, t[1]) : centres.length - 1;
    const centre = (centres[lo] + centres[hi]) / 2;
    offs[i] = centre - m.signed;
    widths[i] = (hi - lo + 1) * m.rec.lw;
  }
  // Blend lane changes: vertices within BLEND_M before a change ease towards the new lanes.
  const rawO = offs.slice(), rawW = widths.slice();
  for (let i = 1; i < n; i++) {
    if (!matches[i] || !matches[i - 1]) continue;
    if (Math.abs(rawO[i] - rawO[i - 1]) < 0.4 && Math.abs(rawW[i] - rawW[i - 1]) < 0.3) continue;
    const avail = (m: Match) => (m.forward ? m.rec.f : m.rec.b);
    for (let j = i - 1; j >= 0 && matches[j]; j--) {
      const back = cum[i] - cum[j];
      if (back > BLEND_M || avail(matches[j]!) !== avail(matches[i]!)) break; // only within the same lane count: never spill off a narrower road
      const k = 1 - back / BLEND_M;
      offs[j] = rawO[j] + (rawO[i] - rawO[j]) * k;
      widths[j] = rawW[j] + (rawW[i] - rawW[j]) * k;
    }
  }
  // Fill short gaps (a vertex nothing matched, between two that did).
  for (let i = 1; i < n - 1; i++) {
    if (!matches[i] && matches[i - 1] && matches[i + 1]) { offs[i] = (offs[i - 1] + offs[i + 1]) / 2; widths[i] = (widths[i - 1] + widths[i + 1]) / 2; matches[i] = matches[i - 1]; }
  }
  // Move the vertices sideways (mitred so the band keeps its width through bends).
  const out: LngLat[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = offs[i];
    if (!o) { out[i] = coords[i]; continue; }
    const prv = coords[Math.max(0, i - 1)], nxt = coords[Math.min(n - 1, i + 1)];
    const b1 = i > 0 ? bearing(prv, coords[i]) : bearing(coords[i], nxt);
    const b2 = i < n - 1 ? bearing(coords[i], nxt) : b1;
    const turn = ((b2 - b1 + 540) % 360) - 180;
    const miter = Math.min(2.5, 1 / Math.max(0.2, Math.cos(toRad(turn / 2))));
    out[i] = destination(coords[i], normalize360(b1 + turn / 2 + 90), o * miter);
  }
  return { coords: out, widths };
}
