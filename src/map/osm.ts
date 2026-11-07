import type { LngLat, LngLatBounds } from '../types';
import type { MapClick, MapEngine, MarkerSpec, Padding, RouteLine, ViewRequest, ViewState } from './engine';
import { attachGestureWatcher } from './gestures';
import { trafficTilesUrl } from '../services/mapbox';
import { arrowImage, turnSet } from './arrows';
import { addRoadLayers, metres, setRoadScene } from './roadlayers';
import type { RoadScene } from '../services/roads';
import { buildStyle, PALETTES } from './style';

declare global {
  interface Window { maplibregl?: any }
}

/**
 * The map: OpenStreetMap vector tiles (OpenFreeMap) rendered by MapLibre GL JS in our own "Drive"
 * style, plus Mapbox live traffic on the roads when a token is configured.
 * MapLibre is self-hosted under vendor/ and only downloaded when needed.
 */

const VENDOR = 'vendor/maplibre/maplibre-gl';
/** Buildings within this many metres of the route ahead are flattened and ghosted while driving. */
const GHOST_M = 32;
const LOAD_TIMEOUT = 15000;

let loading: Promise<any> | null = null;

function loadMapLibre(): Promise<any> {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${VENDOR}.css`;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = `${VENDOR}.js`;
    s.async = true;
    s.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error('MapLibre failed to initialise')));
    s.onerror = () => reject(new Error('MapLibre failed to download'));
    document.head.appendChild(s);
  });
  loading.catch(() => { loading = null; });
  return loading;
}

const ROUTE_LAYERS: { id: string; role: string; part: 'casing' | 'fill' }[] = [
  { id: 'tp-route-alt-casing', role: 'alternative', part: 'casing' },
  { id: 'tp-route-alt-fill', role: 'alternative', part: 'fill' },
  { id: 'tp-route-trav-casing', role: 'traveled', part: 'casing' },
  { id: 'tp-route-trav-fill', role: 'traveled', part: 'fill' },
  { id: 'tp-route-pri-casing', role: 'primary', part: 'casing' },
  { id: 'tp-route-pri-fill', role: 'primary', part: 'fill' },
];

/** Road widths in the style's units (see style.ts ROAD_W) by Mapbox Traffic `class`. */
const TRAFFIC_UNITS: any = ['match', ['get', 'class'], ['motorway', 'motorway_link'], 22, ['trunk', 'trunk_link'], 20, ['primary', 'primary_link'], 16, 'secondary', 13, 'tertiary', 10.5, 'service', 5, 8];
const byZoom = (k: number, minPx: number): any => ['interpolate', ['exponential', 2], ['zoom'],
  11, minPx, 16, ['max', minPx, ['*', TRAFFIC_UNITS, (k * 2 ** 16) / 116860]], 20, ['max', minPx, ['*', TRAFFIC_UNITS, (k * 2 ** 20) / 116860]]];
const TRAFFIC_REFRESH = 8 * 60e3; // Mapbox updates congestion about every 8 minutes
const TRAFFIC_SCHEME = 'tp-traffic';
let trafficProtocol = false;

/**
 * MapLibre fetches tiles in a web worker, and those requests carry no page referrer, so Mapbox
 * refuses them for URL-restricted tokens (403). A custom protocol makes the page itself fetch the
 * traffic tiles (with the site's URL as referrer); MapLibre hands the bytes to the worker.
 */
function trafficUrl(gl: any, token: string): string {
  const url = trafficTilesUrl(token, Math.floor(Date.now() / TRAFFIC_REFRESH));
  if (typeof gl.addProtocol !== 'function') return url;
  if (!trafficProtocol) {
    gl.addProtocol(TRAFFIC_SCHEME, async (params: any, abort: AbortController) => {
      const real = String(params.url).replace(`${TRAFFIC_SCHEME}://`, 'https://');
      const r = await fetch(real, { signal: abort.signal, referrerPolicy: 'no-referrer-when-downgrade' });
      if (!r.ok) throw gl.AJAXError ? new gl.AJAXError(r.status, r.statusText, real.replace(/access_token=[^&]+/, 'access_token=…'), new Blob()) : new Error(`HTTP ${r.status}`);
      return { data: await r.arrayBuffer() };
    });
    trafficProtocol = true;
  }
  return url.replace('https://', `${TRAFFIC_SCHEME}://`);
}
const SLOW_COLORS: Record<number, string> = { 2: '#ff9f0a', 3: '#ff453a', 4: '#c4161c' };

