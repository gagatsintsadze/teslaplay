import type { LaneRecord } from '../services/roads';
import type { Maneuver } from '../types';

/**
 * The lane plan: for every stretch of the route, which lanes are allowed for what comes next,
 * which one is recommended, and by when the car must be in it. Planned the way guidance engines
 * do it — manoeuvre by manoeuvre, carrying the car's lane forward and working the deadlines back:
 *
 *  - allowed lanes at a manoeuvre come from Mapbox's lane flags (when they agree with our lane
 *    count), else OSM `turn:lanes`, else the side of the turn; they hold over the whole approach
 *    section (OSM splits roads where the arrows change)
 *  - the recommended lane is the allowed lane nearest to the lane the car is already in; with no
 *    constraint the car keeps its lane (no drifting to the kerb), except that lanes painted with
 *    no arrow next to arrowed lanes (bus/parking) are avoided
 *  - after a turn the car lands in the lane that turn feeds: left → leftmost, right → rightmost,
 *    straight → the same lane counted from the left (scaled when the count changes)
 *  - the latest point to be in the lane is the manoeuvre minus ~7 s of travel per lane to cross,
 *    at least 150 m per lane
 *
 * Sections are runs of consecutive route vertices on the same lane record and direction.
 */

export interface Section {
  i0: number; i1: number;           // route vertex range (inclusive)
  rec: LaneRecord; forward: boolean;
  count: number;                    // lanes in the direction of travel
  lw: number;
}

export interface PlanStep {
  section: number;
  /** allowed lanes (travel frame, 0 = leftmost) for the next manoeuvre, or null = any */
  allowed: number[] | null;
  recommended: number;
  /** route distance by which the car must be in `recommended` (Infinity when unconstrained) */
  mustBeInBy: number;
  /** index into maneuvers this step prepares for, or -1 */
  maneuver: number;
}

const LANE_LEAD_S = 7;      // seconds of travel per lane change
const LANE_LEAD_MIN = 150;  // metres per lane change, at least

const turnsOf = (r: LaneRecord, forward: boolean) => (forward ? r.tf : r.tb);

/** Allowed lanes for manoeuvre `m` when approached on `sec` (null = any). */
export function allowedLanes(m: Maneuver, sec: Section): number[] | null {
  const n = sec.count;
  if (n <= 1) return null;
  const left = /left/.test(m.type) || m.type === 'uturn';
  const right = /right/.test(m.type);
  if (m.lanes && m.lanes.length === n) {
    const valid = m.lanes.map((l, i) => (l.valid ? i : -1)).filter((i) => i >= 0);
    if (valid.length && valid.length < n) return valid;
    if (valid.length === n) return null;
  }
  const turns = turnsOf(sec.rec, sec.forward);
  if (turns) {
    const want = left ? /left|reverse/ : right ? /right/ : /through|none|^$/;
    const idx = turns.map((t, i) => (want.test(t) ? i : -1)).filter((i) => i >= 0);
    if (idx.length && idx.length < n) return idx;
    if (idx.length === n) return null;
    // arrows exist but none match (e.g. a slight turn tagged as "through"): fall through to the side rule
  }
  if (left) return [0];
  if (right) return [n - 1];
  return null;
}

/** Lanes a car should not sit in when nothing forces it: unmarked lanes beside arrowed ones (bus, parking). */
function usableLanes(sec: Section): number[] {
  const turns = turnsOf(sec.rec, sec.forward);
  const all = Array.from({ length: sec.count }, (_, i) => i);
  if (!turns || turns.every((t) => t === 'none')) return all;
  const marked = all.filter((i) => turns[i] !== 'none');
  return marked.length ? marked : all;
}

/** The lane to cruise in when nothing constrains: the right-hand through lane (keep right), never a turn-only or unmarked lane. */
function preferredLane(sec: Section): number {
  const usable = usableLanes(sec);
  const turns = turnsOf(sec.rec, sec.forward);
  if (!turns) return Math.max(...usable);
  const through = usable.filter((i) => /through|^none$/.test(turns[i]) || turns[i] === '');
  return Math.max(...(through.length ? through : usable));
}

