import type { App } from '../app';
import { h, svg } from '../core/dom';
import { formatClock, formatDistance, formatDuration, formatElevation, formatKWh } from '../core/format';
import { vehicleById } from '../services/ev';
import type { ElevationProfile, RouteResult, TripPlan } from '../types';
import { badge, closeButton, socBar } from './common';
import { icon, weatherIcon } from './icons';

const pct = (v: number) => `${Math.round(v)}%`;

export function plannerView(app: App): Node[] {
  const s = app.state;
  const dest = s.destination!;
  const nodes: Node[] = [];

  nodes.push(h('div.view-head', null,
    h('div.grow', null, h('div.view-title', null, 'Directions'), h('div.view-sub', null, vehicleById(s.settings.vehicleId).name)),
    closeButton(() => app.store.set({ panel: 'place', place: dest, routes: [], plan: null, chargers: [] }), 'Close directions'),
  ));

  nodes.push(h('div.od', null,
    h('div.od-line'),
    h('div.row', null, h('div.od-dot', null, h('i')), h('div.row-main', null, h('div.row-title', null, 'My Location'), h('div.row-sub', null, s.locStatus === 'ok' ? 'Current position' : 'Map centre (no GPS)'))),
    h('div.row', null, h('div.od-dot', { style: { color: 'var(--red)' } }, icon('pin', 22)), h('div.row-main', null, h('div.row-title', null, dest.name), dest.subtitle ? h('div.row-sub', null, dest.subtitle) : null)),
  ));

  nodes.push(h('div.opt-row', null,
    h('button.toggle-chip.pressable', { class: { on: s.settings.avoidTolls }, onclick: () => app.updateSettings({ avoidTolls: !s.settings.avoidTolls }) },
      icon(s.settings.avoidTolls ? 'check' : 'cash', 16), 'Avoid tolls'),
    h('button.toggle-chip.pressable', { onclick: () => app.store.set({ settingsOpen: true }) }, icon('gear', 16), 'Vehicle'),
  ));

  if (s.routing) {
    nodes.push(h('div.loading-block', null, h('span.spinner'), 'Finding the best routes…'));
    return nodes;
  }
  if (s.routeError) {
    nodes.push(h('div.error-block', null, s.routeError), h('button.btn.btn-tinted.btn-block.pressable', { style: { marginTop: '.75rem' }, onclick: () => app.computeRoutes() }, 'Try again'));
    return nodes;
  }

  nodes.push(h('div.routes.stagger', null, ...s.routes.map((r, i) => routeOption(app, r, i))));
  nodes.push(evCard(app));
  const elev = s.plan && s.plan.elevation;
  // Only worth showing when the terrain actually matters to range.
  if (elev && elev.ascent + elev.descent > 60 && s.routes[s.routeIndex] && s.routes[s.routeIndex].distance > 8000) nodes.push(elevationCard(elev));
  if (s.weatherDest) {
    const w = s.weatherDest;
    nodes.push(h('div.alert', { class: { warn: w.severe } },
      h('div.glyph', { style: { background: w.severe ? 'var(--orange)' : 'var(--teal)', width: '2.25rem', height: '2.25rem' } }, icon(weatherIcon(w.code, w.isDay), 18)),
      h('div.alert-text', null, h('b', null, w.label), ` at destination · ${Math.round(w.tempC)}°`),
    ));
  }
  return nodes;
}

/** Live traffic (Mapbox): delay against a normal day, or "Light traffic". */
function trafficBadge(r: RouteResult) {
  if (!r.trafficAware) return null;
  const delay = r.durationTypical ? r.duration - r.durationTypical : 0;
  const slow = (r.traffic || []).reduce((a, t) => a + (t.to - t.from), 0);
  if (delay >= 120) return badge(`+${Math.round(delay / 60)} min traffic`, delay >= 600 ? 'red' : 'orange');
  if (slow > 1500) return badge('Some traffic', 'orange');
  return badge('Light traffic', 'green');
}

