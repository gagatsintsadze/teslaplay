import type { LngLat, RouteResult } from '../types';
import { buildRoute, type RawStep, type RouteRequest, type RoutingService } from './routing';

/**
 * OpenStreetMap routing via the public OSRM server — used only as a fallback when Yandex
 * routing isn't available on the key. The demo server is for light use; self-host OSRM or
 * enable Yandex routing for production. Returns real step names (street names).
 */
export class OsrmRouting implements RoutingService {
  constructor(private base = 'https://router.project-osrm.org') {}

  async route(req: RouteRequest): Promise<RouteResult[]> {
    const pts = req.points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
    const alt = req.points.length === 2 ? 'true' : 'false';
    const r = await fetch(`${this.base}/route/v1/driving/${pts}?overview=full&geometries=geojson&steps=true&alternatives=${alt}`);
    if (!r.ok) throw new Error(`OSRM ${r.status}`);
    const j = await r.json();
    if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('No route found');
    return (j.routes as any[]).slice(0, 3).map((rt) => {
      const steps: RawStep[] = [];
      for (const leg of rt.legs || []) {
        for (const s of leg.steps || []) {
          steps.push({ coords: s.geometry.coordinates as LngLat[], distance: s.distance, duration: s.duration, name: s.name || s.ref || '' });
        }
      }
      return buildRoute(rt.geometry.coordinates as LngLat[], rt.distance, rt.duration, false, steps, req);
    });
  }
}
