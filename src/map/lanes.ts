import { bearing, cumulative, destination, distance, offsetLine, pointAt, slice } from '../core/geo';
import { isOneway, type RoadWay } from '../services/roads';
import type { LngLat } from '../types';
import { turnSet, type TurnDir } from './arrows';

/**
 * Turns OSM lane tags into drawable features. All widths/offsets are in the Drive style's road
 * units (ROAD_W in style.ts; 1 unit ≈ 0.5 m), positive offsets to the right of the geometry.
 *  • surface:  the carriageway, as wide as its lanes (multi-lane avenues get wider than the default)
 *  • dash:     lines between lanes going the same way (3 m dash / 6 m gap)
 *  • double / solid: centre line of two-way roads (OSM `divider`, else double solid on 4+ lanes)
 *  • edge:     solid edge lines on main roads
 *  • arrows:   painted turn arrows from `turn:lanes`, 16 m (and 52 m) before the junction
 */

const BASE_W: Record<string, number> = { motorway: 22, trunk: 20, primary: 16, secondary: 13, tertiary: 10.5, minor: 8 };
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);

function baseClass(hw = ''): string | null {
  const h = hw.replace(/_link$/, '');
  if (h in BASE_W) return h;
  if (h === 'unclassified' || h === 'residential' || h === 'living_street') return 'minor';
  return null;
}

const int = (s?: string): number | null => {
  const n = s ? parseInt(s, 10) : NaN;
  return n >= 1 && n <= 12 ? n : null;
};
const turns = (s?: string): TurnDir[][] | null => (s ? s.split('|').map((l) => turnSet(l.split(';'))) : null);

type Feature = { type: 'Feature'; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
const line = (coords: LngLat[], props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
const point = (c: LngLat, props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });

export interface LaneFeatures { lines: Feature[]; arrows: Feature[]; solids: Feature[] }

/** Lane widths and offsets are already metres (ROAD_W is in metres). */
const U = 1;
/** A polygon strip along `coords`, centred `offM` metres to the right, `widthM` wide. */
function ribbon(coords: LngLat[], offM: number, widthM: number): LngLat[] {
  const a = offsetLine(coords, coords.map(() => offM - widthM / 2));
  const b = offsetLine(coords, coords.map(() => offM + widthM / 2)).reverse();
  return [...a, ...b, a[0]];
}
const poly = (ring: LngLat[], props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });

