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

export interface Puck {
  el: HTMLElement;
  /** headingOnScreen: degrees clockwise from screen-up, or null when unknown. */
  update(headingOnScreen: number | null, nav: boolean, stale: boolean): void;
}

export function createPuck(): Puck {
  const halo = h('div.puck-halo');
  const cone = h('div.puck-cone');
  const core = h('div.puck-core');
  const arrow = h('div.puck-arrow');
  arrow.appendChild(svg(ARROW));
  const puck = h('div.puck', null, halo, cone, core, arrow);
  const el = anchor(puck);
  let last = '';
  return {
    el,
    update(heading, nav, stale) {
      toggleClass(puck, 'nav', nav);
      toggleClass(puck, 'stale', stale);
      toggleClass(puck, 'has-heading', heading !== null);
      const t = `rotate(${(heading || 0).toFixed(1)}deg)`;
      if (t !== last) {
        cone.style.transform = t;
        arrow.style.transform = t;
        last = t;
      }
    },
  };
}
