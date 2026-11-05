import { isTesla } from './core/env';
import { storage } from './core/storage';
import type { FollowMode } from './nav/follow';
import type { NavSnapshot } from './nav/session';
import type { LocationStatus } from './services/location';
import type { Material } from './ui/glass';
import type { Fix, Place, RouteResult, Settings, TripPlan, Weather } from './types';

export type PanelView = 'home' | 'search' | 'place' | 'planner';

export interface Toast { id: number; text: string; tone: 'info' | 'ok' | 'warn' | 'err' }

export interface AppState {
  theme: 'light' | 'dark';
  lite: boolean;
  /** Effective glass material after device checks and frame-rate fallbacks. */
  material: Material;
  settings: Settings;
  demo: boolean;

  panel: PanelView;
  collapsed: boolean;
  query: string;
  suggestions: Place[];
  results: { title: string; categoryId?: string; places: Place[] } | null;
  searching: boolean;
  place: Place | null;
  placeEta: { placeId: string; duration: number; distance: number } | null;
  droppedPin: Place | null;

  destination: Place | null;
  routes: RouteResult[];
  routeIndex: number;
  routing: boolean;
  routeError: string | null;
  quickSoc: number[];
  plan: TripPlan | null;
  planBusy: boolean;
  chargers: Place[];
  skipped: string[];
  battery: number;
  weatherHere: Weather | null;
  weatherDest: Weather | null;

  navigating: boolean;
  navRoute: RouteResult | null;
  nav: NavSnapshot | null;
  rerouting: boolean;
  arrived: boolean;
  tripOpen: boolean;
  simulating: boolean;
  simSpeed: number;
  muted: boolean;

  fix: Fix | null;
  locStatus: LocationStatus;
  follow: FollowMode;
  azimuth: number;
  trafficAvailable: boolean;

  home: Place | null;
  work: Place | null;
  favorites: Place[];
  recents: Place[];

  settingsOpen: boolean;
  toasts: Toast[];
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: 'auto',
  voice: true,
  units: 'metric',
  vehicleId: 'my-lr',
  usableKWh: 75,
  consumption: null,
  reserveSoc: 10,
  maxChargeSoc: 80,
  avoidTolls: false,
  driverSide: 'left',
  glass: 'auto',
  textSize: isTesla ? 'large' : 'standard',
  traffic: true,
  view3D: true,
  roadStyle: 'drive',
  devTools: false,
};

export function initialState(demo: boolean): AppState {
  return {
    theme: 'dark',
    lite: false,
    material: 'frosted',
    settings: { ...DEFAULT_SETTINGS, ...storage.get<Partial<Settings>>('settings', {}) },
    demo,
    panel: 'home',
    collapsed: false,
    query: '',
    suggestions: [],
    results: null,
    searching: false,
    place: null,
    placeEta: null,
    droppedPin: null,
    destination: null,
    routes: [],
    routeIndex: 0,
    routing: false,
    routeError: null,
    quickSoc: [],
    plan: null,
    planBusy: false,
    chargers: [],
    skipped: [],
    battery: storage.get<number>('battery', 80),
    weatherHere: null,
    weatherDest: null,
    navigating: false,
    navRoute: null,
    nav: null,
    rerouting: false,
    arrived: false,
    tripOpen: false,
    simulating: false,
    simSpeed: 1,
    muted: storage.get<boolean>('muted', false),
    fix: null,
    locStatus: 'pending',
    follow: 'follow',
    azimuth: 0,
    trafficAvailable: true,
    home: storage.get<Place | null>('home', null),
    work: storage.get<Place | null>('work', null),
    favorites: storage.get<Place[]>('favorites', []),
    recents: storage.get<Place[]>('recents', []),
    settingsOpen: false,
    toasts: [],
  };
}