export function buildWay(w: RoadWay): LaneFeatures {
  const out: LaneFeatures = { lines: [], arrows: [], solids: [] };
  const t = w.t;
  const cls = baseClass(t.highway);
  if (!cls) return out;
  if (t.tunnel && t.tunnel !== 'no') {
    if (w.g.length >= 2) {
      const n = parseInt(t.lanes || '', 10) || 2;
      const wid = Math.max(12, n * 5.2 + 3);
      for (const [p, q] of [[w.g[1], w.g[0]], [w.g[w.g.length - 2], w.g[w.g.length - 1]]] as [LngLat, LngLat][]) {
        const b = bearing(p, q);
        const m = destination(q, b, -0.6); // just inside the mouth
        const across = [destination(m, b - 90, wid / 2), destination(m, b + 90, wid / 2)];
        out.solids.push(poly(ribbon(across, 0, 2.2), { k: 'portal', h: 7 }));
      }
    }
    return out;
  }
  const br = t.bridge && t.bridge !== 'no' ? 1 : 0;
  const dir = isOneway(t);
  const g = dir === -1 ? w.g.slice().reverse() : w.g;
  const cum = cumulative(g);
  const L = cum[cum.length - 1];
  if (L < 6) return out;
  const oneway = dir !== 0;

  let fwdTurns: TurnDir[][] | null;
  let bwdTurns: TurnDir[][] | null = null;
  let F: number;
  let B: number;
  const link = /_link$/.test(t.highway || '');
  const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
  if (oneway) {
    fwdTurns = turns(t['turn:lanes'] || t['turn:lanes:forward']);
    // Untagged: motorways/trunks run two lanes a carriageway; ramps, roundabouts and streets one.
    F = int(t.lanes) || (fwdTurns ? fwdTurns.length : (cls === 'motorway' || cls === 'trunk') && !link && !roundabout ? 2 : 1);
    B = 0;
  } else {
    fwdTurns = turns(t['turn:lanes:forward']);
    bwdTurns = turns(t['turn:lanes:backward']);
    const N = int(t.lanes);
    let f = int(t['lanes:forward']) || (fwdTurns ? fwdTurns.length : null);
    let b = int(t['lanes:backward']) || (bwdTurns ? bwdTurns.length : null);
    if (N) {
      if (f && !b) b = Math.max(0, N - f);
      else if (b && !f) f = Math.max(0, N - b);
      else if (!f && !b) { f = Math.ceil(N / 2); b = N - f; }
    } else if (!f && !b) { f = 1; b = 1; } // untagged two-way road: one lane each way
    F = f || 0;
    B = b || 0;
  }
  const N = F + B;
  if (!N) return out;

  const lw = Math.max(5.2, Math.min(7, BASE_W[cls] / N)); // lane width, units (≈ 2.6–3.5 m)
  const W = N * lw;
  // Lane band: oneway centred on the geometry; two-way backward lanes left of it, forward right.
  const left = oneway ? -W / 2 : -B * lw;
  const c = left + W / 2;
  const tone = MAJOR.has(cls) ? 'major' : 'minor';

  out.lines.push(line(g, { k: 'surf', o: c, w: W, br, tone }));
  {
    const trimmed = L > 30 ? slice(g, cum, 9, L - 9) : L > 12 ? slice(g, cum, 3, L - 3) : null;
    if (trimmed && trimmed.length > 1) {
      if (oneway) {
        for (let k = 1; k < F; k++) out.lines.push(line(trimmed, { k: 'dash', o: left + k * lw, br }));
      } else if (F && B) {
        const div = t.divider;
        // Centre line between the two directions, in yellow (Georgia's convention): double on big roads.
        const kind = div === 'dashed_line' ? 'cdash' : div === 'solid_line' ? 'csolid' : div === 'double_solid_line' ? 'double'
          : N >= 4 || MAJOR.has(cls) ? 'double' : 'cdash';
        out.lines.push(line(trimmed, { k: kind, o: 0, br }));
        for (let k = 1; k < F; k++) out.lines.push(line(trimmed, { k: 'dash', o: k * lw, br }));
        for (let k = 1; k < B; k++) out.lines.push(line(trimmed, { k: 'dash', o: -k * lw, br }));
      }
      // Edge lines on every road but plain two-way streets (which have none in real life).
      if (cls !== 'minor' || oneway) {
        out.lines.push(line(trimmed, { k: 'edge', o: left + 0.7, br }));
        out.lines.push(line(trimmed, { k: 'edge', o: left + W - 0.7, br }));
      }
    }
  }

  // Bridges: low parapets along both edges, so the deck reads as a raised 3D structure. Tunnels: a
  // portal wall across each mouth (the dashed, faded road inside comes from the base style).
  if (br && L > 8) {
    const h = 1.1 + Math.min(3, Math.max(0, parseInt(t.layer || '1', 10) - 1)) * 0.3;
    out.solids.push(poly(ribbon(g, left + 1.2, 0.9), { k: 'rail', h }));
    out.solids.push(poly(ribbon(g, left + W - 1.2, 0.9), { k: 'rail', h }));
  }

  // Painted arrows: forward lanes left→right from the band's forward start; backward lanes mirrored.
  const place = (lanes: TurnDir[][] | null, forward: boolean, first: number, step: number) => {
    if (!lanes) return;
    const spots = L > 90 ? [16, 52] : L > 30 ? [16] : [L / 2];
    lanes.forEach((dirs, i) => {
      if (!dirs.length) return;
      const off = first + step * (i + 0.5) * lw;
      for (const s of spots) {
        const at = pointAt(g, cum, forward ? L - s : s);
        const side = off >= 0 ? at.bearing + 90 : at.bearing - 90;
        const pos = destination(at.coord, side, Math.abs(off) * 0.5); // units → metres
        out.arrows.push(point(pos, { icon: `ta:${dirs.join(';')}`, rot: forward ? at.bearing : at.bearing + 180, w: lw }));
      }
    });
  };
  if (oneway) place(fwdTurns && fwdTurns.length === F ? fwdTurns : fwdTurns && fwdTurns.slice(0, F), true, left, 1);
  else {
    place(fwdTurns, true, 0, 1);      // forward lanes: from the centre line rightwards
    place(bwdTurns, false, 0, -1);    // backward lanes: from the centre line leftwards
  }
  return out;
}

