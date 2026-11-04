import { bearing, destination, distance, lerpAngle, pointAt } from '../core/geo';
import type { Fix, LngLat, RouteResult } from '../types';

export type LocationStatus = 'pending' | 'ok' | 'denied' | 'unavailable';

/**
 * GPS with the quirks of Tesla's browser handled:
 *  • speed/heading are often null → derived from consecutive fixes;
 *  • the position stream can silently stall (reported on several firmwares) → a watchdog
 *    restarts the watch and polls getCurrentPosition;
 *  • a simulator can replace the GPS to drive any route for testing and demos.
 */
export class LocationService {
  status: LocationStatus = 'pending';
  last: Fix | null = null;
  private watchId: number | null = null;
  private listeners = new Set<(f: Fix) => void>();
  private statusListeners = new Set<(s: LocationStatus) => void>();
  private watchdog: number | undefined;
  private sim: Simulator | null = null;

  onFix(cb: (f: Fix) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  onStatus(cb: (s: LocationStatus) => void) { this.statusListeners.add(cb); return () => this.statusListeners.delete(cb); }

  start() {
    if (!('geolocation' in navigator)) { this.setStatus('unavailable'); return; }
    this.watch();
    clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => {
      if (this.sim) return;
      const age = this.last ? Date.now() - this.last.time : Infinity;
      if (age > 12000) {
        this.watch();
        navigator.geolocation.getCurrentPosition((p) => this.ingest(p), () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 });
      }
    }, 5000);
  }

  private watch() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.ingest(p),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) this.setStatus('denied');
        else if (!this.last) this.setStatus('unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }

  private ingest(p: GeolocationPosition) {
    if (this.sim) return;
    const c = p.coords;
    const coord: LngLat = [c.longitude, c.latitude];
    let speed = c.speed !== null && isFinite(c.speed) ? c.speed : null;
    let heading = c.heading !== null && isFinite(c.heading) && !isNaN(c.heading) ? c.heading : null;
    const prev = this.last;
    if (prev && !prev.simulated) {
      const dt = (p.timestamp - prev.time) / 1000;
      const moved = distance(prev.coord, coord);
      if (speed === null && dt > 0.2) speed = moved / dt;
      if (heading === null && moved > 4) heading = bearing(prev.coord, coord);
      if (heading === null && prev.heading !== null) heading = prev.heading;
    }
    // Hold heading while stationary (GPS bearing is noise below ~1.5 m/s).
    if (speed !== null && speed < 1.5 && prev && prev.heading !== null) heading = prev.heading;
    this.emit({ coord, accuracy: c.accuracy || 50, speed, heading, time: p.timestamp || Date.now() });
  }

  /** Inject a fix (demo start position, tests). */
  push(f: Fix) { this.emit(f); }

  private emit(f: Fix) {
    this.last = f;
    if (this.status !== 'ok') this.setStatus('ok');
    this.listeners.forEach((l) => l(f));
  }

  private setStatus(s: LocationStatus) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  get simulating() { return !!this.sim; }

  simulate(route: RouteResult, speedMultiplier = 1) {
    this.stopSimulation();
    this.sim = new Simulator(route, speedMultiplier, (f) => this.emit(f));
  }
  setSimSpeed(x: number) { if (this.sim) this.sim.multiplier = x; }
  stopSimulation() { if (this.sim) { this.sim.stop(); this.sim = null; } }
}

/** Drives a route at realistic speeds: per-step speed, slowing for turns, ~1 Hz fixes with GPS-like noise. */
class Simulator {
  private d = 0;
  private v = 0;
  private timer: number;
  private heading = 0;

  constructor(private route: RouteResult, public multiplier: number, private emit: (f: Fix) => void) {
    this.heading = pointAt(route.coords, route.cum, 0).bearing;
    this.timer = window.setInterval(() => this.tick(1), 1000);
    this.tick(0);
  }

  stop() { clearInterval(this.timer); }

  private targetSpeed(d: number): number {
    const r = this.route;
    let v = (r.distance / Math.max(1, r.duration));
    for (let i = r.steps.length - 1; i >= 0; i--) {
      const s = r.steps[i];
      if (d >= s.startDist) { if (s.duration > 0 && s.distance > 100) v = s.distance / s.duration; break; }
    }
    v = Math.max(6, Math.min(33, v * 1.08));
    // Slow for upcoming turns and the destination.
    for (const m of r.maneuvers) {
      if (m.at < d - 5 || m.type === 'depart') continue;
      const dist = m.at - d;
      if (dist > 220) break;
      const corner = m.type === 'arrive' ? 0 : m.type === 'waypoint' ? 0 : Math.abs(m.angle) > 60 ? 6 : Math.abs(m.angle) > 30 ? 11 : v;
      v = Math.min(v, corner + dist * 0.12);
    }
    return v;
  }

  private tick(dt: number) {
    const total = this.route.cum[this.route.cum.length - 1];
    const step = dt * this.multiplier;
    if (step > 0) {
      const target = this.targetSpeed(this.d);
      const a = target > this.v ? 2.2 : -3.2;
      this.v = Math.max(0, a > 0 ? Math.min(target, this.v + a * step) : Math.max(target, this.v + a * step));
      this.d = Math.min(total, this.d + this.v * step);
    }
    const here = pointAt(this.route.coords, this.route.cum, this.d);
    const ahead = pointAt(this.route.coords, this.route.cum, Math.min(total, this.d + 8));
    const brg = this.d < total - 2 ? bearing(here.coord, ahead.coord) : this.heading;
    this.heading = lerpAngle(this.heading, brg, 0.7);
    const noise = destination(here.coord, Math.random() * 360, Math.random() * 2.5);
    this.emit({
      coord: noise, accuracy: 6, speed: this.d >= total ? 0 : this.v,
      heading: this.heading + (Math.random() - 0.5) * 2, time: Date.now(), simulated: true,
    });
    if (this.d >= total) this.v = 0;
  }
}
