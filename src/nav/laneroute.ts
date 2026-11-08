import { bearing, destination, normalize360, toRad } from '../core/geo';
import type { LaneRecord, RoadDetails } from '../services/roads';
import type { LngLat, Maneuver } from '../types';
import { planLanes, type PlanStep, type Section } from './laneplan';

/**
 * Puts the route on its lanes. The router (Mapbox) returns a line down the middle of the road;
 * here every vertex is matched to a lane record from the pre-built lane model and moved to the
 * centre of the lanes the car should be in, with the band's width alongside:
 *
 *  - the band is always one lane wide. By default it is the right-hand lane of the direction of
 *    travel (keep right; on a dual carriageway each direction is its own road with its own lanes)
 *  - approaching a turn it moves to the lane that leads there: Mapbox's lane flags when it sent
 *    them (the active lane, else the valid ones), else OSM `turn:lanes`, else the lane on the
 *    turning side; among several usable lanes the one nearest the default is kept
 *  - lane changes are blended in over the vertices before the turn
 *  - where no lane record is within reach (no data) the vertex stays where the router put it
 *
 * The result has exactly one point per route vertex, so the puck and the route's distances stay in step.
 */

const MATCH_M = 16;      // how far a route vertex may be from a reference line to count
const BLEND_M = 90;      // lane changes are spread over this distance

export interface LanePlacement {
  coords: LngLat[]; widths: number[];
  /** chosen lane per vertex (0 = leftmost of the direction of travel), -1 where unmatched */
  lanes: number[];
  /** lanes available in the direction of travel per vertex */
  counts: number[];
  /** road height above ground per vertex (bridges, ramps), metres */
  heights: number[];
  /** the lane plan (nav/laneplan.ts) and the route sections it refers to */
  plan: PlanStep[]; sections: Section[];
  /** plan step index per vertex, -1 where unmatched */
  step: number[];
}

interface Match { rec: LaneRecord; forward: boolean; signed: number; d: number; /** height of the road at the matched point */ h: number }

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
      const h = r.hz ? r.hz[i] + ((r.hz[i + 1] ?? r.hz[i]) - r.hz[i]) * t : 0;
      best = { rec: r, forward: along, signed, d, h };
    }
  }
  return best;
}

export function placeOnLanes(coords: LngLat[], cum: number[], maneuvers: Maneuver[], roads: RoadDetails, startLane: number | null = null): LanePlacement {
  const n = coords.length;
  const widths = new Array<number>(n).fill(0);
  const offs = new Array<number>(n).fill(0);
  const lanes = new Array<number>(n).fill(-1);
  const counts = new Array<number>(n).fill(0);
  const heights = new Array<number>(n).fill(0);
  const stepOf = new Array<number>(n).fill(-1);
  const matches: (Match | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const p = coords[i];
    const h = bearing(coords[Math.max(0, i - 1)], coords[Math.min(n - 1, i + 1)]);
    const m = nearest(p, h, roads.lanesAt(p));
    if (m && !laneCentres(m.rec, m.forward).length) continue;
    matches[i] = m;
  }
  // Sections: runs of vertices on the same record and direction (unmatched vertices break them).
  const sections: Section[] = [];
  const secOf = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const m = matches[i];
    if (!m) continue;
    const last = sections[sections.length - 1];
    if (last && last.rec.id === m.rec.id && last.forward === m.forward && secOf[i - 1] === sections.length - 1) last.i1 = i;
    else sections.push({ i0: i, i1: i, rec: m.rec, forward: m.forward, count: m.forward ? m.rec.f : m.rec.b, lw: m.rec.lw });
    secOf[i] = sections.length - 1;
  }
  const plan = planLanes(sections, cum, maneuvers, startLane);
  // Per vertex: the band covers all allowed lanes until the lane-change deadline, then the recommended lane.
  for (let i = 0; i < n; i++) {
    const m = matches[i];
    if (!m) continue;
    const centres = laneCentres(m.rec, m.forward);
    const st = plan[secOf[i]];
    stepOf[i] = secOf[i];
    let lo = st.recommended, hi = st.recommended;
    if (st.allowed && cum[i] < st.mustBeInBy) { lo = Math.min(...st.allowed); hi = Math.max(...st.allowed); }
    lo = Math.max(0, Math.min(centres.length - 1, lo));
    hi = Math.max(lo, Math.min(centres.length - 1, hi));
    offs[i] = (centres[lo] + centres[hi]) / 2 - m.signed;
    widths[i] = (hi - lo + 1) * m.rec.lw;
    lanes[i] = st.recommended;
    counts[i] = centres.length;
    heights[i] = m.h;
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
    if (Math.abs(turn) > 35) {
      // A corner (a turn at a junction): keep the lane of the road being left and let the band cut
      // across the junction to the next lane, as a car does, instead of mitring far off the road.
      out[i] = destination(coords[i], normalize360(b1 + 90), o);
      continue;
    }
    const miter = Math.min(2.5, 1 / Math.max(0.2, Math.cos(toRad(turn / 2))));
    out[i] = destination(coords[i], normalize360(b1 + turn / 2 + 90), o * miter);
  }
  // a vertex between two elevated ones is elevated too (short unmatched gaps on a deck)
  for (let i = 1; i < n - 1; i++) if (!heights[i] && heights[i - 1] > 0.3 && heights[i + 1] > 0.3) heights[i] = (heights[i - 1] + heights[i + 1]) / 2;
  return { coords: out, widths, lanes, counts, heights, plan, sections, step: stepOf };
}

/**
 * Which lane a GPS fix is in (0 = leftmost of the direction of travel), from its lateral offset on the
 * nearest lane record; null when no record matches. Used to let the car drift to the lane it is really
 * in, instead of sitting on the recommended lane.
 */
export function laneOfFix(p: LngLat, heading: number, recs: LaneRecord[]): { lane: number; count: number; lw: number } | null {
  const m = nearest(p, heading, recs);
  if (!m) return null;
  const centres = laneCentres(m.rec, m.forward);
  if (!centres.length) return null;
  const k = Math.round((m.signed - centres[0]) / m.rec.lw);
  if (k < -1 || k > centres.length) return null; // on the pavement / the other carriageway: not a lane
  return { lane: Math.max(0, Math.min(centres.length - 1, k)), count: centres.length, lw: m.rec.lw };
}
