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

export function loadErrorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // A refused key/domain makes the loader script fail like a network error (HTTP 403 on <script>).
  if (m === 'network') return `Yandex refused to load the map here — add ${location.hostname} to the JS API key’s HTTP Referer list (an ad blocker can also block it).`;
  if (m === 'timeout') return 'Yandex Maps didn’t respond in time.';
  if (m === 'missing-key') return 'No Yandex JS API key configured.';
  if (m === 'invalid-key' || /key|apikey|403|forbidden/i.test(m)) return `Yandex rejected the JS API key — check it and that ${location.hostname} is in its HTTP Referer list.`;
  return `Yandex map failed: ${m}`;
}
