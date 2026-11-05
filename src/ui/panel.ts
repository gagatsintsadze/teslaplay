import type { App } from '../app';
import { h, mount, toggleClass } from '../core/dom';
import { formatDistance, formatDuration } from '../core/format';
import { distance } from '../core/geo';
import { shallowEqualArray } from '../core/store';
import type { Place } from '../types';
import { backButton, closeButton, glyphFor, placeRow, section } from './common';
import { CATEGORIES, icon } from './icons';
import { plannerFooter, plannerView } from './planner';

/** The driver-side card: search, favorites, results, place details and the route planner. */
export function mountPanel(app: App, hud: HTMLElement) {
  const { store } = app;
  const input = h('input', { type: 'search', placeholder: 'Search Maps', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Search' }) as HTMLInputElement;
  const clear = h('button.icon-btn.sm', { 'aria-label': 'Clear search', style: { display: 'none' } }, icon('close', 14));
  const field = h('label.field', null, icon('search', 20), input, clear);
  const cancel = h('button.cancel', null, 'Cancel');
  const bar = h('div.search', null, field, cancel);
  // Search stays pinned above the scrolling content; content dissolves under the edges
  // (scroll edge effect) instead of sitting behind divider lines.
  const head = h('div.panel-head', null, bar);
  const body = h('div.panel-body');
  const scroll = h('div.panel-scroll.scroll-edge', null, body);
  const foot = h('div.panel-foot');
  const el = h('section.panel.glass.glass-lg', { 'aria-label': 'Search and directions' }, head, scroll, foot);
  hud.appendChild(el);

  const edges = () => {
    const max = scroll.scrollHeight - scroll.clientHeight;
    toggleClass(scroll, 'se-t', scroll.scrollTop > 2);
    toggleClass(scroll, 'se-b', max - scroll.scrollTop > 2);
  };
  scroll.addEventListener('scroll', edges, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(edges).observe(body);

  input.addEventListener('focus', () => {
    if (store.get().panel !== 'search') app.openSearch();
    if (input.value) input.select();
  });
  input.addEventListener('input', () => app.setQuery(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = store.get().suggestions[0];
      if (first) { input.blur(); app.openPlace(first); }
    } else if (e.key === 'Escape') { input.blur(); app.cancelSearch(); }
  });
  clear.addEventListener('click', (e) => { e.preventDefault(); input.value = ''; app.setQuery(''); input.focus(); });
  cancel.addEventListener('click', () => { input.value = ''; input.blur(); app.cancelSearch(); });
  field.addEventListener('click', () => { if (store.get().collapsed) app.expandPanel(); });

  // Chrome state: compact / hidden / which header
  store.select((s) => [s.panel, s.collapsed, s.navigating, s.query], () => {
    const s = store.get();
    toggleClass(el, 'hidden', s.navigating);
    toggleClass(el, 'compact', s.panel === 'home' && s.collapsed);
    head.hidden = !(s.panel === 'home' || s.panel === 'search');
    cancel.style.display = s.panel === 'search' ? '' : 'none';
    clear.style.display = s.query ? '' : 'none';
    if (s.panel !== 'search' && input.value) input.value = '';
    if (s.panel === 'search' && input.value !== s.query) input.value = s.query;
  }, { equals: shallowEqualArray as any });

  // Body: re-rendered only when its inputs change
  let lastPanel = '';
  store.select((s) => [
    s.panel, s.collapsed, s.home, s.work, s.favorites, s.recents, s.suggestions, s.results, s.searching, s.query === '',
    s.place, s.placeEta, s.destination, s.routes, s.routeIndex, s.routing, s.routeError, s.plan, s.planBusy,
    s.battery, s.quickSoc, s.weatherDest, s.settings, s.skipped, s.demo,
  ], () => {
    const s = store.get();
    const keepScroll = s.panel === lastPanel ? scroll.scrollTop : 0;
    const views: Record<string, () => Node[]> = {
      home: () => homeView(app),
      search: () => searchView(app),
      place: () => (s.place ? placeView(app, s.place) : []),
      planner: () => plannerView(app),
    };
    const nodes = views[s.panel]();
    const wrap = h('div', { class: s.panel !== lastPanel ? 'view-enter' : '' }, ...nodes);
    mount(body, wrap);
    if (s.panel === 'planner') { foot.style.display = ''; mount(foot, plannerFooter(app)); }
    else { foot.style.display = 'none'; mount(foot); }
    scroll.scrollTop = keepScroll;
    lastPanel = s.panel;
    edges();
  }, { equals: shallowEqualArray as any });
}

function homeView(app: App): Node[] {
  const s = app.state;
  if (s.collapsed) return [];
  const here = app.here();
  const tile = (label: string, sub: string, color: string, ic: string, onTap: () => void) =>
    h('button.fav.pressable', { onclick: onTap },
      h('div.glyph', { style: { background: color } }, icon(ic, 24)),
      h('div.fav-label', null, label),
      h('div.fav-sub', null, sub),
    );
  const savedHint = (what: string) => () => { app.openSearch(); app.toast(`Find your ${what} address, then tap “${what === 'home' ? 'Home' : 'Work'}” on its card.`, 'info', 5000); };
  const distTo = (p: Place | null) => (p && p.coord ? formatDistance(distance(here, p.coord)) : 'Add');

  const nodes: Node[] = [];
  if (s.demo) {
    nodes.push(h('div.alert', { style: { marginTop: '.25rem' } },
      h('div.glyph', { style: { background: 'var(--indigo)', width: '2.25rem', height: '2.25rem' } }, icon('info', 18)),
      h('div.alert-text', null, h('b', null, 'Demo mode'), ' — sample places, routes and chargers. Try “Batumi” or “Axis”.'),
    ));
  }
  nodes.push(section('Favorites', undefined,
    h('div.favs', null,
      tile('Home', distTo(s.home), 'var(--blue)', 'house', s.home ? () => app.directions(s.home!) : savedHint('home')),
      tile('Work', distTo(s.work), '#a2845e', 'briefcase', s.work ? () => app.directions(s.work!) : savedHint('work')),
      tile('Chargers', 'Nearby', 'var(--green)', 'bolt', () => app.runCategory(CATEGORIES[0])),
      tile('Saved', String(s.favorites.length || 'None'), 'var(--orange)', 'star', () => app.showSaved()),
    ),
  ));
  nodes.push(section('Find Nearby', undefined, categoryChips(app)));
  if (s.recents.length) {
    nodes.push(section('Recents', { text: 'Clear', onTap: () => app.clearRecents() },
      h('div.list.stagger', null, ...s.recents.slice(0, 8).map((p) =>
        placeRow({ ...p, distance: p.coord ? distance(here, p.coord) : undefined }, () => app.openPlace(p), {
          glyph: h('div.glyph.soft', null, icon('clock', 20)),
        }))),
    ));
  }
  return nodes;
}

function categoryChips(app: App) {
  return h('div.chips', null, ...CATEGORIES.map((c) =>
    h('button.chip.pressable', { onclick: () => app.runCategory(c) },
      h('span.chip-ic', { style: { background: c.color } }, icon(c.icon, 16)),
      c.label,
    )));
}

function searchView(app: App): Node[] {
  const s = app.state;
  if (s.results) {
    const r = s.results;
    return [
      h('div.view-head', null,
        backButton(() => app.store.set({ results: null, panel: s.query ? 'search' : 'home' })),
        h('div.grow', null, h('div.view-title', { style: { fontSize: '1.375rem' } }, r.title), h('div.view-sub', null, s.searching ? 'Searching…' : `${r.places.length} ${r.places.length === 1 ? 'result' : 'results'}`)),
      ),
      s.searching && !r.places.length ? loading('Searching nearby…') :
        r.places.length ? h('div.list.stagger', null, ...r.places.map((p) => placeRow(p, () => app.openPlace(p)))) :
          empty('Nothing found nearby'),
    ];
  }
  if (s.query) {
    if (s.searching && !s.suggestions.length) return [loading('Searching…')];
    if (!s.suggestions.length) return [empty('No results', 'Try a different spelling or a nearby city.')];
    return [h('div.list', { style: { marginTop: '.25rem' } }, ...s.suggestions.map((p) => placeRow(p, () => app.openPlace(p))))];
  }
  const here = app.here();
  return [
    section('Find Nearby', undefined, categoryChips(app)),
    s.recents.length ? section('Recents', { text: 'Clear', onTap: () => app.clearRecents() },
      h('div.list', null, ...s.recents.slice(0, 10).map((p) => placeRow({ ...p, distance: p.coord ? distance(here, p.coord) : undefined }, () => app.openPlace(p), {
        glyph: h('div.glyph.soft', null, icon('clock', 20)),
      })))) : null,
  ].filter(Boolean) as Node[];
}

function placeView(app: App, p: Place): Node[] {
  const s = app.state;
  const here = app.here();
  const dist = p.coord ? distance(here, p.coord) : undefined;
  const eta = s.placeEta && s.placeEta.placeId === p.id ? s.placeEta : null;
  const fav = app.isFavorite(p);
  const isHome = !!(s.home && s.home.id === p.id);
  const isWork = !!(s.work && s.work.id === p.id);
  const subtitle = [p.subtitle, dist !== undefined ? formatDistance(dist) : null].filter(Boolean).join(' · ');

  const tile = (label: string, ic: string, on: boolean, onTap: () => void) =>
    h('button.tile.pressable', { class: { on }, onclick: onTap }, icon(ic, 22), label);

  const share = () => {
    if (!p.coord) return;
    const url = `https://yandex.com/maps/?pt=${p.coord[0].toFixed(6)},${p.coord[1].toFixed(6)}&z=17&l=map`;
    const done = () => app.toast('Link copied', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => app.toast(url, 'info', 6000));
    else app.toast(url, 'info', 6000);
  };

  const info: Node[] = [];
  const infoRow = (label: string, value: string) => h('div.row', null, h('div.row-main', null, h('div.info-label', null, label), h('div.info-value', null, value)));
  if (p.subtitle) info.push(infoRow(p.kind === 'pin' ? 'Location' : 'Address', p.subtitle));
  if (p.charger) {
    const c = p.charger;
    if (c.powerKW) info.push(infoRow('Max power', `${Math.round(c.powerKW)} kW`));
    if (c.connectors.length) info.push(infoRow('Connectors', c.connectors.join(' · ')));
    if (c.points) info.push(infoRow('Charge points', String(c.points)));
    if (c.cost) info.push(infoRow('Cost', c.cost));
    info.push(infoRow('Source', c.source === 'ocm' ? 'Open Charge Map' : c.source === 'yandex' ? 'Yandex Maps' : 'Demo data'));
  }
  if (p.coord) info.push(infoRow('Coordinates', `${p.coord[1].toFixed(5)}, ${p.coord[0].toFixed(5)}`));

  return [
    h('div.view-head', null,
      glyphFor(p, 'lg'),
      h('div.grow', null, h('div.view-title', null, p.name), subtitle ? h('div.view-sub', null, subtitle) : null),
      closeButton(() => app.closePlace()),
    ),
    h('button.btn.btn-primary.btn-block.dir-btn.pressable', { onclick: () => app.directions(p), disabled: !p.coord },
      icon('car', 22), 'Directions',
      eta ? h('span.eta.num', null, `· ${formatDuration(eta.duration)}`) : h('span.spinner', { style: { width: '1rem', height: '1rem', borderWidth: '2px', borderColor: 'rgba(255,255,255,.35)', borderTopColor: '#fff' } }),
    ),
    h('div.place-actions', { style: { gridTemplateColumns: 'repeat(4, 1fr)' } },
      tile(fav ? 'Saved' : 'Save', fav ? 'star' : 'starLine', fav, () => app.toggleFavorite(p)),
      tile('Home', 'house', isHome, () => app.setHome(p)),
      tile('Work', 'briefcase', isWork, () => app.setWork(p)),
      tile('Share', 'share', false, share),
    ),
    info.length ? h('div.info.group', null, ...info) : null,
  ].filter(Boolean) as Node[];
}

export const loading = (text: string) => h('div.loading-block', null, h('span.spinner'), text);
export const empty = (title: string, sub?: string) => h('div.empty', null, icon('search', 36), h('div', { style: { fontWeight: '700', color: 'var(--text)' } }, title), sub ? h('div', { style: { marginTop: '.25rem' } }, sub) : null);
