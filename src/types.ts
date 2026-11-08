/** [longitude, latitude] — the GeoJSON / MapLibre / Mapbox coordinate order. */
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
  source: 'ocm' | 'osm' | 'demo';
}

export interface Place {
  id: string;
  name: string;
  subtitle?: string;
  coord?: LngLat;
  /** Provider object id, when coordinates are resolved lazily. */
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
  /** Router-written instruction (Mapbox), e.g. "Take the 2nd exit onto …". */
  instruction?: string;
  /** Lanes approaching this maneuver, left to right: arrows painted on each, and whether it leads the right way. */
  lanes?: { dirs: string[]; valid: boolean; active?: boolean }[];
  /** Roundabout entry: which exit to take (1 = first). */
  exit?: number;
  roundabout?: boolean;
}

/** A stretch of the route with moderate (2), heavy (3) or severe (4) congestion, by distance along it. */
export interface TrafficSpan { from: number; to: number; level: 2 | 3 | 4 }

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
  /** Live-traffic routers: the ETA without today's traffic, seconds. */
  durationTypical?: number;
  /** True when the router returned congestion for every segment. */
  trafficAware?: boolean;
  /** Slow stretches along the route (live traffic). */
  traffic?: TrafficSpan[];
  /** Posted speed limit per geometry segment, km/h (null = unknown). */
  maxspeed?: (number | null)[];
  /** Traffic lights the route passes. */
  signals?: LngLat[];
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
  /** Marker shown while driving: an arrow or a car, and the car's colour. */
  carMarker: 'model' | 'arrow' | 'sedan' | 'suv';
  carColor: string;
  devTools: boolean;
}
