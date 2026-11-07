import { formatDistance } from '../core/format';
import { pointAt, projectOnRoute } from '../core/geo';
import type { EnergyModel } from '../services/ev';
import type { Voice } from '../services/voice';
import type { Fix, LngLat, Maneuver, RouteResult, TripPlan } from '../types';
import { maneuverVerb } from '../ui/glyph';

export interface NavSnapshot {
  routeId: string;
  progress: number;
  remaining: number;
  /** Seconds of driving + remaining planned charging. */
  timeRemaining: number;
  eta: number;
  maneuverIndex: number;
  maneuver: Maneuver;
  distToManeuver: number;
  /** The maneuver after, when it comes quickly (for the "Then" row). */
  then: Maneuver | null;
  speed: number | null;
  offRoute: boolean;
  arrived: boolean;
  arrivalSoc: number | null;
  socNow: number | null;
  nextStop: { name: string; distance: number } | null;
  /** Posted limit where the car is, km/h (router data; the app may fill it from map data). */
  speedLimit: number | null;
}

export interface SessionDeps {
  voice: Voice;
  destinationName: string;
  usableKWh: number;
  reverse(c: LngLat): Promise<string | null>;
  onSnapshot(s: NavSnapshot): void;
  onReroute(from: LngLat, heading: number | null): void;
  onArrive(): void;
}

type Stage = 'far' | 'near' | 'now';

/**
 * Turn-by-turn engine: map-matches each GPS fix to the route, tracks progress,
 * computes ETA/energy, detects off-route driving and schedules voice prompts.
 */
export class NavigationSession {
  private progress = 0;
  private offCount = 0;
  private lastReroute = 0;
  private spoken = new Map<number, Set<Stage>>();
  private passedWaypoints = new Set<number>();
  private requestedStreets = new Set<Maneuver>();
  private arrived = false;
  private lastFix: Fix | null = null;
  snap: { d: number; coord: LngLat } | null = null;

  constructor(public route: RouteResult, public plan: TripPlan | null, public energy: EnergyModel | null, private deps: SessionDeps) {}

  get total() { return this.route.cum[this.route.cum.length - 1]; }

  /** Swap in a fresh route after rerouting; progress restarts from the current position. */
  setRoute(route: RouteResult, plan: TripPlan | null, energy: EnergyModel | null) {
    this.route = route;
    this.plan = plan;
    this.energy = energy;
    this.progress = 0;
    this.offCount = 0;
    this.spoken.clear();
    this.passedWaypoints.clear();
    this.requestedStreets.clear();
    this.lastReroute = Date.now();
    if (this.lastFix) this.handleFix(this.lastFix);
  }

  handleFix(fix: Fix) {
    this.lastFix = fix;
    if (this.arrived) return;
    const r = this.route;
    let p = projectOnRoute(r.coords, r.cum, fix.coord, Math.max(0, this.progress - 100), this.progress + 2500);
    if (!p || p.offset > 150) {
      const full = projectOnRoute(r.coords, r.cum, fix.coord);
      if (full && (!p || full.offset < p.offset)) p = full;
    }
    if (!p) return;
    const tol = Math.max(40, Math.min(90, fix.accuracy * 1.5));
    const off = p.offset > tol;
    this.offCount = off ? this.offCount + 1 : 0;
    if (!off) {
      // Progress is near-monotonic; allow small corrections backwards (GPS jitter).
      this.progress = p.d > this.progress - 25 ? p.d : this.progress;
      this.snap = { d: this.progress, coord: p.coord };
    } else {
      this.snap = null;
    }
    const now = Date.now();
    if (this.offCount >= 3 && (fix.speed === null || fix.speed > 1) && now - this.lastReroute > 10000) {
      this.lastReroute = now;
      this.offCount = 0;
      this.deps.onReroute(fix.coord, fix.heading);
    }

    const remaining = Math.max(0, this.total - this.progress);
    if (!off && (remaining < 30 || (remaining < 90 && (fix.speed || 0) < 1.5))) {
      this.arrived = true;
      this.deps.voice.say(`You have arrived at ${this.deps.destinationName}`, true);
      this.emit(fix, remaining, off);
      this.deps.onArrive();
      return;
    }
    this.emit(fix, remaining, off);
  }

