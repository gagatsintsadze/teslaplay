import { distance, encodePolyline, projectOnRoute, sampleAlong, simplify } from '../core/geo';
import type { LngLat, Place, RouteResult } from '../types';
import { CATEGORIES } from '../ui/icons';
import type { OsmPlaces } from './osm';
import type { SearchService } from './search';

export interface ChargerService {
  alongRoute(route: RouteResult): Promise<Place[]>;
  near(center: LngLat): Promise<Place[]>;
}

// Open Charge Map connection type IDs → short labels.
const CONNECTORS: Record<number, string> = {
  1: 'Type 1', 2: 'CHAdeMO', 25: 'Type 2', 1036: 'Type 2', 32: 'CCS1', 33: 'CCS2',
  27: 'Supercharger', 30: 'Tesla', 8: 'Tesla', 1030: 'Tesla', 28: 'Schuko', 13: 'Schuko',
};
const DOWN = new Set([100, 150, 200]); // OCM status: not operational / planned / removed

/**
 * EV chargers, best source first:
 *  1. Open Charge Map (power, connectors, status) — when a key is set
 *  2. OpenStreetMap via Overpass (power and sockets where mapped, incl. GB/T) — no key
 *  3. Yandex business search sampled along the route — needs a Places key
 */
export class LiveChargers implements ChargerService {
  /** Source that answered last (for Settings → Map services). */
  lastSource = '';

  constructor(private ocmKey: string, private search: SearchService, private osm: OsmPlaces) {}

  async alongRoute(route: RouteResult): Promise<Place[]> {
    if (this.ocmKey) {
      try {
        // OCM rejects very long GET URLs — simplify hard, then filter precisely ourselves.
        let line = simplify(route.coords, 400);
        if (line.length > 150) line = simplify(route.coords, 1500);
        const res = await this.ocm({ polyline: encodePolyline(line), distance: '4', maxresults: '250', minpowerkw: '20' });
        if (res.length) { this.lastSource = 'Open Charge Map'; return res; }
      } catch (e) {
        console.warn('[chargers] OCM failed, trying OpenStreetMap', e);
      }
    }
    try {
      const res = (await this.osm.chargersAlong(route)).filter((p) => p.charger!.operational !== false);
      if (res.length) { this.lastSource = 'OpenStreetMap'; return res; }
    } catch (e) {
      console.warn('[chargers] Overpass failed, trying Yandex', e);
    }
    this.lastSource = 'Yandex Places';
    return this.yandexAlong(route);
  }

  async near(center: LngLat): Promise<Place[]> {
    if (this.ocmKey) {
      try {
        const res = await this.ocm({ latitude: String(center[1]), longitude: String(center[0]), distance: '25', maxresults: '60' });
        if (res.length) { this.lastSource = 'Open Charge Map'; return res.map((p) => ({ ...p, distance: distance(center, p.coord!) })).sort((a, b) => a.distance! - b.distance!); }
      } catch (e) {
        console.warn('[chargers] OCM failed', e);
      }
    }
    try {
      const res = await this.osm.nearby('chargers', center, 8000);
      if (res.length) { this.lastSource = 'OpenStreetMap'; return res; }
    } catch (e) {
      console.warn('[chargers] Overpass failed', e);
    }
    const q = CATEGORIES[0].query;
    this.lastSource = 'Yandex Places';
    return this.search.category('chargers', q, center).then((list) => list.map(asCharger));
  }

  private async ocm(params: Record<string, string>): Promise<Place[]> {
    const qs = new URLSearchParams({ output: 'json', compact: 'true', verbose: 'false', distanceunit: 'KM', key: this.ocmKey, ...params });
    const r = await fetch(`https://api.openchargemap.io/v3/poi/?${qs}`);
    if (!r.ok) throw new Error(`OCM ${r.status}`);
    const data: any[] = await r.json();
    return data.map((d) => {
      const a = d.AddressInfo || {};
      const conns: any[] = d.Connections || [];
      const power = conns.reduce((m, c) => Math.max(m, c.PowerKW || 0), 0);
      const types = Array.from(new Set(conns.map((c) => CONNECTORS[c.ConnectionTypeID]).filter(Boolean))) as string[];
      return {
        id: `ocm:${d.ID}`,
        name: a.Title || 'EV charger',
        subtitle: [a.AddressLine1, a.Town].filter(Boolean).join(', ') || undefined,
        coord: [a.Longitude, a.Latitude] as LngLat,
        kind: 'charger' as const,
        charger: {
          powerKW: power,
          connectors: types,
          points: d.NumberOfPoints || conns.length || undefined,
          operational: !DOWN.has(d.StatusTypeID),
          cost: d.UsageCost || undefined,
          source: 'ocm' as const,
        },
      };
    }).filter((p) => p.charger.operational && isFinite(p.coord[0]) && isFinite(p.coord[1]));
  }

  private async yandexAlong(route: RouteResult): Promise<Place[]> {
    // One query per ~70 km keeps within free-tier search quotas on long trips.
    const n = Math.min(8, Math.max(2, Math.round(route.distance / 70000) + 1));
    const samples = sampleAlong(route.coords, route.cum, n);
    const seen = new Map<string, Place>();
    const q = CATEGORIES[0].query;
    for (const s of samples) {
      try {
        const res = await this.search.category('chargers', q, s.coord);
        res.forEach((p) => { if (p.coord) seen.set(`${p.name}:${p.coord[0].toFixed(4)}`, asCharger(p)); });
      } catch { /* keep going */ }
    }
    return Array.from(seen.values()).filter((p) => {
      const pr = projectOnRoute(route.coords, route.cum, p.coord!);
      return pr && pr.offset < 4000;
    });
  }
}

const asCharger = (p: Place): Place => ({
  ...p,
  kind: 'charger',
  // Yandex search doesn't expose power or connectors; the planner treats 0 kW as "unknown, assume 50 kW".
  charger: p.charger || { powerKW: 0, connectors: [], source: 'yandex' },
});
