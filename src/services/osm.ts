import { distance, simplify } from '../core/geo';
import type { ChargerInfo, LngLat, Place, RouteResult } from '../types';
import type { ReverseResult } from './search';

/**
 * OpenStreetMap services that need no key — the safety net behind Yandex's separately-keyed products:
 *  - Photon (komoot): search-as-you-type over places *and* addresses, with location bias
 *  - Overpass: nearby categories (cafés, parking, pharmacies…) and EV chargers along a route
 * Both send CORS headers, so they work straight from the browser.
 */

const PHOTON = 'https://photon.komoot.io';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

/** OSM tag filters per app category. */
const CATEGORY_FILTERS: Record<string, string[]> = {
  chargers: ['["amenity"="charging_station"]'],
  parking: ['["amenity"="parking"]["access"!~"^(private|no|customers)$"]'],
  cafe: ['["amenity"="cafe"]'],
  restaurant: ['["amenity"~"^(restaurant|fast_food)$"]'],
  carwash: ['["amenity"="car_wash"]'],
  pharmacy: ['["amenity"="pharmacy"]'],
  atm: ['["amenity"="atm"]', '["amenity"="bank"]["atm"="yes"]'],
  hospital: ['["amenity"~"^(hospital|clinic)$"]'],
  hotel: ['["tourism"~"^(hotel|guest_house|hostel|motel)$"]'],
};

/** OSM tag value → app category (for icons on search results). */
const CATEGORY_OF: Record<string, string> = {
  charging_station: 'chargers', parking: 'parking', cafe: 'cafe', restaurant: 'restaurant', fast_food: 'restaurant',
  car_wash: 'carwash', pharmacy: 'pharmacy', atm: 'atm', bank: 'atm', hospital: 'hospital', clinic: 'hospital',
  hotel: 'hotel', guest_house: 'hotel', hostel: 'hotel', motel: 'hotel',
};

const GENERIC: Record<string, string> = {
  chargers: 'EV charger', parking: 'Parking', cafe: 'Café', restaurant: 'Restaurant', carwash: 'Car wash',
  pharmacy: 'Pharmacy', atm: 'ATM', hospital: 'Hospital', hotel: 'Hotel',
};

const SOCKETS: [RegExp, string][] = [
  [/^socket:type2_combo$/, 'CCS2'], [/^socket:type1_combo$/, 'CCS1'], [/^socket:chademo$/, 'CHAdeMO'],
  [/^socket:(tesla_supercharger|nacs)/, 'Tesla'], [/^socket:type2(_cable)?$/, 'Type 2'], [/^socket:type1$/, 'Type 1'],
  [/^socket:gb_dc$/, 'GB/T DC'], [/^socket:gb_ac$/, 'GB/T AC'], [/^socket:schuko$/, 'Schuko'],
];

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

export class OsmPlaces {
  constructor(private lang: string) {}

  private get langCode() { return this.lang.slice(0, 2).toLowerCase(); }

  // ───────────────────────── Photon ─────────────────────────

  async search(text: string, near: LngLat | null, limit = 8): Promise<Place[]> {
    const qs = new URLSearchParams({ q: text, limit: String(limit) });
    // Komoot's Photon offers en/de/fr; otherwise names come back in the local language.
    if (['en', 'de', 'fr'].includes(this.langCode)) qs.set('lang', this.langCode);
    if (near) { qs.set('lat', near[1].toFixed(5)); qs.set('lon', near[0].toFixed(5)); qs.set('location_bias_scale', '0.4'); }
    const r = await withTimeout(fetch(`${PHOTON}/api/?${qs}`), 8000, 'Photon');
    if (!r.ok) throw new Error(`Photon ${r.status}`);
    const j = await r.json();
    return ((j && j.features) || []).map((f: any) => photonPlace(f, near)).filter((p: Place | null): p is Place => !!p);
  }

  async reverse(c: LngLat): Promise<ReverseResult | null> {
    const qs = new URLSearchParams({ lat: c[1].toFixed(6), lon: c[0].toFixed(6), limit: '1' });
    if (['en', 'de', 'fr'].includes(this.langCode)) qs.set('lang', this.langCode);
    const r = await withTimeout(fetch(`${PHOTON}/reverse?${qs}`), 8000, 'Photon');
    if (!r.ok) throw new Error(`Photon ${r.status}`);
    const j = await r.json();
    const f = j && j.features && j.features[0];
    if (!f) return null;
    const p = f.properties || {};
    const street = p.street || (p.osm_key === 'highway' ? p.name : undefined);
    return { name: p.name || street || p.city || 'Dropped pin', street, subtitle: [p.city || p.locality, p.country].filter(Boolean).join(', ') || undefined };
  }

  // ───────────────────────── Overpass ─────────────────────────

  private async overpass(query: string): Promise<any[]> {
    let last: unknown = null;
    for (const url of OVERPASS) {
      try {
        const r = await withTimeout(fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        }), 20000, 'Overpass');
        if (!r.ok) throw new Error(`Overpass ${r.status}`);
        const j = await r.json();
        return (j && j.elements) || [];
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error('Overpass unavailable');
  }

