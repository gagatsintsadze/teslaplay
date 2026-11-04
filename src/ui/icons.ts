import { svg } from '../core/dom';

/**
 * Icon set drawn to match SF Symbols proportions: 24×24 grid, 2px rounded strokes.
 * `f:` prefix = filled shape (uses currentColor fill).
 */
const P: Record<string, string> = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  locate: 'f:<path d="M20.6 3.4 3.9 10.6c-.9.4-.8 1.7.2 1.9l6.8 1.4 1.4 6.8c.2 1 1.5 1.1 1.9.2l7.2-16.7c.3-.6-.3-1.2-.8-.8Z"/>',
  locateLine: '<path d="M20 4 4 11l7 2 2 7Z"/>',
  house: 'f:<path d="M12 3.2 2.6 11a1 1 0 0 0 1.3 1.5l.6-.5V19a2 2 0 0 0 2 2h3.3v-5.2a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1V21h3.3a2 2 0 0 0 2-2v-7l.6.5a1 1 0 0 0 1.3-1.5L12 3.2Z"/>',
  briefcase: 'f:<path d="M9 3.5A1.5 1.5 0 0 0 7.5 5v1.5H5A2.5 2.5 0 0 0 2.5 9v3.2c2.8 1.2 6 1.8 9.5 1.8s6.7-.6 9.5-1.8V9A2.5 2.5 0 0 0 19 6.5h-2.5V5A1.5 1.5 0 0 0 15 3.5H9Zm.5 2h5v1h-5v-1ZM2.5 14.4V18A2.5 2.5 0 0 0 5 20.5h14a2.5 2.5 0 0 0 2.5-2.5v-3.6c-2.9 1.1-6.1 1.6-9.5 1.6s-6.6-.5-9.5-1.6Z"/>',
  star: 'f:<path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9L12 2.8Z"/>',
  starLine: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>',
  bolt: 'f:<path d="M13.5 2 4.8 13.1c-.4.5 0 1.2.6 1.2H11l-1.3 7.2c-.1.6.6.9 1 .4l8.6-11.1c.4-.5 0-1.2-.6-1.2H13l1.4-7.2c.1-.6-.6-.9-.9-.4Z"/>',
  parking: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M9.5 17V7.5h3.3a2.9 2.9 0 0 1 0 5.8H9.5"/>',
  drop: 'f:<path d="M12 2.5c-.3 0-.6.2-.8.4C9.3 5.3 5.5 10.6 5.5 14.2a6.5 6.5 0 0 0 13 0c0-3.6-3.8-8.9-5.7-11.3a1 1 0 0 0-.8-.4Z"/>',
  cup: '<path d="M4.5 9h12v5.5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5V9Z"/><path d="M16.5 10.5h1.2a2.8 2.8 0 0 1 0 5.6h-1.6"/><path d="M8 3.5c-.6.8-.6 1.7 0 2.5M11.5 3.5c-.6.8-.6 1.7 0 2.5"/>',
  fork: '<path d="M7 3v7.5M4.5 3v5.5a2.5 2.5 0 0 0 5 0V3M7 11v10"/><path d="M17.5 21V3c-2.2 1.4-3.5 4.4-3.5 8 0 1.6.8 2.5 2 2.5h1.5"/>',
  pharmacy: 'f:<path d="M9.5 3A1.5 1.5 0 0 0 8 4.5V8H4.5A1.5 1.5 0 0 0 3 9.5v5A1.5 1.5 0 0 0 4.5 16H8v3.5A1.5 1.5 0 0 0 9.5 21h5a1.5 1.5 0 0 0 1.5-1.5V16h3.5a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 19.5 8H16V4.5A1.5 1.5 0 0 0 14.5 3h-5Z"/>',
  hospital: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M9 7.5v9M15 7.5v9M9 12h6"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  bed: '<path d="M3 18.5V6M3 14h18v4.5M21 14v-2.5a3 3 0 0 0-3-3h-7V14"/><circle cx="7" cy="11" r="1.8"/>',
  pin: 'f:<path d="M12 2a7 7 0 0 0-7 7c0 5.1 5.6 11.4 6.3 12.1.4.4 1 .4 1.4 0C13.4 20.4 19 14.1 19 9a7 7 0 0 0-7-7Zm0 9.6a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 10.5H6a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4A7.6 7.6 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.7 7.7 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z"/>',
  traffic: '<rect x="7.5" y="2.5" width="9" height="19" rx="3"/><circle cx="12" cy="7" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="17" r="1.6"/>',
  cube: '<path d="M12 2.8 20 7.2v9.6L12 21.2 4 16.8V7.2L12 2.8Z"/><path d="M4 7.2 12 11.6l8-4.4M12 11.6v9.6"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  flag: 'f:<path d="M5.5 2.5a1 1 0 0 0-1 1v17a1 1 0 1 0 2 0v-6.3c2.6-1.3 4.6.2 7 .9 2 .6 3.9.4 5.6-.6.3-.2.4-.5.4-.8V5.1c0-.7-.8-1.2-1.4-.8-1.4.8-2.7.9-4.2.4-2.6-.8-5-2.7-8.4-.9V3.5a1 1 0 0 0-1-1Z"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
  overview: '<path d="M3.5 6.5 9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5-5.5 2.5v-13.5Z"/><path d="M9 4v13.5M15 6.5V20"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3"/>',
  warning: 'f:<path d="M10.3 3.6 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0ZM12 8.2c.6 0 1.1.5 1 1.1l-.3 4.8a.7.7 0 0 1-1.4 0L11 9.3c-.1-.6.4-1.1 1-1.1Zm0 7.8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>',
  mountain: '<path d="m2.5 19.5 6.2-10 3.8 5.6 2.3-3.4 6.7 7.8H2.5Z"/>',
  car: '<path d="M5 16.5h14M6.5 16.5V19M17.5 16.5V19"/><path d="M4 16.5v-4.2l1.8-4.6a2 2 0 0 1 1.9-1.2h8.6a2 2 0 0 1 1.9 1.2l1.8 4.6v4.2"/><circle cx="7.8" cy="13.3" r=".9" fill="currentColor"/><circle cx="16.2" cy="13.3" r=".9" fill="currentColor"/>',
  play: 'f:<path d="M7 4.6v14.8c0 .8.9 1.3 1.6.8l11.3-7.4a1 1 0 0 0 0-1.6L8.6 3.8C7.9 3.3 7 3.8 7 4.6Z"/>',
  pause: 'f:<rect x="6" y="4.5" width="4" height="15" rx="1.3"/><rect x="14" y="4.5" width="4" height="15" rx="1.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: 'f:<path d="M20.3 14.6A8.5 8.5 0 0 1 9.4 3.7a.7.7 0 0 0-.9-.9 9.5 9.5 0 1 0 12.7 12.7.7.7 0 0 0-.9-.9Z"/>',
  cloud: 'f:<path d="M17.5 19H7a4.5 4.5 0 0 1-.8-8.9 6 6 0 0 1 11.4-1.2A5.1 5.1 0 0 1 17.5 19Z"/>',
  cloudSun: 'f:<path d="M8.6 3.2a.8.8 0 0 1 .8.8v.9a.8.8 0 1 1-1.6 0V4a.8.8 0 0 1 .8-.8ZM3.6 5.3a.8.8 0 0 1 1.1 0l.7.7a.8.8 0 1 1-1.1 1.1l-.7-.7a.8.8 0 0 1 0-1.1ZM8.6 6.8a3.3 3.3 0 0 0-3 4.6 4.9 4.9 0 0 1 2.6-1.3 6.6 6.6 0 0 1 3.4-2.4 3.3 3.3 0 0 0-3-.9Zm9.7 13.4H8.7a3.8 3.8 0 0 1-.6-7.6 5.2 5.2 0 0 1 9.9-.9 4.3 4.3 0 0 1 .3 8.5Z"/>',
  rain: 'f:<path d="M17.5 15H7a4.5 4.5 0 0 1-.8-8.9 6 6 0 0 1 11.4-1.2A5.1 5.1 0 0 1 17.5 15Z"/><path d="M8 17.5l-1 2.5M12 17.5 11 20M16 17.5 15 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  storm: 'f:<path d="M17.5 14H7a4.5 4.5 0 0 1-.8-8.9 6 6 0 0 1 11.4-1.2A5.1 5.1 0 0 1 17.5 14Z"/><path d="m12.5 14.5-2.5 4h3l-1.5 3.5"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5 4.2 16.5"/><path d="m9.8 4.8 2.2 2 2.2-2M9.8 19.2l2.2-2 2.2 2"/>',
  fog: '<path d="M4 9h16M4 13h16M6 17h12"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  swap: '<path d="M7 4v14M3.5 7.5 7 4l3.5 3.5M17 20V6M13.5 16.5 17 20l3.5-3.5"/>',
  pinDrop: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  fullscreen: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  signal: '<path d="M5 18v-2M9.5 18v-5M14 18V9M18.5 18V5"/>',
};

