import { App } from './app';
import { clearLocalApiKey, deployedApiKey, loadConfig } from './config';
import { isTesla } from './core/env';
import { watchForUpdates } from './core/update';
import { bindMap } from './mapsync';
import { mountControls } from './ui/controls';
import { GlassEngine } from './ui/glass';
import { mountNavHud } from './ui/navhud';
import { loadErrorMessage, showOnboarding } from './ui/onboarding';
import { mountPanel } from './ui/panel';
import { mountSettings } from './ui/settings';

declare global { interface Window { teslaplay?: App } }

async function main() {
  const cfg = loadConfig();
  if (isTesla) document.documentElement.classList.add('tesla');
  const app = new App(cfg);
  window.teslaplay = app; // handy for debugging from the console
  watchForUpdates(() => app.state.navigating);
  // No Yandex key configured: go straight to the OpenStreetMap map — never ask the driver for keys.
  if (!cfg.demo && !cfg.yandexApiKey) app.useOsmMap('No Yandex JS API key configured');

  const hud = document.getElementById('hud')!;
  const mapEl = document.getElementById('map')!;
  app.store.select((s) => s.settings.driverSide, (side) => { hud.dataset.side = side; });
  app.store.select((s) => s.lite, (lite) => document.documentElement.classList.toggle('lite', lite));

  // Liquid Glass: lensing, sun-lit rims and touch light for everything in the HUD.
  const glass = new GlassEngine(hud);
  const root = document.documentElement;
  app.store.select((s) => s.material, (m) => {
    root.classList.remove('mat-liquid', 'mat-frosted', 'mat-solid');
    root.classList.add(`mat-${m}`);
    glass.setEnabled(m === 'liquid');
  });
  const relight = () => glass.setLight(app.lightAngle());
  app.store.select((s) => s.azimuth, relight);
  setInterval(relight, 60e3);
  app.store.select((s) => s.settingsOpen, (open) => hud.classList.toggle('modal', open));
  app.store.select((s) => s.navigating, (n) => { hud.dataset.mode = n ? 'nav' : 'explore'; });

  mountPanel(app, hud);
  mountControls(app, hud);
  mountNavHud(app, hud);
  mountSettings(app, hud);

  try {
    await app.start(mapEl);
  } catch (e) {
    console.error(e);
    if (app.engine.kind === 'demo' || app.engine.kind === 'osm') { showOnboarding(String((e as Error).message || e)); return; }
    // A key saved in this browser (e.g. typed into an old key screen) overrides config.js.
    // If it's refused, forget it and try the deployed key before leaving Yandex.
    const deployed = deployedApiKey();
    if (deployed && cfg.yandexApiKey !== deployed && !new URLSearchParams(location.search).get('key')) {
      console.warn('[map] saved key …' + cfg.yandexApiKey.slice(-4) + ' refused; retrying with the deployed key');
      clearLocalApiKey();
      cfg.yandexApiKey = deployed;
      try {
        await app.start(mapEl);
        app.toast('Yandex map loaded with the site’s key — an old key saved in this browser was removed.', 'info', 6500);
        bindMap(app);
        relight();
        requestAnimationFrame(() => document.getElementById('boot')!.classList.add('done'));
        return;
      } catch (e3) {
        console.error(e3);
        e = e3;
      }
    }
    // Yandex map didn't load (key not allowed on this site, blocked, timeout): carry on with
    // the OpenStreetMap map. Search, Yandex routing, drive times and chargers keep working.
    const reason = loadErrorMessage(e);
    app.useOsmMap(reason);
    try {
      await app.start(mapEl);
      app.toast(`Yandex map didn’t load (${shortReason(e)}) — showing OpenStreetMap. Settings → Map services → Yandex key test.`, 'info', 9000);
    } catch (e2) {
      console.error(e2);
      console.warn('[map] Yandex:', reason);
      showOnboarding(`Map error: ${(e2 as Error).message || e2}`);
      return;
    }
  }
  bindMap(app);
  relight();
  requestAnimationFrame(() => document.getElementById('boot')!.classList.add('done'));
}

function shortReason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === 'network') return 'Yandex refused the key on this site';
  if (m === 'timeout') return 'no answer from Yandex';
  if (m === 'invalid-key') return 'key rejected';
  return m.length > 60 ? m.slice(0, 57) + '…' : m;
}

main();
