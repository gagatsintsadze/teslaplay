import { App } from './app';
import { loadConfig } from './config';
import { isTesla } from './core/env';
import { bindMap } from './mapsync';
import { mountControls } from './ui/controls';
import { mountNavHud } from './ui/navhud';
import { loadErrorMessage, showOnboarding } from './ui/onboarding';
import { mountPanel } from './ui/panel';
import { mountSettings } from './ui/settings';

declare global { interface Window { teslaplay?: App } }

async function main() {
  const cfg = loadConfig();
  if (isTesla) document.documentElement.classList.add('tesla');
  if (!cfg.demo && !cfg.yandexApiKey) { showOnboarding(); return; }

  const app = new App(cfg);
  window.teslaplay = app; // handy for debugging from the console

  const hud = document.getElementById('hud')!;
  const mapEl = document.getElementById('map')!;
  app.store.select((s) => s.settings.driverSide, (side) => { hud.dataset.side = side; });
  app.store.select((s) => s.lite, (lite) => document.documentElement.classList.toggle('lite', lite));
  app.store.select((s) => s.navigating, (n) => { hud.dataset.mode = n ? 'nav' : 'explore'; });

  mountPanel(app, hud);
  mountControls(app, hud);
  mountNavHud(app, hud);
  mountSettings(app, hud);

  try {
    await app.start(mapEl);
  } catch (e) {
    console.error(e);
    showOnboarding(loadErrorMessage(e));
    return;
  }
  bindMap(app);
  requestAnimationFrame(() => document.getElementById('boot')!.classList.add('done'));
}

main();
