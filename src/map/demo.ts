import { boundsCenter, simplify } from '../core/geo';
import type { LngLat, LngLatBounds } from '../types';
import type { MapClick, MapEngine, MarkerSpec, Padding, RouteLine, ViewRequest, ViewState } from './engine';

/**
 * Offline map used by demo mode (no API key, no network): a Web-Mercator canvas that
 * renders a static map backdrop, route lines and DOM markers. It lets the whole app —
 * search, routing, EV planning, turn-by-turn — be developed and tested without Yandex.
 */

const TILE = 256;
const project = ([lng, lat]: LngLat, z: number): [number, number] => {
  const s = TILE * Math.pow(2, z);
  const sin = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * Math.PI) / 180)));
  return [((lng + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
};
const unproject = ([x, y]: [number, number], z: number): LngLat => {
  const s = TILE * Math.pow(2, z);
  const lng = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return [lng, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
};
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface DemoBackdrop { url: string; trafficUrl?: string; bounds: LngLatBounds }

export class DemoEngine implements MapEngine {
  readonly kind = 'demo' as const;
  readonly supportsTraffic = true;
  readonly maxTilt = 0; // flat backdrop image
  private root!: HTMLElement;
  private img!: HTMLImageElement;
  private svgEl!: SVGSVGElement;
  private markerLayer!: HTMLElement;
  private center: LngLat = [44.76, 41.725];
  private zoom = 16.5;
  private azimuth = 0;
  private tilt = 0;
  private pad: Padding = { top: 0, right: 0, bottom: 0, left: 0 };
  private lines: RouteLine[] = [];
  private layers = new Map<string, MarkerSpec[]>();
  private user: { coord: LngLat; el: HTMLElement } | null = null;
  private dirty = false;
  private anim: number | null = null;
  private traffic = false;
  private gestureCbs: (() => void)[] = [];
  private viewCbs: ((v: ViewState) => void)[] = [];
  private clickCbs: ((e: MapClick) => void)[] = [];
  private longCbs: ((e: MapClick) => void)[] = [];

  constructor(private backdrop: DemoBackdrop) {}

  async init(container: HTMLElement, opts: { center: LngLat; zoom: number; theme: 'light' | 'dark' }) {
    this.center = opts.center;
    this.zoom = opts.zoom;
    this.root = document.createElement('div');
    this.root.className = 'demo-map';
    this.root.style.cssText = 'position:absolute;top:0;right:0;bottom:0;left:0;overflow:hidden;touch-action:none;cursor:grab;' +
      'background-color:var(--map-bg);background-image:linear-gradient(var(--fill-3) 1px,transparent 1px),linear-gradient(90deg,var(--fill-3) 1px,transparent 1px);background-size:64px 64px;';
    this.img = document.createElement('img');
    this.img.src = this.backdrop.url;
    this.img.alt = '';
    this.img.draggable = false;
    this.img.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;will-change:transform;transition:filter .4s;';
    this.svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgEl.setAttribute('style', 'position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible');
    this.markerLayer = document.createElement('div');
    this.markerLayer.style.cssText = 'position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none;';
    this.root.append(this.img, this.svgEl, this.markerLayer);
    container.appendChild(this.root);
    this.img.onload = () => this.invalidate();
    this.setTheme(opts.theme);
    this.bindGestures();
    window.addEventListener('resize', () => this.invalidate());
    this.invalidate();
  }

  // ── projection helpers ──
  private size() { return { w: this.root.clientWidth || window.innerWidth, h: this.root.clientHeight || window.innerHeight }; }
  private visualCenter() {
    const { w, h } = this.size();
    const p = this.pad;
    return [p.left + (w - p.left - p.right) / 2, p.top + (h - p.top - p.bottom) / 2];
  }
  private toScreen(ll: LngLat): [number, number] {
    const [cx, cy] = project(this.center, this.zoom);
    const [x, y] = project(ll, this.zoom);
    const [vx, vy] = this.visualCenter();
    return [x - cx + vx, y - cy + vy];
  }
  private toLngLat(sx: number, sy: number): LngLat {
    const [cx, cy] = project(this.center, this.zoom);
    const [vx, vy] = this.visualCenter();
    return unproject([sx - vx + cx, sy - vy + cy], this.zoom);
  }

  private invalidate() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      this.render();
      const v = this.getView();
      this.viewCbs.forEach((cb) => cb(v));
    });
  }

  private render() {
    // Backdrop
    const [[w, n], [e, s]] = this.backdrop.bounds;
    const [x1, y1] = this.toScreen([w, n]);
    const [x2, y2] = this.toScreen([e, s]);
    const nw = this.img.naturalWidth || 1;
    const nh = this.img.naturalHeight || 1;
    this.img.style.transform = `translate(${x1}px,${y1}px) scale(${(x2 - x1) / nw},${(y2 - y1) / nh})`;
    this.img.style.width = nw + 'px';
    this.img.style.height = nh + 'px';

    // Routes (casing + fill), simplified to screen resolution
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;
    const tolMeters = (156543 * Math.cos((this.center[1] * Math.PI) / 180)) / Math.pow(2, this.zoom);
    const order: Record<string, number> = { alternative: 0, traveled: 1, primary: 2 };
    const sorted = this.lines.slice().sort((a, b) => order[a.role] - order[b.role]);
    let html = '';
    for (const l of sorted) {
      const pts = simplify(l.coords, tolMeters).map((c) => this.toScreen(c));
      if (pts.length < 2) continue;
      const d = 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
      const [casing, fill, cw, fw] = l.role === 'primary'
        ? [v('--route-casing', '#0b4fc4'), v('--route', '#2f8bff'), 14, 9]
        : l.role === 'traveled' ? ['#4a5160', '#8a93a3', 11, 7] : [v('--route-alt-casing', '#3a4250'), v('--route-alt', '#7e8a9c'), 11, 7];
      html += `<path d="${d}" fill="none" stroke="${casing}" stroke-width="${cw}" stroke-linecap="round" stroke-linejoin="round"/>`;
      html += `<path d="${d}" fill="none" stroke="${fill}" stroke-width="${fw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    this.svgEl.innerHTML = html;

    // Markers
    const wanted = new Set<HTMLElement>();
    const place = (spec: { coord: LngLat; el: HTMLElement; z?: number }) => {
      const [x, y] = this.toScreen(spec.coord);
      const el = spec.el;
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.top = '0';
      el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      el.style.zIndex = String(spec.z || 10);
      el.style.pointerEvents = 'auto';
      if (el.parentNode !== this.markerLayer) this.markerLayer.appendChild(el);
      wanted.add(el);
    };
    this.layers.forEach((specs) => specs.forEach(place));
    if (this.user) place({ ...this.user, z: 50 });
    Array.from(this.markerLayer.children).forEach((c) => { if (!wanted.has(c as HTMLElement)) c.remove(); });
  }

  // ── MapEngine ──
  setTheme(theme: 'light' | 'dark') {
    this.img.style.filter = theme === 'light' ? 'invert(1) hue-rotate(180deg) saturate(.7) brightness(1.06) contrast(.92)' : 'none';
    this.invalidate();
  }

  async setTraffic(visible: boolean) {
    this.traffic = visible;
    if (this.backdrop.trafficUrl) this.img.src = visible ? this.backdrop.trafficUrl : this.backdrop.url;
    return true;
  }

  setView(req: ViewRequest) {
    if (req.azimuth !== undefined) this.azimuth = 0; // demo map stays north-up
    if (req.tilt !== undefined) this.tilt = 0;
    const to = { center: req.center || this.center, zoom: req.zoom !== undefined ? req.zoom : this.zoom };
    this.animateTo(to.center, to.zoom, req.duration || 0);
  }

  private animateTo(center: LngLat, zoom: number, duration: number) {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = null;
    if (!duration) {
      this.center = center;
      this.zoom = zoom;
      this.invalidate();
      return;
    }
    const c0 = this.center;
    const z0 = this.zoom;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = ease(Math.min(1, (t - t0) / duration));
      // interpolate in projected space at a fixed reference zoom for a straight path
      const p0 = project(c0, 20);
      const p1 = project(center, 20);
      this.center = unproject([p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k], 20);
      this.zoom = z0 + (zoom - z0) * k;
      this.invalidate();
      this.anim = k < 1 ? requestAnimationFrame(step) : null;
    };
    this.anim = requestAnimationFrame(step);
  }

  getView(): ViewState {
    return { center: this.center, zoom: this.zoom, tilt: this.tilt, azimuth: this.azimuth };
  }

  fitBounds(b: LngLatBounds, padding: Padding, duration = 600) {
    this.pad = padding;
    const { w, h } = this.size();
    const [[west, north], [east, south]] = b;
    const [ax, ay] = project([west, north], 0);
    const [bx, by] = project([east, south], 0);
    const availW = Math.max(80, w - padding.left - padding.right);
    const availH = Math.max(80, h - padding.top - padding.bottom);
    const zx = Math.log2(availW / Math.max(1e-9, bx - ax));
    const zy = Math.log2(availH / Math.max(1e-9, by - ay));
    const z = Math.max(3, Math.min(18, Math.min(zx, zy)));
    const mid = unproject([(ax + bx) / 2, (ay + by) / 2], 0);
    this.animateTo(mid || boundsCenter(b), z, duration);
  }

  setPadding(p: Padding) {
    this.pad = p;
    this.invalidate();
  }

  setRoutes(lines: RouteLine[]) {
    this.lines = lines;
    this.invalidate();
  }

  setMarkers(layer: string, markers: MarkerSpec[]) {
    this.layers.set(layer, markers);
    this.invalidate();
  }

  setUserMarker(coord: LngLat | null, el: HTMLElement) {
    this.user = coord ? { coord, el } : null;
    this.invalidate();
  }

  onUserGesture(cb: () => void) { this.gestureCbs.push(cb); }
  onViewChange(cb: (v: ViewState) => void) { this.viewCbs.push(cb); }
  onClick(cb: (e: MapClick) => void) { this.clickCbs.push(cb); }
  onLongPress(cb: (e: MapClick) => void) { this.longCbs.push(cb); }

  // ── gestures: drag, pinch, wheel, double-tap, long-press ──
  private bindGestures() {
    const ptrs = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number; t: number } | null = null;
    let moved = false;
    let pinch0: { dist: number; zoom: number } | null = null;
    let longTimer: number | undefined;
    let lastTap = 0;
    const root = this.root;
    const isUi = (t: EventTarget | null) => !!(t as Element | null)?.closest?.('.pin, .charger-mk, [data-tap]');

    root.addEventListener('pointerdown', (e) => {
      if (isUi(e.target)) return;
      root.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) {
        start = { x: e.clientX, y: e.clientY, t: performance.now() };
        moved = false;
        clearTimeout(longTimer);
        longTimer = window.setTimeout(() => {
          if (!moved && start) {
            const r = root.getBoundingClientRect();
            this.longCbs.forEach((cb) => cb({ coord: this.toLngLat(start!.x - r.left, start!.y - r.top) }));
            start = null;
          }
        }, 600);
      } else if (ptrs.size === 2) {
        const [a, b] = Array.from(ptrs.values());
        pinch0 = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom };
        clearTimeout(longTimer);
      }
    });
    root.addEventListener('pointermove', (e) => {
      const prev = ptrs.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      ptrs.set(e.pointerId, cur);
      if (ptrs.size === 2 && pinch0) {
        const [a, b] = Array.from(ptrs.values());
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoom = Math.max(3, Math.min(19, pinch0.zoom + Math.log2(d / pinch0.dist)));
        moved = true;
        this.gestureCbs.forEach((cb) => cb());
        this.invalidate();
        return;
      }
      if (start && !moved && Math.abs(cur.x - start.x) + Math.abs(cur.y - start.y) < 8) return;
      if (!moved) { moved = true; root.style.cursor = 'grabbing'; clearTimeout(longTimer); this.gestureCbs.forEach((cb) => cb()); }
      const [cx, cy] = project(this.center, this.zoom);
      this.center = unproject([cx - (cur.x - prev.x), cy - (cur.y - prev.y)], this.zoom);
      this.invalidate();
    });
    const up = (e: PointerEvent) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch0 = null;
      clearTimeout(longTimer);
      root.style.cursor = 'grab';
      if (ptrs.size === 0 && start && !moved && performance.now() - start.t < 500) {
        const r = root.getBoundingClientRect();
        const coord = this.toLngLat(e.clientX - r.left, e.clientY - r.top);
        const now = performance.now();
        if (now - lastTap < 300) {
          this.gestureCbs.forEach((cb) => cb());
          this.animateTo(coord, Math.min(19, this.zoom + 1), 250);
          lastTap = 0;
        } else {
          lastTap = now;
          this.clickCbs.forEach((cb) => cb({ coord }));
        }
      }
      start = null;
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.gestureCbs.forEach((cb) => cb());
      const r = root.getBoundingClientRect();
      const before = this.toLngLat(e.clientX - r.left, e.clientY - r.top);
      this.zoom = Math.max(3, Math.min(19, this.zoom - e.deltaY * 0.0025));
      // keep the point under the cursor fixed
      const after = this.toLngLat(e.clientX - r.left, e.clientY - r.top);
      this.center = [this.center[0] + before[0] - after[0], this.center[1] + before[1] - after[1]];
      this.invalidate();
    }, { passive: false });
  }
}
