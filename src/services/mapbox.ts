import { angleDiff } from '../core/geo';
import { turnSet } from '../map/arrows';
import type { LngLat, ManeuverType, RouteResult, TrafficSpan } from '../types';
import { buildRoute, type RawManeuver, type RawStep, type RouteRequest, type RoutingService } from './routing';
import type { DriveTime } from './matrix';

/**
 * Mapbox — live traffic on top of the OpenStreetMap map (one public `pk.` token):
 *  • Directions API, `driving-traffic` profile: routes and ETAs from real-time + typical traffic,
 *    real turn instructions, per-segment congestion along the route
 *  • Matrix API: drive times from here to nearby results
 *  • Traffic v1 vector tiles: congestion colours on the roads (drawn by the map engine)
 * Free tier: 100k directions, 100k matrix elements and 200k vector tiles a month.
 */

const API = 'https://api.mapbox.com';

export const trafficTilesUrl = (token: string, bucket: number) =>
  `${API}/v4/mapbox.mapbox-traffic-v1/{z}/{x}/{y}.vector.pbf?access_token=${encodeURIComponent(token)}&v=${bucket}`;

/** Congestion words → levels: 0 unknown, 1 low, 2 moderate, 3 heavy, 4 severe. */
const LEVEL: Record<string, number> = { unknown: 0, low: 1, moderate: 2, heavy: 3, severe: 4 };

const MODIFIER: Record<string, ManeuverType> = {
  uturn: 'uturn', 'sharp right': 'sharp-right', right: 'right', 'slight right': 'slight-right',
  straight: 'straight', 'slight left': 'slight-left', left: 'left', 'sharp left': 'sharp-left',
};
const DEFAULT_ANGLE: Record<ManeuverType, number> = {
  depart: 0, arrive: 0, waypoint: 0, straight: 0, 'slight-right': 30, right: 90, 'sharp-right': 140,
  'slight-left': -30, left: -90, 'sharp-left': -140, uturn: 180,
};
/** Step types that never need a banner of their own. */
const SILENT = new Set(['depart', 'arrive', 'new name', 'notification', 'exit roundabout', 'exit rotary']);

export class MapboxError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `Mapbox ${r.status}`;
    try { const j = await r.json(); if (j && j.message) msg += `: ${j.message}`; } catch { /* not JSON */ }
    throw new MapboxError(msg, r.status);
  }
  return r.json();
}

/** Traffic-aware driving routes (Mapbox Directions, `driving-traffic`). */
export class MapboxRouting implements RoutingService {
  constructor(private token: string, private lang = 'en') {}

  async route(req: RouteRequest): Promise<RouteResult[]> {
    const pts = req.points.slice(0, 25).map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
    const qs = new URLSearchParams({
      access_token: this.token,
      alternatives: req.points.length === 2 ? 'true' : 'false',
      geometries: 'geojson',
      overview: 'full',
      steps: 'true',
      annotations: 'congestion,maxspeed',
      language: this.lang,
    });
    if (req.avoidTolls) qs.set('exclude', 'toll');
    const j = await getJson(`${API}/directions/v5/mapbox/driving-traffic/${pts}?${qs}`);
    if (j.code !== 'Ok' || !Array.isArray(j.routes) || !j.routes.length) throw new Error(j.message || 'No route found');
    return (j.routes as any[]).slice(0, 3).map((rt) => toRoute(rt, req));
  }
}