export class OsmEngine implements MapEngine {
  readonly kind = 'osm' as const;
  readonly maxTilt = 62;
  private gl: any;
  private map: any;
  private theme: 'light' | 'dark' = 'dark';
  private routes: RouteLine[] = [];
  private layers = new Map<string, Map<string, { marker: any; spec: MarkerSpec }>>();
  private user: any = null;
  private userEl: HTMLElement | null = null;
  private gestureCbs: (() => void)[] = [];
  private viewCbs: ((v: ViewState) => void)[] = [];
  private clickCbs: ((e: MapClick) => void)[] = [];
  private longCbs: ((e: MapClick) => void)[] = [];
  private viewQueued = false;
  private ahead: LngLat[] | null = null;
  private maneuver: LngLat[] | null = null;

  private trafficOn = false;
  private scene: RoadScene | null = null;
  private trafficTimer = 0;
  /** Called when Mapbox refuses the traffic tiles (bad or restricted token). */
  onTrafficError: ((message: string) => void) | null = null;

  constructor(private lang = 'en_US', private mapboxToken = '') {}

  get supportsTraffic() { return !!this.mapboxToken; }

  async init(container: HTMLElement, opts: { center: LngLat; zoom: number; theme: 'light' | 'dark' }) {
    const gl = (this.gl = await loadMapLibre());
    this.theme = opts.theme;
    while (container.firstChild) container.removeChild(container.firstChild);
    const map = (this.map = new gl.Map({
      container,
      style: buildStyle(opts.theme, this.lang),
      center: opts.center,
      zoom: opts.zoom,
      pitch: 0,
      bearing: 0,
      maxPitch: 60,
      attributionControl: { compact: true },
      dragRotate: true,
      touchPitch: true,
      fadeDuration: 150,
    }));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('OpenStreetMap map timed out')), LOAD_TIMEOUT);
      map.once('load', () => { clearTimeout(t); resolve(); });
      map.on('error', (e: any) => {
        console.warn('[osm map]', e && e.error ? e.error.message || e.error : e);
        const status = e && e.error && e.error.status;
        if (e && e.sourceId === 'tp-traffic' && (status === 401 || status === 403) && this.onTrafficError) {
          this.onTrafficError(`Mapbox refused the traffic tiles (${status}) — check the token and its URL restrictions.`);
        }
      });
    });
    this.decorateStyle();
    map.on('style.load', () => this.decorateStyle());
    map.on('styleimagemissing', (e: any) => {
      const id: string = e && e.id;
      if (!id || !id.startsWith('ta:') || map.hasImage(id)) return;
      const img = arrowImage(turnSet(id.slice(3).split(';')), PALETTES[this.theme].marking);
      if (img) map.addImage(id, img, { pixelRatio: 2 });
    });
    map.on('move', () => this.queueView());
    map.on('click', (e: any) => this.handleClick(e, this.clickCbs));
    map.on('contextmenu', (e: any) => this.handleClick(e, this.longCbs));
    attachGestureWatcher(container, () => this.gestureCbs.forEach((cb) => cb()));
    this.attachLongPress(container);
  }

  /** Dynamic layers on top of the style: routes, chevrons, ghost buildings, maneuver arrow. Re-run after style swaps. */
  private decorateStyle() {
    const map = this.map;
    if (!map.getStyle()) return;
    const dark = this.theme === 'dark';
    const before = map.getLayer('tp-buildings') ? 'tp-buildings' : undefined;
    map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: dark ? 0.4 : 0.5, position: [1.15, 210, 30] });

    // Routes sit on the road beneath the buildings.
    if (!map.getSource('tp-routes')) {
      map.addSource('tp-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      for (const l of ROUTE_LAYERS) {
        map.addLayer({
          id: l.id, type: 'line', source: 'tp-routes',
          filter: ['==', ['get', 'role'], l.role],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#2f8bff', 'line-width': 6 },
        }, before);
      }
      // Direction chevrons along the active route.
      map.addLayer({
        id: 'tp-route-chevrons', type: 'symbol', source: 'tp-routes', minzoom: 13.5,
        filter: ['==', ['get', 'role'], 'primary'],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 14, 60, 19, 110],
          'text-field': '›', 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['exponential', 1.6], ['zoom'], 14, 13, 19, 34],
          'text-keep-upright': false, 'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map',
          'text-allow-overlap': true, 'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ffffff', 'text-opacity': 0.9 },
      }, before);
    }

    // Slow stretches of the active route, painted over its blue fill.
    if (!map.getSource('tp-route-traffic')) {
      map.addSource('tp-route-traffic', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'tp-route-traffic', type: 'line', source: 'tp-route-traffic',
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: { 'line-color': ['match', ['get', 'level'], 4, SLOW_COLORS[4], 3, SLOW_COLORS[3], SLOW_COLORS[2]], 'line-width': 6 },
      }, map.getLayer('tp-route-chevrons') ? 'tp-route-chevrons' : before);
    }

    // Ghost copy of the buildings: those standing on the route ahead, low and see-through.
    if (map.getLayer('tp-buildings') && !map.getLayer('tp-buildings-ghost')) {
      const b = map.getLayer('tp-buildings');
      map.addLayer({
        // Placed beneath the route lines so the route stays crisp over the flattened slabs.
        id: 'tp-buildings-ghost', type: 'fill-extrusion', source: b.source, 'source-layer': b.sourceLayer, minzoom: 13.5,
        filter: ['has', '__tp_never__'],
        paint: {
          'fill-extrusion-color': map.getPaintProperty('tp-buildings', 'fill-extrusion-color'),
          'fill-extrusion-height': ['min', ['coalesce', ['get', 'render_height'], 8], 2.5],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.35,
        },
      }, map.getLayer('tp-route-alt-casing') ? 'tp-route-alt-casing' : 'tp-buildings');
    }

    // Maneuver arrow (white, above the buildings so it is always readable).
    if (!map.getSource('tp-mv')) {
      map.addSource('tp-mv', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const w = (m: number, minPx: number) => ['interpolate', ['exponential', 2], ['zoom'], 14, minPx, 20, Math.max(minPx, m * 2 ** 20 / 116860)];
      map.addLayer({ id: 'tp-mv-casing', type: 'line', source: 'tp-mv', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b4fc4', 'line-width': w(6.2, 12) } });
      map.addLayer({ id: 'tp-mv-line', type: 'line', source: 'tp-mv', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': w(4.2, 8) } });
      // Arrow head: a real triangle on the ground (no font glyph needed).
      map.addLayer({ id: 'tp-mv-head-casing', type: 'line', source: 'tp-mv', filter: ['==', ['geometry-type'], 'Polygon'], layout: { 'line-join': 'round' }, paint: { 'line-color': '#0b4fc4', 'line-width': w(1, 2.5) } });
      map.addLayer({ id: 'tp-mv-head', type: 'fill', source: 'tp-mv', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffffff' } });
    }
    addRoadLayers(map, this.theme);
    if (this.scene) setRoadScene(map, this.scene);
    this.applyTraffic();
    this.paintRoutes();
    this.applyNavOverlay();
  }

  /** The lane model (services/roads.ts): asphalt, junctions, markings, arrows, parapets, portals, traffic lights. */
  setRoadDetails(scene: RoadScene) {
    this.scene = scene;
    if (this.map && this.map.getSource('tp-surf')) setRoadScene(this.map, scene);
  }

  /** Mapbox Traffic v1: congestion lines on each side of the road, beneath the route and buildings. */
  private applyTraffic() {
    const map = this.map;
    if (!map || !map.getStyle() || !this.mapboxToken) return;
    if (this.trafficOn && !map.getSource('tp-traffic')) {
      map.addSource('tp-traffic', {
        type: 'vector', tiles: [trafficUrl(this.gl, this.mapboxToken)],
        maxzoom: 16, attribution: '© Mapbox traffic',
      });
      const before = map.getLayer('tp-buildings-ghost') ? 'tp-buildings-ghost' : map.getLayer('tp-route-alt-casing') ? 'tp-route-alt-casing' : undefined;
      map.addLayer({
        id: 'tp-traffic', type: 'line', source: 'tp-traffic', 'source-layer': 'traffic', minzoom: 9,
        // Slowdowns everywhere; free-flowing traffic only on main roads so the city doesn't turn green.
        filter: ['any',
          ['match', ['get', 'congestion'], ['moderate', 'heavy', 'severe'], true, false],
          ['all', ['==', ['get', 'congestion'], 'low'], ['match', ['get', 'class'], ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary'], true, false]],
        ],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['get', 'congestion'], 'low', '#30d158', 'moderate', SLOW_COLORS[2], 'heavy', SLOW_COLORS[3], SLOW_COLORS[4]],
          // At street level free-flowing traffic turns into a light tint so lane markings show through.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 16, ['match', ['get', 'congestion'], 'low', 0.7, 0.95], 17.5, ['match', ['get', 'congestion'], 'low', 0.32, 0.75]],
          'line-width': byZoom(0.42, 1.6),
          // Traffic lines are directional: offset to the right-hand lane of each direction.
          'line-offset': byZoom(0.25, 1.2),
        },
      }, before);
    }
    if (map.getLayer('tp-traffic')) map.setLayoutProperty('tp-traffic', 'visibility', this.trafficOn ? 'visible' : 'none');
    if (this.trafficOn && !this.trafficTimer) {
      this.trafficTimer = window.setInterval(() => {
        const src = this.map && this.map.getSource('tp-traffic');
        if (src && typeof src.setTiles === 'function') src.setTiles([trafficUrl(this.gl, this.mapboxToken)]);
      }, TRAFFIC_REFRESH);
    } else if (!this.trafficOn && this.trafficTimer) {
      clearInterval(this.trafficTimer);
      this.trafficTimer = 0;
    }
  }

  private queueView() {
    if (this.viewQueued) return;
    this.viewQueued = true;
    requestAnimationFrame(() => {
      this.viewQueued = false;
      const v = this.getView();
      this.viewCbs.forEach((cb) => cb(v));
    });
  }

  private handleClick(e: any, cbs: ((e: MapClick) => void)[]) {
    if (!e || !e.lngLat) return;
    const target = e.originalEvent && (e.originalEvent.target as HTMLElement);
    if (target && target.closest && target.closest('[data-tap]')) return; // our own markers
    const click: MapClick = { coord: [e.lngLat.lng, e.lngLat.lat] };
    try {
      const feats: any[] = this.map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]]);
      const poi = feats.find((f) => /poi/i.test(f.sourceLayer || '') && f.properties && (f.properties.name || f.properties.name_en));
      if (poi) {
        const p = poi.properties;
        const g = poi.geometry;
        click.poi = {
          name: String(p.name_en || p.name),
          subtitle: p.class || p.subclass || undefined,
          coord: g && g.type === 'Point' ? g.coordinates : click.coord,
        };
      }
    } catch { /* ignore */ }
    cbs.forEach((cb) => cb(click));
  }

  /** Touch screens don't fire contextmenu reliably: hold still for 550 ms to drop a pin. */
  private attachLongPress(el: HTMLElement) {
    let timer = 0;
    let start: { x: number; y: number } | null = null;
    const cancel = () => { clearTimeout(timer); timer = 0; start = null; };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('[data-tap]')) return;
      start = { x: e.clientX, y: e.clientY };
      const r = el.getBoundingClientRect();
      timer = window.setTimeout(() => {
        if (!start) return;
        const ll = this.map.unproject([start.x - r.left, start.y - r.top]);
        this.longCbs.forEach((cb) => cb({ coord: [ll.lng, ll.lat] }));
        cancel();
      }, 550);
    }, { passive: true });
    el.addEventListener('pointermove', (e) => { if (start && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 8) cancel(); }, { passive: true });
    el.addEventListener('pointerup', cancel, { passive: true });
    el.addEventListener('pointercancel', cancel, { passive: true });
  }

  setTheme(theme: 'light' | 'dark') {
    if (theme === this.theme) return;
    this.theme = theme;
    if (!this.map) return;
    // Full reload (no diff) so `style.load` fires and our buildings and route layers are re-added.
    this.map.setStyle(buildStyle(theme, this.lang), { diff: false });
  }

  async setTraffic(visible: boolean): Promise<boolean> {
    if (!this.mapboxToken) return false;
    this.trafficOn = visible;
    this.applyTraffic();
    return true;
  }

  setView(req: ViewRequest) {
    if (!this.map) return;
    const opts: any = {};
    if (req.center) opts.center = req.center;
    if (req.zoom !== undefined) opts.zoom = req.zoom;
    if (req.tilt !== undefined) opts.pitch = Math.max(0, Math.min(55, req.tilt));
    if (req.azimuth !== undefined) opts.bearing = req.azimuth;
    if (req.duration) this.map.easeTo({ ...opts, duration: req.duration });
    else this.map.jumpTo(opts);
  }

  getView(): ViewState {
    const m = this.map;
    const c = m.getCenter();
    return { center: [c.lng, c.lat], zoom: m.getZoom(), tilt: m.getPitch(), azimuth: ((m.getBearing() % 360) + 360) % 360 };
  }

  /**
   * Fit bounds inside the padded area. Zoom/centre are computed here (Web Mercator, 512 px tiles)
   * and the padding is animated with the camera, so the UI insets and the fit always agree.
   */
  fitBounds(b: LngLatBounds, padding: Padding, duration = 600) {
    const map = this.map;
    const p = clampPadding(padding, map);
    const [x1, y1] = merc(b[0][0], b[0][1]);
    const [x2, y2] = merc(b[1][0], b[1][1]);
    const c = map.getContainer();
    const availW = Math.max(60, c.clientWidth - p.left - p.right);
    const availH = Math.max(60, c.clientHeight - p.top - p.bottom);
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const z = dx || dy ? Math.log2(Math.min(dx ? availW / (dx * 512) : Infinity, dy ? availH / (dy * 512) : Infinity)) : 16;
    const center = unmerc((x1 + x2) / 2, (y1 + y2) / 2);
    this.pendingPad = null;
    map.easeTo({ center, zoom: Math.max(2, Math.min(17, z)), bearing: 0, pitch: 0, padding: p, duration });
  }

  private pendingPad: Padding | null = null;

  /** MapLibre's setPadding jumps the camera (and would cancel a running animation): wait for it to finish. */
  setPadding(p: Padding) {
    const map = this.map;
    if (!map) return;
    const pad = clampPadding(p, map);
    if (map.isMoving()) {
      if (!this.pendingPad) map.once('moveend', () => { const q = this.pendingPad; this.pendingPad = null; if (q) map.setPadding(q); });
      this.pendingPad = pad;
      return;
    }
    map.setPadding(pad);
  }

  setRoutes(lines: RouteLine[]) {
    this.routes = lines;
    this.paintRoutes();
  }

  private paintRoutes() {
    const map = this.map;
    if (!map) return;
    const src = map.getSource('tp-routes');
    if (!src) return;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;
    // [casing px when zoomed out, fill px when zoomed out, casing metres, fill metres]
    const colors: Record<string, { casing: string; fill: string; cw: number; fw: number; cm: number; fm: number }> = {
      alternative: { casing: v('--route-alt-casing', '#3a4250'), fill: v('--route-alt', '#7e8a9c'), cw: 7, fw: 4.5, cm: 8, fm: 6 },
      traveled: { casing: '#4a5160', fill: '#8a93a3', cw: 7, fw: 4.5, cm: 8, fm: 6 },
      primary: { casing: v('--route-casing', '#0b4fc4'), fill: v('--route', '#2f8bff'), cw: 9, fw: 6, cm: 9.5, fm: 7.5 },
    };
    for (const l of ROUTE_LAYERS) {
      const c = colors[l.role];
      if (!map.getLayer(l.id)) continue;
      map.setPaintProperty(l.id, 'line-color', l.part === 'casing' ? c.casing : c.fill);
      const px = l.part === 'casing' ? c.cw : c.fw;
      const m = l.part === 'casing' ? c.cm : c.fm;
      // Fixed pixels when zoomed out; at street level it covers the lane like a painted road.
      // Fixed pixels zoomed out; at street level as wide as the lanes the car drives in (feature `wm`, metres),
      // else the role's default metres. Casing adds 1.4 m.
      const metresExpr: any = ['+', ['coalesce', ['get', 'wm'], m], l.part === 'casing' ? 0.8 : 0];
      map.setPaintProperty(l.id, 'line-width', metres(metresExpr, px));
    }
    const features: any[] = [];
    for (const r of this.routes) {
      const pieces = r.parts && r.parts.length ? r.parts : [{ coords: r.coords, w: 0 }];
      for (const p of pieces) {
        if (p.coords.length < 2) continue;
        const props: any = { role: r.role };
        if (p.w > 0) props.wm = Math.max(2.4, p.w - 0.5); // the band fills the lanes, 25 cm of asphalt showing each side
        features.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: p.coords } });
      }
    }
    src.setData({ type: 'FeatureCollection', features });
    const slow = map.getSource('tp-route-traffic');
    if (slow) {
      const p = colors.primary;
      map.setPaintProperty('tp-route-traffic', 'line-width', metres(['coalesce', ['get', 'wm'], p.fm], p.fw));
      const primary = this.routes.find((r) => r.role === 'primary');
      slow.setData({
        type: 'FeatureCollection',
        features: ((primary && primary.traffic) || []).filter((t) => t.coords.length > 1).map((t) => ({ type: 'Feature', properties: { level: t.level, ...(t.w ? { wm: Math.max(2.4, t.w - 0.5) } : {}) }, geometry: { type: 'LineString', coordinates: t.coords } })),
      });
    }
  }

  setMarkers(layer: string, specs: MarkerSpec[]) {
    const gl = this.gl;
    const current = this.layers.get(layer) || new Map();
    const next = new Map<string, { marker: any; spec: MarkerSpec }>();
    for (const spec of specs) {
      const prev = current.get(spec.id);
      if (prev && prev.spec.el === spec.el) {
        if (prev.spec.coord[0] !== spec.coord[0] || prev.spec.coord[1] !== spec.coord[1]) prev.marker.setLngLat(spec.coord);
        prev.spec = spec;
        next.set(spec.id, prev);
        current.delete(spec.id);
      } else {
        if (prev) { prev.marker.remove(); current.delete(spec.id); }
        spec.el.style.zIndex = String(spec.z || 1200);
        const marker = new gl.Marker({ element: spec.el, anchor: 'center' }).setLngLat(spec.coord).addTo(this.map);
        next.set(spec.id, { marker, spec });
      }
    }
    current.forEach(({ marker }) => marker.remove());
    this.layers.set(layer, next);
  }

  setUserMarker(coord: LngLat | null, el: HTMLElement) {
    if (!coord) {
      if (this.user) { this.user.remove(); this.user = null; }
      return;
    }
    if (!this.user || this.userEl !== el) {
      if (this.user) this.user.remove();
      el.style.zIndex = '5000';
      // Pitch-aligned: in the tilted driving view the arrow lies flat on the road.
      this.user = new this.gl.Marker({ element: el, anchor: 'center', pitchAlignment: 'map' }).setLngLat(coord).addTo(this.map);
      this.userEl = el;
    } else {
      this.user.setLngLat(coord);
    }
  }

  setNavOverlay(o: { ahead: LngLat[] | null; maneuver: LngLat[] | null }) {
    this.ahead = o.ahead && o.ahead.length > 1 ? o.ahead : null;
    this.maneuver = o.maneuver && o.maneuver.length > 1 ? o.maneuver : null;
    this.applyNavOverlay();
  }

  private applyNavOverlay() {
    const map = this.map;
    if (!map || !map.getLayer('tp-buildings')) return;
    const solid: any = ['!', ['has', 'hide_3d']];
    if (this.ahead) {
      const line = { type: 'LineString', coordinates: this.ahead };
      map.setFilter('tp-buildings', ['all', solid, ['>', ['distance', line], GHOST_M]]);
      if (map.getLayer('tp-buildings-ghost')) map.setFilter('tp-buildings-ghost', ['all', solid, ['<=', ['distance', line], GHOST_M]]);
    } else {
      map.setFilter('tp-buildings', solid);
      if (map.getLayer('tp-buildings-ghost')) map.setFilter('tp-buildings-ghost', ['has', '__tp_never__']);
    }
    const src = map.getSource('tp-mv');
    if (src) {
      const m = this.maneuver;
      const feats: any[] = [];
      if (m) {
        // Shaft along the route through the turn, then a triangular head pointing out of it.
        const a = m[m.length - 2];
        const b = m[m.length - 1];
        const kx = 111320 * Math.cos((b[1] * Math.PI) / 180);
        const ky = 110540;
        const dx = (b[0] - a[0]) * kx;
        const dy = (b[1] - a[1]) * ky;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const at = (along: number, side: number): LngLat => [b[0] + (ux * along - uy * side) / kx, b[1] + (uy * along + ux * side) / ky];
        const head = [at(-0.5, 6), at(10, 0), at(-0.5, -6), at(-0.5, 6)];
        feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: m } });
        feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [head] } });
      }
      src.setData({ type: 'FeatureCollection', features: feats });
    }
  }

  onUserGesture(cb: () => void) { this.gestureCbs.push(cb); }
  onViewChange(cb: (v: ViewState) => void) { this.viewCbs.push(cb); }
  onClick(cb: (e: MapClick) => void) { this.clickCbs.push(cb); }
  onLongPress(cb: (e: MapClick) => void) { this.longCbs.push(cb); }
}

/** MapLibre refuses padding that leaves no room; keep at least a third of each axis free. */
function clampPadding(p: Padding, map: any): Padding {
  const c = map.getContainer();
  const w = c.clientWidth;
  const h = c.clientHeight;
  const sx = Math.min(1, (w * 0.66) / Math.max(1, p.left + p.right));
  const sy = Math.min(1, (h * 0.66) / Math.max(1, p.top + p.bottom));
  return { top: Math.round(p.top * sy), bottom: Math.round(p.bottom * sy), left: Math.round(p.left * sx), right: Math.round(p.right * sx) };
}

const merc = (lng: number, lat: number): [number, number] => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
};
const unmerc = (x: number, y: number): [number, number] => [x * 360 - 180, (360 / Math.PI) * Math.atan(Math.exp((1 - 2 * y) * Math.PI)) - 90];
