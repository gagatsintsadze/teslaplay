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
    h('div.onboard-icon', { html: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="obb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4fa0ff"/><stop offset="1" stop-color="#0646c8"/></linearGradient><radialGradient id="obs" cx=".28" cy=".06" r=".95"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient><linearGradient id="oba" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d9e6ff"/></linearGradient><linearGradient id="obr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#fff" stop-opacity=".15"/><stop offset="1" stop-color="#fff" stop-opacity=".7"/></linearGradient><filter id="obd" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="2.6" stdDeviation="2.4" flood-color="#001c55" flood-opacity=".5"/></filter></defs><rect width="64" height="64" rx="14.5" fill="url(#obb)"/><path d="M-6 54C12 47 21 33 37 27S58 17 70 7" stroke="#fff" stroke-opacity=".13" stroke-width="10" fill="none"/><path d="M-6 54C12 47 21 33 37 27S58 17 70 7" stroke="#fff" stroke-opacity=".22" stroke-width=".8" stroke-dasharray="3 3" fill="none"/><rect width="64" height="64" rx="14.5" fill="url(#obs)"/><path d="M32 13 47 49 32 40.8 17 49Z" fill="url(#oba)" stroke="url(#oba)" stroke-width="2.4" stroke-linejoin="round" filter="url(#obd)"/><path d="M32 13 47 49 32 40.8 17 49Z" fill="none" stroke="url(#obr)" stroke-width="1" stroke-linejoin="round" transform="translate(32 31) scale(1.035) translate(-32 -31)" opacity=".9"/><rect x=".5" y=".5" width="63" height="63" rx="14" fill="none" stroke="#fff" stroke-opacity=".24"/></svg>' }),
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