function toRoute(rt: any, req: RouteRequest): RouteResult {
  const coords = rt.geometry.coordinates as LngLat[];
  const steps: RawStep[] = [];
  const maneuvers: RawManeuver[] = [];
  let tolls = false;
  const congestion: number[] = [];
  const maxspeed: (number | null)[] = [];
  const signals: LngLat[] = [];
  for (const leg of rt.legs || []) {
    const ann = leg.annotation && leg.annotation.congestion;
    if (Array.isArray(ann)) for (const c of ann) congestion.push(LEVEL[c] || 0);
    const ms = leg.annotation && leg.annotation.maxspeed;
    if (Array.isArray(ms)) for (const v of ms) maxspeed.push(v && typeof v.speed === 'number' ? Math.round(v.speed * (v.unit === 'mph' ? 1.609 : 1)) : null);
    for (const s of leg.steps || []) {
      const name = s.name || s.ref || '';
      steps.push({ coords: s.geometry.coordinates as LngLat[], distance: s.distance, duration: s.duration, name });
      const xs: any[] = s.intersections || [];
      if (xs.some((x: any) => Array.isArray(x.classes) && x.classes.includes('toll'))) tolls = true;
      for (const x of xs) if (x.traffic_signal && Array.isArray(x.location)) signals.push(x.location as LngLat);
      // Lanes at the junction where this step's maneuver happens, as Mapbox reports them.
      const rawLanes: any[] = (xs[0] && xs[0].lanes) || [];
      const lanes = rawLanes.length > 1 ? rawLanes.map((l: any) => ({ dirs: turnSet(l.indications || []), valid: !!l.valid })) : undefined;
      const m = s.maneuver || {};
      if (SILENT.has(m.type)) continue;
      const type = MODIFIER[m.modifier];
      // "Continue straight" and plain forks straight ahead aren't worth a banner.
      if (!type || (type === 'straight' && m.type !== 'roundabout' && m.type !== 'rotary')) continue;
      let angle = DEFAULT_ANGLE[type];
      if (m.type === 'turn' || m.type === 'end of road' || m.type === 'continue') {
        const a = typeof m.bearing_before === 'number' && typeof m.bearing_after === 'number' ? angleDiff(m.bearing_before, m.bearing_after) : NaN;
        if (isFinite(a) && Math.sign(a) === Math.sign(angle)) angle = a;
      }
      maneuvers.push({ coord: m.location as LngLat, type, angle, street: name || undefined, instruction: m.instruction, lanes });
    }
  }
  const r = buildRoute(coords, rt.distance, rt.duration, tolls, steps, req, maneuvers);
  if (typeof rt.duration_typical === 'number' && rt.duration_typical > 0) r.durationTypical = rt.duration_typical;
  if (maxspeed.length === coords.length - 1 && maxspeed.some((v) => v !== null)) r.maxspeed = maxspeed;
  if (signals.length) r.signals = signals;
  if (congestion.length === coords.length - 1) {
    r.trafficAware = true;
    r.traffic = trafficSpans(congestion, r.cum);
  }
  const summary: string = (rt.legs && rt.legs[0] && rt.legs[0].summary) || '';
  if (summary) r.via = summary.split(',')[0].trim();
  return r;
}

/** Runs of moderate-or-worse congestion along the route, merged across tiny gaps. */
export function trafficSpans(levels: number[], cum: number[]): TrafficSpan[] {
  const out: TrafficSpan[] = [];
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level < 2) continue;
    const from = cum[i];
    const to = cum[i + 1];
    const last = out[out.length - 1];
    if (last && last.level === level && from - last.to < 15) last.to = to;
    else out.push({ from, to, level: level as 2 | 3 | 4 });
  }
  return out.filter((s) => s.to - s.from > 8);
}

/** Drive times from one origin to many destinations (Mapbox Matrix, `driving-traffic`: 10 coordinates a request). */
export class MapboxMatrix {
  private broken = false;
  constructor(private token: string) {}

  get available() { return !this.broken; }

  async from(origin: LngLat, dests: LngLat[]): Promise<(DriveTime | null)[]> {
    if (this.broken || !dests.length) return dests.map(() => null);
    const out: (DriveTime | null)[] = [];
    for (let i = 0; i < dests.length; i += 9) {
      const chunk = dests.slice(i, i + 9);
      const coords = [origin, ...chunk].map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
      // The Matrix API needs at least 2 elements: with one destination, also ask origin → origin.
      const pad = chunk.length === 1 ? 1 : 0;
      const qs = new URLSearchParams({
        access_token: this.token,
        sources: '0',
        destinations: (pad ? ['0'] : []).concat(chunk.map((_, k) => String(k + 1))).join(';'),
        annotations: 'duration,distance',
      });
      let j: any;
      try {
        j = await getJson(`${API}/directions-matrix/v1/mapbox/driving-traffic/${coords}?${qs}`);
      } catch (e) {
        if (e instanceof MapboxError && (e.status === 401 || e.status === 403)) this.broken = true;
        throw e;
      }
      const dur: (number | null)[] = (j.durations && j.durations[0]) || [];
      const dist: (number | null)[] = (j.distances && j.distances[0]) || [];
      chunk.forEach((_, k) => {
        const d = dur[k + pad];
        const m = dist[k + pad];
        out.push(typeof d === 'number' ? { duration: d, distance: typeof m === 'number' ? m : 0 } : null);
      });
    }
    return out;
  }
}

/** Cheap token check for Settings → Map services: one tiny directions request. */
export async function checkMapboxToken(token: string, a: LngLat, b: LngLat): Promise<string> {
  const r = await new MapboxRouting(token).route({ points: [a, b], avoidTolls: false });
  const best = r[0];
  const delay = best.durationTypical ? Math.round((best.duration - best.durationTypical) / 60) : null;
  return `${(best.distance / 1000).toFixed(1)} km, ${Math.round(best.duration / 60)} min${delay !== null ? ` (${delay > 0 ? `+${delay}` : delay} min vs typical)` : ''} · ${best.traffic ? best.traffic.length : 0} slow stretches`;
}

