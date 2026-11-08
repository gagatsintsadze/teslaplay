import type { LngLat, LngLatBounds } from '../types';

export interface ViewState {
  center: LngLat;
  zoom: number;
  /** degrees, 0 = top-down */
  tilt: number;
  /** degrees clockwise; the compass direction at the top of the screen */
  azimuth: number;
}

export interface Padding { top: number; right: number; bottom: number; left: number }

export type RouteRole = 'primary' | 'alternative' | 'traveled';
/** `traffic`: slow stretches of this line (live traffic), drawn over it in orange/red. */
/**
 * `w`: width in metres of the lanes the car drives in along this piece (0/absent = default width).
 * A line may be split into `parts` with different widths; `coords` is always the whole line.
 */
export interface RouteLine {
  id: string; coords: LngLat[]; role: RouteRole;
  parts?: { coords: LngLat[]; w: number; h?: number[] }[];
  traffic?: { coords: LngLat[]; level: number; w?: number }[];
  /** lane-change marks painted on the band: where to move over, and which way */
  marks?: { coord: LngLat; bearing: number; dir: 'left' | 'right' }[];
}

export interface MarkerSpec {
  id: string;
  coord: LngLat;
  /** Element is placed with its (0,0) at the coordinate; children position themselves with CSS. */
  el: HTMLElement;
  z?: number;
}

export interface MapClick {
  coord: LngLat;
  /** Set when a map POI was tapped. */
  poi?: { name: string; subtitle?: string; coord: LngLat };
}

export interface ViewRequest extends Partial<ViewState> { duration?: number }

/** Everything the app needs from a map. Implemented by OsmEngine (MapLibre) and the offline DemoEngine. */
export interface MapEngine {
  readonly kind: 'osm' | 'demo';
  readonly supportsTraffic: boolean;
  /** Steepest camera pitch the engine renders well, degrees (the driving view uses it). */
  readonly maxTilt: number;
  init(container: HTMLElement, opts: { center: LngLat; zoom: number; theme: 'light' | 'dark' }): Promise<void>;
  setTheme(theme: 'light' | 'dark'): void;
  /** Resolves to whether traffic could be shown. */
  setTraffic(visible: boolean): Promise<boolean>;
  setView(req: ViewRequest): void;
  getView(): ViewState;
  fitBounds(b: LngLatBounds, padding: Padding, duration?: number): void;
  /** UI insets: the visual centre of the map is the centre of the unpadded area. */
  setPadding(p: Padding): void;
  setRoutes(lines: RouteLine[]): void;
  setMarkers(layer: string, markers: MarkerSpec[]): void;
  setUserMarker(coord: LngLat | null, el: HTMLElement, heading?: number, height?: number): void;
  /** Optional: structures (by id) the car is about to drive under, drawn see-through. */
  setXray?(ids: string[]): void;
  /** Optional: a 3-D car model drawn at the user's position instead of the DOM puck. */
  setCarModel?(enabled: boolean, color: string): void;
  /** Fired when the user drags/zooms/rotates the map (not for programmatic moves). */
  onUserGesture(cb: () => void): void;
  onViewChange(cb: (v: ViewState) => void): void;
  onClick(cb: (e: MapClick) => void): void;
  onLongPress(cb: (e: MapClick) => void): void;
  /** Optional: the lane model to draw (services/roads.ts). */
  setRoadDetails?(scene: import('../services/roads').RoadScene): void;
  /** Optional: live traffic features in view, and congestion polygons to paint on the lane model. */
  trafficFeatures?(): { congestion: string; coords: LngLat[] }[];
  setTrafficLanes?(fc: any): void;
  onTrafficTiles?: (() => void) | null;
  /**
   * Driving overlays (optional): `ahead` is the next stretch of route — buildings standing on it
   * are flattened and ghosted so they never hide the line; `maneuver` is a short path through
   * the next turn, drawn as a white arrow.
   */
  setNavOverlay?(o: { ahead: LngLat[] | null; maneuver: LngLat[] | null }): void;
}
