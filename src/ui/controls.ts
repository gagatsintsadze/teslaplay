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

  const status = h('div.status.glass', { role: 'status' });
  const compassNeedle = h('div.compass', null, h('span.compass-n', null, 'N'));
  const compass = h('button.ctl', { 'aria-label': 'Point north', onclick: () => app.northUp() }, compassNeedle);
  const btn3d = h('button.ctl.label', { 'aria-label': 'Toggle 3D', onclick: () => app.updateSettings({ view3D: !store.get().settings.view3D }) }, '3D');
  const traffic = h('button.ctl', { 'aria-label': 'Toggle traffic', onclick: () => app.updateSettings({ traffic: !store.get().settings.traffic }) }, icon('traffic', 22));
  const settings = h('button.ctl', { 'aria-label': 'Settings', onclick: () => store.set({ settingsOpen: true }) }, icon('gear', 22));
  const group = h('div.ctl-group.glass', null, settings, traffic, btn3d, compass);

  const speedV = h('div.speed-v.num', null, '0');
  const speedU = h('div.speed-u', null, 'km/h');
  const speed = h('div.speed.glass', { 'aria-label': 'Speed' }, speedV, speedU);

  const zoom = h('div.ctl-group.glass.zoom-group', null,
    h('button.ctl', { 'aria-label': 'Zoom in', onclick: () => app.zoomBy(1) }, icon('plus', 22)),
    h('button.ctl', { 'aria-label': 'Zoom out', onclick: () => app.zoomBy(-1) }, icon('minus', 22)),
  );
  const locate = h('button.ctl-single.glass.locate.pressable', { 'aria-label': 'My location', onclick: () => app.cycleLocate() });

  const col = h('div.controls', null, status, group, h('div.spacer'), speed, zoom, locate);
  const recenter = h('button.recenter.glass.pressable.hidden', { onclick: () => app.recenter() }, icon('locate', 20), 'Recenter');
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
    compass.style.display = Math.abs(((s.azimuth + 180) % 360) - 180) > 1 || s.navigating ? '' : 'none';
    setText(btn3d, s.settings.view3D ? '3D' : '2D');
    toggleClass(btn3d, 'on', s.settings.view3D);
    toggleClass(traffic, 'on', s.settings.traffic && s.trafficAvailable);
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

  const toastEls = new Map<number, HTMLElement>();
  store.select((s) => s.toasts, (list) => {
    const ids = new Set(list.map((t) => t.id));
    toastEls.forEach((el, id) => {
      if (!ids.has(id)) { el.classList.add('out'); setTimeout(() => el.remove(), 300); toastEls.delete(id); }
    });
    list.forEach((t) => {
      if (toastEls.has(t.id)) return;
      const ic = t.tone === 'warn' ? icon('warning', 18, 'ic-warn') : t.tone === 'err' ? icon('warning', 18, 'ic-err') : t.tone === 'ok' ? icon('check', 18, 'ic-ok') : icon('info', 18);
      const el = h('div.toast.glass', null, ic, t.text);
      toastEls.set(t.id, el);
      toasts.appendChild(el);
    });
  });
}
