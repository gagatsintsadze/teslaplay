import type { LngLat } from '../types';

/**
 * The one lane model every road drawing derives from — the asphalt surface, lane lines, painted
 * arrows, stop lines, bridge parapets AND the route band / car position. Everything is in metres,
 * relative to the OSM way's centre line, positive to the right of the way's direction.
 *
 * Lanes are drawn generously (5.2–7 m) the way nav maps do, so markings stay readable in the car.
 */

export const PX_PER_M_Z0 = 1 / 116860; // pixels per metre at zoom 0 around 41.7°N (Georgia)

/** Total carriageway width per class, metres (one-way carriageways of a dual road use half of it). */
export const ROAD_W: Record<string, number> = { motorway: 22, trunk: 20, primary: 16, secondary: 13, tertiary: 10.5, minor: 8, service: 5, track: 3.5 };
export const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);

export interface LaneModel {
  cls: string;
  oneway: boolean;
  /** Way geometry runs against the direction of travel (oneway=-1). */
  reversed: boolean;
  link: boolean;
  roundabout: boolean;
  /** Forward / backward lane counts (backward is 0 on one-way roads). */
  F: number;
  B: number;
  /** Lane width, metres. */
  lw: number;
  /** Carriageway width, metres. */
  W: number;
  /** Left edge of the carriageway relative to the centre line, metres (negative). */
  left: number;
  /** Centre of the forward lanes relative to the centre line, metres. */
  forwardCentre: number;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
}

export function baseClass(hw = ''): string | null {
  const h = hw.replace(/_link$/, '');
  if (h in ROAD_W) return h;
  if (h === 'unclassified' || h === 'residential' || h === 'living_street') return 'minor';
  return null;
}

const int = (s?: string): number | null => {
  const n = s ? parseInt(s, 10) : NaN;
  return n >= 1 && n <= 12 ? n : null;
};

/** 1 = one-way along the geometry, -1 = against it, 0 = two-way. */
export function isOneway(t: Record<string, string>): 1 | -1 | 0 {
  const o = t.oneway;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'yes' || o === '1' || o === 'true') return 1;
  if (o === 'no') return 0;
  if (t.junction === 'roundabout' || t.junction === 'circular' || /^motorway/.test(t.highway || '')) return 1;
  return 0;
}

export function laneModel(t: Record<string, string>): LaneModel | null {
  const cls = baseClass(t.highway);
  if (!cls) return null;
  const dir = isOneway(t);
  const oneway = dir !== 0;
  const link = /_link$/.test(t.highway || '');
  const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
  const turnCount = (k: string) => (t[k] ? t[k].split('|').length : 0);
  let F: number, B: number;
  if (oneway) {
    // Untagged: motorways/trunks run two lanes a carriageway; ramps, roundabouts and streets one.
    F = int(t.lanes) || turnCount('turn:lanes') || turnCount('turn:lanes:forward') || ((cls === 'motorway' || cls === 'trunk') && !link && !roundabout ? 2 : 1);
    B = 0;
  } else {
    const N = int(t.lanes);
    let f = int(t['lanes:forward']) || turnCount('turn:lanes:forward') || null;
    let b = int(t['lanes:backward']) || turnCount('turn:lanes:backward') || null;
    if (N) {
      if (f && !b) b = Math.max(0, N - f);
      else if (b && !f) f = Math.max(0, N - b);
      else if (!f && !b) { f = Math.ceil(N / 2); b = N - f; }
    } else if (!f && !b) { f = 1; b = 1; } // untagged two-way road: one lane each way
    F = f || 0;
    B = b || 0;
  }
  const N = F + B;
  if (!N) return null;
  const lw = Math.max(5.2, Math.min(7, ROAD_W[cls] / N));
  const W = N * lw;
  const left = oneway ? -W / 2 : -B * lw;
  return {
    cls, oneway, reversed: dir === -1, link, roundabout, F, B, lw, W, left,
    forwardCentre: oneway ? 0 : (F * lw) / 2,
    bridge: !!t.bridge && t.bridge !== 'no',
    tunnel: !!t.tunnel && t.tunnel !== 'no',
    layer: parseInt(t.layer || '0', 10) || 0,
  };
}

/** Way geometry oriented with the direction of travel. */
export function travelGeometry(g: LngLat[], m: LaneModel): LngLat[] { return m.reversed ? g.slice().reverse() : g; }

/**
 * MapLibre width expression that is exactly `m` metres on the ground at every zoom (two metric stops
 * on an exponential-2 curve), never thinner than `minPx`. `m` may be a number or a data expression.
 */
export function metres(m: number | any[], minPx = 0): any[] {
  // Zoom curves must be top-level in MapLibre, so the pixel floor goes inside each stop. Between stops
  // the exponential-2 curve is exact wherever the metric value is above the floor.
  const at = (z: number): any => {
    const v: any = typeof m === 'number' ? m * 2 ** z * PX_PER_M_Z0 : ['*', m, 2 ** z * PX_PER_M_Z0];
    return minPx > 0 ? ['max', minPx, v] : v;
  };
  const stops = minPx > 0 ? [10, 13, 15, 17, 19, 22] : [10, 22];
  return ['interpolate', ['exponential', 2], ['zoom'], ...stops.flatMap((z) => [z, at(z)])];
}