function routeOption(app: App, r: RouteResult, i: number) {
  const s = app.state;
  const sel = i === s.routeIndex;
  const plan = sel && s.plan && s.plan.routeId === r.id ? s.plan : null;
  const total = plan ? plan.totalDuration : r.duration;
  const soc = plan ? plan.arrivalSoc : s.quickSoc[i];
  const fastest = s.routes.every((o) => o.duration >= r.duration - 1);
  return h('button.route-opt', { class: { sel }, onclick: () => app.selectRoute(i), 'aria-pressed': sel ? 'true' : 'false' },
    h('div.route-top', null,
      h('span.route-time.num', null, formatDuration(r.duration)),
      h('span.route-arrive.num', null, `Arrive ${formatClock(Date.now() + total * 1000)}`),
    ),
    h('div.route-meta', null,
      h('span.num', null, formatDistance(r.distance)),
      r.via ? [h('span.dot'), h('span', null, `via ${r.via}`)] : null,
      fastest && s.routes.length > 1 ? badge('Fastest', 'green') : null,
      trafficBadge(r),
      r.hasTolls ? badge('Tolls', 'orange') : null,
      plan && plan.stops.length ? badge(`${plan.stops.length} charging stop${plan.stops.length > 1 ? 's' : ''}`, 'blue') : null,
    ),
    soc !== undefined ? h('div.route-batt', null, icon('battery', 18), socBar(soc), h('span.soc-val.num', null, pct(Math.max(0, soc)))) : null,
  );
}

function evCard(app: App) {
  const s = app.state;
  const plan = s.plan;
  const busy = s.planBusy || !plan;
  const tone = (v: number) => (v < 10 ? 'crit' : v < 20 ? 'low' : '');
  // Slider: label follows the finger; the trip is re-planned when it's released.
  const socLabel = h('span.ev-soc.num', null, pct(s.battery));
  const slider = h('input.slider.ev-slider', { type: 'range', min: '5', max: '100', step: '1', value: String(Math.round(s.battery)), 'aria-label': 'Battery now' }) as HTMLInputElement;
  const paint = () => {
    const v = +slider.value;
    slider.style.setProperty('--val', `${((v - 5) / 95) * 100}%`);
    slider.classList.remove('low', 'crit');
    const t = tone(v);
    if (t) slider.classList.add(t);
    socLabel.textContent = pct(v);
    socLabel.style.color = t === 'crit' ? 'var(--red)' : t === 'low' ? 'var(--orange)' : '';
  };
  slider.addEventListener('input', paint);
  slider.addEventListener('change', () => app.setBattery(+slider.value));
  paint();
  const reserve = s.settings.reserveSoc;

  const stat = (label: string, value: Node | string, unit?: string) =>
    h('div.stat', null, h('div.stat-label', null, label), h('div.stat-value.num', null, value, unit ? h('small', null, unit) : null));
  const skel = () => h('div.stat', null, h('div.skeleton', { style: { height: '.75rem', width: '60%' } }), h('div.skeleton', { style: { height: '1.25rem', width: '80%', marginTop: '.4rem' } }));

  const chargeText = plan
    ? plan.stops.length
      ? formatDuration(plan.stops.reduce((a, x) => a + x.chargeMinutes * 60, 0))
      : 'None'
    : '';

  return h('div.ev', null,
    h('div.ev-head', null,
      h('div.ev-title', null, icon('bolt', 18), 'Battery now'),
      socLabel,
    ),
    slider,
    h('div.ev-stats', null, ...(busy
      ? [skel(), skel(), skel()]
      : [
        stat('Energy', formatKWh(plan!.kWh), 'kWh'),
        stat('Arrive', h('span', { style: { color: plan!.arrivalSoc < reserve ? 'var(--red)' : plan!.arrivalSoc < 20 ? 'var(--orange)' : 'var(--green)' } }, pct(Math.max(0, plan!.arrivalSoc)))),
        stat('Charging', chargeText),
      ])),
    plan && plan.note ? h('div.ev-note.warn', null, icon('warning', 16), plan.note) : null,
    plan && !plan.note && plan.tempC !== undefined && plan.tempC < 8 ? h('div.ev-note', null, icon('info', 16), `Cold weather (${Math.round(plan.tempC)}°) — estimate includes heating.`) : null,
    plan && plan.stops.length ? timeline(app, plan) : null,
  );
}

