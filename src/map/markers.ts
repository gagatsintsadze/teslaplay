import { h, svg, toggleClass } from '../core/dom';
import { icon } from '../ui/icons';

/** A zero-size anchor placed at the coordinate; content offsets itself with CSS. */
const anchor = (...children: Node[]) => {
  const el = h('div.mk');
  children.forEach((c) => el.appendChild(c));
  return el;
};

const stop = (e: Event) => e.stopPropagation();

export function pinMarker(opts: { color: string; icon: string; label?: string; large?: boolean; selected?: boolean; onTap?: () => void }) {
  const pin = h('div.pin', { 'data-tap': '1', class: { lg: opts.large, sel: opts.selected } },
    h('div.pin-head', { style: { background: opts.color } }, icon(opts.icon, opts.large ? 22 : 18)),
    h('div.pin-tail'),
    opts.label ? h('div.pin-label', null, opts.label) : null,
  );
  if (opts.onTap) {
    pin.addEventListener('pointerdown', stop);
    pin.addEventListener('click', (e) => { e.stopPropagation(); opts.onTap!(); });
  }
  return anchor(pin);
}

export function chargerMarker(opts: { powerKW: number; planned?: boolean; dim?: boolean; onTap?: () => void }) {
  const el = h('div.charger-mk', { 'data-tap': '1', class: { planned: opts.planned, dim: opts.dim } },
    icon('bolt', 16),
    opts.powerKW ? `${Math.round(opts.powerKW)}` : '',
  );
  if (opts.onTap) {
    el.addEventListener('pointerdown', stop);
    el.addEventListener('click', (e) => { e.stopPropagation(); opts.onTap!(); });
  }
  return anchor(el);
}

export function dotMarker(waypoint = false) {
  return anchor(h('div.dot-mk', { class: { wp: waypoint } }));
}

export function cityLabel(name: string) {
  return anchor(h('div.city-label', null, name));
}

const ARROW = `<svg viewBox="0 0 56 56" width="56" height="56"><circle cx="28" cy="28" r="21" fill="#fff"/><path d="M28 13.5 38.6 39.2c.3.7-.5 1.4-1.2 1L28 35l-9.4 5.2c-.7.4-1.5-.3-1.2-1L28 13.5Z" fill="#0a84ff"/></svg>`;

/**
 * Original top-down car sprites (a sedan and an SUV — not any maker's design), shaded so they read
 * as 3-D in the tilted driving view. The body colour comes from the --car CSS variable.
 */
