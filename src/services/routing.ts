import { cumulative, pointAt, projectOnRoute } from '../core/geo';
import type { LngLat, Maneuver, ManeuverType, RouteResult, RouteStep } from '../types';
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
  rawSteps: RawStep[], req: RouteRequest, rawManeuvers?: RawManeuver[],
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

  const stops = waypointDists.map((at, i) => ({ at, label: (req.waypointLabels && req.waypointLabels[i]) || 'Stop' }));
  // Routers with real instructions (Mapbox) place their own maneuvers; otherwise rebuild them from the geometry.
  const maneuvers = rawManeuvers ? placeManeuvers(coords, cum, rawManeuvers, stops) : deriveManeuvers(coords, cum, steps.map((s) => s.startDist), stops);

  // Routers that name their steps (OSRM) give street names for free.
  for (const m of maneuvers) {
    if (m.type === 'depart' || m.type === 'arrive' || m.type === 'waypoint' || m.street) continue;
    const st = steps.find((s) => s.name && Math.abs(s.startDist - m.at) < 40);
    if (st) m.street = st.name;
  }

  return { id: `r${++seq}`, coords, cum, distance: dist, duration, hasTolls, steps, maneuvers, waypointDists };
}

export interface RawStep { coords: LngLat[]; distance?: number; duration?: number; name?: string }

/** A maneuver as the router describes it, located by coordinate. */
export interface RawManeuver { coord: LngLat; type: ManeuverType; angle: number; street?: string; instruction?: string; lanes?: Maneuver['lanes'] }

function placeManeuvers(coords: LngLat[], cum: number[], raw: RawManeuver[], stops: { at: number; label: string }[]): Maneuver[] {
  const total = cum[cum.length - 1];
  const out: Maneuver[] = [{ type: 'depart', angle: 0, at: 0, coord: coords[0] }];
  let from = 0;
  for (const m of raw) {
    const p = projectOnRoute(coords, cum, m.coord, from, from + 50000);
    if (!p || p.d < 5 || p.d > total - 5) continue;
    from = p.d;
    out.push({ type: m.type, angle: m.angle, at: p.d, coord: m.coord, street: m.street, instruction: m.instruction, lanes: m.lanes });
  }
  for (const w of stops) out.push({ type: 'waypoint', angle: 0, at: w.at, coord: pointAt(coords, cum, w.at).coord, label: w.label });
  out.sort((a, b) => a.at - b.at);
  out.push({ type: 'arrive', angle: 0, at: total, coord: coords[coords.length - 1] });
  return out;
}

export interface NamedRouter { name: string; router: RoutingService }

/**
 * Tries routers in order per request (Mapbox live traffic, then OpenStreetMap/OSRM).
 * A router that fails twice in a row is skipped for the rest of the session.
 * `onFallback` fires when a request had to use the last router.
 */
export class FallbackRouting implements RoutingService {
  private failures = new Map<string, number>();
  /** Name of the router that answered last (for Settings → Map services). */
  lastUsed = '';
  constructor(private chain: NamedRouter[], private onFallback: () => void) {}
  async route(req: RouteRequest): Promise<RouteResult[]> {
    let last: unknown = null;
    for (let i = 0; i < this.chain.length; i++) {
      const { name, router } = this.chain[i];
      const isLast = i === this.chain.length - 1;
      if (!isLast && (this.failures.get(name) || 0) >= 2) continue;
      try {
        const r = await router.route(req);
        this.failures.set(name, 0);
        this.lastUsed = name;
        if (isLast && i > 0) this.onFallback();
        return r;
      } catch (e) {
        last = e;
        this.failures.set(name, (this.failures.get(name) || 0) + 1);
        console.warn(`[routing] ${name} failed`, e);
      }
    }
    throw last instanceof Error ? last : new Error('No route found');
  }
}
