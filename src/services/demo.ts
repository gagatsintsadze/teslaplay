import { bearing, cumulative, destination, distance, projectOnRoute } from '../core/geo';
import type { LngLat, LngLatBounds, Place, RouteResult } from '../types';
import type { ChargerService } from './chargers';
import { CORRIDOR, DEMO_CHARGERS, DEMO_PLACES, EXIT_NODE, type GraphPath, graphPath, insideBackdrop, nodeCoord, snapToRoads } from './demo-data';
import { buildRoute, type RouteRequest, type RoutingService } from './routing';
import type { ReverseResult, SearchService } from './search';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TBILISI: LngLat = [44.79, 41.715];

export class DemoSearch implements SearchService {
  async suggest(text: string, near: LngLat | null): Promise<Place[]> {
    await wait(90);
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const all = DEMO_PLACES.concat(DEMO_CHARGERS);
    return all
      .filter((p) => p.name.toLowerCase().includes(q) || (p.subtitle || '').toLowerCase().includes(q))
      .map((p) => ({ ...p, distance: near && p.coord ? distance(near, p.coord) : undefined }))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || (a.distance || 0) - (b.distance || 0))
      .slice(0, 8);
  }

  async resolve(p: Place) { return p; }

  async category(id: string, _q: string, near: LngLat, _b?: LngLatBounds): Promise<Place[]> {
    await wait(140);
    const list = id === 'chargers' ? DEMO_CHARGERS : DEMO_PLACES.filter((p) => p.category === id);
    return list.map((p) => ({ ...p, distance: distance(near, p.coord!) })).sort((a, b) => a.distance! - b.distance!);
  }

  async reverse(coord: LngLat): Promise<ReverseResult | null> {
    await wait(40);
    if (insideBackdrop(coord)) {
      const s = snapToRoads(coord);
      return { name: s.name, street: s.name, subtitle: 'Tbilisi, Georgia' };
    }
    let best = CORRIDOR[0];
    for (const c of CORRIDOR) if (distance(c.at, coord) < distance(best.at, coord)) best = c;
    const hw = coord[0] < 42.9 ? 'E70 Highway' : 'E60 Highway';
    return { name: distance(best.at, coord) < 6000 ? best.name : hw, street: hw, subtitle: 'Georgia' };
  }
}

export class DemoChargers implements ChargerService {
  async alongRoute(route: RouteResult): Promise<Place[]> {
    await wait(200);
    return DEMO_CHARGERS.filter((c) => {
      const p = projectOnRoute(route.coords, route.cum, c.coord!);
      return p && p.offset < 4000;
    });
  }
  async near(center: LngLat): Promise<Place[]> {
    return DEMO_CHARGERS.map((p) => ({ ...p, distance: distance(center, p.coord!) })).sort((a, b) => a.distance! - b.distance!);
  }
}

interface Seg { c: LngLat; name: string; speed: number }

export class DemoRouting implements RoutingService {
  async route(req: RouteRequest): Promise<RouteResult[]> {
    await wait(350);
    const main = this.compose(req, 0);
    const out = [main];
    if (main.distance > 20000) out.push(this.compose(req, 1));
    return out;
  }

  private compose(req: RouteRequest, variant: number): RouteResult {
    let segs: Seg[] = [];
    for (let i = 0; i < req.points.length - 1; i++) {
      const leg = this.leg(req.points[i], req.points[i + 1], variant);
      segs = segs.concat(segs.length ? leg.slice(1) : leg);
    }
    // dedupe consecutive duplicates
    segs = segs.filter((s, i) => i === 0 || distance(s.c, segs[i - 1].c) > 0.5);
    const coords = segs.map((s) => s.c);
    const cum = cumulative(coords);
    let duration = 0;
    for (let i = 1; i < segs.length; i++) duration += (cum[i] - cum[i - 1]) / segs[i].speed;
    // segs[i].name is the road of segment (i-1 → i). A step ends at vertex i when the next
    // segment is on a different road — exactly at the junction, like a real router's steps.
    const steps: { coords: LngLat[]; distance: number; duration: number }[] = [];
    let start = 0;
    for (let i = 1; i < segs.length; i++) {
      const last = i === segs.length - 1;
      if (last || segs[i + 1].name !== segs[i].name) {
        steps.push({ coords: coords.slice(start, i + 1), distance: cum[i] - cum[start], duration: 0 });
        start = i;
      }
    }
    return buildRoute(coords, cum[cum.length - 1], duration, false, steps, req);
  }

