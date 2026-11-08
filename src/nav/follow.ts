import { angleDiff, bearing, destination, lerp, lerpAngle, pointAt } from '../core/geo';
import type { MapEngine } from '../map/engine';
import type { Puck } from '../map/markers';
import type { Fix, LngLat, RouteResult } from '../types';

export type FollowMode = 'none' | 'follow' | 'course';

/**
 * Owns the user puck and the follow camera. GPS arrives at ~1 Hz; this interpolates between
 * fixes every frame (along the route while navigating) so the puck glides like a native app.
 */
export class FollowController {
  mode: FollowMode = 'follow';
  navigating = false;
  tilt3D = true;
  private fix: Fix | null = null;
  private disp: LngLat | null = null;
  private heading = 0;
  private hasHeading = false;
  private from: LngLat | null = null;
  private to: LngLat | null = null;
  private route: RouteResult | null = null;
  /** Route geometry as drawn (shifted into the lanes of travel); same vertex count as route.coords. */
  private shown: LngLat[] | null = null;
  private alongFrom = 0;
  private alongTo = 0;
  private start = 0;
  private dur = 1000;
  private running = false;
  private lastCam = 0;
  private zoom = 16.5;
  private tilt = 0;
  private distToManeuver = Infinity;

  constructor(private engine: MapEngine, private puck: Puck, private opts: { lite(): boolean; onMode(m: FollowMode): void }) {}

  setMode(m: FollowMode) {
    if (m === this.mode) return;
    this.mode = m;
    this.opts.onMode(m);
    this.tilt = this.engine.getView().tilt; // ease from wherever the camera is now
    if (m === 'follow' && !this.navigating) this.engine.setView({ azimuth: 0, tilt: this.exploreTilt, duration: 400 });
    if (m === 'course' && this.navigating && this.disp) {
      // Fly into the close, tilted driving view.
      const z = this.navZoom();
      this.zoom = z;
      this.tilt = this.driveTilt;
      this.engine.setView({ center: this.disp, zoom: z, tilt: this.tilt, azimuth: this.heading, duration: 1400 });
      this.lastCam = performance.now() + 1400;
    } else if (m !== 'none' && this.disp) {
      const z = this.navigating ? this.navZoom() : Math.max(15.5, this.engine.getView().zoom);
      this.zoom = z;
      this.engine.setView({ center: this.disp, zoom: z, duration: 450 });
      this.lastCam = performance.now() + 450;
    }
    this.kick();
  }

  /** Sideways shift of the car from the drawn route line, metres (right positive): the lane it is really in. */
  private laneShift = 0;
  private laneShiftTarget = 0;
  setLaneShift(m: number) { this.laneShiftTarget = m; this.kick(); }

  setDisplayCoords(coords: LngLat[] | null) { this.shown = coords && this.route && coords.length === this.route.coords.length ? coords : null; }

  setNavigation(route: RouteResult | null) {
    this.route = route;
    this.shown = null;
    this.navigating = !!route;
    if (route) { this.alongFrom = this.alongTo = 0; }
    this.laneShift = this.laneShiftTarget = 0;
    this.kick();
  }

  setManeuverDistance(d: number) { this.distToManeuver = d; }

  /** Feed a fix, optionally with its map-matched distance along the active route. */
  setFix(fix: Fix, snappedD: number | null) {
    const first = !this.fix;
    this.fix = fix;
    const now = performance.now();
    const v = fix.speed || 0;
    if (this.route && snappedD !== null) {
      const cur = this.currentAlong(now);
      this.alongFrom = Math.abs(cur - snappedD) > 150 ? snappedD : cur;
      this.alongTo = snappedD + Math.min(40, v * 0.95);
      this.from = this.to = null;
    } else {
      this.from = this.disp || fix.coord;
      this.to = v > 2 && fix.heading !== null ? destination(fix.coord, fix.heading, Math.min(30, v * 0.9)) : fix.coord;
      if (this.route) this.alongFrom = this.alongTo = -1;
    }
    if (fix.heading !== null) this.hasHeading = true;
    this.start = now;
    this.dur = fix.simulated ? 1000 : 1050;
    if (first) {
      this.disp = fix.coord;
      if (this.mode !== 'none') this.engine.setView({ center: fix.coord, zoom: Math.max(16, this.engine.getView().zoom), duration: 0 });
    }
    this.kick();
  }

