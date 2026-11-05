import { distance } from '../core/geo';
import type { LngLat, Place } from '../types';
import type { ReverseResult } from './search';

/**
 * Yandex HTTP Geocoder — included with the "JavaScript API and HTTP Geocoder" key, so address
 * search and street names keep working even when no separate Geosuggest / Places key exists.
 * It finds addresses, streets and cities (not businesses).
 */
export class HttpGeocoder {
  private endpoints: { url: string; key: string }[];

  /**
   * @param key       Geocoder API key (geocode-maps.yandex.ru/v1) — or the JS API key alone
   * @param lang      response language
   * @param legacyKey JS API key for the legacy 1.x endpoint, tried if the Geocoder key is refused
   */
  constructor(key: string, private lang: string, legacyKey = '') {
    this.endpoints = [];
    if (key && key !== legacyKey) this.endpoints.push({ url: 'https://geocode-maps.yandex.ru/v1/', key });
    if (legacyKey || key) this.endpoints.push({ url: 'https://geocode-maps.yandex.ru/1.x/', key: legacyKey || key });
  }

  private async query(params: Record<string, string>): Promise<any[]> {
    let last: unknown = null;
    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[i];
      try {
        const qs = new URLSearchParams({ apikey: ep.key, format: 'json', lang: this.lang, ...params });
        const r = await fetch(`${ep.url}?${qs}`);
        if (!r.ok) throw new Error(`geocoder ${r.status}`);
        const j = await r.json();
        // Remember the endpoint that works so later calls go straight to it.
        if (i > 0) this.endpoints = this.endpoints.slice(i);
        const members = j && j.response && j.response.GeoObjectCollection && j.response.GeoObjectCollection.featureMember;
        return (members || []).map((m: any) => m.GeoObject).filter(Boolean);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error('geocoder unavailable');
  }

  /** Which endpoint is answering (for Settings → Map services). */
  get endpoint() { return this.endpoints[0] ? this.endpoints[0].url.replace('https://', '') : 'none'; }

  async search(text: string, near: LngLat | null, limit = 8): Promise<Place[]> {
    const params: Record<string, string> = { geocode: text, results: String(limit) };
    if (near) { params.ll = `${near[0]},${near[1]}`; params.spn = '4,3'; }
    const list = await this.query(params);
    return list.map((g, i) => {
      const p = toPlace(g, i);
      return near && p.coord ? { ...p, distance: distance(near, p.coord) } : p;
    }).filter((p) => p.coord);
  }

  async reverse(c: LngLat): Promise<ReverseResult | null> {
    for (const kind of ['street', 'house']) {
      const list = await this.query({ geocode: `${c[0]},${c[1]}`, kind, results: '1' });
      if (list.length) {
        const g = list[0];
        const meta = (g.metaDataProperty && g.metaDataProperty.GeocoderMetaData) || {};
        const comps: any[] = (meta.Address && meta.Address.Components) || [];
        const street = (comps.find((x) => x.kind === 'street') || {}).name || g.name;
        return { name: g.name, street, subtitle: g.description };
      }
    }
    return null;
  }
}

function toPlace(g: any, i: number): Place {
  const pos = g.Point && typeof g.Point.pos === 'string' ? g.Point.pos.split(' ').map(Number) : null;
  const meta = (g.metaDataProperty && g.metaDataProperty.GeocoderMetaData) || {};
  const kind = meta.kind as string | undefined;
  return {
    id: `geo:${meta.text || g.name}:${i}`,
    name: g.name || meta.text || 'Place',
    subtitle: g.description,
    coord: pos && isFinite(pos[0]) && isFinite(pos[1]) ? [pos[0], pos[1]] : undefined,
    kind: kind === 'locality' || kind === 'province' || kind === 'country' || kind === 'area' ? 'city' : 'address',
  };
}
