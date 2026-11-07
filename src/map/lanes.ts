import { bearing, cumulative, destination, distance, offsetLine, pointAt, slice } from '../core/geo';
import type { RoadWay } from '../services/roads';
import type { LngLat } from '../types';
import { turnSet, type TurnDir } from './arrows';
import { laneModel, MAJOR, travelGeometry, type LaneModel } from './roadmodel';

/**
 * Turns OSM lane tags into drawable features, all from the shared lane model (roadmodel.ts), in
 * metres relative to the way's centre line (positive = right of travel):
 *  • surf:   the carriageway, as wide as its lanes
 *  • dash:   white lines between lanes going the same way
 *  • cdash / csolid / double: the yellow centre line between the two directions
 *  • edge:   white edge lines
 *  • stop / zebra: stop lines before traffic lights, zebra stripes at marked crossings
 *  • arrows: painted turn arrows from `turn:lanes`, 16 m (and 52 m) before the junction
 *  • solids: 3D bridge parapets and tunnel portal arches (fill-extrusion polygons)
 */

type Feature = { type: 'Feature'; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
const line = (coords: LngLat[], props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
const point = (c: LngLat, props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });
const poly = (ring: LngLat[], props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });

/** A polygon strip along `coords`, centred `offM` metres to the right, `widthM` wide. */
function ribbon(coords: LngLat[], offM: number, widthM: number): LngLat[] {
  const a = offsetLine(coords, coords.map(() => offM - widthM / 2));
  const b = offsetLine(coords, coords.map(() => offM + widthM / 2)).reverse();
  return [...a, ...b, a[0]];
}

const turns = (s?: string): TurnDir[][] | null => (s ? s.split('|').map((l) => turnSet(l.split(';'))) : null);

export interface LaneFeatures { lines: Feature[]; arrows: Feature[]; solids: Feature[] }

/** Tunnel portal: two pillars and a stepped lintel that reads as an arch, across the mouth. */
function portal(p: LngLat, q: LngLat, m: LaneModel): Feature[] {
  const b = bearing(p, q);
  const mouth = destination(q, b, -0.8);
  const wid = m.W + 2.4;
  const pillar = 1.2;
  const out: Feature[] = [];
  for (const side of [-1, 1]) {
    const c = destination(mouth, b + side * 90, wid / 2 - pillar / 2);
    out.push(poly(ribbon([destination(c, b, -1.1), destination(c, b, 1.1)], 0, pillar), { k: 'portal', h: 5.6, base: 0 }));
  }
  // Lintel in five steps, higher in the middle, with the opening below.
  const steps = [[0.0, 0.2, 4.6], [0.2, 0.4, 5.3], [0.4, 0.6, 5.7], [0.6, 0.8, 5.3], [0.8, 1.0, 4.6]];
  const inner = wid - 2 * pillar;
  for (const [a, z, base] of steps) {
    const from = destination(mouth, b - 90, inner / 2 - a * inner);
    const to = destination(mouth, b - 90, inner / 2 - z * inner);
    out.push(poly(ribbon([from, to], 0, 2.2), { k: 'portal', h: 6.4, base }));
  }
  return out;
}

