/**
 * Liquid Glass engine for the web.
 *
 * - Lensing: every `.glass` element gets an SVG displacement filter shaped to its own size and
 *   corner radius (a smooth bezel that bends the map beneath it, flat in the middle). It is fed to
 *   `backdrop-filter` through the per-element `--lg-lens` custom property. Chromium only; elsewhere
 *   the material falls back to frosted glass.
 * - Light: specular rims follow `--lg-light`, which the app points at the sun relative to the map.
 * - Touch: glass lights up from the fingertip (and nearby glass catches a little of it); `.lg-flex`
 *   controls swell slightly under the finger and spring back.
 */

export type Material = 'liquid' | 'frosted' | 'solid';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const chromeVersion = parseInt((ua.match(/(?:\b|Headless)Chrom(?:e|ium)\/(\d+)/) || [])[1] || '0', 10);
/** SVG filters inside backdrop-filter render correctly in Blink only (iOS "CriOS" is WebKit, so excluded). */
export const lensSupported =
  chromeVersion >= 90 && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'blur(1px)');

const SVG_NS = 'http://www.w3.org/2000/svg';
const SETTLE_MS = 140;
const NEAR_PX = 110;

interface Applied { key: string; w: number; h: number }

export class GlassEngine {
  private defs: SVGDefsElement;
  private filters = new Map<string, string>();
  private applied = new WeakMap<HTMLElement, Applied>();
  private pending = new WeakMap<HTMLElement, number>();
  private tracked = new Set<HTMLElement>();
  private ro: ResizeObserver | null = null;
  private seq = 0;
  private enabled = false;
  private light = 320;

  constructor(private root: HTMLElement) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    this.defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(this.defs);
    document.body.appendChild(svg);

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver((entries) => entries.forEach((e) => this.onResize(e.target as HTMLElement)));
    }
    new MutationObserver((list) => {
      for (const m of list) {
        m.addedNodes.forEach((n) => { if (n instanceof HTMLElement) this.scan(n); });
        m.removedNodes.forEach((n) => { if (n instanceof HTMLElement) this.forget(n); });
      }
    }).observe(root, { childList: true, subtree: true });
    this.scan(root);
    this.bindTouch();
    // Materialize animations hold `transform` while they fill; release it so `.lg-flex` can work.
    root.addEventListener('animationend', (e) => {
      const t = e.target as HTMLElement;
      if (e.animationName === 'lg-in' && t.classList.contains('lg-in')) t.classList.remove('lg-in');
    });
  }

  /** Turn lensing on (Liquid) or off (Frosted / Solid). */
  setEnabled(on: boolean) {
    on = on && lensSupported;
    if (on === this.enabled) return;
    this.enabled = on;
    this.tracked.forEach((el) => (on ? this.apply(el) : this.clear(el)));
  }

  /** Point the specular highlight (degrees clockwise from screen-up). Wraps the short way round. */
  setLight(deg: number) {
    const q = Math.round(deg / 4) * 4;
    let delta = ((q - this.light) % 360 + 540) % 360 - 180;
    if (Math.abs(delta) < 2) return;
    this.light += delta;
    document.documentElement.style.setProperty('--lg-light', `${this.light}deg`);
  }

  // ───────────────────────── lens ─────────────────────────

  private scan(node: HTMLElement) {
    if (node.classList.contains('glass')) this.track(node);
    node.querySelectorAll<HTMLElement>('.glass').forEach((el) => this.track(el));
  }

  private track(el: HTMLElement) {
    if (this.tracked.has(el)) return;
    this.tracked.add(el);
    if (this.ro) this.ro.observe(el);
    else if (this.enabled) this.apply(el);
  }

  private forget(node: HTMLElement) {
    const drop = (el: HTMLElement) => {
      if (!this.tracked.delete(el)) return;
      if (this.ro) this.ro.unobserve(el);
      // keep `applied`: if the same element is re-attached at the same size it reuses the filter
    };
    if (node.classList.contains('glass')) drop(node);
    node.querySelectorAll<HTMLElement>('.glass').forEach(drop);
  }

  private onResize(el: HTMLElement) {
    if (!this.enabled) return;
    const a = this.applied.get(el);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (a && a.w === w && a.h === h && el.style.getPropertyValue('--lg-lens')) return;
    // A displacement map of the wrong size would smear the backdrop: drop it while the
    // element is changing shape and re-shape the lens once it settles.
    if (a) this.clear(el);
    const t = this.pending.get(el);
    if (t) clearTimeout(t);
    this.pending.set(el, window.setTimeout(() => { this.pending.delete(el); if (this.enabled) this.apply(el); }, a ? SETTLE_MS : 0));
  }

  private apply(el: HTMLElement) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w < 8 || h < 8 || !el.isConnected) return;
    const cs = getComputedStyle(el);
    const minSide = Math.min(w, h);
    const r = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, minSide / 2);
    const large = minSide >= 160 || el.classList.contains('glass-lg');
    const bezel = large ? Math.min(24, minSide * 0.3) : Math.max(8, minSide * 0.35);
    const scale = large ? 28 : Math.max(14, Math.min(36, minSide * 0.3));
    const key = `${w}x${h}r${Math.round(r)}b${Math.round(bezel)}s${Math.round(scale)}`;
    let id = this.filters.get(key);
    if (!id) {
      id = `lg${++this.seq}`;
      this.defs.appendChild(buildFilter(id, w, h, r, bezel, scale));
      this.filters.set(key, id);
    }
    el.style.setProperty('--lg-lens', `url(#${id})`);
    this.applied.set(el, { key, w, h });
  }

  private clear(el: HTMLElement) {
    el.style.removeProperty('--lg-lens');
  }

  // ───────────────────────── touch light & flex ─────────────────────────

  private bindTouch() {
    let lit: HTMLElement[] = [];
    let flex: HTMLElement | null = null;
    let active: HTMLElement | null = null;

    const place = (el: HTMLElement, x: number, y: number) => {
      const b = el.getBoundingClientRect();
      el.style.setProperty('--lg-x', `${Math.max(0, Math.min(b.width, x - b.left)).toFixed(0)}px`);
      el.style.setProperty('--lg-y', `${Math.max(0, Math.min(b.height, y - b.top)).toFixed(0)}px`);
    };
    const release = () => {
      lit.forEach((el) => el.classList.remove('lg-lit', 'lg-near'));
      lit = [];
      if (flex) flex.classList.remove('lg-pressed');
      flex = null;
      active = null;
    };

    this.root.addEventListener('pointerdown', (e) => {
      release();
      const target = e.target as HTMLElement;
      const glass = target.closest<HTMLElement>('.glass');
      if (!glass) return;
      active = glass;
      place(glass, e.clientX, e.clientY);
      glass.classList.add('lg-lit');
      lit.push(glass);
      // Light spills onto neighbouring glass.
      this.tracked.forEach((el) => {
        if (el === glass || !el.isConnected) return;
        const b = el.getBoundingClientRect();
        const dx = Math.max(b.left - e.clientX, 0, e.clientX - b.right);
        const dy = Math.max(b.top - e.clientY, 0, e.clientY - b.bottom);
        if (Math.hypot(dx, dy) < NEAR_PX) { place(el, e.clientX, e.clientY); el.classList.add('lg-near'); lit.push(el); }
      });
      const f = target.closest<HTMLElement>('.lg-flex');
      if (f && !matchMedia('(prefers-reduced-motion: reduce)').matches) { f.classList.add('lg-pressed'); flex = f; }
    }, { passive: true });
    this.root.addEventListener('pointermove', (e) => { if (active) place(active, e.clientX, e.clientY); }, { passive: true });
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    window.addEventListener('blur', release);
  }
}