function timeline(app: App, plan: TripPlan) {
  const s = app.state;
  const dest = s.destination!;
  let clock = Date.now();
  const items: Node[] = [];
  items.push(h('div.tl', null,
    h('div.tl-rail', null, h('div.tl-node.start', null, icon('locate', 14))),
    h('div.tl-body', null, h('div.tl-top', null, h('div.tl-name', null, 'My Location'), h('div.tl-soc.num', null, pct(plan.startSoc)))),
  ));
  plan.stops.forEach((st, i) => {
    const leg = plan.legs[i];
    clock += leg.duration * 1000;
    items.push(h('div.tl-leg.num', null, `${formatDuration(leg.duration)} · ${formatDistance(leg.distance)} · ${formatKWh(leg.kWh)} kWh`));
    const c = st.place.charger;
    const detail = [`Arrive ${pct(st.arriveSoc)}`, c && c.connectors.length ? c.connectors.slice(0, 2).join('/') : null, st.powerKW ? `${Math.round(st.powerKW)} kW` : 'Power unknown'].filter(Boolean).join(' · ');
    items.push(h('div.tl', null,
      h('div.tl-rail', null, h('div.tl-node.charge', null, icon('bolt', 14))),
      h('div.tl-body', null,
        h('div.tl-top', null, h('div.tl-name', null, st.place.name), h('span.charge-badge.num', null, `${st.chargeMinutes} min → ${pct(st.departSoc)}`)),
        h('div.tl-sub.num', null, `${detail} · ${formatClock(clock)}`),
        h('div.tl-actions', null, h('button.tl-link', { onclick: () => app.skipCharger(st.place.id) }, 'Skip this charger')),
      ),
    ));
    clock += st.chargeMinutes * 60000;
  });
  const last = plan.legs[plan.legs.length - 1];
  clock += last.duration * 1000;
  items.push(h('div.tl-leg.num', null, `${formatDuration(last.duration)} · ${formatDistance(last.distance)} · ${formatKWh(last.kWh)} kWh`));
  items.push(h('div.tl', null,
    h('div.tl-rail', null, h('div.tl-node.end', null, icon('flag', 13))),
    h('div.tl-body', null,
      h('div.tl-top', null, h('div.tl-name', null, dest.name), h('div.tl-soc.num', { style: { color: plan.arrivalSoc < s.settings.reserveSoc ? 'var(--red)' : '' } }, pct(Math.max(0, plan.arrivalSoc)))),
      h('div.tl-sub.num', null, `Arrive ${formatClock(clock)}`),
    ),
  ));
  return h('div.timeline', null, ...items);
}

function elevationCard(e: ElevationProfile) {
  const W = 300;
  const H = 56;
  const xs = e.samples.map((p) => p.d);
  const ys = e.samples.map((p) => p.h);
  const maxD = xs[xs.length - 1] || 1;
  const minH = Math.min(...ys);
  const maxH = Math.max(...ys);
  const span = Math.max(30, maxH - minH);
  const pts = e.samples.map((p) => [(p.d / maxD) * W, H - 4 - ((p.h - minH) / span) * (H - 10)]);
  const line = 'M' + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L');
  const area = `${line}L${W} ${H}L0 ${H}Z`;
  const chart = svg(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="elev-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#elev-g)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`);
  return h('div.elev', null,
    h('div.elev-head', null,
      icon('mountain', 16),
      h('span.grow', null, 'Elevation'),
      h('span.num', null, '↑ ', h('b', null, formatElevation(e.ascent)), ' · ↓ ', h('b', null, formatElevation(e.descent)), ' · max ', h('b', null, formatElevation(maxH))),
    ),
    chart,
  );
}

export function plannerFooter(app: App): Node[] {
  const s = app.state;
  const ready = !s.routing && !s.routeError && s.routes.length > 0;
  const showSim = s.settings.devTools || s.demo;
  return [h('div.go-row', null,
    h('button.btn.btn-go.pressable', { disabled: !ready || s.planBusy, onclick: () => app.startNavigation() }, s.planBusy ? 'Planning…' : 'Go'),
    showSim && !s.demo ? h('button.btn.btn-plain.pressable', { disabled: !ready, onclick: () => app.startNavigation(true), style: { minHeight: 'var(--tap-lg)' } }, icon('play', 18), 'Simulate') : null,
  )];
}
