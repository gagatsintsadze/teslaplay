import type { AppConfig } from '../config';
import { toDeg, toRad } from '../core/geo';
import type { LngLat, LngLatBounds } from '../types';
import type { MapClick, MapEngine, MarkerSpec, Padding, RouteLine, ViewRequest, ViewState } from './engine';
import { attachGestureWatcher } from './gestures';

declare global {
  interface Window { ymaps3?: any }
}

/**
 * Sign convention between our `azimuth` (compass bearing at the top of the screen, like Apple/Mapbox)
 * and Yandex's camera azimuth. If the compass needle turns the opposite way to the map on a live key,
 * flip this to -1.
 */
export const AZIMUTH_SIGN = 1;

const LOAD_TIMEOUT = 12000;
let loading: Promise<any> | null = null;

/** Inject the JS API v3 loader once and wait for `ymaps3.ready`. */
export function loadYandex(cfg: AppConfig): Promise<any> {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (!cfg.yandexApiKey) return reject(new Error('missing-key'));
    const s = document.createElement('script');
    s.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(cfg.yandexApiKey)}&lang=${encodeURIComponent(cfg.mapLang)}`;
    s.async = true;
    const timer = setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT);
    s.onerror = () => { clearTimeout(timer); reject(new Error('network')); };
    s.onload = () => {
      const y = window.ymaps3;
      if (!y) { clearTimeout(timer); reject(new Error('invalid-key')); return; }
      Promise.resolve(y.ready).then(() => {
        clearTimeout(timer);
        try {
          // Separate HTTP services may use their own keys; fall back to the JS API key.
          y.getDefaultConfig().setApikeys({
            suggest: cfg.yandexSuggestKey || cfg.yandexApiKey,
            search: cfg.yandexSearchKey || cfg.yandexApiKey,
            router: cfg.yandexRouterKey || cfg.yandexApiKey,
          });
        } catch (e) { console.warn('[yandex] setApikeys failed', e); }
        resolve(y);
      }, (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
    };
    document.head.appendChild(s);
  });
  loading.catch(() => { loading = null; });
  return loading;
}

interface RouteStyle { casing: string; fill: string; casingW: number; fillW: number; z: number }

export class YandexEngine implements MapEngine {
  readonly kind = 'yandex' as const;
  supportsTraffic = true;
  readonly maxTilt = 50; // ymaps3 camera limit
  private y: any;
  private map: any;
  private scheme: any;
  private trafficLayer: any = null;
  private routeEntities: any[] = [];
  private layers = new Map<string, Map<string, { marker: any; spec: MarkerSpec }>>();
  private user: any = null;
  private userEl: HTMLElement | null = null;
  private theme: 'light' | 'dark' = 'dark';
  private gestureCbs: (() => void)[] = [];
  private viewCbs: ((v: ViewState) => void)[] = [];
  private clickCbs: ((e: MapClick) => void)[] = [];
  private longCbs: ((e: MapClick) => void)[] = [];
  private viewQueued = false;

  constructor(private cfg: AppConfig) {}

  async init(container: HTMLElement, opts: { center: LngLat; zoom: number; theme: 'light' | 'dark' }) {
    const y = (this.y = await loadYandex(this.cfg));
    this.theme = opts.theme;
    const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapListener } = y;
    this.map = new YMap(container, {
      location: { center: opts.center, zoom: opts.zoom },
      camera: { tilt: 0, azimuth: 0 },
      mode: 'vector',
      theme: opts.theme,
      behaviors: ['drag', 'pinchZoom', 'scrollZoom', 'dblClick', 'mouseRotate', 'mouseTilt', 'pinchRotate', 'panTilt'],
      zoomRange: { min: 3, max: 21 },
      showScaleInCopyrights: true,
    });
    this.scheme = new YMapDefaultSchemeLayer({ theme: opts.theme });
    this.map.addChild(this.scheme);
    this.map.addChild(new YMapDefaultFeaturesLayer({}));
    this.map.addChild(new YMapListener({
      layer: 'any',
      onUpdate: () => this.queueView(),
      onClick: (object: any, event: any) => this.handleClick(object, event, this.clickCbs),
      onContextMenu: (object: any, event: any) => this.handleClick(object, event, this.longCbs),
    }));
    attachGestureWatcher(container, () => this.gestureCbs.forEach((cb) => cb()));
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

  private handleClick(object: any, event: any, cbs: ((e: MapClick) => void)[]) {
    if (!event || !event.coordinates) return;
    if (object && object.type === 'marker') return; // our own markers handle their taps
    const click: MapClick = { coord: event.coordinates as LngLat };
    if (object && object.type === 'hotspot' && object.entity) {
      const props = object.entity.properties || {};
      const name = props.name || props.title || props.caption || props.hint || '';
      if (name) {
        const g = object.entity.geometry;
        click.poi = {
          name: String(name),
          subtitle: props.category || props.description || undefined,
          coord: g && Array.isArray(g.coordinates) && typeof g.coordinates[0] === 'number' ? g.coordinates : click.coord,
        };
      }
    }
    cbs.forEach((cb) => cb(click));
  }

  setTheme(theme: 'light' | 'dark') {
    if (theme === this.theme) return;
    this.theme = theme;
    if (!this.map) return; // applied at init
    try { this.map.update({ theme }); } catch (e) { console.warn(e); }
    try { this.scheme.update({ theme }); } catch { /* prop removed in newer builds */ }
  }

  async setTraffic(visible: boolean): Promise<boolean> {
    if (!this.trafficLayer) {
      if (!visible) return true;
      try {
        const mod = await this.y.import('@yandex/ymaps3-layers-extra');
        this.trafficLayer = new mod.YMapTrafficLayer({ visible: true });
        this.map.addChild(this.trafficLayer);
        return true;
      } catch (e) {
        console.warn('[yandex] traffic layer unavailable on this key/plan', e);
        this.supportsTraffic = false;
        return false;
      }
    }
    this.trafficLayer.update({ visible });
    return true;
  }

  setView(req: ViewRequest) {
    const upd: any = {};
    const dur = req.duration || 0;
    if (req.center || req.zoom !== undefined) {
      const loc: any = {};
      if (req.center) loc.center = req.center;
      loc.zoom = req.zoom !== undefined ? req.zoom : this.map.zoom;
      if (!req.center) loc.center = this.map.center;
      if (dur) { loc.duration = dur; loc.easing = 'ease-in-out'; }
      upd.location = loc;
    }
    if (req.tilt !== undefined || req.azimuth !== undefined) {
      const cam: any = {};
      if (req.tilt !== undefined) cam.tilt = toRad(Math.max(0, Math.min(50, req.tilt)));
      if (req.azimuth !== undefined) cam.azimuth = AZIMUTH_SIGN * toRad(normalizeSigned(req.azimuth));
      if (dur) { cam.duration = dur; cam.easing = 'ease-in-out'; }
      upd.camera = cam;
    }
    if (upd.location || upd.camera) this.map.update(upd);
  }

  getView(): ViewState {
    const m = this.map;
    return {
      center: m.center as LngLat,
      zoom: m.zoom,
      tilt: toDeg(m.tilt || 0),
      azimuth: (((AZIMUTH_SIGN * toDeg(m.azimuth || 0)) % 360) + 360) % 360,
    };
  }

  fitBounds(b: LngLatBounds, padding: Padding, duration = 600) {
    this.setPadding(padding);
    this.map.update({ location: { bounds: b, duration, easing: 'ease-in-out' }, camera: { tilt: 0, azimuth: 0, duration } });
  }

  setPadding(p: Padding) {
    if (!this.map) return;
    const margin = [p.top, p.right, p.bottom, p.left].map((v) => Math.max(0, Math.round(v)));
    try {
      if (typeof this.map.setMargin === 'function') this.map.setMargin(margin);
      else this.map.update({ margin });
    } catch (e) { console.warn(e); }
  }

  setRoutes(lines: RouteLine[]) {
    const { YMapFeature } = this.y;
    this.routeEntities.forEach((f) => this.map.removeChild(f));
    this.routeEntities = [];
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;
    const styles: Record<string, RouteStyle> = {
      alternative: { casing: v('--route-alt-casing', '#3a4250'), fill: v('--route-alt', '#7e8a9c'), casingW: 11, fillW: 7, z: 1000 },
      traveled: { casing: '#4a5160', fill: '#8a93a3', casingW: 11, fillW: 7, z: 1050 },
      primary: { casing: v('--route-casing', '#0b4fc4'), fill: v('--route', '#2f8bff'), casingW: 17, fillW: 11, z: 1100 },
    };
    for (const line of lines) {
      if (line.coords.length < 2) continue;
      const s = styles[line.role];
      const geometry = { type: 'LineString', coordinates: line.coords };
      const casing = new YMapFeature({ id: line.id + ':c', geometry, style: { stroke: [{ color: s.casing, width: s.casingW }], zIndex: s.z, simplificationRate: 0 } });
      const fill = new YMapFeature({ id: line.id + ':f', geometry, style: { stroke: [{ color: s.fill, width: s.fillW }], zIndex: s.z + 1, simplificationRate: 0 } });
      this.map.addChild(casing);
      this.map.addChild(fill);
      this.routeEntities.push(casing, fill);
    }
  }

  setMarkers(layer: string, specs: MarkerSpec[]) {
    const { YMapMarker } = this.y;
    const current = this.layers.get(layer) || new Map();
    const next = new Map<string, { marker: any; spec: MarkerSpec }>();
    for (const spec of specs) {
      const prev = current.get(spec.id);
      if (prev && prev.spec.el === spec.el) {
        if (prev.spec.coord[0] !== spec.coord[0] || prev.spec.coord[1] !== spec.coord[1]) prev.marker.update({ coordinates: spec.coord });
        prev.spec = spec;
        next.set(spec.id, prev);
        current.delete(spec.id);
      } else {
        if (prev) { this.map.removeChild(prev.marker); current.delete(spec.id); }
        const marker = new YMapMarker({ coordinates: spec.coord, zIndex: spec.z || 1200 }, spec.el);
        this.map.addChild(marker);
        next.set(spec.id, { marker, spec });
      }
    }
    current.forEach(({ marker }) => this.map.removeChild(marker));
    this.layers.set(layer, next);
  }

  setUserMarker(coord: LngLat | null, el: HTMLElement) {
    if (!coord) {
      if (this.user) { this.map.removeChild(this.user); this.user = null; }
      return;
    }
    if (!this.user || this.userEl !== el) {
      if (this.user) this.map.removeChild(this.user);
      this.user = new this.y.YMapMarker({ coordinates: coord, zIndex: 5000 }, el);
      this.userEl = el;
      this.map.addChild(this.user);
    } else {
      this.user.update({ coordinates: coord });
    }
  }

  onUserGesture(cb: () => void) { this.gestureCbs.push(cb); }
  onViewChange(cb: (v: ViewState) => void) { this.viewCbs.push(cb); }
  onClick(cb: (e: MapClick) => void) { this.clickCbs.push(cb); }
  onLongPress(cb: (e: MapClick) => void) { this.longCbs.push(cb); }
}

const normalizeSigned = (deg: number) => { const n = ((deg % 360) + 360) % 360; return n > 180 ? n - 360 : n; };
