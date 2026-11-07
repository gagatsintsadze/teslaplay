import { params } from './core/env';
import { storage } from './core/storage';

export interface AppConfig {
  /** Mapbox public token (pk.…): live-traffic routes, traffic on the map, drive times. Optional. */
  mapboxToken: string;
  /** Label and search language, e.g. en_US, ka_GE, ru_RU. */
  mapLang: string;
  openChargeMapKey: string;
  demo: boolean;
  demoBackdropUrl: string;
  /** Start a simulated drive automatically when navigation begins. */
  autoSimulate: boolean;
  debug: boolean;
}

declare global {
  interface Window { TESLAPLAY_CONFIG?: Partial<AppConfig> }
}

const DEFAULTS: AppConfig = {
  mapboxToken: '',
  mapLang: 'en_US',
  openChargeMapKey: '',
  demo: false,
  demoBackdropUrl: 'demo/backdrop-dark.jpg',
  autoSimulate: false,
  debug: false,
};

/** Keys a user typed into the app (onboarding / settings) override the deployed config. */
export type LocalKeys = Partial<Pick<AppConfig, 'mapboxToken' | 'openChargeMapKey' | 'mapLang'>>;

export function loadConfig(): AppConfig {
  const fromFile = window.TESLAPLAY_CONFIG || {};
  const saved = storage.get<Record<string, unknown>>('keys', {});
  const local: LocalKeys = { mapboxToken: saved.mapboxToken as string, openChargeMapKey: saved.openChargeMapKey as string, mapLang: saved.mapLang as string };
  const cfg: AppConfig = { ...DEFAULTS, ...stripEmpty(fromFile), ...stripEmpty(local) };
  if (params.has('demo')) cfg.demo = params.get('demo') !== '0';
  if (params.get('mapbox')) cfg.mapboxToken = params.get('mapbox')!;
  if (params.get('lang')) cfg.mapLang = params.get('lang')!;
  if (params.has('sim')) cfg.autoSimulate = params.get('sim') !== '0';
  if (params.has('debug')) cfg.debug = true;
  return cfg;
}

export function saveLocalKeys(keys: LocalKeys) {
  storage.set('keys', { ...storage.get<LocalKeys>('keys', {}), ...keys });
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in o) {
    const v = o[k];
    if (v !== '' && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