/** Features for a set of tiles' ways (a way crossing tiles is drawn once). */
export function buildLanes(ways: Iterable<RoadWay>, signals: Iterable<LngLat>, crossings: Iterable<LngLat> = []) {
  const lines: Feature[] = [];
  const arrows: Feature[] = [];
  const solids: Feature[] = [];
  const seen = new Set<number>();
  const all: RoadWay[] = [];
  for (const w of ways) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    all.push(w);
    const f = buildWay(w);
    for (const l of f.lines) lines.push(l);
    for (const a of f.arrows) arrows.push(a);
    for (const s of f.solids) solids.push(s);
  }
  const uniq = (pts: Iterable<LngLat>) => { const seenK = new Set<string>(); const out: LngLat[] = []; for (const p of pts) { const k = `${p[0].toFixed(5)},${p[1].toFixed(5)}`; if (!seenK.has(k)) { seenK.add(k); out.push(p); } } return out; };
  signals = uniq(signals);
  crossings = uniq(crossings);
  // Stop lines: on every road approaching a traffic light, 4 m before it, across the lanes of travel.
  for (const s of signals) {
    for (const w of all) {
      const i = w.g.findIndex((p) => distance(p, s) < 2);
      if (i < 0 || w.t.tunnel && w.t.tunnel !== 'no') continue;
      const geom = carriageway(w);
      if (!geom) continue;
      const { g, left, W, F, B, oneway } = geom;
      const j = isOneway(w.t) === -1 ? g.length - 1 - i : i;
      if (j > 0) { // forward approach: lanes right of the centre line (or the whole one-way carriageway)
        const a = pointAt(g, cumulative(g), Math.max(0, cumulative(g)[j] - 4));
        const from = oneway ? left : 0, to = oneway ? left + W : F * (W / (F + B));
        lines.push(line([destination(a.coord, a.bearing + 90, from * U), destination(a.coord, a.bearing + 90, to * U)], { k: 'stop', o: 0, br: 0 }));
      }
      if (!oneway && j < g.length - 1 && B) { // backward approach: lanes left of the centre line
        const cum = cumulative(g);
        const a = pointAt(g, cum, Math.min(cum[cum.length - 1], cum[j] + 4));
        lines.push(line([destination(a.coord, a.bearing - 90, 0), destination(a.coord, a.bearing - 90, B * (W / (F + B)) * U)], { k: 'stop', o: 0, br: 0 }));
      }
    }
  }
  // Zebra crossings: stripes across the whole road at marked pedestrian crossings.
  for (const x of crossings) {
    let best: { w: RoadWay; i: number; d: number } | null = null;
    for (const w of all) {
      const i = w.g.findIndex((p) => distance(p, x) < 2);
      if (i >= 0 && (!best || RANK_OF(w) > RANK_OF(best.w))) best = { w, i, d: 0 };
    }
    if (!best || (best.w.t.tunnel && best.w.t.tunnel !== 'no')) continue;
    const geom = carriageway(best.w);
    if (!geom) continue;
    const { g, left, W } = geom;
    const j = isOneway(best.w.t) === -1 ? g.length - 1 - best.i : best.i;
    const cum = cumulative(g);
    const a = pointAt(g, cum, cum[j]);
    lines.push(line([destination(a.coord, a.bearing + 90, (left - 0.5) * U), destination(a.coord, a.bearing + 90, (left + W + 0.5) * U)], { k: 'zebra', o: 0, br: 0 }));
  }
  const sig: Feature[] = [];
  const keys = new Set<string>();
  for (const s of signals) {
    const k = `${s[0].toFixed(4)},${s[1].toFixed(4)}`; // ~10 m: one icon per junction corner cluster
    if (keys.has(k)) continue;
    keys.add(k);
    sig.push(point(s, {}));
  }
  return {
    lines: { type: 'FeatureCollection', features: lines },
    arrows: { type: 'FeatureCollection', features: arrows },
    signals: { type: 'FeatureCollection', features: sig },
    solids: { type: 'FeatureCollection', features: solids },
  };
}

const RANK_OF = (w: RoadWay) => ({ motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3 } as Record<string, number>)[(w.t.highway || '').replace(/_link$/, '')] || 2;

/** Geometry (oriented with travel), lane band and lane counts of a way — shared by the markings above. */
function carriageway(w: RoadWay): { g: LngLat[]; left: number; W: number; F: number; B: number; oneway: boolean } | null {
  const t = w.t;
  const cls = baseClass(t.highway);
  if (!cls) return null;
  const dir = isOneway(t);
  const g = dir === -1 ? w.g.slice().reverse() : w.g;
  const oneway = dir !== 0;
  const link = /_link$/.test(t.highway || '');
  const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
  let F: number, B: number;
  if (oneway) { F = int(t.lanes) || ((cls === 'motorway' || cls === 'trunk') && !link && !roundabout ? 2 : 1); B = 0; }
  else {
    const N = int(t.lanes);
    let f = int(t['lanes:forward']), b = int(t['lanes:backward']);
    if (N) { if (f && !b) b = Math.max(0, N - f); else if (b && !f) f = Math.max(0, N - b); else if (!f && !b) { f = Math.ceil(N / 2); b = N - f; } }
    else if (!f && !b) { f = 1; b = 1; }
    F = f || 0; B = b || 0;
  }
  const N = F + B;
  if (!N) return null;
  const lw = Math.max(5.2, Math.min(7, BASE_W[cls] / N));
  const W = N * lw;
  return { g, left: oneway ? -W / 2 : -B * lw, W, F, B, oneway };
}
