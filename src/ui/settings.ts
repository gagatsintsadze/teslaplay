import type { App } from '../app';
import { saveLocalKeys } from '../config';
import { h, mount, removeWithAnimation } from '../core/dom';
import { isTesla, teslaFirmware } from '../core/env';
import { VEHICLES, vehicleById } from '../services/ev';
import type { Settings } from '../types';
import type { Material } from './glass';
import { lensSupported } from './glass';
import { icon } from './icons';

declare const __BUILD__: string;
import { segmented } from './segmented';
import { activeProviders, type CheckResult, reportText, runServiceCheck } from '../services/diagnostics';

function glassNote(material: Material, choice: Settings['glass']): string {
  if (choice === 'liquid' && material !== 'liquid') return 'Lensing needs a Chromium browser — using Frosted';
  if (choice !== 'auto') return material === 'liquid' ? 'Lensing, light and depth' : material === 'frosted' ? 'Blurred glass, no lensing' : 'Opaque panels, lightest on the GPU';
  const now = material === 'liquid' ? 'Liquid' : material === 'frosted' ? 'Frosted' : 'Solid';
  return `Now ${now}${lensSupported ? '' : ' (no lensing in this browser)'} · steps down if driving gets choppy`;
}

/** iOS-style grouped settings sheet. */
export function mountSettings(app: App, hud: HTMLElement) {
  const { store } = app;
  let backdrop: HTMLElement | null = null;
  let sheet: HTMLElement | null = null;
  let body: HTMLElement | null = null;

  const close = () => store.set({ settingsOpen: false });

  store.select((s) => s.settingsOpen, (open) => {
    if (open && !sheet) {
      backdrop = h('div.backdrop', { onclick: close });
      body = h('div.sheet-body');
      sheet = h('section.sheet.glass.glass-lg', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
        h('div.sheet-head', null, h('div.sheet-title', null, 'Settings'), h('button.btn.btn-tinted.pressable', { onclick: close, style: { minHeight: '2.75rem' } }, 'Done')),
        body,
      );
      hud.append(backdrop, sheet);
      render();
    } else if (!open && sheet) {
      removeWithAnimation(sheet, 300);
      removeWithAnimation(backdrop!, 300);
      sheet = backdrop = body = null;
    }
  });
  store.select((s) => [s.settings, s.material, s.trafficAvailable], () => { if (body) render(); }, { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] });

  // Map services check (kept across re-renders while the sheet is open)
  let checks: CheckResult[] | null = null;
  let checking = false;
  const runCheck = async () => {
    if (checking) return;
    checking = true;
    render();
    try { checks = await runServiceCheck(app); } finally { checking = false; }
    render();
  };
  const copyReport = () => {
    if (!checks) return;
    const text = reportText(app, checks);
    const done = () => app.toast('Report copied — paste it into the chat', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  };

  function servicesGroup(row: (label: string, sub: string | null, control: Node) => HTMLElement) {
    const status = (r: CheckResult) => h('span.svc', { class: r.ok === null ? 'skip' : r.ok ? 'ok' : 'bad' },
      r.ms !== undefined && r.ok !== null ? h('span.svc-ms.num', null, `${r.ms} ms`) : null,
      h('span.svc-dot', null, icon(r.ok === null ? 'minus' : r.ok ? 'check' : 'close', 14)));
    const rows: Node[] = [];
    if (checks) {
      activeProviders(app, checks).forEach((p) => rows.push(row(p.label, null, h('span.svc-using', null, p.value))));
      checks.forEach((r) => rows.push(row(r.name, r.detail, status(r))));
    }
    rows.push(h('div.set-row', null,
      h('div.label', null, checks ? 'Run again after changing keys' : 'Check what works with these keys', h('small', null, 'Tests the map, search, directions, chargers and GPS from this browser')),
      checks ? h('button.btn.btn-plain.pressable', { onclick: copyReport, style: { minHeight: '2.75rem' } }, 'Copy report') : null,
      h('button.btn.btn-tinted.pressable', { onclick: runCheck, disabled: checking, style: { minHeight: '2.75rem' } }, checking ? h('span.spinner', { style: { width: '1.1rem', height: '1.1rem', borderWidth: '2px' } }) : null, checking ? 'Checking…' : checks ? 'Check again' : 'Check services'),
    ));
    return rows;
  }

  function render() {
    if (!body) return;
    const top = body.scrollTop;
    const s = store.get();
    const st = s.settings;
    const set = (patch: Partial<Settings>) => app.updateSettings(patch);
    const v = vehicleById(st.vehicleId);

    const seg = <T extends string | number>(key: string, value: T, options: [T, string][], on: (v: T) => void) => segmented(key, value, options, on);
    const sw = (on: boolean, toggle: () => void, label: string) => h('button.switch', { class: { on }, role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, onclick: toggle });
    const row = (label: string, sub: string | null, control: Node) => h('div.set-row', null, h('div.label', null, label, sub ? h('small', null, sub) : null), control);
    const group = (caption: string, ...rows: (Node | null)[]) => h('div.set-section', null, h('div.set-caption', null, caption), h('div.set-group', null, ...rows), );

    const vehicleSelect = h('select', { 'aria-label': 'Vehicle' }, ...VEHICLES.map((x) => h('option', { value: x.id, selected: x.id === st.vehicleId }, x.name))) as HTMLSelectElement;
    vehicleSelect.addEventListener('change', () => {
      const nv = vehicleById(vehicleSelect.value);
      set({ vehicleId: nv.id, usableKWh: nv.usableKWh, consumption: null });
    });
    const num = (value: number | null, placeholder: string, on: (n: number | null) => void, label: string) => {
      const input = h('input.input.num', { type: 'number', inputmode: 'decimal', value: value === null ? '' : String(value), placeholder, 'aria-label': label, style: { width: '7rem', textAlign: 'right' } }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const n = parseFloat(input.value);
        on(isFinite(n) && n > 0 ? n : null);
      });
      return input;
    };

    const keys = { ...app.cfg };
    const keyInput = (k: 'yandexApiKey' | 'yandexSuggestKey' | 'yandexSearchKey' | 'yandexRouterKey' | 'yandexGeocoderKey' | 'yandexMatrixKey' | 'openChargeMapKey', placeholder: string) => {
      const input = h('input.input', { type: 'text', value: (keys as any)[k] || '', placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': placeholder }) as HTMLInputElement;
      input.addEventListener('input', () => { (keys as any)[k] = input.value.trim(); });
      return input;
    };
    const langSelect = h('select', { 'aria-label': 'Map language' }, ...[['en_US', 'English'], ['ru_RU', 'Русский'], ['en_RU', 'English (RU data)'], ['uk_UA', 'Українська'], ['tr_TR', 'Türkçe']].map(([val, label]) => h('option', { value: val, selected: val === app.cfg.mapLang }, label))) as HTMLSelectElement;
    langSelect.addEventListener('change', () => { keys.mapLang = langSelect.value; });

    mount(body,
      group('Appearance',
        row('Map appearance', st.themeMode === 'auto' ? 'Follows sunrise and sunset' : null, seg('theme', st.themeMode, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], (m) => set({ themeMode: m }))),
        row('Text size', null, seg('text', st.textSize, [['standard', 'Standard'], ['large', 'Large'], ['larger', 'Larger']], (t) => set({ textSize: t }))),
        row('Driver side', 'Where cards and guidance appear', seg('side', st.driverSide, [['left', 'Left'], ['right', 'Right']], (d) => set({ driverSide: d }))),
        row('Glass', glassNote(s.material, st.glass), seg('glass', st.glass, [['auto', 'Auto'], ['liquid', 'Liquid'], ['frosted', 'Frosted'], ['solid', 'Solid']], (g) => set({ glass: g }))),
      ),
      group('Navigation',
        row('Voice guidance', app.voice.canSpeak ? null : 'No speech voice in this browser — chimes instead', sw(st.voice, () => set({ voice: !st.voice }), 'Voice guidance')),
        row('Avoid tolls', null, sw(st.avoidTolls, () => set({ avoidTolls: !st.avoidTolls }), 'Avoid tolls')),
        row('3D perspective', 'Tilted map with buildings while driving', sw(st.view3D, () => set({ view3D: !st.view3D }), '3D perspective')),
        row('Live traffic', s.trafficAvailable ? null : 'Requires a paid Yandex plan', sw(st.traffic && s.trafficAvailable, () => set({ traffic: !st.traffic }), 'Live traffic')),
        row('Units', null, seg('units', st.units, [['metric', 'Kilometres'], ['imperial', 'Miles']], (u) => set({ units: u }))),
      ),
      group('Vehicle & charging',
        row('Model', null, vehicleSelect),
        row('Usable battery', 'kWh', num(st.usableKWh, String(v.usableKWh), (n) => set({ usableKWh: n || v.usableKWh }), 'Usable battery kWh')),
        row('Consumption', `Wh/km · preset ${v.whPerKm}`, num(st.consumption, String(v.whPerKm), (n) => set({ consumption: n }), 'Consumption Wh/km')),
        row('Arrive with at least', null, seg('reserve', st.reserveSoc, [[5, '5%'], [10, '10%'], [15, '15%'], [20, '20%']], (r) => set({ reserveSoc: r }))),
        row('Charge up to', 'On trip charging stops', seg('maxsoc', st.maxChargeSoc, [[70, '70%'], [80, '80%'], [90, '90%']], (m) => set({ maxChargeSoc: m }))),
      ),
      h('div.set-foot', null, 'Range estimates use speed, outside temperature and elevation. Tune consumption to match your car’s trip meter for best accuracy.'),
      group('Map services', ...servicesGroup(row)),
      group('Map data',
        row('Yandex JS API key', 'Required for the live map', keyInput('yandexApiKey', 'JS API v3 key')),
        row('Geosuggest key', 'Optional · Yandex search as you type', keyInput('yandexSuggestKey', 'Same as JS key')),
        row('Search (Places) key', 'Optional · Yandex businesses and categories', keyInput('yandexSearchKey', 'Same as JS key')),
        row('Router API key', 'Yandex routes with live traffic', keyInput('yandexRouterKey', 'Router API key')),
        row('Geocoder API key', 'Addresses and street names', keyInput('yandexGeocoderKey', 'Geocoder API key')),
        row('Distance Matrix key', 'Drive times on nearby results', keyInput('yandexMatrixKey', 'Distance Matrix key')),
        row('Open Charge Map key', 'Charger power & connectors', keyInput('openChargeMapKey', 'Free key')),
        row('Map language', null, langSelect),
        h('div.set-row', null, h('div.label'), h('button.btn.btn-primary.pressable', {
          onclick: () => {
            saveLocalKeys({ yandexApiKey: keys.yandexApiKey, yandexSuggestKey: keys.yandexSuggestKey, yandexSearchKey: keys.yandexSearchKey, yandexRouterKey: keys.yandexRouterKey, yandexGeocoderKey: keys.yandexGeocoderKey, yandexMatrixKey: keys.yandexMatrixKey, openChargeMapKey: keys.openChargeMapKey, mapLang: keys.mapLang });
            const url = new URL(location.href);
            url.searchParams.delete('demo');
            location.href = url.toString();
          },
        }, 'Save & reload')),
      ),
      h('div.set-foot', null, 'Without the optional keys, search uses the Yandex Geocoder plus OpenStreetMap, directions use OpenStreetMap routing, and chargers come from OpenStreetMap. Keys entered here are stored only in this browser; for a deployment put them in config.js and restrict them to your domain in the Yandex Developer Dashboard.'),
      group('Developer',
        row('Simulation controls', 'Adds “Simulate” next to Go', sw(st.devTools, () => set({ devTools: !st.devTools }), 'Simulation controls')),
        row('Demo mode', s.demo ? 'Running with sample data' : 'Offline map with sample data', h('button.btn.btn-plain.pressable', {
          style: { minHeight: '2.5rem' },
          onclick: () => { const url = new URL(location.href); url.searchParams.set('demo', s.demo ? '0' : '1'); location.href = url.toString(); },
        }, s.demo ? 'Exit demo' : 'Open demo')),
      ),
      h('div.set-foot', null,
        icon('info', 14), ` Teslaplay 0.1 (build ${typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'}) · Maps, search and routing © Yandex · Weather & elevation: Open-Meteo · Chargers: Open Charge Map, OpenStreetMap. Backup map: MapLibre, © CARTO, © OpenStreetMap contributors. `,
        isTesla ? `Tesla browser detected${teslaFirmware ? ` (${teslaFirmware})` : ''}.` : '',
      ),
    );
    body.scrollTop = top;
  }
}

function fallbackCopy(text: string, done: () => void) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  ta.remove();
}
