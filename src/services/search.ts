import { distance } from '../core/geo';
import type { LngLat, LngLatBounds, Place } from '../types';
import type { HttpGeocoder } from './geocoder';

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
 * Yandex search with graceful degradation, because each Yandex product needs its own key:
 *   1. Geosuggest (`ymaps3.suggest`)   — search-as-you-type      [Geosuggest key]
 *   2. Places/Search (`ymaps3.search`) — businesses, place details [Places key]
 *   3. HTTP Geocoder                   — addresses, streets, cities [the JS API key itself]
 * A product that fails once (no key / not enabled) is skipped for the rest of the session.
 */
export class YandexSearch implements SearchService {
  private suggestBroken = false;
  private searchBroken = false;
  onDegraded: ((what: 'suggest' | 'search') => void) | null = null;

  constructor(private geocoder: HttpGeocoder) {}

  private get y() { return window.ymaps3; }

  private markBroken(what: 'suggest' | 'search', e: unknown) {
    console.warn(`[search] Yandex ${what} unavailable on this key, falling back`, e);
    if (what === 'suggest') this.suggestBroken = true; else this.searchBroken = true;
    if (this.onDegraded) this.onDegraded(what);
  }

  async suggest(text: string, near: LngLat | null): Promise<Place[]> {
    const q = text.trim();
    if (!q) return [];
    if (!this.suggestBroken) {
      try {
        const opts: any = { text: q, limit: 8 };
        if (near) { opts.center = near; opts.span = [0.6, 0.4]; }
        const items: any[] = await this.y.suggest(opts);
        return (items || []).map((it, i) => {
          const tags: string[] = it.tags || [];
          const business = tags.some((t) => /business|бизнес/i.test(t));
          const place: Place = {
            id: `sg:${it.uri || i + ':' + (it.title && it.title.text)}`,
            name: (it.title && it.title.text) || it.value || it.displayName || q,
            subtitle: it.subtitle && it.subtitle.text,
            uri: it.uri,
            kind: business ? 'business' : 'address',
            distance: it.distance && typeof it.distance.value === 'number' ? it.distance.value : undefined,
          };
          return place;
        });
      } catch (e) {
        this.markBroken('suggest', e);
      }
    }
    if (!this.searchBroken) {
      try { return await this.search(q, near, 8); } catch (e) { this.markBroken('search', e); }
    }
    return this.geocoder.search(q, near, 8);
  }

  private async search(text: string, near: LngLat | null, limit: number, extra: any = {}): Promise<Place[]> {
    const opts: any = { text, limit, ...extra };
    if (near && !opts.bounds) { opts.center = near; opts.span = opts.span || [0.5, 0.35]; }
    const feats: any[] = await this.y.search(opts);
    return (feats || []).map((f, i) => withDistance(featureToPlace(f, i), near));
  }

  async resolve(p: Place): Promise<Place> {
    if (p.coord) return p;
    if (!this.searchBroken) {
      try {
        const feats: any[] = p.uri
          ? await this.y.search({ uri: p.uri })
          : await this.y.search({ text: [p.name, p.subtitle].filter(Boolean).join(', '), limit: 1 });
        if (feats && feats.length) {
          const r = featureToPlace(feats[0], 0);
          if (r.coord) return { ...p, coord: r.coord, subtitle: p.subtitle || r.subtitle, kind: p.kind || r.kind };
        }
      } catch (e) {
        this.markBroken('search', e);
      }
    }
    const g = await this.geocoder.search([p.subtitle, p.name].filter(Boolean).join(', '), null, 1);
    if (!g.length || !g[0].coord) throw new Error('Place not found');
    return { ...p, coord: g[0].coord };
  }

  async category(_id: string, query: string, near: LngLat, bounds?: LngLatBounds): Promise<Place[]> {
    if (this.searchBroken) throw new Error('places-key');
    const extra: any = { type: ['businesses'] };
    if (bounds) extra.bounds = bounds;
    else extra.span = [0.06, 0.04];
    try {
      const out = await this.search(query, near, 20, extra);
      return out.sort((a, b) => (a.distance || 0) - (b.distance || 0));
    } catch (e) {
      this.markBroken('search', e);
      throw new Error('places-key');
    }
  }

  async reverse(coord: LngLat): Promise<ReverseResult | null> {
    if (!this.searchBroken) {
      try {
        const feats: any[] = await this.y.search({ text: `${coord[0]},${coord[1]}`, type: ['toponyms'], limit: 1 });
        if (feats && feats.length) {
          const pr = feats[0].properties || {};
          const name: string = pr.name || '';
          return { name, street: streetOf(name), subtitle: pr.description };
        }
      } catch (e) {
        this.markBroken('search', e);
      }
    }
    return this.geocoder.reverse(coord);
  }
}

function featureToPlace(f: any, i: number): Place {
  const pr = f.properties || {};
  const c = f.geometry && f.geometry.coordinates;
  const coord: LngLat | undefined = Array.isArray(c) && typeof c[0] === 'number' ? [c[0], c[1]] : undefined;
  const name = pr.name || pr.title || 'Unnamed place';
  return {
    id: `ys:${pr.uri || name + ':' + (coord ? coord.join(',') : i)}`,
    name,
    subtitle: pr.description,
    coord,
    uri: pr.uri,
    kind: pr.type === 'business' || pr.companyMetaData || pr.categories ? 'business' : 'address',
  };
}
