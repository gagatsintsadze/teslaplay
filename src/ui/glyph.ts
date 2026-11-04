import { svg } from '../core/dom';
import type { ManeuverType } from '../types';

const f = (n: number) => n.toFixed(1);

/**
 * Apple-Maps-style maneuver glyph: a thick road stem that bends by `angle` (+ right, − left),
 * with the straight-through road ghosted behind it so the junction reads at a glance.
 */
export function maneuverGlyph(type: ManeuverType, angle: number, color = '#fff'): SVGElement {
  const S = `stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  if (type === 'arrive') {
    return svg(`<svg viewBox="0 0 80 80"><path d="M40 8C27.8 8 18 17.6 18 29.6 18 45.8 40 72 40 72s22-26.2 22-42.4C62 17.6 52.2 8 40 8Z" fill="${color}"/><circle cx="40" cy="30" r="8.5" fill="#ff453a"/></svg>`);
  }
  if (type === 'waypoint') {
    return svg(`<svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="30" fill="#30d158"/><path d="M43 16 26 43h12l-3 21 19-28H42l1-20Z" fill="#fff"/></svg>`);
  }
  if (type === 'uturn') {
    return svg(`<svg viewBox="0 0 80 80"><path d="M50 72V36a11 11 0 0 0-22 0v14" ${S}/><path d="M18 46l10 13 10-13Z" fill="${color}" stroke="${color}" stroke-width="3" stroke-linejoin="round"/></svg>`);
  }
  const a = type === 'depart' || type === 'straight' ? 0 : Math.max(-150, Math.min(150, angle));
  const rad = (a * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const jx = 40 - dx * 6; // shift so the whole glyph stays centred
  const jy = 46;
  const len = 24;
  const ex = jx + dx * len;
  const ey = jy + dy * len;
  const cx = jx;
  const cy = jy - 9;
  // arrow head
  const tipX = ex + dx * 11;
  const tipY = ey + dy * 11;
  const px = -dy;
  const py = dx;
  const b1x = ex + px * 10;
  const b1y = ey + py * 10;
  const b2x = ex - px * 10;
  const b2y = ey - py * 10;
  const ghost = Math.abs(a) > 18
    ? `<path d="M${f(jx)} ${f(jy)}V10" stroke="${color}" stroke-opacity=".28" stroke-width="9" stroke-linecap="round" fill="none"/>`
    : '';
  const stem = Math.abs(a) < 4
    ? `<path d="M${f(jx)} 74V${f(ey)}" ${S}/>`
    : `<path d="M${f(jx)} 74V${f(jy)}Q${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}" ${S}/>`;
  return svg(`<svg viewBox="0 0 80 80">${ghost}${stem}<path d="M${f(tipX)} ${f(tipY)}L${f(b1x)} ${f(b1y)}L${f(b2x)} ${f(b2y)}Z" fill="${color}" stroke="${color}" stroke-width="3" stroke-linejoin="round"/></svg>`);
}

export const maneuverVerb = (type: ManeuverType): string => ({
  depart: 'Head out',
  straight: 'Continue straight',
  'slight-left': 'Bear left',
  'slight-right': 'Bear right',
  left: 'Turn left',
  right: 'Turn right',
  'sharp-left': 'Sharp left',
  'sharp-right': 'Sharp right',
  uturn: 'Make a U-turn',
  waypoint: 'Arrive at stop',
  arrive: 'Arrive',
}[type]);
