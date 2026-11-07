import type { App } from '../app';
import type { LngLat } from '../types';
import { HttpGeocoder } from './geocoder';
import { OsrmRouting } from './osrm';
import { YandexRouterHttp } from './routing';

export interface CheckResult {
  id: string;
  name: string;
  /** true = working, false = failing, null = not configured / skipped */
  ok: boolean | null;
  ms?: number;
  detail: string;
}

const describe = (e: unknown): string => {
  if (!e) return 'Unknown error';
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  const o = e as any;
  const msg = o.message || o.statusText || o.error || o.status;
  if (msg) return String(msg);
  try { return JSON.stringify(e).slice(0, 160); } catch { return String(e); }
};

const timed = async (fn: () => Promise<string>, ms = 12000): Promise<{ ok: boolean; ms: number; detail: string }> => {
  const t0 = performance.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`No answer in ${ms / 1000} s`)), ms)),
    ]);
    return { ok: true, ms: Math.round(performance.now() - t0), detail };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), detail: describe(e) };
  }
};

/**
 * Live check of every service the app talks to, using the real keys from this browser.
 * Runs in parallel; each check is small (one result) so it costs almost nothing in quota.
 */
export async function runServiceCheck(app: App): Promise<CheckResult[]> {
  const cfg = app.cfg;
  const here = app.here();
  const near: LngLat = [here[0] + 0.012, here[1] + 0.006];
  const y = window.ymaps3;
  const live = app.engine.kind === 'yandex';

  const checks: Promise<CheckResult>[] = [];
  const add = (id: string, name: string, fn: (() => Promise<string>) | null, skipped = 'Not configured') => {
    checks.push(fn ? timed(fn).then((r) => ({ id, name, ...r })) : Promise.resolve({ id, name, ok: null, detail: skipped }));
  };

  add('map', 'Yandex map', live ? async () => {
    if (!y) throw new Error('JS API not loaded');
    const warn = (app.engine as any).initWarnings as string[] | undefined;
    return `JS API v3 loaded${y.version ? ` (${y.version})` : ''} · key …${cfg.yandexApiKey.slice(-4)}${warn && warn.length ? ` · refused: ${warn.join('; ')}` : ''}`;
  } : app.engine.kind === 'osm' ? async () => { throw new Error(app.mapFallbackReason || 'Not loaded'); } : null, 'Demo mode — offline map');
  if (app.engine.kind === 'osm') add('osmmap', 'OpenStreetMap map', async () => 'Showing CARTO / OpenStreetMap tiles');

  add('suggest', 'Yandex Geosuggest', live && y ? async () => {
    const r: any[] = await y.suggest({ text: 'Rustaveli', limit: 1 });
    return r && r.length ? `“${r[0].title && r[0].title.text}”` : 'Answered, no results';
  } : null);

  add('search', 'Yandex Places search', live && y ? async () => {
    const r: any[] = await y.search({ text: 'cafe', center: here, span: [0.05, 0.03], type: ['businesses'], limit: 1 });
    return r && r.length ? `“${r[0].properties && r[0].properties.name}”` : 'Answered, no results';
  } : null);

  add('routerhttp', 'Yandex Router API', cfg.yandexRouterKey && !cfg.demo ? async () => {
    const r = await new YandexRouterHttp(cfg.yandexRouterKey).route({ points: [here, near], avoidTolls: false });
    return `${r[0].coords.length} points · ${Math.max(1, Math.round(r[0].duration / 60))} min with traffic`;
  } : null);

  add('router', 'Yandex routing (JS API)', live && y ? async () => {
    const r: any[] = await y.route({ points: [here, near], type: 'driving' });
    const f = r && r[0] && r[0].toRoute();
    const n = f && f.geometry && f.geometry.coordinates ? f.geometry.coordinates.length : 0;
    if (!n) throw new Error('Empty route');
    return `${n} points${f.properties && f.properties.duration ? ` · ${Math.round(f.properties.duration / 60)} min` : ''}`;
  } : null);

  add('geocoder', 'Yandex Geocoder', cfg.yandexApiKey && !cfg.demo ? async () => {
    const g = app.geocoder || new HttpGeocoder(cfg.yandexGeocoderKey || cfg.yandexApiKey, cfg.mapLang, cfg.yandexApiKey);
    const r = await g.search('Tbilisi', null, 1);
    return `${r.length ? `“${r[0].name}”` : 'Answered, no results'} · ${g.endpoint}`;
  } : null);

  add('matrix', 'Yandex Distance Matrix', app.matrix ? async () => {
    const r = await app.matrix!.from(here, [near]);
    if (!r[0]) throw new Error('No time returned');
    return `${Math.max(1, Math.round(r[0].duration / 60))} min drive to a point ${(r[0].distance / 1000).toFixed(1)} km away`;
  } : null);

  add('traffic', 'Yandex live traffic', live ? async () => {
    if (!app.state.trafficAvailable) throw new Error('Needs a paid Yandex plan');
    return app.state.settings.traffic ? 'On' : 'Available (switched off)';
  } : null);

  add('osrm', 'OpenStreetMap routing', async () => {
    const r = await new OsrmRouting().route({ points: [here, near], avoidTolls: false });
    return `${r.length} route${r.length === 1 ? '' : 's'} · ${Math.round(r[0].duration / 60)} min`;
  });

  add('photon', 'OpenStreetMap search', app.osm ? async () => {
    const r = await app.osm!.search('Rustaveli', here, 1);
    return r.length ? `“${r[0].name}”` : 'Answered, no results';
  } : null);

  add('overpass', 'OpenStreetMap places', app.osm ? async () => {
    const r = await app.osm!.nearby('cafe', here, 1500);
    return `${r.length} cafés within reach`;
  } : null);

  add('ocm', 'Open Charge Map', cfg.openChargeMapKey ? async () => {
    const qs = new URLSearchParams({ output: 'json', compact: 'true', verbose: 'false', maxresults: '1', latitude: String(here[1]), longitude: String(here[0]), distance: '50', key: cfg.openChargeMapKey });
    const r = await fetch(`https://api.openchargemap.io/v3/poi/?${qs}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return `${j.length} charger${j.length === 1 ? '' : 's'} nearby`;
  } : null, 'No key — chargers come from OpenStreetMap');

  add('weather', 'Weather (Open-Meteo)', async () => {
    const w = await app.weather.get(here);
    if (!w) throw new Error('No answer');
    return `${Math.round(w.tempC)}° · ${w.label}`;
  });

  add('gps', 'GPS', async () => {
    const s = app.state;
    if (s.locStatus === 'denied') throw new Error('Location permission denied');
    if (!s.fix) throw new Error(s.locStatus === 'pending' ? 'Waiting for a fix' : `No fix (${s.locStatus})`);
    const age = Math.round((Date.now() - s.fix.time) / 1000);
    return `±${Math.round(s.fix.accuracy || 0)} m · ${age}s ago${s.fix.simulated ? ' · simulated' : ''}`;
  });

  return Promise.all(checks);
}

/** What the app is actually using right now for each job. */
export function activeProviders(app: App, results: CheckResult[]): { label: string; value: string }[] {
  const ok = (id: string) => results.some((r) => r.id === id && r.ok);
  const has = (id: string) => results.some((r) => r.id === id);
  return [
    { label: 'Map', value: ok('map') ? 'Yandex' : ok('osmmap') ? 'OpenStreetMap (backup)' : app.cfg.demo ? 'Demo' : 'Not loaded' },
    { label: 'Search as you type', value: ok('suggest') ? 'Yandex Geosuggest' : ok('search') ? 'Yandex Places' : [ok('geocoder') && 'Yandex Geocoder', ok('photon') && 'OpenStreetMap'].filter(Boolean).join(' + ') || 'Unavailable' },
    { label: 'Nearby places', value: (ok('search') ? 'Yandex Places' : ok('overpass') ? 'OpenStreetMap' : 'Unavailable') + (ok('matrix') ? ' · drive times by Yandex' : '') },
    { label: 'Directions', value: ok('router') || ok('routerhttp') ? 'Yandex (live traffic)' : ok('osrm') ? 'OpenStreetMap (OSRM)' : 'Unavailable' },
    { label: 'EV chargers', value: ok('ocm') ? 'Open Charge Map' : ok('overpass') ? 'OpenStreetMap' : ok('search') ? 'Yandex Places' : has('ocm') ? 'Unavailable' : 'Unavailable' },
  ];
}

export function reportText(app: App, results: CheckResult[]): string {
  const lines = [
    `Teslaplay service check · ${new Date().toISOString()}`,
    `${location.host}${location.pathname} · ${navigator.userAgent}`,
    '',
    ...results.map((r) => `${r.ok === null ? '–' : r.ok ? '✓' : '✗'} ${r.name}${r.ms !== undefined ? ` (${r.ms} ms)` : ''}: ${r.detail}`),
    '',
    ...activeProviders(app, results).map((p) => `${p.label}: ${p.value}`),
  ];
  return lines.join('\n');
}
