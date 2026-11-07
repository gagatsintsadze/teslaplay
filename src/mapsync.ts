import type { App } from './app';
import { simplify, slice } from './core/geo';
import { shallowEqualArray } from './core/store';
import type { MarkerSpec, RouteLine } from './map/engine';
import { chargerMarker, cityLabel, pinMarker } from './map/markers';
import { CORRIDOR } from './services/demo-data';
import type { LngLat, Place, RouteResult } from './types';
import { categoryById } from './ui/icons';

/** Keeps the map (routes, pins, insets) in sync with app state. */
export function bindMap(app: App) {
  const { store, engine } = app;
  const eq = shallowEqualArray as (a: unknown[], b: unknown[]) => boolean;

  // ── markers ──
  const renderMarkers = () => {
    const s = store.get();
    const results: MarkerSpec[] = [];
    if (!s.navigating && s.panel === 'search' && s.results) {
      s.results.places.forEach((p, i) => {
        if (!p.coord) return;
        results.push({ id: p.id, coord: p.coord, el: markerFor(p, i < 8, () => app.openPlace(p)), z: 1300 - i });
      });
    }
    engine.setMarkers('results', results);

    const sel: MarkerSpec[] = [];
    if (!s.navigating && s.panel === 'place' && s.place && s.place.coord) {
      const p = s.place;
      sel.push({ id: 'sel:' + p.id, coord: p.coord!, el: markerFor(p, false, undefined, true), z: 1500 });
    }
    engine.setMarkers('place', sel);

    const trip: MarkerSpec[] = [];
    const dest = s.destination;
    if ((s.panel === 'planner' || s.navigating) && dest && dest.coord) {
      trip.push({ id: 'dest', coord: dest.coord, el: pinMarker({ color: 'var(--red)', icon: 'flag', large: true }), z: 1600 });
      const planned = new Set((s.plan ? s.plan.stops : []).map((st) => st.place.id));
      (s.plan ? s.plan.stops : []).forEach((st) => {
        trip.push({ id: 'stop:' + st.place.id, coord: st.place.coord!, el: chargerMarker({ powerKW: st.powerKW, planned: true }), z: 1550 });
      });
      if (!s.navigating) {
        s.chargers.forEach((c) => {
          if (planned.has(c.id) || !c.coord) return;
          trip.push({
            id: 'ch:' + c.id, coord: c.coord, z: 1400,
            el: chargerMarker({ powerKW: c.charger ? c.charger.powerKW : 0, dim: true, onTap: () => app.toast(`${c.name}${c.charger && c.charger.powerKW ? ` · ${Math.round(c.charger.powerKW)} kW` : ''}`) }),
          });
        });
      }
    }
    engine.setMarkers('trip', trip);
  };
  store.select((s) => [s.panel, s.results, s.place, s.destination, s.plan, s.chargers, s.navigating], renderMarkers, { equals: eq });

  if (app.cfg.demo) {
    engine.setMarkers('cities', CORRIDOR.slice(1).map((c) => ({ id: c.name, coord: c.at, el: cityLabel(c.name), z: 5 })));
  }

  // ── route lines ──
  let drawnAt = -1e9;
  // Live-traffic slow stretches of a route from distance `from` on, as drawable pieces.
  // Pieces of the drawn route with the lane-band width they run in (quantised to 0.5 m), from `from` on.
  const parts = (r: RouteResult, from = 0) => {
    const { coords, widths } = app.drawGeometry(r);
    const end = r.cum[r.cum.length - 1];
    if (!widths.length) return [{ coords: slice(coords, r.cum, from, end), w: 0 }];
    const out: { coords: LngLat[]; w: number }[] = [];
    const q = (i: number) => Math.round(widths[i] * 2) / 2;
    let start = Math.max(0, from);
    let i = 0;
    while (i < r.cum.length && r.cum[i] <= start) i++;
    let w = q(Math.max(0, i - 1));
    for (; i < r.cum.length; i++) {
      const wi = q(i);
      if (wi !== w && r.cum[i] > start + 1) {
        const d = Math.min(end, r.cum[i]);
        out.push({ coords: slice(coords, r.cum, start, d), w });
        start = d; w = wi;
      }
    }
    if (end > start) out.push({ coords: slice(coords, r.cum, start, end), w });
    return out;
  };
  const widthAt = (r: RouteResult, d: number) => { const { widths } = app.drawGeometry(r); if (!widths.length) return 0; let i = 0; while (i < r.cum.length - 1 && r.cum[i + 1] < d) i++; return widths[i] || 0; };
  const slowParts = (r: RouteResult, from = 0) => (r.traffic || [])
    .filter((t) => t.to > from + 1)
    .map((t) => ({ coords: slice(app.drawCoords(r), r.cum, Math.max(t.from, from), t.to), level: t.level, w: widthAt(r, Math.max(t.from, from)) }));
  const renderRoutes = () => {
    const s = store.get();
    const lines: RouteLine[] = [];
    if (s.navigating && s.navRoute) {
      const r = s.navRoute;
      const p = s.nav ? s.nav.progress : 0;
      lines.push({ id: 'nav', coords: slice(app.drawCoords(r), r.cum, p, r.cum[r.cum.length - 1]), role: 'primary', parts: parts(r, p), traffic: slowParts(r, p) });
      drawnAt = p;
    } else if (s.panel === 'planner') {
      s.routes.forEach((r, i) => { if (i !== s.routeIndex) lines.push({ id: r.id, coords: app.drawCoords(r), role: 'alternative', parts: parts(r) }); });
      const sel = s.routes[s.routeIndex];
      if (sel) lines.push({ id: sel.id, coords: app.drawCoords(sel), role: 'primary', parts: parts(sel), traffic: slowParts(sel) });
    }
    engine.setRoutes(lines);
  };
  store.select((s) => [s.navigating, s.navRoute, s.panel, s.routes, s.routeIndex, s.theme, s.roadsVersion], renderRoutes, { equals: eq });
  store.select((s) => (s.nav ? s.nav.progress : 0), (p) => {
    if (store.get().navigating && Math.abs(p - drawnAt) > 30) renderRoutes();
  });

  // ── driving overlays: ghost buildings on the road ahead, white arrow through the next turn ──
  if (engine.setNavOverlay) {
    const TURNS = new Set(['left', 'right', 'slight-left', 'slight-right', 'sharp-left', 'sharp-right', 'uturn', 'keep-left', 'keep-right', 'roundabout', 'exit-left', 'exit-right', 'fork-left', 'fork-right']);
    let last = '';
    store.select((s) => {
      if (!s.navigating || !s.navRoute || !s.nav) return 'off';
      const n = s.nav;
      const near = n.distToManeuver < 380 && TURNS.has(n.maneuver.type);
      return `${n.routeId}|${Math.floor(n.progress / 120)}|${near ? n.maneuverIndex : -1}`;
    }, (key) => {
      if (key === last) return;
      last = key;
      const s = store.get();
      if (key === 'off' || !s.navRoute || !s.nav) { engine.setNavOverlay!({ ahead: null, maneuver: null }); return; }
      const r = s.navRoute;
      const end = r.cum[r.cum.length - 1];
      const p = s.nav.progress;
      const ahead = simplify(slice(r.coords, r.cum, Math.max(0, p - 30), Math.min(end, p + 900)), 4);
      const m = s.nav.maneuver;
      const near = s.nav.distToManeuver < 380 && TURNS.has(m.type);
      const maneuver = near ? simplify(slice(app.drawCoords(r), r.cum, Math.max(0, m.at - 38), Math.min(end, m.at + 28)), 0.8) : null;
      engine.setNavOverlay!({ ahead, maneuver });
    });
  }

  // ── insets ──
  const pad = () => engine.setPadding(app.padding());
  store.select((s) => [s.panel, s.collapsed, s.navigating, s.settings.driverSide, s.settings.textSize], () => requestAnimationFrame(pad), { equals: eq, immediate: false });
  app.layoutListeners.push(() => { pad(); renderRoutes(); });
  requestAnimationFrame(pad);
}

function markerFor(p: Place, label: boolean, onTap?: () => void, large = false): HTMLElement {
  if (p.kind === 'charger' || p.charger) {
    return chargerMarker({ powerKW: p.charger ? p.charger.powerKW : 0, planned: large, onTap });
  }
  const cat = categoryById(p.category);
  const color = p.kind === 'pin' ? 'var(--red)' : cat ? cat.color : p.kind === 'city' ? 'var(--indigo)' : 'var(--red)';
  const ic = cat ? cat.icon : p.kind === 'pin' ? 'pinDrop' : 'pin';
  return pinMarker({ color, icon: ic, label: label ? p.name : undefined, large, selected: large, onTap });
}