/**
 * Displacement map for a rounded rectangle: zero (128,128) in the flat middle, rising smoothly to
 * full strength inside a bezel band along the edge, pointing along the outward normal. The rounded
 * corners use the true distance to the corner arc so there is no diagonal seam.
 * Rendered at half resolution — the filter scales it back up smoothly.
 */
function buildFilter(id: string, w: number, h: number, r: number, bezel: number, scale: number): SVGFilterElement {
  const k = 0.5;
  const cw = Math.max(4, Math.round(w * k));
  const ch = Math.max(4, Math.round(h * k));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(cw, ch);
  const d = img.data;
  const re = Math.min(Math.max(r, bezel), w / 2, h / 2);
  const hw = w / 2;
  const hh = h / 2;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const px = (x + 0.5) / k - hw;
      const py = (y + 0.5) / k - hh;
      const qx = Math.abs(px) - (hw - re);
      const qy = Math.abs(py) - (hh - re);
      let inset: number;
      let nx = 0;
      let ny = 0;
      if (qx > 0 && qy > 0) {
        const l = Math.hypot(qx, qy) || 1;
        inset = re - l;
        nx = (qx / l) * Math.sign(px);
        ny = (qy / l) * Math.sign(py);
      } else if (qx > qy) {
        inset = hw - Math.abs(px);
        nx = Math.sign(px);
      } else {
        inset = hh - Math.abs(py);
        ny = Math.sign(py);
      }
      let m = 0;
      if (inset >= 0 && inset < bezel) {
        const t = 1 - inset / bezel;
        m = t * t * (3 - 2 * t);
      }
      const i = (y * cw + x) * 4;
      d[i] = 128 + nx * m * 127;
      d[i + 1] = 128 + ny * m * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const href = canvas.toDataURL('image/png');

  const filter = document.createElementNS(SVG_NS, 'filter') as SVGFilterElement;
  const attrs = (el: Element, a: Record<string, string | number>) => Object.keys(a).forEach((key) => el.setAttribute(key, String(a[key])));
  attrs(filter, { id, x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
  const image = document.createElementNS(SVG_NS, 'feImage');
  attrs(image, { x: 0, y: 0, width: w, height: h, result: 'map', preserveAspectRatio: 'none' });
  image.setAttribute('href', href);
  image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
  const disp = document.createElementNS(SVG_NS, 'feDisplacementMap');
  attrs(disp, { in: 'SourceGraphic', in2: 'map', scale: scale.toFixed(1), xChannelSelector: 'R', yChannelSelector: 'G' });
  filter.append(image, disp);
  return filter;
}

/**
 * Frame-rate guard: while driving, if the device can't hold ~38 fps for two consecutive
 * 3-second windows, ask the app to step the material down (Liquid → Frosted → Solid).
 */
export class FrameGuard {
  private raf = 0;
  private bad = 0;

  constructor(private onSlow: () => void) {}

  start() {
    if (this.raf) return;
    let frames = 0;
    let start = performance.now();
    let last = start;
    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      if (dt > 250) { frames = 0; start = t; } // tab hidden or a one-off hitch: discard the window
      else frames++;
      if (t - start >= 3000) {
        const fps = (frames * 1000) / (t - start);
        this.bad = fps < 38 ? this.bad + 1 : 0;
        frames = 0;
        start = t;
        if (this.bad >= 2) { this.bad = 0; this.onSlow(); }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.bad = 0;
  }
}