  private leg(a: LngLat, b: LngLat, variant: number): Seg[] {
    const inA = insideBackdrop(a);
    const inB = insideBackdrop(b);
    if (inA && inB) return this.local(a, b);
    if (inA && !inB) return this.local(a, null).concat(this.longHaul(CORRIDOR[0].at, b, variant).slice(1));
    return this.longHaul(a, b, variant);
  }

  private local(a: LngLat, b: LngLat | null): Seg[] {
    const sa = snapToRoads(a);
    const sb = b ? snapToRoads(b) : null;
    // Try both ends of the start and target edges; keep the shortest overall path (no backtracking).
    let best: { path: GraphPath; from: number; to: number; cost: number } | null = null;
    for (const from of [sa.u, sa.v]) {
      for (const to of sb ? [sb.u, sb.v] : [EXIT_NODE]) {
        const path = graphPath(from, to);
        const cost = distance(sa.coord, nodeCoord(from)) + path.length + (sb ? distance(nodeCoord(to), sb.coord) : 0);
        if (!best || cost < best.cost) best = { path, from, to, cost };
      }
    }
    const segs: Seg[] = [{ c: a, name: sa.name, speed: 6 }, { c: sa.coord, name: sa.name, speed: 6 }];
    best!.path.pts.forEach((c, i) => segs.push({ c, name: i === 0 ? sa.name : best!.path.names[i], speed: 9.5 }));
    if (sb && b) {
      segs.push({ c: sb.coord, name: sb.name, speed: 8 });
      segs.push({ c: b, name: sb.name, speed: 5 });
    }
    return segs;
  }

  /** Synthetic road between towns along the corridor, densified with gentle curvature. */
  private longHaul(a: LngLat, b: LngLat, variant: number): Seg[] {
    let k = 0;
    for (let i = 0; i < CORRIDOR.length; i++) if (distance(CORRIDOR[i].at, b) < distance(CORRIDOR[k].at, b)) k = i;
    const useCorridor = distance(CORRIDOR[k].at, b) < distance(a, b) * 0.6 && distance(a, CORRIDOR[0].at) < 15000;
    const anchors: { c: LngLat; name: string }[] = [{ c: a, name: 'start' }];
    if (useCorridor) for (let i = 1; i <= k; i++) anchors.push({ c: CORRIDOR[i].at, name: CORRIDOR[i].name });
    anchors.push({ c: b, name: 'end' });
    const out: Seg[] = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const p = anchors[i].c;
      const q = anchors[i + 1].c;
      const d = distance(p, q);
      const n = Math.max(2, Math.round(d / 350));
      const brg = bearing(p, q);
      const amp = Math.min(1600, d * 0.05) * (variant ? -1.6 : 1);
      for (let j = 0; j < n; j++) {
        const t = j / n;
        const base: LngLat = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const off = Math.sin(t * Math.PI) * amp + Math.sin(t * Math.PI * 7 + i) * 90;
        const c = destination(base, brg + 90, off);
        const urban = distance(c, TBILISI) < 12000 || distance(c, b) < 4000;
        out.push({ c, name: c[0] < 42.9 ? 'E70' : 'E60', speed: urban ? 13 : variant ? 21 : 23.5 });
      }
    }
    out.push({ c: b, name: 'E-dest', speed: 10 });
    return out;
  }
}
