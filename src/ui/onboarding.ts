import { saveLocalKeys } from '../config';
import { h } from '../core/dom';
import { icon } from './icons';

/** First run (no key) or map-load failure: ask for a Yandex key or open the demo. */
export function showOnboarding(error?: string) {
  const input = h('input', { type: 'text', placeholder: 'Yandex Maps JS API v3 key', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Yandex API key' }) as HTMLInputElement;
  const go = () => {
    const key = input.value.trim();
    if (!key) { input.focus(); return; }
    saveLocalKeys({ yandexApiKey: key });
    const url = new URL(location.href);
    url.searchParams.delete('demo');
    location.href = url.toString();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const card = h('div.onboard-card', null,
    h('div.onboard-icon', { html: '<svg viewBox="0 0 64 64" width="72" height="72"><defs><linearGradient id="ob" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a8bff"/><stop offset="1" stop-color="#0050d8"/></linearGradient></defs><rect width="64" height="64" fill="url(#ob)"/><path d="M32 13 47 49 32 41 17 49Z" fill="#fff"/></svg>' }),
    h('h1', null, 'Teslaplay'),
    h('p', null, 'Navigation built for your car’s browser — Yandex maps with live traffic, 3D buildings and EV trip planning for Georgia and beyond.'),
    h('label.field', null, icon('gear', 20), input),
    error ? h('div.err', null, error) : null,
    h('button.btn.btn-primary.btn-block.pressable', { onclick: go }, 'Continue'),
    h('button.link', { onclick: () => { const url = new URL(location.href); url.searchParams.set('demo', '1'); location.href = url.toString(); } }, 'Explore the demo instead'),
  );
  document.body.appendChild(h('div.onboard', null, card));
  document.getElementById('boot')?.classList.add('done');
}

export function loadErrorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === 'timeout') return 'Yandex Maps didn’t respond. Check the connection and that this domain is allowed for the key.';
  if (m === 'network') return 'Couldn’t reach Yandex Maps. Check the internet connection.';
  if (m === 'invalid-key' || /key|apikey|403|forbidden/i.test(m)) return 'Yandex rejected this key. Check it’s a JS API v3 key and that this domain is allowed in its HTTP Referer list.';
  return `Map failed to load: ${m}`;
}