export function icon(name: string, size = 22, extraClass = ''): SVGElement {
  let body = P[name] || P.info;
  let filled = false;
  if (body.startsWith('f:')) { filled = true; body = body.slice(2); }
  const attrs = filled
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return svg(`<svg class="ic ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" ${attrs} aria-hidden="true">${body}</svg>`);
}

/** Category metadata shared by search chips, result rows and pins. */
export interface Category { id: string; label: string; icon: string; color: string; query: string }

// Queries are in Russian: Yandex's business index for Georgia is densest in RU; labels stay English.
export const CATEGORIES: Category[] = [
  { id: 'chargers', label: 'Chargers', icon: 'bolt', color: '#30d158', query: 'зарядная станция для электромобилей' },
  { id: 'parking', label: 'Parking', icon: 'parking', color: '#0a84ff', query: 'парковка' },
  { id: 'cafe', label: 'Cafés', icon: 'cup', color: '#ff9f0a', query: 'кафе' },
  { id: 'restaurant', label: 'Restaurants', icon: 'fork', color: '#ff7a1a', query: 'ресторан' },
  { id: 'carwash', label: 'Car Wash', icon: 'drop', color: '#40c8e0', query: 'автомойка' },
  { id: 'pharmacy', label: 'Pharmacies', icon: 'pharmacy', color: '#ff453a', query: 'аптека' },
  { id: 'atm', label: 'ATMs', icon: 'cash', color: '#34c759', query: 'банкомат' },
  { id: 'hospital', label: 'Hospitals', icon: 'hospital', color: '#ff375f', query: 'больница' },
  { id: 'hotel', label: 'Hotels', icon: 'bed', color: '#bf5af2', query: 'гостиница' },
];

export const categoryById = (id?: string) => CATEGORIES.find((c) => c.id === id);

/** Weather code (WMO) → icon + label. */
export function weatherIcon(code: number, isDay: boolean): string {
  if (code >= 95) return 'storm';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 85 && code <= 86) return 'snow';
  if (code >= 51) return 'rain';
  if (code >= 45) return 'fog';
  if (code >= 2) return 'cloud';
  if (code === 1) return isDay ? 'cloudSun' : 'cloud';
  return isDay ? 'sun' : 'moon';
}
