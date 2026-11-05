import { h } from '../core/dom';
import { formatDistance, formatDuration } from '../core/format';
import type { Place } from '../types';
import { categoryById, icon } from './icons';

export function glyphFor(p: Place, size: 'md' | 'lg' = 'md'): HTMLElement {
  const cat = categoryById(p.category);
  let color = 'var(--gray)';
  let ic = 'pin';
  if (p.kind === 'charger' || p.charger) { color = 'var(--green)'; ic = 'bolt'; }
  else if (cat) { color = cat.color; ic = cat.icon; }
  else if (p.kind === 'city') { color = 'var(--indigo)'; ic = 'pin'; }
  else if (p.kind === 'pin') { color = 'var(--red)'; ic = 'pinDrop'; }
  else if (p.kind === 'business') { color = 'var(--orange)'; ic = 'star'; }
  const el = h('div.glyph', { class: { lg: size === 'lg' }, style: { background: color } }, icon(ic, size === 'lg' ? 26 : 20));
  return el;
}

export function placeRow(p: Place, onTap: () => void, opts: { glyph?: HTMLElement; trail?: string } = {}) {
  return h('button.row', { onclick: onTap },
    opts.glyph || glyphFor(p),
    h('div.row-main', null,
      h('div.row-title', null, p.name),
      p.subtitle ? h('div.row-sub', null, p.subtitle) : null,
    ),
    opts.trail !== undefined ? h('div.row-trail.num', null, opts.trail)
      : p.eta !== undefined ? h('div.row-trail.num', null, h('div.row-eta', null, formatDuration(p.eta)), p.distance !== undefined ? h('div.row-trail-sub', null, formatDistance(p.distance)) : null)
        : p.distance !== undefined ? h('div.row-trail.num', null, formatDistance(p.distance)) : null,
  );
}

export const badge = (text: string, tone: '' | 'green' | 'blue' | 'orange' | 'red' = '') => h('span.badge', { class: tone || undefined }, text);

export function socBar(soc: number) {
  const cls = soc < 10 ? 'crit' : soc < 20 ? 'low' : '';
  return h('div.soc-bar', { class: cls || undefined }, h('i', { style: { width: `${Math.max(2, Math.min(100, soc))}%` } }));
}

export function batteryGlyph(soc: number) {
  const cls = soc < 10 ? 'crit' : soc < 20 ? 'low' : '';
  return h('span.batt', { class: cls || undefined },
    h('span.batt-body', null, h('span.batt-fill', { style: { width: `${Math.max(4, Math.min(100, soc))}%`, display: 'block' } })),
    h('span.num', null, `${Math.round(soc)}%`),
  );
}

export const closeButton = (onTap: () => void, label = 'Close') =>
  h('button.icon-btn.pressable', { 'aria-label': label, onclick: onTap }, icon('close', 18));

export const backButton = (onTap: () => void) =>
  h('button.icon-btn.pressable', { 'aria-label': 'Back', onclick: onTap }, icon('back', 20));

export function section(title: string, link?: { text: string; onTap: () => void }, ...children: (Node | null)[]) {
  return h('div.section', null,
    h('div.section-head', null, h('div.section-title', null, title), link ? h('button.section-link', { onclick: link.onTap }, link.text) : null),
    ...children,
  );
}
