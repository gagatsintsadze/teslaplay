import { h } from '../core/dom';

/** Last thumb geometry per control key, so a re-rendered control slides from where it was. */
const lastThumb = new Map<string, { x: number; w: number }>();

/**
 * Capsule segmented control with a raised thumb that slides between segments.
 * Views here re-render wholesale, so the thumb's previous position is remembered by `key`
 * and animated from (FLIP) when the new control mounts.
 */
export function segmented<T extends string | number>(key: string, value: T, options: [T, string][], on: (v: T) => void, attrs: Record<string, unknown> = {}): HTMLElement {
  const thumb = h('span.seg-thumb', { 'aria-hidden': 'true' });
  const buttons = options.map(([val, label]) =>
    h('button', { class: { on: val === value }, role: 'radio', 'aria-checked': val === value ? 'true' : 'false', onclick: () => { if (val !== value) on(val); } }, label));
  const el = h('div.segmented', { role: 'radiogroup', ...attrs }, thumb, ...buttons);
  const index = options.findIndex(([val]) => val === value);

  const place = (animate: boolean) => {
    const b = buttons[index];
    if (!b || !el.isConnected || !b.offsetWidth) return false;
    const x = b.offsetLeft;
    const w = b.offsetWidth;
    const prev = lastThumb.get(key);
    if (animate && prev && (prev.x !== x || prev.w !== w)) {
      thumb.style.transition = 'none';
      thumb.style.transform = `translateX(${prev.x}px)`;
      thumb.style.width = `${prev.w}px`;
      void thumb.offsetWidth;
      thumb.style.transition = '';
    }
    thumb.style.transform = `translateX(${x}px)`;
    thumb.style.width = `${w}px`;
    lastThumb.set(key, { x, w });
    return true;
  };

  if (index < 0) thumb.style.display = 'none';
  else {
    // Wait until the control is laid out (it is created detached).
    let tries = 0;
    const tick = () => { if (!place(true) && ++tries < 10) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => place(false)).observe(el);
  }
  return el;
}