/** Where the car lands on the next section after a manoeuvre, given its lane before it. */
function landingLane(m: Maneuver, from: Section, lane: number, to: Section): number {
  if (/left/.test(m.type) || m.type === 'uturn') return 0;
  if (/right/.test(m.type)) return to.count - 1;
  if (from.count === to.count) return lane;
  // straight on with a different lane count: keep the position scaled from the left
  return Math.max(0, Math.min(to.count - 1, Math.round((lane * (to.count - 1)) / Math.max(1, from.count - 1))));
}

const nearestIn = (set: number[], lane: number) => set.reduce((best, k) => (Math.abs(k - lane) < Math.abs(best - lane) ? k : best), set[0]);

/** Speed limit (km/h) to plan lane changes with, from the record or a class default. */
function planSpeed(sec: Section): number {
  const r = sec.rec;
  const v = sec.forward ? r.ms : r.mb;
  if (v) return v;
  return /motorway/.test(r.c) ? 110 : /trunk|primary/.test(r.c) ? 70 : 50;
}

export function planLanes(sections: Section[], cum: number[], maneuvers: Maneuver[], startLane: number | null): PlanStep[] {
  const steps: PlanStep[] = [];
  if (!sections.length) return steps;
  // which section each manoeuvre is approached on: the one containing the last vertex before `at`
  // the approach section of a manoeuvre: the last section that starts before it
  const approach = (m: Maneuver): number => {
    for (let s = sections.length - 1; s >= 0; s--) if (cum[sections[s].i0] < m.at - 2) return s;
    return 0;
  };
  const mFor: number[] = sections.map(() => -1);
  maneuvers.forEach((m, mi) => {
    if (m.type === 'depart' || m.type === 'arrive') return;
    const s = approach(m);
    if (mFor[s] < 0) mFor[s] = mi; // the first manoeuvre on a section is the one to prepare for
  });
  const allowedOf = sections.map((sec, s) => (mFor[s] >= 0 ? allowedLanes(maneuvers[mFor[s]], sec) : null));
  let lane = startLane;
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    const mi = mFor[s];
    const m = mi >= 0 ? maneuvers[mi] : null;
    const allowed = allowedOf[s];
    const usable = allowed || usableLanes(sec);
    if (lane === null || lane >= sec.count) lane = Math.min(sec.count - 1, Math.max(...usable)); // first section: kerb-side usable lane
    let recommended: number;
    if (allowed) {
      recommended = nearestIn(allowed, lane);
    } else {
      // unconstrained: get ready for a constraint coming within 500 m, else cruise in the right-hand through lane
      let aim: number | null = null;
      for (let c = s + 1; c < sections.length && cum[sections[c].i0] - cum[sec.i0] < 500; c++) {
        const a = allowedOf[c];
        if (a) { aim = Math.max(0, Math.min(sec.count - 1, nearestIn(a, lane))); break; }
      }
      const len = cum[sec.i1] - cum[sec.i0];
      recommended = aim !== null ? nearestIn(usable, aim) : len >= 150 || s === 0 ? preferredLane(sec) : nearestIn(usable, lane);
    }
    let mustBeInBy = Infinity;
    if (m && allowed) {
      const toCross = Math.abs(recommended - lane);
      const vms = planSpeed(sec) / 3.6;
      const lead = Math.max(LANE_LEAD_MIN, LANE_LEAD_S * vms) * Math.max(1, toCross);
      mustBeInBy = m.at - lead;
    }
    steps.push({ section: s, allowed, recommended, mustBeInBy, maneuver: mi });
    // carry the lane into the next section
    const next = sections[s + 1];
    if (next) {
      if (m && m.at <= cum[next.i0] + 1) lane = landingLane(m, sec, recommended, next);
      else lane = next.count === sec.count ? recommended : Math.round((recommended * (next.count - 1)) / Math.max(1, sec.count - 1));
    }
  }
  return steps;
}
