let units: 'metric' | 'imperial' = 'metric';
export const setUnits = (u: 'metric' | 'imperial') => { units = u; };

/** Navigation-style rounded distance: "350 m", "1.2 km", "128 km". Returns [value, unit]. */
export function distanceParts(m: number): [string, string] {
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return [String(Math.max(0, Math.round(ft / 50) * 50)), 'ft'];
    const mi = m / 1609.344;
    return [mi < 10 ? mi.toFixed(1) : String(Math.round(mi)), 'mi'];
  }
  if (m < 1000) {
    const step = m < 100 ? 10 : m < 300 ? 25 : 50;
    return [String(Math.max(0, Math.round(m / step) * step)), 'm'];
  }
  const km = m / 1000;
  return [km < 10 ? km.toFixed(1) : String(Math.round(km)), 'km'];
}

export const formatDistance = (m: number) => distanceParts(m).join(' ');

/** "<1 min", "12 min", "1 h 05 min", "5 h 37 min" */
export function formatDuration(s: number): string {
  if (!isFinite(s)) return '—';
  const mins = Math.round(s / 60);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Compact "5:37" style for tight HUD slots, with unit label. */
export function durationParts(s: number): [string, string] {
  const mins = Math.max(0, Math.round(s / 60));
  if (mins < 60) return [String(mins), 'min'];
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [`${h}:${String(m).padStart(2, '0')}`, 'hr'];
}

export function formatClock(t: number | Date): string {
  const d = typeof t === 'number' ? new Date(t) : t;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function speedParts(mps: number | null): [string, string] {
  if (mps === null || !isFinite(mps)) return ['—', units === 'imperial' ? 'mph' : 'km/h'];
  const v = units === 'imperial' ? mps * 2.23694 : mps * 3.6;
  return [String(Math.round(v < 1.5 ? 0 : v)), units === 'imperial' ? 'mph' : 'km/h'];
}

export const formatPercent = (v: number) => `${Math.round(v)}%`;

export function formatKWh(v: number) {
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

export function formatElevation(m: number) {
  if (units === 'imperial') return `${Math.round(m * 3.28084).toLocaleString('en-US')} ft`;
  return `${Math.round(m).toLocaleString('en-US')} m`;
}
