import { sampleAlong } from '../core/geo';
import type { ElevationProfile, LngLat, RouteResult, Weather } from '../types';
import { demoElevation } from './demo-data';

/** Open-Meteo: free, keyless, CORS-enabled weather + elevation. */
const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers',
  82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
};
const SEVERE = new Set([48, 56, 57, 65, 66, 67, 73, 75, 82, 86, 95, 96, 99]);

const cache = new Map<string, Promise<any>>();
function getJSON(url: string): Promise<any> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

const toWeather = (temp: number, code: number, isDay: number | boolean): Weather => ({
  tempC: temp, code, isDay: !!isDay, label: WMO[code] || 'Weather', severe: SEVERE.has(code),
});

export class WeatherService {
  constructor(private demo: boolean) {}

  /** Current weather, or the hourly forecast nearest to `at` (epoch ms). */
  async get(c: LngLat, at?: number): Promise<Weather | null> {
    const lat = c[1].toFixed(2);
    const lng = c[0].toFixed(2);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day&forecast_days=2&timezone=auto`;
    try {
      const j = await getJSON(url);
      if (at && j.hourly && j.hourly.time) {
        const off = (j.utc_offset_seconds || 0) * 1000;
        let best = 0;
        let bestDiff = Infinity;
        j.hourly.time.forEach((t: string, i: number) => {
          const ms = Date.parse(t + ':00Z') - off;
          const diff = Math.abs(ms - at);
          if (diff < bestDiff) { bestDiff = diff; best = i; }
        });
        if (bestDiff < 3 * 3600e3) return toWeather(j.hourly.temperature_2m[best], j.hourly.weather_code[best], j.hourly.is_day[best]);
      }
      if (j.current) return toWeather(j.current.temperature_2m, j.current.weather_code, j.current.is_day);
      return null;
    } catch {
      if (!this.demo) return null;
      // Offline demo: plausible November weather in Georgia.
      const coast = c[0] < 42.3;
      const hour = new Date(at || Date.now()).getHours();
      return toWeather(coast ? 16 : 12, coast ? 95 : 3, hour > 6 && hour < 18);
    }
  }

  /** Elevation profile along a route (≤100 samples per request). */
  async elevation(route: RouteResult): Promise<ElevationProfile | null> {
    const n = Math.max(2, Math.min(100, Math.ceil(route.distance / 800)));
    const samples = sampleAlong(route.coords, route.cum, n);
    let heights: number[] | null = null;
    try {
      const lat = samples.map((s) => s.coord[1].toFixed(4)).join(',');
      const lng = samples.map((s) => s.coord[0].toFixed(4)).join(',');
      const j = await getJSON(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
      if (Array.isArray(j.elevation) && j.elevation.length === samples.length) heights = j.elevation;
    } catch {
      if (this.demo) heights = samples.map((s) => demoElevation(s.coord));
    }
    if (!heights) return null;
    // Ignore sub-3 m noise when summing climb/descent.
    let ascent = 0;
    let descent = 0;
    let ref = heights[0];
    for (const h of heights) {
      if (h - ref > 3) { ascent += h - ref; ref = h; } else if (ref - h > 3) { descent += ref - h; ref = h; }
    }
    return { samples: samples.map((s, i) => ({ d: s.d, h: heights![i] })), ascent, descent };
  }
}