export function buildWay(w: RoadWay): LaneFeatures {
  const out: LaneFeatures = { lines: [], arrows: [], solids: [] };
  const t = w.t;
  const m = laneModel(t);
  if (!m) return out;
  const g = travelGeometry(w.g, m);
  if (m.tunnel) {
    if (g.length >= 2) {
      out.solids.push(...portal(g[1], g[0], m));
      out.solids.push(...portal(g[g.length - 2], g[g.length - 1], m));
    }
    return out;
  }
  const cum = cumulative(g);
  const L = cum[cum.length - 1];
  if (L < 6) return out;
  const { F, B, lw, W, left, oneway, cls } = m;
  const br = m.bridge ? 1 : 0;
  const tone = MAJOR.has(cls) ? 'major' : 'minor';

  out.lines.push(line(g, { k: 'surf', o: left + W / 2, w: W, br, tone }));
  const trimmed = L > 30 ? slice(g, cum, 9, L - 9) : L > 12 ? slice(g, cum, 3, L - 3) : null;
  if (trimmed && trimmed.length > 1) {
    if (oneway) {
      for (let k = 1; k < F; k++) out.lines.push(line(trimmed, { k: 'dash', o: left + k * lw, br }));
    } else if (F && B) {
      // Centre line between the two directions, in yellow (Georgia's convention): double on big roads.
      const div = t.divider;
      const kind = div === 'dashed_line' ? 'cdash' : div === 'solid_line' ? 'csolid' : div === 'double_solid_line' ? 'double'
        : F + B >= 4 || MAJOR.has(cls) ? 'double' : 'cdash';
      out.lines.push(line(trimmed, { k: kind, o: 0, br }));
      for (let k = 1; k < F; k++) out.lines.push(line(trimmed, { k: 'dash', o: k * lw, br }));
      for (let k = 1; k < B; k++) out.lines.push(line(trimmed, { k: 'dash', o: -k * lw, br }));
    }
    // Edge lines on every road but plain two-way streets (which have none in real life).
    if (cls !== 'minor' || oneway) {
      out.lines.push(line(trimmed, { k: 'edge', o: left + 0.5, br }));
      out.lines.push(line(trimmed, { k: 'edge', o: left + W - 0.5, br }));
    }
  }

  // Bridges: low parapets along both edges, so the deck reads as a raised 3D structure.
  if (br && L > 8) {
    const h = 1.1 + Math.min(3, Math.max(0, m.layer - 1)) * 0.3;
    out.solids.push(poly(ribbon(g, left + 0.9, 0.8), { k: 'rail', h, base: 0 }));
    out.solids.push(poly(ribbon(g, left + W - 0.9, 0.8), { k: 'rail', h, base: 0 }));
  }

  // Painted arrows: forward lanes left→right from the centre line (or the band's left on one-way roads).
  const fwdTurns = turns(oneway ? t['turn:lanes'] || t['turn:lanes:forward'] : t['turn:lanes:forward']);
  const bwdTurns = oneway ? null : turns(t['turn:lanes:backward']);
  const place = (lanes: TurnDir[][] | null, forward: boolean, first: number, step: number) => {
    if (!lanes) return;
    const spots = L > 90 ? [16, 52] : L > 30 ? [16] : [L / 2];
    lanes.forEach((dirs, i) => {
      if (!dirs.length) return;
      const off = first + step * (i + 0.5) * lw;
      for (const s of spots) {
        const at = pointAt(g, cum, forward ? L - s : s);
        const pos = destination(at.coord, at.bearing + 90, off);
        out.arrows.push(point(pos, { icon: `ta:${dirs.join(';')}`, rot: forward ? at.bearing : at.bearing + 180, w: lw }));
      }
    });
  };
  place(fwdTurns && fwdTurns.slice(0, F), true, oneway ? left : 0, 1);
  place(bwdTurns && bwdTurns.slice(0, B), false, 0, -1);
  return out;
}

const RANK_OF = (w: RoadWay) => ({ motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3 } as Record<string, number>)[(w.t.highway || '').replace(/_link$/, '')] || 2;

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
  const uniq = (pts: Iterable<LngLat>) => { const k2 = new Set<string>(); const o: LngLat[] = []; for (const p of pts) { const k = `${p[0].toFixed(5)},${p[1].toFixed(5)}`; if (!k2.has(k)) { k2.add(k); o.push(p); } } return o; };
  const sigs = uniq(signals);

  // Stop lines: on every road approaching a traffic light, 4 m before it, across the lanes of travel.
  for (const s of sigs) {
    for (const w of all) {
      const idx = w.g.findIndex((p) => distance(p, s) < 2);
      if (idx < 0) continue;
      const m = laneModel(w.t);
      if (!m || m.tunnel) continue;
      const g = travelGeometry(w.g, m);
      const cum = cumulative(g);
      const j = m.reversed ? g.length - 1 - idx : idx;
      if (j > 0) { // forward approach: the forward lanes
        const a = pointAt(g, cum, Math.max(0, cum[j] - 4));
        const from = m.oneway ? m.left : 0, to = m.oneway ? m.left + m.W : m.F * m.lw;
        lines.push(line([destination(a.coord, a.bearing + 90, from), destination(a.coord, a.bearing + 90, to)], { k: 'stop', o: 0, br: 0 }));
      }
      if (!m.oneway && j < g.length - 1 && m.B) { // backward approach: the backward lanes
        const a = pointAt(g, cum, Math.min(cum[cum.length - 1], cum[j] + 4));
        lines.push(line([a.coord, destination(a.coord, a.bearing - 90, m.B * m.lw)], { k: 'stop', o: 0, br: 0 }));
      }
    }
  }
  // Zebra crossings: stripes across the whole road at marked pedestrian crossings.
  for (const x of uniq(crossings)) {
    let best: { w: RoadWay; i: number } | null = null;
    for (const w of all) {
      const i = w.g.findIndex((p) => distance(p, x) < 2);
      if (i >= 0 && (!best || RANK_OF(w) > RANK_OF(best.w))) best = { w, i };
    }
    if (!best) continue;
    const m = laneModel(best.w.t);
    if (!m || m.tunnel) continue;
    const g = travelGeometry(best.w.g, m);
    const cum = cumulative(g);
    const j = m.reversed ? g.length - 1 - best.i : best.i;
    const a = pointAt(g, cum, cum[j]);
    lines.push(line([destination(a.coord, a.bearing + 90, m.left - 0.3), destination(a.coord, a.bearing + 90, m.left + m.W + 0.3)], { k: 'zebra', o: 0, br: 0 }));
  }

  return {
    lines: { type: 'FeatureCollection', features: lines },
    arrows: { type: 'FeatureCollection', features: arrows },
    signals: { type: 'FeatureCollection', features: sigs.map((s) => point(s, {})) },
    solids: { type: 'FeatureCollection', features: solids },
  };
}