  private emit(fix: Fix, remaining: number, off: boolean) {
    const r = this.route;
    const ms = r.maneuvers;
    let idx = ms.findIndex((m, i) => i > 0 && m.at > this.progress + 3 && !(m.type === 'waypoint' && this.passedWaypoints.has(i)));
    if (idx < 0) idx = ms.length - 1;
    // Waypoints we just drove past.
    ms.forEach((m, i) => {
      if (m.type === 'waypoint' && m.at <= this.progress + 25 && !this.passedWaypoints.has(i)) {
        this.passedWaypoints.add(i);
        this.deps.voice.say(`Arriving at ${m.label || 'your stop'}`, true);
      }
    });
    const m = ms[idx];
    const dist = Math.max(0, m.at - this.progress);
    const after = ms[idx + 1];
    const then = after && after.at - m.at < 180 && after.type !== 'arrive' ? after : after && after.type === 'arrive' && after.at - m.at < 120 ? after : null;

    this.ensureStreets(idx);
    this.announce(idx, m, dist, fix.speed, then);

    const driving = this.remainingDriveTime(this.progress);
    const stopsLeft = this.plan ? this.plan.stops.filter((s) => s.distAlong > this.progress + 20) : [];
    const charging = stopsLeft.reduce((a, s) => a + s.chargeMinutes * 60, 0);
    const usable = this.deps.usableKWh;
    let socNow: number | null = null;
    let arrivalSoc: number | null = null;
    if (this.plan && this.energy) {
      // Walk the plan: SoC at current position given charges already passed.
      const passed = this.plan.stops.filter((s) => s.distAlong <= this.progress + 20);
      const last = passed[passed.length - 1];
      const fromD = last ? last.distAlong : 0;
      const fromSoc = last ? last.departSoc : this.plan.startSoc;
      socNow = fromSoc - ((this.energy.at(this.progress) - this.energy.at(fromD)) / usable) * 100;
      arrivalSoc = this.plan.arrivalSoc;
    }
    const nextStop = stopsLeft[0] ? { name: stopsLeft[0].place.name, distance: stopsLeft[0].distAlong - this.progress } : null;

    this.deps.onSnapshot({
      routeId: r.id,
      progress: this.progress,
      remaining,
      timeRemaining: driving + charging,
      eta: Date.now() + (driving + charging) * 1000,
      maneuverIndex: idx,
      maneuver: m,
      distToManeuver: dist,
      then,
      speed: fix.speed,
      offRoute: off,
      arrived: this.arrived,
      arrivalSoc,
      socNow,
      nextStop,
      speedLimit: this.route.maxspeed ? this.route.maxspeed[Math.min(this.route.maxspeed.length - 1, pointAt(this.route.coords, this.route.cum, this.progress).seg)] ?? null : null,
    });
  }

  /** Driving seconds left from distance `d` along the route (step durations, so traffic-heavy stretches count). */
  remainingDriveTime(d: number = this.progress): number {
    const r = this.route;
    const total = this.total;
    if (!r.steps.length) return r.duration * Math.max(0, 1 - d / total);
    const sum = r.steps.reduce((a, s) => a + s.duration, 0) || r.duration;
    const scale = r.duration / sum;
    let t = 0;
    r.steps.forEach((s, i) => {
      const end = i + 1 < r.steps.length ? r.steps[i + 1].startDist : total;
      if (end <= d) return;
      const len = Math.max(1, end - s.startDist);
      t += s.duration * ((end - Math.max(d, s.startDist)) / len);
    });
    return t * scale;
  }

  /** Street names come from reverse geocoding just past each upcoming maneuver. */
  private ensureStreets(idx: number) {
    const ms = this.route.maneuvers;
    for (let i = idx; i < Math.min(ms.length, idx + 2); i++) {
      const m = ms[i];
      if (m.street || m.type === 'arrive' || m.type === 'waypoint' || this.requestedStreets.has(m)) continue;
      this.requestedStreets.add(m);
      const probe = pointAt(this.route.coords, this.route.cum, Math.min(this.total, m.at + 40)).coord;
      this.deps.reverse(probe).then((street) => {
        if (street) { m.street = street; if (this.lastFix) this.emit(this.lastFix, Math.max(0, this.total - this.progress), false); }
      }).catch(() => {});
    }
  }

  private announce(idx: number, m: Maneuver, dist: number, speed: number | null, then: Maneuver | null) {
    const v = speed === null ? 12 : speed;
    const farTh = v > 22 ? 2000 : v > 14 ? 1000 : 450;
    const nearTh = Math.max(140, v * 11);
    const nowTh = Math.max(28, v * 3.2);
    const stage: Stage | null = dist <= nowTh ? 'now' : dist <= nearTh ? 'near' : dist <= farTh ? 'far' : null;
    if (!stage) return;
    const done = this.spoken.get(idx) || new Set<Stage>();
    if (done.has(stage)) return;
    const prev = this.route.maneuvers[idx - 1];
    if (stage === 'far' && (done.has('near') || (prev && m.at - prev.at < farTh * 0.8))) { done.add('far'); this.spoken.set(idx, done); return; }
    if (stage === 'near' && done.has('now')) return;
    done.add(stage);
    if (stage === 'now') done.add('near').add('far');
    if (stage === 'near') done.add('far');
    this.spoken.set(idx, done);

    const spokenDist = formatDistance(dist).replace(/ m$/, ' meters').replace(/ km$/, ' kilometers').replace(/ mi$/, ' miles').replace(/ ft$/, ' feet');
    const onto = m.street ? ` onto ${m.street}` : '';
    let text: string;
    if (m.type === 'arrive') {
      if (stage === 'now') return; // arrival prompt handled on arrival
      text = `In ${spokenDist}, you will arrive at ${this.deps.destinationName}`;
    } else if (m.type === 'waypoint') {
      text = stage === 'now' ? `Arriving at ${m.label}` : `In ${spokenDist}, your charging stop, ${m.label}`;
    } else if (stage === 'now') {
      text = maneuverVerb(m.type) + onto;
      if (then) text += then.type === 'arrive' ? `, then your destination` : `, then ${maneuverVerb(then.type).toLowerCase()}`;
    } else {
      text = `In ${spokenDist}, ${maneuverVerb(m.type).toLowerCase()}${onto}`;
    }
    this.deps.voice.say(text, stage === 'now');
  }
}
