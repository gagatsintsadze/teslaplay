import type { LngLat } from '../types';

export interface DriveTime { duration: number; distance: number }

/**
 * Yandex Distance Matrix API — real driving time (with traffic) from one point to many.
 * Used to rank nearby results by how long they take to reach rather than straight-line distance.
 * One origin × up to 100 destinations per request (the API's cell limit).
 */
export class DriveTimes {
  private broken = false;
  constructor(private key: string) {}

  get available() { return !this.broken; }

  async from(origin: LngLat, dests: LngLat[], avoidTolls = false): Promise<(DriveTime | null)[]> {
    if (this.broken || !dests.length) return dests.map(() => null);
    const out: (DriveTime | null)[] = [];
    for (let i = 0; i < dests.length; i += 100) {
      const chunk = dests.slice(i, i + 100);
      const qs = new URLSearchParams({
        apikey: this.key,
        origins: `${origin[1].toFixed(6)},${origin[0].toFixed(6)}`,
        destinations: chunk.map((d) => `${d[1].toFixed(6)},${d[0].toFixed(6)}`).join('|'),
        mode: 'driving',
      });
      if (avoidTolls) qs.set('avoid_tolls', 'true');
      let r: Response;
      try {
        r = await fetch(`https://api.routing.yandex.net/v2/distancematrix?${qs}`);
      } catch (e) {
        this.broken = true; // network/CORS: don't keep trying this session
        throw e;
      }
      if (r.status === 401 || r.status === 403) { this.broken = true; throw new Error(`Distance Matrix ${r.status}`); }
      if (!r.ok) throw new Error(`Distance Matrix ${r.status}`);
      const j = await r.json();
      if (j && j.errors && j.errors.length) throw new Error(String(j.errors[0]));
      const els: any[] = (j && j.rows && j.rows[0] && j.rows[0].elements) || [];
      chunk.forEach((_, k) => {
        const e = els[k];
        out.push(e && e.status === 'OK' && e.duration && e.distance ? { duration: e.duration.value, distance: e.distance.value } : null);
      });
    }
    return out;
  }
}
