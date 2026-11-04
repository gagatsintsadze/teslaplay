import type { App } from '../app';
import { h, mount, setText, toggleClass } from '../core/dom';
import { distanceParts, durationParts, formatClock, formatDistance } from '../core/format';
import { shallowEqualArray } from '../core/store';
import type { NavSnapshot } from '../nav/session';
import { maneuverGlyph, maneuverVerb } from './glyph';
import { icon } from './icons';

/** Turn-by-turn HUD: maneuver banner (top), trip summary (bottom), status pills, arrival card. */
export function mountNavHud(app: App, hud: HTMLElement) {
  const { store } = app;
  const eq = shallowEqualArray as any;

  // ── maneuver banner ──
  const glyph = h('div.mv-glyph');
  const distV = h('span.num');
  const distU = h('small');
  const dist = h('div.mv-dist', null, distV, distU);
  const street = h('div.mv-street');
  const text = h('div.mv-text', null, dist, street);
  const main = h('div.mv-main', null, glyph, text);
  const thenGlyph = h('span');
  const thenText = h('span');
  const thenRow = h('div.mv-then', null, h('span', null, 'Then'), thenGlyph, thenText);
  const banner = h('section.maneuver.glass-ink', { 'aria-live': 'assertive' }, main, thenRow);

  // ── trip summary ──
  const arrV = h('div.trip-v.arr.num');
  const timeV = h('div.trip-v.num');
  const timeL = h('div.trip-l');
  const distV2 = h('div.trip-v.num');
  const distL = h('div.trip-l');
  const chev = h('span.trip-chev', null, icon('chevronUp', 20));
  const bar = h('button.trip-bar', { 'aria-label': 'Trip details' },
    h('div.trip-stats', null,
      h('div', null, arrV, h('div.trip-l', null, 'arrival')),
      h('div', null, timeV, timeL),
      h('div', null, distV2, distL),
    ),
    chev,
  );
  const socRow = h('div.trip-soc');
  const stopRow = h('div.trip-soc');
  const muteTile = h('button.tile.pressable', { onclick: () => app.toggleMute() });
  const tilt = h('button.tile.pressable', { onclick: () => app.updateSettings({ view3D: !store.get().settings.view3D }) });
  const simRow = h('div.sim-row');
  const extra = h('div.trip-extra', null,
    socRow, stopRow,
    h('div.trip-grid', null,
      h('button.tile.pressable', { onclick: () => { app.overview(); store.set({ tripOpen: false }); } }, icon('overview', 22), 'Overview'),
      muteTile, tilt,
    ),
    h('button.btn.btn-danger.btn-block.trip-end.pressable', { onclick: () => app.endNavigation() }, 'End Route'),
    simRow,
  );
  const trip = h('section.trip.glass', null, bar, extra);
  bar.addEventListener('click', () => store.set({ tripOpen: !store.get().tripOpen }));

  const pill = h('div.nav-pill.glass', null, h('span.spinner'), 'Rerouting…');
  const gpsPill = h('div.nav-pill.glass', null, icon('signal', 18), 'Searching for GPS…');
  let arrival: HTMLElement | null = null;
  let lastIdx = -1;
  let lastRoute = '';

  store.select((s) => s.navigating, (on) => {
    if (on) {
      hud.append(banner, trip);
      lastIdx = -1;
      mount(glyph);
      setText(distV, '');
      setText(distU, '');
      setText(street, 'Starting route…');
      thenRow.style.display = 'none';
    } else {
      banner.remove();
      trip.remove();
      pill.remove();
      gpsPill.remove();
      if (arrival) { arrival.remove(); arrival = null; }
    }
  });

  store.select((s) => s.nav, (n) => { if (n && !store.get().arrived) renderSnapshot(n); });

  function renderSnapshot(n: NavSnapshot) {
    const s = store.get();
    const m = n.maneuver;
    if (n.maneuverIndex !== lastIdx || n.routeId !== lastRoute) {
      lastIdx = n.maneuverIndex;
      lastRoute = n.routeId;
      mount(glyph, maneuverGlyph(m.type, m.angle));
      main.classList.remove('mv-swap');
      void main.offsetWidth;
      main.classList.add('mv-swap');
    }
    const [dv, du] = distanceParts(n.distToManeuver);
    setText(distV, dv);
    setText(distU, du);
    const label = m.type === 'arrive' ? (s.destination ? s.destination.name : 'Destination')
      : m.type === 'waypoint' ? (m.label || 'Charging stop')
        : m.street || maneuverVerb(m.type);
    setText(street, label);
    toggleClass(street, 'dim', !m.street && m.type !== 'arrive' && m.type !== 'waypoint');
    if (n.then) {
      thenRow.style.display = '';
      mount(thenGlyph, maneuverGlyph(n.then.type, n.then.angle));
      setText(thenText, n.then.type === 'arrive' ? 'Arrive' : n.then.street || maneuverVerb(n.then.type));
    } else thenRow.style.display = 'none';

    setText(arrV, formatClock(n.eta));
    const [tv, tu] = durationParts(n.timeRemaining);
    setText(timeV, tv);
    setText(timeL, tu);
    const [rv, ru] = distanceParts(n.remaining);
    setText(distV2, rv);
    setText(distL, ru);
  }

  // expanded trip details
  store.select((s) => [s.tripOpen, s.muted, s.settings.view3D, s.simulating, s.simSpeed, s.nav ? Math.round((s.nav.socNow || 0) * 2) : 0, s.nav && s.nav.nextStop ? s.nav.nextStop.name : ''], () => {
    const s = store.get();
    toggleClass(trip, 'open', s.tripOpen);
    mount(muteTile, icon(s.muted ? 'mute' : 'volume', 22), s.muted ? 'Unmute' : 'Mute');
    mount(tilt, icon('cube', 22), s.settings.view3D ? '2D view' : '3D view');
    const n = s.nav;
    if (n && n.socNow !== null) {
      mount(socRow, icon('battery', 18), 'Battery now ', h('b.num', null, `~${Math.round(Math.max(0, n.socNow))}%`), ' · at arrival ', h('b.num', null, `~${Math.round(Math.max(0, n.arrivalSoc || 0))}%`));
      socRow.style.display = '';
    } else socRow.style.display = 'none';
    if (n && n.nextStop) {
      mount(stopRow, icon('bolt', 18), 'Next charge ', h('b', null, n.nextStop.name), ` · ${formatDistance(n.nextStop.distance)}`);
      stopRow.style.display = '';
    } else stopRow.style.display = 'none';
    if (s.simulating) {
      mount(simRow, h('span', null, 'Simulated drive'), h('div.segmented', { style: { minWidth: '12rem' } },
        ...[1, 2, 4, 8].map((x) => h('button', { class: { on: s.simSpeed === x }, onclick: () => app.setSimSpeed(x) }, `${x}×`))));
      simRow.style.display = '';
    } else simRow.style.display = 'none';
  }, { equals: eq });

  // rerouting / GPS status
  store.select((s) => [s.navigating, s.rerouting, s.locStatus, s.simulating, s.fix ? Date.now() - s.fix.time > 15000 : true], () => {
    const s = store.get();
    if (s.navigating && s.rerouting) hud.appendChild(pill); else pill.remove();
    const lost = s.navigating && !s.simulating && !s.rerouting && (s.locStatus !== 'ok' || !s.fix || Date.now() - s.fix.time > 15000);
    if (lost) hud.appendChild(gpsPill); else gpsPill.remove();
  }, { equals: eq });

  // arrival card
  store.select((s) => s.arrived, (arrived) => {
    if (!arrived) { if (arrival) { arrival.remove(); arrival = null; } return; }
    const s = store.get();
    const soc = s.nav && s.nav.socNow !== null ? s.nav.socNow : null;
    trip.remove();
    arrival = h('section.arrival.glass', null,
      h('div.arrival-flag', null, icon('flag', 26)),
      h('div.arrival-title', null, 'Arrived'),
      h('div.arrival-sub', null, `${s.destination ? s.destination.name : 'Destination'} · ${formatClock(Date.now())}${soc !== null ? ` · ${Math.round(Math.max(0, soc))}% battery` : ''}`),
      h('button.btn.btn-primary.btn-block.pressable', { onclick: () => app.endNavigation() }, 'Done'),
    );
    hud.appendChild(arrival);
    mount(glyph, maneuverGlyph('arrive', 0));
    setText(distV, 'Arrived');
    setText(distU, '');
    setText(street, s.destination ? s.destination.name : 'Destination');
    toggleClass(street, 'dim', false);
    thenRow.style.display = 'none';
  });
}
