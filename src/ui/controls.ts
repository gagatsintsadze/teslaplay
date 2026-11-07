import type { App } from '../app';
import { h, mount, setText, toggleClass } from '../core/dom';
import { speedParts } from '../core/format';
import { shallowEqualArray } from '../core/store';
import { batteryGlyph } from './common';
import { icon, weatherIcon } from './icons';

/** Right-hand column: status, map controls, speed, locate — plus the recenter pill and toasts. */
export function mountControls(app: App, hud: HTMLElement) {
  const { store } = app;
  const eq = shallowEqualArray as any;

  // Grouped by function, icons only: settings | layers [traffic · 3D] | compass … speed | zoom | locate
  const status = h('div.status.glass', { role: 'status' });
  const settings = h('button.ctl-single.glass.lg-flex', { 'aria-label': 'Settings', onclick: () => store.set({ settingsOpen: true }) }, icon('gear', 24));
  const traffic = h('button.ctl', { 'aria-label': 'Live traffic', 'aria-pressed': 'false', onclick: () => app.updateSettings({ traffic: !store.get().settings.traffic }) }, icon('traffic', 22));
  const btn3d = h('button.ctl', { 'aria-label': '3D map', 'aria-pressed': 'false', onclick: () => app.updateSettings({ view3D: !store.get().settings.view3D }) }, icon('cube', 23));
  const layers = h('div.ctl-group.glass.lg-flex', null, traffic, btn3d);
  const compassNeedle = h('div.compass', null, h('span.compass-n', null, 'N'));
  const compass = h('button.ctl-single.glass.lg-flex.compass-btn', { 'aria-label': 'Point north', onclick: () => app.northUp() }, compassNeedle);

  const speedV = h('div.speed-v.num', null, '0');
  const speedU = h('div.speed-u', null, 'km/h');
  const speed = h('div.speed.glass', { 'aria-label': 'Speed' }, speedV, speedU);
  // Posted speed limit (round European sign) above the speedometer while driving.
  const limitV = h('span.num');
  const limit = h('div.limit.hidden', { role: 'img', 'aria-label': 'Speed limit' }, limitV);

  const zoom = h('div.ctl-group.glass.lg-flex.zoom-group', null,
    h('button.ctl', { 'aria-label': 'Zoom in', onclick: () => app.zoomBy(1) }, icon('plus', 22)),
    h('button.ctl', { 'aria-label': 'Zoom out', onclick: () => app.zoomBy(-1) }, icon('minus', 22)),
  );
  const locate = h('button.ctl-single.glass.lg-flex.locate', { 'aria-label': 'My location', onclick: () => app.cycleLocate() });

  const col = h('div.controls', null, status, settings, layers, compass, h('div.spacer'), limit, speed, zoom, locate);
  const recenter = h('button.recenter.glass.lg-flex.hidden', { onclick: () => app.recenter() }, icon('locate', 20), 'Recenter');
  const toasts = h('div.toasts', { 'aria-live': 'polite' });
  hud.append(col, recenter, toasts);

  store.select((s) => [s.weatherHere, s.battery, s.navigating, s.nav ? Math.round(s.nav.socNow || 0) : 0], () => {
    const s = store.get();
    const soc = s.navigating && s.nav && s.nav.socNow !== null ? s.nav.socNow : s.battery;
    const w = s.weatherHere;
    mount(status,
      w ? h('span.wx', null, icon(weatherIcon(w.code, w.isDay), 20), h('span.num', null, `${Math.round(w.tempC)}°`)) : null,
      w ? h('span.sep') : null,
      batteryGlyph(Math.max(0, soc)),
    );
  }, { equals: eq });

  store.select((s) => [s.azimuth, s.navigating, s.settings.view3D, s.settings.traffic, s.trafficAvailable], () => {
    const s = store.get();
    compassNeedle.style.transform = `rotate(${-s.azimuth}deg)`;
    toggleClass(compass, 'hidden', !(Math.abs(((s.azimuth + 180) % 360) - 180) > 1 || s.navigating));
    toggleClass(btn3d, 'on', s.settings.view3D);
    btn3d.setAttribute('aria-pressed', String(s.settings.view3D));
    const trafficOn = s.settings.traffic && s.trafficAvailable;
    toggleClass(traffic, 'on', trafficOn);
    traffic.setAttribute('aria-pressed', String(trafficOn));
    traffic.style.display = s.trafficAvailable ? '' : 'none';
  }, { equals: eq });

  store.select((s) => [s.follow, s.navigating], () => {
    const s = store.get();
    mount(locate, icon(s.follow === 'none' ? 'locateLine' : 'locate', 22));
    toggleClass(locate, 'following', s.follow !== 'none');
    toggleClass(locate, 'course', s.follow === 'course');
    toggleClass(recenter, 'hidden', !(s.navigating && s.follow === 'none'));
    zoom.style.display = s.navigating ? 'none' : '';
    speed.style.display = s.navigating ? '' : 'none';
  }, { equals: eq });

  store.select((s) => (s.fix ? s.fix.speed : null), (v) => {
    const [val, unit] = speedParts(v === undefined ? null : v);
    setText(speedV, val === '—' ? '0' : val);
    setText(speedU, unit);
  });

  store.select((s) => [s.navigating, s.nav ? s.nav.speedLimit : null, s.fix && s.fix.speed ? Math.round(s.fix.speed * 3.6) : 0, s.settings.units], () => {
    const s = store.get();
    const lim = s.navigating && s.nav ? s.nav.speedLimit : null;
    toggleClass(limit, 'hidden', lim === null);
    const kmh = s.fix && s.fix.speed ? s.fix.speed * 3.6 : 0;
    const over = lim !== null && kmh > lim + 4;
    if (lim !== null) {
      const shown = s.settings.units === 'imperial' ? Math.round(lim / 1.609 / 5) * 5 : lim;
      setText(limitV, String(shown));
      limit.setAttribute('aria-label', `Speed limit ${shown}`);
    }
    toggleClass(limit, 'over', over);
    toggleClass(speed, 'over', over);
  }, { equals: eq });

  // While driving, map chrome recedes after a few idle seconds; any touch brings it back.
  let idleTimer = 0;
  const wake = () => {
    hud.classList.remove('idle');
    clearTimeout(idleTimer);
    if (store.get().navigating) idleTimer = window.setTimeout(() => hud.classList.add('idle'), 6000);
  };
  document.addEventListener('pointerdown', wake, { passive: true, capture: true });
  store.select((s) => s.navigating, wake);

  const toastEls = new Map<number, HTMLElement>();
  store.select((s) => s.toasts, (list) => {
    const ids = new Set(list.map((t) => t.id));
    toastEls.forEach((el, id) => {
      if (!ids.has(id)) { el.classList.add('out'); setTimeout(() => el.remove(), 300); toastEls.delete(id); }
    });
    list.forEach((t) => {
      if (toastEls.has(t.id)) return;
      const ic = t.tone === 'warn' ? icon('warning', 18, 'ic-warn') : t.tone === 'err' ? icon('warning', 18, 'ic-err') : t.tone === 'ok' ? icon('check', 18, 'ic-ok') : icon('info', 18);
      const el = h('div.toast.glass', { role: t.tone === 'err' ? 'alert' : 'status' }, ic, t.text);
      toastEls.set(t.id, el);
      toasts.appendChild(el);
    });
  });
}
