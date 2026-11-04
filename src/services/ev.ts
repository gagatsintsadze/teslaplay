import { pointAt, projectOnRoute } from '../core/geo';
import type { ChargeStop, ElevationProfile, Place, RouteResult, Settings, TripPlan } from '../types';

export interface Vehicle {
  id: string;
  name: string;
  usableKWh: number;
  /** Typical mixed consumption at ~90 km/h, 20 °C, flat, Wh/km. */
  whPerKm: number;
  maxChargeKW: number;
  massKg: number;
}

// Approximate figures for planning — owners should fine-tune capacity/consumption in Settings.
export const VEHICLES: Vehicle[] = [
  { id: 'm3-rwd', name: 'Model 3 RWD', usableKWh: 57, whPerKm: 148, maxChargeKW: 170, massKg: 1850 },
  { id: 'm3-lr', name: 'Model 3 Long Range', usableKWh: 75, whPerKm: 152, maxChargeKW: 250, massKg: 1900 },
  { id: 'm3-p', name: 'Model 3 Performance', usableKWh: 75, whPerKm: 172, maxChargeKW: 250, massKg: 1950 },
  { id: 'my-rwd', name: 'Model Y RWD', usableKWh: 60, whPerKm: 158, maxChargeKW: 170, massKg: 1990 },
  { id: 'my-lr', name: 'Model Y Long Range', usableKWh: 75, whPerKm: 165, maxChargeKW: 250, massKg: 2050 },
  { id: 'my-p', name: 'Model Y Performance', usableKWh: 75, whPerKm: 180, maxChargeKW: 250, massKg: 2070 },
  { id: 'ms-lr', name: 'Model S Long Range', usableKWh: 95, whPerKm: 178, maxChargeKW: 250, massKg: 2150 },
  { id: 'ms-plaid', name: 'Model S Plaid', usableKWh: 95, whPerKm: 192, maxChargeKW: 250, massKg: 2190 },
  { id: 'mx-lr', name: 'Model X Long Range', usableKWh: 95, whPerKm: 210, maxChargeKW: 250, massKg: 2450 },
  { id: 'mx-plaid', name: 'Model X Plaid', usableKWh: 95, whPerKm: 222, maxChargeKW: 250, massKg: 2480 },
  { id: 'ct-awd', name: 'Cybertruck AWD', usableKWh: 123, whPerKm: 270, maxChargeKW: 325, massKg: 3100 },
];
export const vehicleById = (id: string) => VEHICLES.find((v) => v.id === id) || VEHICLES[1];

/** Aerodynamic/rolling factor vs average speed (1.0 ≈ 88 km/h). */
export const speedFactor = (kmh: number) => {
  const v = Math.max(5, Math.min(150, kmh));
  return 0.849 - 0.001067 * v + 3.667e-5 * v * v;
};
/** Cabin/battery heating below 20 °C, A/C above 27 °C. */
export const tempFactor = (t?: number) => (t === undefined ? 1 : t < 20 ? 1 + Math.min(0.4, 0.012 * (20 - t)) : t > 27 ? 1 + 0.006 * (t - 27) : 1);

export interface EnergyModel {
  /** Cumulative kWh from the route start to distance d (m). */
  at(d: number): number;
  total: number;
}

/**
 * Energy along a route: base consumption × speed factor (per step) × temperature factor,
 * plus potential energy from the elevation profile (climbs cost /0.9, descents recover ×0.65).
 */
