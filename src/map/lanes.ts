import { cumulative, destination, pointAt, slice } from '../core/geo';
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

export interface LaneFeatures { lines: Feature[]; arrows: Feature[] }

export function buildWay(w: RoadWay): LaneFeatures {
  const out: LaneFeatures = { lines: [], arrows: [] };
  const t = w.t;
  const cls = baseClass(t.highway);
  if (!cls || (t.tunnel && t.tunnel !== 'no')) return out;
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
  if (oneway) {
    fwdTurns = turns(t['turn:lanes'] || t['turn:lanes:forward']);
    F = int(t.lanes) || (fwdTurns ? fwdTurns.length : 0);
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
    }
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

  if (N >= 2) {
    out.lines.push(line(g, { k: 'surf', o: c, w: W, br, tone }));
    const trimmed = L > 30 ? slice(g, cum, 9, L - 9) : null;
    if (trimmed && trimmed.length > 1) {
      if (oneway) {
        for (let k = 1; k < F; k++) out.lines.push(line(trimmed, { k: 'dash', o: left + k * lw, br }));
      } else if (F && B) {
        const div = t.divider;
        const kind = div === 'dashed_line' ? 'dash' : div === 'solid_line' ? 'solid' : div === 'double_solid_line' ? 'double'
          : N >= 4 || MAJOR.has(cls) ? 'double' : 'dash';
        out.lines.push(line(trimmed, { k: kind, o: 0, br }));
        for (let k = 1; k < F; k++) out.lines.push(line(trimmed, { k: 'dash', o: k * lw, br }));
        for (let k = 1; k < B; k++) out.lines.push(line(trimmed, { k: 'dash', o: -k * lw, br }));
      }
      if (cls !== 'minor') {
        out.lines.push(line(trimmed, { k: 'edge', o: left + 0.7, br }));
        out.lines.push(line(trimmed, { k: 'edge', o: left + W - 0.7, br }));
      }
    }
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
export function buildLanes(ways: Iterable<RoadWay>, signals: Iterable<LngLat>) {
  const lines: Feature[] = [];
  const arrows: Feature[] = [];
  const seen = new Set<number>();
  for (const w of ways) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const f = buildWay(w);
    for (const l of f.lines) lines.push(l);
    for (const a of f.arrows) arrows.push(a);
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
  };
}
