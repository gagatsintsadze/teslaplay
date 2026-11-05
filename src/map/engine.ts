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
export interface RouteLine { id: string; coords: LngLat[]; role: RouteRole }

export interface MarkerSpec {
  id: string;
  coord: LngLat;
  /** Element is placed with its (0,0) at the coordinate; children position themselves with CSS. */
  el: HTMLElement;
  z?: number;
}

export interface MapClick {
  coord: LngLat;
  /** Set when a map POI (Yandex hotspot) was tapped. */
  poi?: { name: string; subtitle?: string; coord: LngLat };
}

export interface ViewRequest extends Partial<ViewState> { duration?: number }

/** Everything the app needs from a map. Implemented by YandexEngine, OsmEngine (MapLibre fallback) and the offline DemoEngine. */
export interface MapEngine {
  readonly kind: 'yandex' | 'osm' | 'demo';
  readonly supportsTraffic: boolean;
  /** Steepest camera pitch the engine renders well, degrees (the driving view uses it). */
  readonly maxTilt: number;
  init(container: HTMLElement, opts: { center: LngLat; zoom: number; theme: 'light' | 'dark'; roadStyle?: 'drive' | 'classic' }): Promise<void>;
  setTheme(theme: 'light' | 'dark'): void;
  /** Yandex only: switch between the Drive road styling and Yandex's stock scheme. */
  setRoadStyle?(style: 'drive' | 'classic'): void;
  /** Resolves to whether traffic could be shown. */
  setTraffic(visible: boolean): Promise<boolean>;
  setView(req: ViewRequest): void;
  getView(): ViewState;
  fitBounds(b: LngLatBounds, padding: Padding, duration?: number): void;
  /** UI insets: the visual centre of the map is the centre of the unpadded area. */
  setPadding(p: Padding): void;
  setRoutes(lines: RouteLine[]): void;
  setMarkers(layer: string, markers: MarkerSpec[]): void;
  setUserMarker(coord: LngLat | null, el: HTMLElement): void;
  /** Fired when the user drags/zooms/rotates the map (not for programmatic moves). */
  onUserGesture(cb: () => void): void;
  onViewChange(cb: (v: ViewState) => void): void;
  onClick(cb: (e: MapClick) => void): void;
  onLongPress(cb: (e: MapClick) => void): void;
  /**
   * Driving overlays (optional): `ahead` is the next stretch of route — buildings standing on it
   * are flattened and ghosted so they never hide the line; `maneuver` is a short path through
   * the next turn, drawn as a white arrow.
   */
  setNavOverlay?(o: { ahead: LngLat[] | null; maneuver: LngLat[] | null }): void;
}
