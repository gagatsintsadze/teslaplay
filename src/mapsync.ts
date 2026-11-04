import type { App } from './app';
import { slice } from './core/geo';
import { shallowEqualArray } from './core/store';
import type { MarkerSpec, RouteLine } from './map/engine';
import { chargerMarker, cityLabel, pinMarker } from './map/markers';
import { CORRIDOR } from './services/demo-data';
import type { Place } from './types';
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
  const renderRoutes = () => {
    const s = store.get();
    const lines: RouteLine[] = [];
    if (s.navigating && s.navRoute) {
      const r = s.navRoute;
      const p = s.nav ? s.nav.progress : 0;
      lines.push({ id: 'nav', coords: slice(r.coords, r.cum, p, r.cum[r.cum.length - 1]), role: 'primary' });
      drawnAt = p;
    } else if (s.panel === 'planner') {
      s.routes.forEach((r, i) => { if (i !== s.routeIndex) lines.push({ id: r.id, coords: r.coords, role: 'alternative' }); });
      const sel = s.routes[s.routeIndex];
      if (sel) lines.push({ id: sel.id, coords: sel.coords, role: 'primary' });
    }
    engine.setRoutes(lines);
  };
  store.select((s) => [s.navigating, s.navRoute, s.panel, s.routes, s.routeIndex, s.theme], renderRoutes, { equals: eq });
  store.select((s) => (s.nav ? s.nav.progress : 0), (p) => {
    if (store.get().navigating && Math.abs(p - drawnAt) > 30) renderRoutes();
  });

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