  /** Places of a category around a point, nearest first. Widens the radius once if it finds little. */
  async nearby(catId: string, near: LngLat, radius = 3000): Promise<Place[]> {
    const filters = CATEGORY_FILTERS[catId];
    if (!filters) return [];
    const around = (r: number) => filters.map((f) => `nwr${f}(around:${r},${near[1].toFixed(5)},${near[0].toFixed(5)});`).join('');
    const run = async (r: number) => {
      const els = await this.overpass(`[out:json][timeout:15];(${around(r)});out center tags 80;`);
      return els.map((e) => this.element(e, catId)).filter((p): p is Place => !!p)
        .map((p) => ({ ...p, distance: distance(near, p.coord!) }))
        .sort((a, b) => a.distance! - b.distance!);
    };
    let list = await run(radius);
    if (list.length < 4 && radius < 12000) list = await run(radius * 4);
    return list.slice(0, 40);
  }

  /** EV chargers within `corridor` metres of a route (Overpass treats a coordinate list as a polyline). */
  async chargersAlong(route: RouteResult, corridor = 3000): Promise<Place[]> {
    let line = simplify(route.coords, 300);
    if (line.length > 120) line = simplify(route.coords, 1500);
    if (line.length > 120) line = simplify(route.coords, 5000);
    const poly = line.map((c) => `${c[1].toFixed(4)},${c[0].toFixed(4)}`).join(',');
    const els = await this.overpass(`[out:json][timeout:25];nwr["amenity"="charging_station"](around:${corridor},${poly});out center tags 300;`);
    return els.map((e) => this.element(e, 'chargers')).filter((p): p is Place => !!p);
  }

  private element(e: any, catId: string): Place | null {
    const t = e.tags || {};
    const lat = e.lat !== undefined ? e.lat : e.center && e.center.lat;
    const lon = e.lon !== undefined ? e.lon : e.center && e.center.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    const local = t[`name:${this.langCode}`] || t.name || t.brand || t.operator;
    const name = local || GENERIC[catId] || 'Place';
    const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    const subtitle = [addr || null, t['addr:city'] || null].filter(Boolean).join(', ') || undefined;
    const place: Place = {
      id: `osm:${e.type}${e.id}`,
      name,
      subtitle: catId === 'chargers' ? [t.operator && t.operator !== name ? t.operator : null, addr || null].filter(Boolean).join(' · ') || undefined : subtitle,
      coord: [lon, lat],
      kind: catId === 'chargers' ? 'charger' : 'business',
      category: catId,
    };
    if (catId === 'chargers') place.charger = chargerInfo(t);
    return place;
  }
}

function chargerInfo(t: Record<string, string>): ChargerInfo {
  const connectors = new Set<string>();
  let power = 0;
  for (const k of Object.keys(t)) {
    const out = /^socket:([a-z0-9_]+):output$/.exec(k);
    if (out) power = Math.max(power, parseKW(t[k]));
    for (const [re, label] of SOCKETS) if (re.test(k) && t[k] !== 'no' && t[k] !== '0') connectors.add(label);
  }
  if (!power && t['charging_station:output']) power = parseKW(t['charging_station:output']);
  if (!power && t.maxpower) power = parseKW(t.maxpower);
  const cap = parseInt(t.capacity, 10);
  return {
    powerKW: power,
    connectors: Array.from(connectors),
    points: isFinite(cap) && cap > 0 ? cap : undefined,
    operational: !/^(no|disused|construction|planned)$/.test(t.operational_status || t.disused || ''),
    cost: t.fee === 'no' ? 'Free' : t.charge || undefined,
    operator: t.operator || t.brand || undefined,
    source: 'osm',
  };
}

/** "50 kW", "22", "7.4kW", "150 kW;50 kW" → kW */
function parseKW(v: string | undefined): number {
  if (!v) return 0;
  return v.split(/[;,]/).reduce((m, part) => {
    const n = parseFloat(part.replace(',', '.'));
    if (!isFinite(n)) return m;
    const kw = /w\b/i.test(part) && !/kw/i.test(part) ? n / 1000 : n; // "22000 W"
    return Math.max(m, kw);
  }, 0);
}

function photonPlace(f: any, near: LngLat | null): Place | null {
  const p = f.properties || {};
  const c = f.geometry && f.geometry.coordinates;
  if (!Array.isArray(c) || typeof c[0] !== 'number') return null;
  const coord: LngLat = [c[0], c[1]];
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name: string = p.name || street || p.city || p.state || '';
  if (!name) return null;
  const locality = p.district && p.district !== name ? p.district : null;
  const city = p.city && p.city !== name ? p.city : null;
  const subtitle = [p.name && street ? street : null, locality, city, p.country !== name ? p.country : null].filter(Boolean).join(', ');
  const isPlace = p.osm_key === 'place' || ['city', 'town', 'village', 'locality', 'state', 'country', 'district', 'county'].includes(p.type);
  const isPoi = !isPlace && p.osm_key !== 'highway' && p.osm_key !== 'building' && !!p.name && p.type !== 'street' && p.type !== 'house';
  return {
    id: `osm:${(p.osm_type || 'X')}${p.osm_id || coord.join(',')}`,
    name,
    subtitle: subtitle || undefined,
    coord,
    kind: isPlace ? 'city' : isPoi ? 'business' : 'address',
    category: CATEGORY_OF[p.osm_value] || undefined,
    distance: near ? distance(near, coord) : undefined,
  };
}