export function energyModel(route: RouteResult, v: Vehicle, s: Settings, elevation?: ElevationProfile, tempC?: number): EnergyModel {
  const base = (s.consumption || v.whPerKm) * tempFactor(tempC);
  const avgKmh = (route.distance / Math.max(1, route.duration)) * 3.6;
  const stepSpeed = (d: number) => {
    for (let i = route.steps.length - 1; i >= 0; i--) {
      const st = route.steps[i];
      if (d >= st.startDist) return st.duration > 0 && st.distance > 200 ? (st.distance / st.duration) * 3.6 : avgKmh;
    }
    return avgKmh;
  };
  const N = Math.max(2, Math.min(240, Math.ceil(route.distance / 1500)));
  const ds: number[] = [];
  const es: number[] = [0];
  const total = route.cum[route.cum.length - 1];
  for (let i = 0; i <= N; i++) ds.push((total * i) / N);
  const hAt = elevation && elevation.samples.length > 1 ? (d: number) => interp(elevation.samples, d) : null;
  const g = 9.81;
  const mass = v.massKg + 120;
  for (let i = 1; i <= N; i++) {
    const d0 = ds[i - 1];
    const d1 = ds[i];
    const kmh = stepSpeed((d0 + d1) / 2);
    let kwh = ((d1 - d0) / 1000) * base * speedFactor(kmh) / 1000;
    if (hAt) {
      const dh = hAt(d1) - hAt(d0);
      const pe = (mass * g * dh) / 3.6e6;
      kwh += dh > 0 ? pe / 0.9 : pe * 0.65;
    }
    es.push(es[i - 1] + kwh);
  }
  // Scale so the model's distance matches the provider's reported distance.
  const scale = route.distance / Math.max(1, total);
  return {
    total: es[N] * scale,
    at: (d: number) => {
      if (d <= 0) return 0;
      if (d >= total) return es[N] * scale;
      const f = (d / total) * N;
      const i = Math.floor(f);
      return (es[i] + (es[i + 1] - es[i]) * (f - i)) * scale;
    },
  };
}

function interp(samples: { d: number; h: number }[], d: number): number {
  if (d <= samples[0].d) return samples[0].h;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].d >= d) {
      const a = samples[i - 1];
      const b = samples[i];
      return a.h + ((b.h - a.h) * (d - a.d)) / Math.max(1, b.d - a.d);
    }
  }
  return samples[samples.length - 1].h;
}

/** Minutes to charge from→to % at a station, with a typical Tesla taper curve. */
export function chargeMinutes(from: number, to: number, stationKW: number, v: Vehicle, usable: number): number {
  const peak = Math.min(stationKW > 0 ? stationKW : 50, v.maxChargeKW);
  let hours = 0;
  for (let soc = Math.floor(from); soc < Math.ceil(to); soc++) {
    const curve = soc < 10 ? 0.75 : soc < 40 ? 1 : soc < 80 ? 1 - (soc - 40) * 0.015 : Math.max(0.15, 0.4 - (soc - 80) * 0.0125);
    const kw = Math.min(peak, v.maxChargeKW * curve);
    hours += (usable / 100 / 0.92) / Math.max(5, kw);
  }
  return Math.round(hours * 60);
}

export interface PlanInput {
  route: RouteResult;
  model: EnergyModel;
  chargers: Place[];
  startSoc: number;
  vehicle: Vehicle;
  settings: Settings;
  skip: string[];
  elevation?: ElevationProfile;
  tempC?: number;
}

/**
 * Greedy charging-stop planner: drive as far as the reserve allows, prefer the most powerful
 * charger within the last 40 km of reach, charge just enough to finish (or to the max-charge cap),
 * repeat. Detour energy for off-route chargers is included.
 */
