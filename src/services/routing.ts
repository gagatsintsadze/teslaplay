import { cumulative, distance, projectOnRoute } from '../core/geo';
import type { LngLat, RouteResult, RouteStep } from '../types';
import { deriveManeuvers } from './maneuvers';

export interface RouteRequest {
  points: LngLat[];
  /** Labels for intermediate points (charging stops), same order as points[1..n-2]. */
  waypointLabels?: string[];
  avoidTolls: boolean;
}

export interface RoutingService {
  route(req: RouteRequest): Promise<RouteResult[]>;
}

let seq = 0;

/** Normalise a raw route (from any provider) into the app's RouteResult. */
export function buildRoute(
  coords: LngLat[], rawDistance: number | undefined, rawDuration: number | undefined, hasTolls: boolean,
  rawSteps: RawStep[], req: RouteRequest,
): RouteResult {
  const cum = cumulative(coords);
  const total = cum[cum.length - 1];
  const dist = rawDistance && rawDistance > 0 ? rawDistance : total;
  let duration = rawDuration && rawDuration > 0 ? rawDuration : total / 13.9;
  // Guard against a provider returning milliseconds.
  if (duration > dist * 4) duration /= 1000;

  // Step boundaries: project each step's first vertex onto the route, in order.
  const steps: RouteStep[] = [];
  let from = 0;
  let expected = 0;
  for (const s of rawSteps) {
    if (!s.coords || s.coords.length < 2) continue;
    // Search a window around where this step should start (previous start + previous step's
    // own length), so 100+ km highway steps and routes that revisit a road both match correctly.
    const p = projectOnRoute(coords, cum, s.coords[0], from, Math.max(from + 3000, expected + 5000));
    const start = p ? p.d : expected;
    const geomLen = cumulative(s.coords).pop() || 0;
    const len = s.distance || geomLen;
    steps.push({ startDist: start, distance: len, duration: s.duration || 0, name: s.name || undefined });
    from = start;
    expected = start + geomLen;
  }
  // Durations per step let ETA track traffic-heavy sections; fill gaps proportionally.
  const known = steps.reduce((a, s) => a + s.duration, 0);
  if (steps.length && known <= 0) steps.forEach((s) => { s.duration = (s.distance / Math.max(1, total)) * duration; });

  // Intermediate waypoints → distance along the route.
  const waypointDists: number[] = [];
  let wFrom = 0;
  req.points.slice(1, -1).forEach((pt) => {
    const p = projectOnRoute(coords, cum, pt, wFrom);
    waypointDists.push(p ? p.d : wFrom);
    if (p) wFrom = p.d;
  });

  const maneuvers = deriveManeuvers(
    coords, cum, steps.map((s) => s.startDist),
    waypointDists.map((at, i) => ({ at, label: (req.waypointLabels && req.waypointLabels[i]) || 'Stop' })),
  );

  // Routers that name their steps (OSRM) give street names for free.
  for (const m of maneuvers) {
    if (m.type === 'depart' || m.type === 'arrive' || m.type === 'waypoint') continue;
    const st = steps.find((s) => s.name && Math.abs(s.startDist - m.at) < 40);
    if (st) m.street = st.name;
  }

  return { id: `r${++seq}`, coords, cum, distance: dist, duration, hasTolls, steps, maneuvers, waypointDists };
}

export interface RawStep { coords: LngLat[]; distance?: number; duration?: number; name?: string }

/**
 * Tries the primary router per request and falls back on failure (e.g. Yandex routing not
 * enabled on the key). After two consecutive primary failures the primary is skipped.
 */
export class FallbackRouting implements RoutingService {
  private failures = 0;
  constructor(private primary: RoutingService, private fallback: RoutingService, private onFallback: () => void) {}
  async route(req: RouteRequest): Promise<RouteResult[]> {
    if (this.failures < 2) {
      try {
        const r = await this.primary.route(req);
        this.failures = 0;
        return r;
      } catch (e) {
        this.failures++;
        console.warn('[routing] primary router failed, using fallback', e);
        this.onFallback();
      }
    }
    return this.fallback.route(req);
  }
}

function extractCoords(geometry: any): LngLat[] {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return geometry.coordinates as LngLat[];
  if (geometry.type === 'MultiLineString') return ([] as LngLat[]).concat(...(geometry.coordinates as LngLat[][]));
  return [];
}

/** Driving routes via Yandex JS API v3 `ymaps3.route` (traffic-aware on Yandex's side). */
export class YandexRouting implements RoutingService {
  async route(req: RouteRequest): Promise<RouteResult[]> {
    const y = window.ymaps3;
    const res = await y.route({ points: req.points, type: 'driving', bounds: true, avoidTolls: req.avoidTolls });
    const list: any[] = Array.isArray(res) ? res : [res];
    const out: RouteResult[] = [];
    for (const r of list.slice(0, 3)) {
      let feature: any;
      try { feature = r.toRoute(); } catch { continue; }
      const coords = extractCoords(feature && feature.geometry);
      if (coords.length < 2) continue;
      const props = feature.properties || {};
      let rawSteps: RawStep[] = [];
      try {
        const steps: any[] = typeof r.toSteps === 'function' ? r.toSteps() : [];
        rawSteps = steps.map((s) => ({
          coords: extractCoords(s.geometry),
          distance: s.properties && s.properties.length,
          duration: s.properties && s.properties.duration,
        }));
      } catch { /* steps are optional */ }
      const flags = props.flags || {};
      out.push(buildRoute(coords, props.length, props.duration, !!(flags.hasTolls || flags.hasNonTransactionalTolls), rawSteps, req));
    }
    if (!out.length) throw new Error('No route found');
    // Distinct alternatives only.
    return out.filter((r, i) => i === 0 || Math.abs(r.distance - out[0].distance) > 50 || distance(r.coords[r.coords.length >> 1], out[0].coords[out[0].coords.length >> 1]) > 100);
  }
}
