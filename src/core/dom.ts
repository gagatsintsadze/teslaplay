export type Child = Node | string | number | null | undefined | false | Child[];

type Props = {
  [key: string]: unknown;
  class?: string | Record<string, boolean | undefined>;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
};

/**
 * Hyperscript helper. Tag may carry classes: h('button.btn.btn-primary', {...}, 'Go').
 * Props: `onX` → event listener, `class` string|map, `style` object, `html` → innerHTML (trusted only), others → attributes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | string, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div') as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(' ');
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el: HTMLElement, props: Props) {
  for (const key in props) {
    const v = props[key];
    if (v === undefined || v === null || v === false) continue;
    if (key === 'class') {
      if (typeof v === 'string') el.className = (el.className ? el.className + ' ' : '') + v;
      else for (const c in v as Record<string, boolean>) if ((v as Record<string, boolean>)[c]) el.classList.add(c);
    } else if (key === 'style') {
      Object.assign(el.style, v as object);
    } else if (key === 'html') {
      el.innerHTML = String(v);
    } else if (key.startsWith('on') && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v as EventListener);
    } else if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(v);
    } else if (v === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(v));
    }
  }
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Replace all children (Element.replaceChildren is Chrome 86+, Tesla firmware may be older). */
export function mount(el: Element, ...children: Child[]) {
  while (el.firstChild) el.removeChild(el.firstChild);
  append(el, children);
}

export function svg(markup: string): SVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild as SVGElement;
}

export function toggleClass(el: Element, cls: string, on: boolean) {
  if (on) el.classList.add(cls);
  else el.classList.remove(cls);
}

export function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

export const raf = (fn: FrameRequestCallback) => requestAnimationFrame(fn);

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | undefined;
  const d = (...a: A) => {
    if (t) clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => { if (t) clearTimeout(t); };
  return d;
}

/** Animate a closing element with its `.out` class, then remove it. */
export function removeWithAnimation(el: Element, ms = 300) {
  el.classList.add('out');
  setTimeout(() => el.remove(), ms);
}
