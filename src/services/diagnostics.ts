import type { App } from '../app';
import type { LngLat } from '../types';
import { checkMapboxToken } from './mapbox';
import { OsrmRouting } from './osrm';

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
  const token = cfg.mapboxToken;
  const live = !cfg.demo;

  const checks: Promise<CheckResult>[] = [];
  const add = (id: string, name: string, fn: (() => Promise<string>) | null, skipped = 'Not configured') => {
    checks.push(fn ? timed(fn).then((r) => ({ id, name, ...r })) : Promise.resolve({ id, name, ok: null, detail: skipped }));
  };

  add('map', 'Map tiles (OpenFreeMap)', live ? async () => {
    const r = await fetch('https://tiles.openfreemap.org/planet');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return `OpenStreetMap data${j.version ? ` · ${j.version}` : ''}`;
  } : null, 'Demo mode — offline map');

  add('mapbox', 'Mapbox live-traffic routes', live && token ? async () => checkMapboxToken(token, here, near) : null,
    'No Mapbox token — routes without traffic');

  add('traffic', 'Mapbox traffic on the map', live && token ? async () => {
    // One real traffic tile where you are (zoom 14).
    const z = 14;
    const x = Math.floor(((here[0] + 180) / 360) * 2 ** z);
    const lat = (here[1] * Math.PI) / 180;
    const yy = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * 2 ** z);
    const r = await fetch(`https://api.mapbox.com/v4/mapbox.mapbox-traffic-v1/${z}/${x}/${yy}.vector.pbf?access_token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 401 || r.status === 403 ? ' — token refused (check URL restrictions)' : ''}`);
    const kb = ((await r.arrayBuffer()).byteLength / 1024).toFixed(1);
    return `${kb} KB of traffic here · ${app.state.settings.traffic ? 'shown on the map' : 'switched off in Settings'}`;
  } : null, 'No Mapbox token');

  add('matrix', 'Mapbox drive times', app.matrix ? async () => {
    const [t] = await app.matrix!.from(here, [near]);
    if (!t) throw new Error('No route between test points');
    return `${Math.round(t.duration / 60)} min to a point ${(t.distance / 1000).toFixed(1)} km away`;
  } : null, 'No Mapbox token — nearby results sorted by distance');

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
    { label: 'Map', value: app.cfg.demo ? 'Demo' : ok('map') ? 'OpenStreetMap (Drive style)' : 'Not loading' },
    { label: 'Directions', value: ok('mapbox') ? 'Mapbox — live traffic' : ok('osrm') ? 'OpenStreetMap (OSRM) — no traffic' : 'Unavailable' },
    { label: 'Traffic on the map', value: ok('traffic') ? 'Mapbox' : 'Off' },
    { label: 'Search', value: ok('photon') ? 'OpenStreetMap (Photon)' : 'Unavailable' },
    { label: 'Nearby places', value: (ok('overpass') ? 'OpenStreetMap' : 'Unavailable') + (ok('matrix') ? ' · drive times by Mapbox' : '') },
    { label: 'EV chargers', value: ok('ocm') ? 'Open Charge Map' : ok('overpass') ? 'OpenStreetMap' : has('ocm') ? 'Unavailable' : 'Unavailable' },
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
