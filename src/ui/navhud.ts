import { laneSvg, turnSet, type TurnDir } from '../map/arrows';
import type { App } from '../app';
import { h, mount, setText, toggleClass } from '../core/dom';
import { distanceParts, durationParts, formatClock, formatDistance } from '../core/format';
import { shallowEqualArray } from '../core/store';
import type { NavSnapshot } from '../nav/session';
import { maneuverGlyph, maneuverVerb } from './glyph';
import { icon } from './icons';
import { segmented } from './segmented';

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
  const lanesRow = h('div.mv-lanes.hidden', { 'aria-hidden': 'true' });
  const lanePrompt = h('div.mv-lane-prompt.hidden', { role: 'status' });
  const banner = h('section.maneuver.glass.glass-lg.glass-dark', { 'aria-live': 'assertive' }, main, lanesRow, lanePrompt, thenRow);

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
  const extra = h('div.trip-extra', null, h('div.trip-inner', null,
    socRow, stopRow,
    h('div.trip-grid', null,
      h('button.tile.pressable', { onclick: () => { app.overview(); store.set({ tripOpen: false }); } }, icon('overview', 22), 'Overview'),
      muteTile, tilt,
    ),
    h('button.btn.btn-danger.btn-block.trip-end.pressable', { onclick: () => app.endNavigation() }, 'End Route'),
    simRow,
  ));
  const trip = h('section.trip.glass.glass-lg', null, bar, extra);
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
    // Lane guidance: from the lane plan (lanes of this road, allowed / recommended / the car's lane),
    // else Mapbox's lanes for the coming junction.
    const lg = n.lanes;
    const mb = m.lanes && m.lanes.length > 1 && n.distToManeuver < 1500 ? m.lanes : null;
    const show = lg ? lg.turns.length > 1 && (lg.toDeadline !== null || n.distToManeuver < 1500 || lg.current !== null) : !!mb;
    const laneSig = lg && show ? `p:${n.routeId}:${lg.allowed.join('')}:${lg.recommended}:${lg.current}:${lg.turns.map((t) => t.join('')).join('|')}` : mb ? `m:${n.routeId}:${n.maneuverIndex}` : '';
    if (lanesRow.dataset.sig !== laneSig) {
      lanesRow.dataset.sig = laneSig;
      toggleClass(lanesRow, 'hidden', !laneSig);
      if (lg && show) {
        mount(lanesRow, ...lg.turns.map((t, k) => {
          const ok = lg.allowed.includes(k);
          const rec = k === lg.recommended && lg.toDeadline !== null;
          const color = rec ? '#8fc3ff' : ok ? '#ffffff' : 'rgba(255,255,255,.32)';
          // an unmarked lane (no arrow painted: parking, bus, or simply unknown) is shown as a plain lane
          const icon = t.length ? laneSvg(turnSet(t) as TurnDir[], color) : `<svg viewBox="0 0 40 80" width="22" height="44" aria-hidden="true"><path d="M20 14v52" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="10 10" fill="none"/></svg>`;
          return h('div.mv-lane', { class: { ok, rec, here: lg.current === k } }, h('span', { html: icon }), h('i.mv-lane-car'));
        }));
      } else if (mb) {
        mount(lanesRow, ...mb.map((l) => h('div.mv-lane', { class: { ok: l.valid }, html: laneSvg(l.dirs as TurnDir[], l.valid ? '#ffffff' : 'rgba(255,255,255,.32)') })));
      }
    }
    const pr = lg && lg.prompt;
    const prSig = pr ? `${pr.dir}${pr.lanes}${pr.urgent}` : '';
    if (lanePrompt.dataset.sig !== prSig) {
      lanePrompt.dataset.sig = prSig;
      toggleClass(lanePrompt, 'hidden', !pr);
      toggleClass(lanePrompt, 'urgent', !!pr && pr.urgent);
      if (pr) setText(lanePrompt, `${pr.dir === 'left' ? '←' : '→'} ${pr.urgent ? 'Wrong lane — ' : ''}Move ${pr.lanes === 1 ? 'one lane' : `${pr.lanes} lanes`} ${pr.dir}`);
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
      const jump = h('input.sim-jump', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(s.nav && s.navRoute ? (s.nav.progress / Math.max(1, s.navRoute.distance)) * 100 : 0)), 'aria-label': 'Jump to a point of the route' }) as HTMLInputElement;
      jump.addEventListener('change', () => app.setSimProgress(Number(jump.value) / 100));
      mount(simRow, h('span', null, 'Simulated drive'),
        segmented('sim-speed', s.simSpeed, [1, 2, 4, 8].map((x) => [x, `${x}×`] as [number, string]), (x) => app.setSimSpeed(x), { style: { minWidth: '12rem' } }),
        h('label.sim-jump-row', null, h('span', null, 'Jump to'), jump, h('span.sim-jump-val', null, `${jump.value}%`)));
      jump.addEventListener('input', () => { (jump.nextElementSibling as HTMLElement).textContent = `${jump.value}%`; });
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
    arrival = h('section.arrival.glass.glass-lg', null,
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
