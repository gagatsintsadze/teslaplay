import type { LaneConnection, LaneRecord } from '../services/roads';
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
  /** the lane the car arrives on this section in (before any change) */
  from: number;
}

const LANE_LEAD_S = 7;      // seconds of travel per lane change
const LANE_LEAD_MIN = 150;  // metres per lane change, at least
const EXIT_LEAD_MIN = 600;  // on motorways/trunks: be in the exit lane this far ahead

const turnsOf = (r: LaneRecord, forward: boolean) => (forward ? r.tf : r.tb);

/**
 * Lanes whose arrows serve a turn. Explicitly marked lanes win; unmarked lanes ("none"/empty) only count when
 * no lane is marked for that turn, and a slight turn is accepted for "through" as a last resort.
 */
export function lanesForTurn(turns: string[], t: 'left' | 'right' | 'through'): number[] {
  const pick = (re: RegExp) => turns.map((x, i) => (re.test(x) ? i : -1)).filter((i) => i >= 0);
  const explicit = pick(t === 'left' ? /left|reverse/ : t === 'right' ? /right/ : /through/);
  if (explicit.length) return explicit;
  const unmarked = pick(/^(none)?$/);
  if (t === 'through') return unmarked.length ? unmarked : pick(/slight/);
  // a turn with no marked lane: an unmarked lane may still allow it, but only if every lane is unmarked
  return unmarked.length === turns.length ? unmarked : [];
}

/** The junction connection from `sec` into `next`, when the pipeline recorded one. */
function connection(sec: Section, next: Section | undefined): LaneConnection | null {
  if (!next) return null;
  const list = sec.forward ? sec.rec.cn : sec.rec.cnb;
  if (!list) return null;
  return list.find((c) => c.to === next.rec.id && c.d === (next.forward ? 'f' : 'b')) || null;
}

const busLanes = (sec: Section) => (sec.forward ? sec.rec.bf : sec.rec.bb) || null;
const notBus = (sec: Section, lanes: number[]) => { const b = busLanes(sec); const out = b ? lanes.filter((i) => !b[i]) : lanes; return out.length ? out : lanes; };

/** Allowed lanes for manoeuvre `m` when approached on `sec` (null = any). Junction connectivity first, then Mapbox, then arrows. */
export function allowedLanes(m: Maneuver, sec: Section, next?: Section): number[] | null {
  const n = sec.count;
  if (n <= 1) return null;
  const left = /left/.test(m.type) || m.type === 'uturn';
  const right = /right/.test(m.type);
  if (m.roundabout) {
    // Entering a roundabout: first exit from the right-hand lane, the last exits (or going round) from the left, else any.
    if (m.exit === 1) return notBus(sec, [n - 1]);
    if ((m.exit !== undefined && m.exit >= 3) || left) return notBus(sec, [0]);
    return null;
  }
  const cn = connection(sec, next);
  // The recorded connection is trusted only when the pipeline saw the same kind of turn the router did:
  // a shallow junction can be classed "through" by angle while the router (and the arrows) call it a left.
  const agrees = cn && (left ? cn.t === 'left' || cn.t === 'uturn' : right ? cn.t === 'right' : cn.t === 'through');
  if (cn && cn.m.length && agrees) {
    const src = Array.from(new Set(cn.m.map(([a]) => a))).sort((a, b) => a - b);
    if (src.length < n) return notBus(sec, src);
    if (!left && !right) return null;
  }
  const turns = turnsOf(sec.rec, sec.forward);
  if (turns) {
    const idx = lanesForTurn(turns, left ? 'left' : right ? 'right' : 'through');
    if (idx.length && idx.length < n) return notBus(sec, idx);
    if (idx.length === n) return null;
    // arrows exist but none match (e.g. a slight turn tagged as "through"): try the router's lane flags, then the side rule
  }
  if (m.lanes && m.lanes.length === n) {
    const valid = m.lanes.map((l, i) => (l.valid ? i : -1)).filter((i) => i >= 0);
    if (valid.length && valid.length < n) return notBus(sec, valid);
    if (valid.length === n) return null;
  }
  if (left) return [0];
  if (right) return [n - 1];
  return null;
}

/** Lanes a car should not sit in when nothing forces it: unmarked lanes beside arrowed ones (bus, parking). */
function usableLanes(sec: Section): number[] {
  const turns = turnsOf(sec.rec, sec.forward);
  const all = notBus(sec, Array.from({ length: sec.count }, (_, i) => i));
  if (!turns || turns.every((t) => t === 'none')) return all;
  const marked = all.filter((i) => turns[i] !== 'none');
  return marked.length ? marked : all;
}

/** Can the car move from lane `a` to lane `b` on this section? (OSM change:lanes: no / not_left / not_right) */
export function changeAllowed(sec: Section, a: number, b: number): boolean {
  const ch = sec.forward ? sec.rec.cf : sec.rec.cb;
  if (!ch) return true;
  const step = b > a ? 1 : -1;
  for (let i = a; i !== b; i += step) {
    const v = ch[i] || 'yes';
    if (v === 'no' || (step > 0 && v === 'not_right') || (step < 0 && v === 'not_left')) return false;
  }
  return true;
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
function landingLane(m: Maneuver | null, from: Section, lane: number, to: Section): number {
  const cn = connection(from, to);
  const left = !!m && (/left/.test(m.type) || m.type === 'uturn');
  const right = !!m && /right/.test(m.type);
  const agrees = !cn || !m || (left ? cn.t === 'left' || cn.t === 'uturn' : right ? cn.t === 'right' : cn.t === 'through');
  if (cn && cn.m.length && agrees) {
    const hit = cn.m.find(([a]) => a === lane);
    if (hit) return Math.min(to.count - 1, hit[1]);
    const nearest = cn.m.reduce((best, pair) => (Math.abs(pair[0] - lane) < Math.abs(best[0] - lane) ? pair : best), cn.m[0]);
    return Math.min(to.count - 1, nearest[1]);
  }
  if (!m) return to.count === from.count ? lane : Math.max(0, Math.min(to.count - 1, Math.round((lane * (to.count - 1)) / Math.max(1, from.count - 1))));
  if (left) return 0;
  if (right) return to.count - 1;
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
  const allowedOf = sections.map((sec, s) => (mFor[s] >= 0 ? allowedLanes(maneuvers[mFor[s]], sec, sections[s + 1]) : null));
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
      const fast = /motorway|trunk/.test(sec.rec.c);
      const lead = Math.max(fast ? EXIT_LEAD_MIN : LANE_LEAD_MIN, LANE_LEAD_S * vms) * Math.max(1, toCross);
      mustBeInBy = m.at - lead;
      // a solid line on this section forbids the change: be in the lane before the section starts
      if (toCross && !changeAllowed(sec, lane, recommended)) mustBeInBy = Math.min(mustBeInBy, cum[sec.i0]);
    }
    steps.push({ section: s, allowed, recommended, mustBeInBy, maneuver: mi, from: lane });
    // carry the lane into the next section
    const next = sections[s + 1];
    if (next) lane = landingLane(m && m.at <= cum[next.i0] + 1 ? m : null, sec, recommended, next);
  }
  return steps;
}
