import type { LngLat } from '../types';

/**
 * Solar elevation (degrees) for a moment and place — NOAA approximation, ±0.5°.
 * Used for automatic day/night map appearance, like Apple Maps and Tesla do.
 */
export function solarElevation(date: Date, [lng, lat]: LngLat): number {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const λ = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const ε = (23.439 - 0.0000004 * n) * rad;
  const δ = Math.asin(Math.sin(ε) * Math.sin(λ));
  const α = Math.atan2(Math.cos(ε) * Math.sin(λ), Math.cos(λ));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lng) * rad;
  const H = lst - α;
  const φ = lat * rad;
  return Math.asin(Math.sin(φ) * Math.sin(δ) + Math.cos(φ) * Math.cos(δ) * Math.cos(H)) / rad;
}

/** Day while the sun is above civil-twilight-ish threshold. */
export const isDaylight = (date: Date, at: LngLat) => solarElevation(date, at) > -4;
