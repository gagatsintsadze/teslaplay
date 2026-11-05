import type { LngLat, LngLatBounds } from '../types';
import type { MapClick, MapEngine, MarkerSpec, Padding, RouteLine, ViewRequest, ViewState } from './engine';
import { attachGestureWatcher } from './gestures';

declare global {
  interface Window { maplibregl?: any }
}

/**
 * OpenStreetMap vector map (MapLibre GL JS + CARTO basemaps) — used whenever the Yandex map can't
 * load (key not allowed on this site, blocked, offline Yandex), so the app always has a real map.
 * MapLibre is self-hosted under vendor/ and only downloaded when needed.
 */

const STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
};
const VENDOR = 'vendor/maplibre/maplibre-gl';
/** OpenFreeMap: OpenMapTiles-schema vector tiles with building heights (render_height), free, no key. */
const BUILDINGS_TILES = 'https://tiles.openfreemap.org/planet';
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

export class OsmEngine implements MapEngine {
  readonly kind = 'osm' as const;
  readonly supportsTraffic = false;
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

  async init(container: HTMLElement, opts: { center: LngLat; zoom: number; theme: 'light' | 'dark' }) {
    const gl = (this.gl = await loadMapLibre());
    this.theme = opts.theme;
    while (container.firstChild) container.removeChild(container.firstChild);
    const map = (this.map = new gl.Map({
      container,
      style: STYLES[opts.theme],
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
      map.on('error', (e: any) => console.warn('[osm map]', e && e.error ? e.error.message || e.error : e));
    });
    this.decorateStyle();
    map.on('style.load', () => this.decorateStyle());
    map.on('move', () => this.queueView());
    map.on('click', (e: any) => this.handleClick(e, this.clickCbs));
    map.on('contextmenu', (e: any) => this.handleClick(e, this.longCbs));
    attachGestureWatcher(container, () => this.gestureCbs.forEach((cb) => cb()));
    this.attachLongPress(container);
  }

  /** Our additions on top of the basemap: 3D buildings and the route layers. Re-run after style swaps. */
  private decorateStyle() {
    const map = this.map;
    const style = map.getStyle();
    if (!style) return;
    const layers: any[] = style.layers || [];
    const firstSymbol = (layers.find((l) => l.type === 'symbol') || {}).id;
    const dark = this.theme === 'dark';
    // Real 3D buildings: heights from OpenStreetMap (height / building:levels) via OpenFreeMap.
    // The basemap's own flat building footprints are hidden so the extrusions read cleanly.
    layers.filter((l) => l['source-layer'] === 'building' && l.id !== 'tp-buildings').forEach((l) => {
      try { map.setLayoutProperty(l.id, 'visibility', 'none'); } catch { /* ignore */ }
    });
    try {
      if (!map.getSource('tp-ofm')) map.addSource('tp-ofm', { type: 'vector', url: BUILDINGS_TILES });
      if (!map.getLayer('tp-buildings')) {
        map.addLayer({
          id: 'tp-buildings',
          type: 'fill-extrusion',
          source: 'tp-ofm',
          'source-layer': 'building',
          minzoom: 13.5,
          filter: ['!=', ['get', 'hide_3d'], true],
          paint: {
            'fill-extrusion-color': dark
              ? ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#2a303c', 40, '#343c4c', 120, '#3e4860']
              : ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#e9e6e0', 40, '#e1ddd5', 120, '#d6d2ca'],
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 15, ['coalesce', ['get', 'render_height'], 8]],
            'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 15, ['coalesce', ['get', 'render_min_height'], 0]],
            // Must be fully opaque: any value below 1 composites the whole building layer
            // translucently, so streets and labels show through the buildings.
            'fill-extrusion-opacity': 1,
            'fill-extrusion-vertical-gradient': true,
          },
        }, firstSymbol);
      }
      map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: dark ? 0.35 : 0.42, position: [1.3, 200, 35] });
    } catch (e) { console.warn('[osm map] 3D buildings unavailable', e); }
    if (!map.getSource('tp-routes')) {
      map.addSource('tp-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      // Routes sit on the road *under* the 3D buildings, so buildings stay solid and hide the
      // line only where it really passes behind them.
      const below = map.getLayer('tp-buildings') ? 'tp-buildings' : firstSymbol;
      for (const l of ROUTE_LAYERS) {
        map.addLayer({
          id: l.id,
          type: 'line',
          source: 'tp-routes',
          filter: ['==', ['get', 'role'], l.role],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#2f8bff', 'line-width': 6 },
        }, below);
      }
    }
    this.paintRoutes();
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
    this.map.setStyle(STYLES[theme], { diff: false });
  }

  async setTraffic(_visible: boolean): Promise<boolean> { return false; }

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
    const colors: Record<string, { casing: string; fill: string; cw: number; fw: number }> = {
      alternative: { casing: v('--route-alt-casing', '#3a4250'), fill: v('--route-alt', '#7e8a9c'), cw: 10, fw: 6 },
      traveled: { casing: '#4a5160', fill: '#8a93a3', cw: 10, fw: 6 },
      primary: { casing: v('--route-casing', '#0b4fc4'), fill: v('--route', '#2f8bff'), cw: 12.5, fw: 8 },
    };
    for (const l of ROUTE_LAYERS) {
      const c = colors[l.role];
      if (!map.getLayer(l.id)) continue;
      map.setPaintProperty(l.id, 'line-color', l.part === 'casing' ? c.casing : c.fill);
      const w = l.part === 'casing' ? c.cw : c.fw;
      // Wide and confident in the close driving view, slim when zoomed out.
      map.setPaintProperty(l.id, 'line-width', ['interpolate', ['exponential', 1.5], ['zoom'], 8, w * 0.4, 14, w * 0.8, 17, w * 1.35, 19.5, w * 2.3]);
    }
    src.setData({
      type: 'FeatureCollection',
      features: this.routes.filter((r) => r.coords.length > 1).map((r) => ({ type: 'Feature', properties: { role: r.role }, geometry: { type: 'LineString', coordinates: r.coords } })),
    });
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
