import { distance } from '../core/geo';
import type { LngLat, LngLatBounds, Place } from '../types';
import type { OsmPlaces } from './osm';

export interface ReverseResult { name: string; street?: string; subtitle?: string }

export interface SearchService {
  suggest(text: string, near: LngLat | null): Promise<Place[]>;
  /** Ensure the place has coordinates (suggest items carry only a URI). */
  resolve(p: Place): Promise<Place>;
  category(catId: string, query: string, near: LngLat, bounds?: LngLatBounds): Promise<Place[]>;
  reverse(coord: LngLat): Promise<ReverseResult | null>;
}

/** "Tsotne Dadiani Street, 71" → "Tsotne Dadiani Street" */
export function streetOf(name: string): string {
  return name.replace(/,\s*\d[\w\/\-.\s]*$/u, '').trim();
}

const withDistance = (p: Place, near: LngLat | null): Place =>
  near && p.coord ? { ...p, distance: distance(near, p.coord) } : p;

/**
 * Search on OpenStreetMap data — no key, no quota:
 *  • Photon (komoot): search as you type over places and addresses, biased to where you are
 *  • Overpass: nearby categories (cafés, parking, pharmacies…)
 *  • Photon reverse: street names for turn-by-turn and dropped pins
 */
export class OsmSearch implements SearchService {
  constructor(private osm: OsmPlaces) {}

  get providers() { return { suggest: 'OpenStreetMap (Photon)', places: 'OpenStreetMap (Overpass)' }; }

  async suggest(text: string, near: LngLat | null): Promise<Place[]> {
    const q = text.trim();
    if (!q) return [];
    return (await this.osm.search(q, near, 8)).map((p) => withDistance(p, near));
  }

  async resolve(p: Place): Promise<Place> {
    if (p.coord) return p;
    const found = await this.osm.search([p.name, p.subtitle].filter(Boolean).join(', '), null, 1);
    if (!found.length || !found[0].coord) throw new Error('Place not found');
    return { ...p, coord: found[0].coord };
  }

  async category(id: string, _query: string, near: LngLat): Promise<Place[]> {
    return this.osm.nearby(id, near);
  }

  reverse(coord: LngLat): Promise<ReverseResult | null> {
    return this.osm.reverse(coord);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Interleave two result lists, dropping near-duplicates (same name within 250 m). */
export function mergePlaces(a: Place[], b: Place[], limit: number): Place[] {
  const out: Place[] = [];
  const dup = (p: Place) => out.some((q) => p.coord && q.coord && distance(p.coord, q.coord) < 250 && (norm(q.name).includes(norm(p.name)) || norm(p.name).includes(norm(q.name))));
  for (let i = 0; out.length < limit && (i < a.length || i < b.length); i++) {
    for (const p of [a[i], b[i]]) if (p && out.length < limit && !dup(p)) out.push(p);
  }
  return out;
}
