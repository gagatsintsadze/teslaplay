import { h } from '../core/dom';

declare const __BUILD__: string;

const APP_ICON = document.querySelector('.boot-mark svg') ? document.querySelector('.boot-mark')!.innerHTML : '';

/**
 * Last-resort screen, shown only when no map at all could start (no WebGL, offline on first run…).
 * Keys never come from the driver: they live in config.js (or Settings → Map data).
 */
export function showOnboarding(error?: string) {
  const retry = () => location.reload();
  const demo = () => { const url = new URL(location.href); url.searchParams.set('demo', '1'); location.href = url.toString(); };
  const card = h('div.onboard-card', null,
    h('div.onboard-icon', { html: APP_ICON }),
    h('h1', null, 'Teslaplay'),
    h('p', null, 'The map couldn’t start. Check the internet connection and try again.'),
    error ? h('div.err', null, error) : null,
    h('div.ver', null, `Build ${typeof __BUILD__ === 'string' ? __BUILD__ : ''}`),
    h('button.btn.btn-primary.btn-block.pressable', { onclick: retry }, 'Try again'),
    h('button.link', { onclick: demo }, 'Explore the demo instead'),
  );
  document.body.appendChild(h('div.onboard', null, card));
  document.getElementById('boot')?.classList.add('done');
}