const CAR_DEFS = `<defs>
  <linearGradient id="cb" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset=".25" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity=".05"/><stop offset=".8" stop-color="#000" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient>
  <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fd3ff"/><stop offset="1" stop-color="#1c2a3a"/></linearGradient>
  <linearGradient id="cr" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".18"/><stop offset=".5" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient>
</defs>`;
const SEDAN = `<svg viewBox="0 0 64 128" width="56" height="112">${CAR_DEFS}
  <ellipse cx="32" cy="66" rx="27" ry="60" fill="#000" opacity=".28"/>
  <rect x="7" y="22" width="8" height="18" rx="3" fill="#15171b"/><rect x="49" y="22" width="8" height="18" rx="3" fill="#15171b"/>
  <rect x="7" y="86" width="8" height="18" rx="3" fill="#15171b"/><rect x="49" y="86" width="8" height="18" rx="3" fill="#15171b"/>
  <path d="M14 20c0-9 7-14 18-14s18 5 18 14v88c0 9-7 14-18 14s-18-5-18-14Z" fill="var(--car,#e8eaf0)"/>
  <path d="M14 20c0-9 7-14 18-14s18 5 18 14v88c0 9-7 14-18 14s-18-5-18-14Z" fill="url(#cb)"/>
  <path d="M19 44c3-8 7-12 13-12s10 4 13 12l-2 6H21Z" fill="url(#cg)"/>
  <path d="M20 54h24l1 30H19Z" fill="var(--car,#e8eaf0)"/><path d="M20 54h24l1 30H19Z" fill="url(#cr)"/>
  <path d="M21 86h22l2 10c-3 5-7 7-13 7s-10-2-13-7Z" fill="url(#cg)" opacity=".9"/>
  <path d="M17 13c3-3 8-5 15-5s12 2 15 5l-1 4H18Z" fill="#fff" opacity=".35"/>
  <rect x="17" y="8" width="8" height="4" rx="2" fill="#fff8d6"/><rect x="39" y="8" width="8" height="4" rx="2" fill="#fff8d6"/>
  <rect x="16" y="117" width="10" height="4" rx="2" fill="#ff3b30"/><rect x="38" y="117" width="10" height="4" rx="2" fill="#ff3b30"/>
</svg>`;
const SUV = `<svg viewBox="0 0 64 128" width="56" height="112">${CAR_DEFS}
  <ellipse cx="32" cy="66" rx="29" ry="60" fill="#000" opacity=".28"/>
  <rect x="5" y="20" width="9" height="20" rx="3" fill="#15171b"/><rect x="50" y="20" width="9" height="20" rx="3" fill="#15171b"/>
  <rect x="5" y="84" width="9" height="20" rx="3" fill="#15171b"/><rect x="50" y="84" width="9" height="20" rx="3" fill="#15171b"/>
  <path d="M12 18c0-8 8-12 20-12s20 4 20 12v94c0 8-8 12-20 12s-20-4-20-12Z" fill="var(--car,#e8eaf0)"/>
  <path d="M12 18c0-8 8-12 20-12s20 4 20 12v94c0 8-8 12-20 12s-20-4-20-12Z" fill="url(#cb)"/>
  <path d="M17 40c3-7 8-10 15-10s12 3 15 10l-1 6H18Z" fill="url(#cg)"/>
  <path d="M18 50h28l1 46H17Z" fill="var(--car,#e8eaf0)"/><path d="M18 50h28l1 46H17Z" fill="url(#cr)"/>
  <rect x="20" y="52" width="24" height="42" rx="3" fill="#1c2a3a" opacity=".55"/>
  <path d="M18 100h28l1 8c-3 5-8 8-15 8s-12-3-15-8Z" fill="url(#cg)" opacity=".9"/>
  <path d="M15 12c3-3 9-5 17-5s14 2 17 5l-1 4H16Z" fill="#fff" opacity=".35"/>
  <rect x="15" y="7" width="9" height="4" rx="2" fill="#fff8d6"/><rect x="40" y="7" width="9" height="4" rx="2" fill="#fff8d6"/>
  <rect x="14" y="119" width="11" height="4" rx="2" fill="#ff3b30"/><rect x="39" y="119" width="11" height="4" rx="2" fill="#ff3b30"/>
</svg>`;

export type CarMarker = 'arrow' | 'sedan' | 'suv';

export interface Puck {
  el: HTMLElement;
  /** Which marker shows while driving, and the car's paint colour. */
  setCar(kind: CarMarker, color: string): void;
  /** headingOnScreen: degrees clockwise from screen-up, or null when unknown. */
  update(headingOnScreen: number | null, nav: boolean, stale: boolean): void;
}

export function createPuck(): Puck {
  const halo = h('div.puck-halo');
  const cone = h('div.puck-cone');
  const core = h('div.puck-core');
  const arrow = h('div.puck-arrow');
  arrow.appendChild(svg(ARROW));
  const car = h('div.puck-car');
  const puck = h('div.puck', null, halo, cone, core, arrow, car);
  const el = anchor(puck);
  let last = '';
  return {
    el,
    setCar(kind, color) {
      car.innerHTML = '';
      if (kind !== 'arrow') car.appendChild(svg(kind === 'suv' ? SUV : SEDAN));
      car.style.setProperty('--car', color);
      toggleClass(puck, 'car', kind !== 'arrow');
    },
    update(heading, nav, stale) {
      toggleClass(puck, 'nav', nav);
      toggleClass(puck, 'stale', stale);
      toggleClass(puck, 'has-heading', heading !== null);
      const t = `rotate(${(heading || 0).toFixed(1)}deg)`;
      if (t !== last) {
        cone.style.transform = t;
        arrow.style.transform = t;
        car.style.transform = t;
        last = t;
      }
    },
  };
}
