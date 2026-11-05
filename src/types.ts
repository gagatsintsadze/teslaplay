/** [longitude, latitude] — the coordinate order used by Yandex Maps JS API v3. */
export type LngLat = [number, number];
/** [[west, north], [east, south]] — top-left and bottom-right corners. */
export type LngLatBounds = [LngLat, LngLat];

export type PlaceKind = 'address' | 'business' | 'charger' | 'pin' | 'city';

export interface ChargerInfo {
  powerKW: number;
  connectors: string[];
  points?: number;
  operational?: boolean;
  cost?: string;
  operator?: string;
  source: 'ocm' | 'osm' | 'yandex' | 'demo';
}

export interface Place {
  id: string;
  name: string;
  subtitle?: string;
  coord?: LngLat;
  /** Yandex object URI (from suggest) used to resolve coordinates lazily. */
  uri?: string;
  kind?: PlaceKind;
  category?: string;
  /** Straight-line distance from the user, metres. */
  distance?: number;
  /** Driving time from the user (Distance Matrix, with traffic), seconds. */
  eta?: number;
  charger?: ChargerInfo;
}

export interface RouteStep {
  startDist: number;
  distance: number;
  duration: number;
  /** Road name for this step, when the router provides one. */
  name?: string;
}

export type ManeuverType =
  | 'depart' | 'straight' | 'slight-left' | 'slight-right' | 'left' | 'right'
  | 'sharp-left' | 'sharp-right' | 'uturn' | 'waypoint' | 'arrive';

export interface Maneuver {
  type: ManeuverType;
  /** Signed turn angle in degrees: + right, − left. */
  angle: number;
  /** Distance along the route, metres. */
  at: number;
  coord: LngLat;
  street?: string;
  /** For waypoint maneuvers: the stop's name. */
  label?: string;
}

export interface RouteResult {
  id: string;
  coords: LngLat[];
  /** Cumulative distance at each vertex, metres. */
  cum: number[];
  distance: number;
  duration: number;
  hasTolls: boolean;
  steps: RouteStep[];
  maneuvers: Maneuver[];
  /** Distances along the route where each intermediate waypoint is reached. */
  waypointDists: number[];
  via?: string;
}

export interface ElevationProfile {
  /** Distance (m) and height (m) samples along the route. */
  samples: { d: number; h: number }[];
  ascent: number;
  descent: number;
}

export interface Weather {
  tempC: number;
  code: number;
  isDay: boolean;
  label: string;
  severe: boolean;
}

export interface ChargeStop {
  place: Place;
  distAlong: number;
  arriveSoc: number;
  departSoc: number;
  chargeMinutes: number;
  powerKW: number;
}

export interface TripPlan {
  routeId: string;
  startSoc: number;
  kWh: number;
  arrivalSoc: number;
  /** Driving + charging time, seconds. */
  totalDuration: number;
  stops: ChargeStop[];
  /** Legs between consecutive stops: distance (m), duration (s), energy (kWh). */
  legs: { distance: number; duration: number; kWh: number }[];
  feasible: boolean;
  note?: string;
  elevation?: ElevationProfile;
  tempC?: number;
}

export interface Fix {
  coord: LngLat;
  accuracy: number;
  /** m/s */
  speed: number | null;
  /** degrees clockwise from north */
  heading: number | null;
  time: number;
  simulated?: boolean;
}

export type ThemeMode = 'auto' | 'light' | 'dark';

export interface Settings {
  themeMode: ThemeMode;
  voice: boolean;
  units: 'metric' | 'imperial';
  vehicleId: string;
  usableKWh: number;
  /** Override for base consumption, Wh/km. null = use the vehicle preset. */
  consumption: number | null;
  reserveSoc: number;
  maxChargeSoc: number;
  avoidTolls: boolean;
  driverSide: 'left' | 'right';
  /** Liquid (lensed glass), Frosted (blur only), Solid (opaque). Auto picks by device and steps down if driving gets choppy. */
  glass: 'auto' | 'liquid' | 'frosted' | 'solid';
  textSize: 'standard' | 'large' | 'larger';
  traffic: boolean;
  view3D: boolean;
  /** Drive: high-contrast asphalt roads and lane markings on the Yandex map. Classic: Yandex's stock scheme. */
  roadStyle: 'drive' | 'classic';
  devTools: boolean;
}