  private currentAlong(now: number) {
    const t = Math.min(1, (now - this.start) / this.dur);
    return this.alongFrom + (this.alongTo - this.alongFrom) * t;
  }

  kick() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame((t) => this.tick(t));
  }

  /** Pitch while driving: as steep as the engine allows (Apple-style street-level view). */
  get driveTilt() { return this.tilt3D ? Math.min(60, this.engine.maxTilt) : 0; }
  private get tiltTarget() { return this.navigating ? this.driveTilt : this.exploreTilt; }

  /** Pitch while exploring with 3D on. */
  get exploreTilt() { return this.tilt3D ? Math.min(45, this.engine.maxTilt) : 0; }

  /** Close in town, pulling back smoothly with speed; a touch closer approaching a turn. */
  private navZoom() {
    const kmh = (this.fix && this.fix.speed ? this.fix.speed : 0) * 3.6;
    let z = 18.5 - Math.max(0, Math.min(1, (kmh - 25) / 90)) * 1.8;
    if (this.distToManeuver < 260 && kmh < 75) z += 0.4;
    return Math.min(19, z);
  }

  private tick(now: number) {
    const fix = this.fix;
    if (!fix) { this.running = false; return; }
    const t = Math.min(1, (now - this.start) / this.dur);
    let target = this.heading;
    if (this.route && this.alongTo >= 0 && this.from === null) {
      const d = this.alongFrom + (this.alongTo - this.alongFrom) * t;
      const line = this.shown || this.route.coords;
      const here = pointAt(line, this.route.cum, d);
      const ahead = pointAt(line, this.route.cum, d + 12);
      target = bearing(here.coord, ahead.coord);
      this.laneShift += (this.laneShiftTarget - this.laneShift) * 0.06;
      this.disp = Math.abs(this.laneShift) > 0.05 ? destination(here.coord, target + 90, this.laneShift) : here.coord;
    } else if (this.from && this.to) {
      this.disp = lerp(this.from, this.to, t);
      if (fix.heading !== null) target = fix.heading;
    }
    this.heading = lerpAngle(this.heading, target, Math.abs(angleDiff(this.heading, target)) > 90 ? 0.35 : 0.12);

    const view = this.engine.getView();
    const stale = Date.now() - fix.time > 15000;
    this.engine.setUserMarker(this.disp, this.puck.el, this.heading);
    this.puck.update(this.hasHeading ? this.heading - view.azimuth : null, this.navigating && this.mode === 'course', stale);

    const camInterval = this.opts.lite() ? 66 : 33;
    if (this.mode !== 'none' && this.disp && now - this.lastCam >= camInterval) {
      const dt = Math.min(250, Math.max(0, now - this.lastCam));
      this.lastCam = now;
      // The follow controller owns the pitch while following, so per-frame camera jumps
      // can't cut short a tilt animation.
      this.tilt += (this.tiltTarget - this.tilt) * (1 - Math.exp(-dt / 380)); // time-based: same feel at any frame rate
      if (this.mode === 'course') {
        this.zoom += ((this.navigating ? this.navZoom() : Math.max(16, this.zoom)) - this.zoom) * 0.06;
        this.engine.setView({ center: this.disp, zoom: this.zoom, azimuth: this.heading, tilt: this.tilt });
      } else {
        this.engine.setView({ center: this.disp, tilt: this.tilt });
      }
    }

    const moving = t < 1 || (fix.speed || 0) > 0.5;
    const settling = Math.abs(angleDiff(this.heading, target)) > 0.5 || (this.mode !== 'none' && Math.abs(this.tilt - this.tiltTarget) > 0.3);
    if (moving || settling || this.mode === 'course') requestAnimationFrame((tt) => this.tick(tt));
    else this.running = false;
  }

  get position() { return this.disp; }
  get displayHeading() { return this.heading; }
}