export function planTrip(inp: PlanInput): TripPlan {
  const { route, model, vehicle: v, settings: s } = inp;
  const usable = s.usableKWh || v.usableKWh;
  const reserve = s.reserveSoc;
  const total = route.cum[route.cum.length - 1];
  const pct = (kwh: number) => (kwh / usable) * 100;
  const socAfter = (fromD: number, fromSoc: number, toD: number) => fromSoc - pct(model.at(toD) - model.at(fromD));
  const perKm = model.total / Math.max(1, route.distance / 1000);

  const cands = inp.chargers
    .filter((c) => c.coord && inp.skip.indexOf(c.id) < 0)
    .map((c) => {
      const p = projectOnRoute(route.coords, route.cum, c.coord!);
      return p ? { place: c, d: p.d, detourKWh: (2 * p.offset / 1000) * perKm, power: c.charger?.powerKW || 0 } : null;
    })
    .filter((c): c is NonNullable<typeof c> => !!c && c.d > 3000 && c.d < total - 3000)
    .sort((a, b) => a.d - b.d);

  const stops: ChargeStop[] = [];
  let pos = 0;
  let soc = inp.startSoc;
  let feasible = true;
  let note: string | undefined;

  for (let guard = 0; guard < 6 && socAfter(pos, soc, total) < reserve; guard++) {
    const reachable = cands.filter((c) => c.d > pos + 5000 && socAfter(pos, soc, c.d) - pct(c.detourKWh / 2) >= reserve - 0.5);
    if (!reachable.length) {
      feasible = false;
      note = stops.length
        ? 'No charger within range after the last stop. Charge higher or choose another route.'
        : cands.length ? 'Not enough range to reach a charger. Charge before leaving.' : 'No chargers found along this route.';
      break;
    }
    const maxD = reachable[reachable.length - 1].d;
    const pool = reachable.filter((c) => c.d >= maxD - 40000);
    const pick = pool.reduce((b, c) => ((c.power || 50) > (b.power || 50) || ((c.power || 50) === (b.power || 50) && c.d > b.d) ? c : b));
    const arrive = socAfter(pos, soc, pick.d) - pct(pick.detourKWh / 2);
    const needToFinish = reserve + pct(model.at(total) - model.at(pick.d)) + pct(pick.detourKWh / 2) + 3;
    const target = Math.min(s.maxChargeSoc, Math.max(arrive + 10, needToFinish));
    stops.push({
      place: pick.place,
      distAlong: pick.d,
      arriveSoc: arrive,
      departSoc: target,
      chargeMinutes: chargeMinutes(arrive, target, pick.power, v, usable),
      powerKW: pick.power,
    });
    pos = pick.d;
    soc = target - pct(pick.detourKWh / 2);
  }

  const arrivalSoc = socAfter(pos, soc, total);
  if (feasible && arrivalSoc < reserve) feasible = false;

  // Legs between start, stops and destination.
  const marks = [0, ...stops.map((x) => x.distAlong), total];
  const legs = marks.slice(1).map((d, i) => {
    const d0 = marks[i];
    return { distance: d - d0, duration: route.duration * ((d - d0) / total), kWh: model.at(d) - model.at(d0) };
  });

  return {
    routeId: route.id,
    startSoc: inp.startSoc,
    kWh: model.total,
    arrivalSoc,
    totalDuration: route.duration + stops.reduce((a, x) => a + x.chargeMinutes * 60, 0),
    stops,
    legs,
    feasible,
    note,
    elevation: inp.elevation,
    tempC: inp.tempC,
  };
}

/**
 * Re-evaluate already chosen stops on a route that passes through them
 * (after re-routing via the chargers): arrival SoC, charge time, legs.
 */
export function evaluateStops(route: RouteResult, model: EnergyModel, chosen: ChargeStop[], startSoc: number, v: Vehicle, s: Settings, extra: { elevation?: ElevationProfile; tempC?: number } = {}): TripPlan {
  const usable = s.usableKWh || v.usableKWh;
  const pct = (kwh: number) => (kwh / usable) * 100;
  const total = route.cum[route.cum.length - 1];
  let pos = 0;
  let soc = startSoc;
  let feasible = true;
  const stops: ChargeStop[] = chosen.map((st, i) => {
    const d = route.waypointDists[i] !== undefined ? route.waypointDists[i] : st.distAlong;
    const arrive = soc - pct(model.at(d) - model.at(pos));
    if (arrive < 0) feasible = false;
    const depart = Math.max(st.departSoc, arrive);
    const out = { ...st, distAlong: d, arriveSoc: arrive, departSoc: depart, chargeMinutes: chargeMinutes(arrive, depart, st.powerKW, v, usable) };
    pos = d;
    soc = depart;
    return out;
  });
  const arrivalSoc = soc - pct(model.at(total) - model.at(pos));
  if (arrivalSoc < s.reserveSoc - 1) feasible = false;
  const marks = [0, ...stops.map((x) => x.distAlong), total];
  const legs = marks.slice(1).map((d, i) => ({ distance: d - marks[i], duration: route.duration * ((d - marks[i]) / total), kWh: model.at(d) - model.at(marks[i]) }));
  return {
    routeId: route.id, startSoc, kWh: model.total, arrivalSoc,
    totalDuration: route.duration + stops.reduce((a, x) => a + x.chargeMinutes * 60, 0),
    stops, legs, feasible,
    note: feasible ? undefined : 'Battery may run low on this plan — consider charging higher.',
    elevation: extra.elevation, tempC: extra.tempC,
  };
}

/** Quick arrival-SoC estimate for listing alternatives (no charger search). */
export function quickArrival(route: RouteResult, startSoc: number, v: Vehicle, s: Settings, tempC?: number): number {
  const m = energyModel(route, v, s, undefined, tempC);
  return startSoc - (m.total / (s.usableKWh || v.usableKWh)) * 100;
}

export const socClass = (soc: number) => (soc < 10 ? 'crit' : soc < 20 ? 'low' : '');

export const midpoint = (r: RouteResult) => pointAt(r.coords, r.cum, r.cum[r.cum.length - 1] / 2).coord;
