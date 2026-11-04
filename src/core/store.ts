export type Listener<T> = (state: T, prev: T) => void;

/** Minimal immutable store: shallow-merge updates, synchronous notifications, selector subscriptions. */
export class Store<T extends object> {
  private state: T;
  private listeners = new Set<Listener<T>>();
  private notifying = false;
  private queued: Partial<T> | null = null;

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  set(patch: Partial<T> | ((s: T) => Partial<T>)): void {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    if (this.notifying) {
      // Coalesce updates triggered from inside listeners; apply after the current pass.
      this.queued = { ...(this.queued || {}), ...p };
      return;
    }
    let changed = false;
    for (const k in p) {
      if ((this.state as any)[k] !== (p as any)[k]) { changed = true; break; }
    }
    if (!changed) return;
    const prev = this.state;
    this.state = { ...prev, ...p };
    this.notifying = true;
    try {
      this.listeners.forEach((l) => {
        try { l(this.state, prev); } catch (e) { console.error(e); }
      });
    } finally {
      this.notifying = false;
    }
    if (this.queued) {
      const q = this.queued;
      this.queued = null;
      this.set(q);
    }
  }

  subscribe(l: Listener<T>): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Run `cb` whenever the selected slice changes (and once immediately if `immediate`). */
  select<K>(selector: (s: T) => K, cb: (v: K, prev: K | undefined) => void, opts: { immediate?: boolean; equals?: (a: K, b: K) => boolean } = {}): () => void {
    const eq = opts.equals || Object.is;
    let last = selector(this.state);
    if (opts.immediate !== false) cb(last, undefined);
    return this.subscribe((s) => {
      const v = selector(s);
      if (!eq(v, last)) {
        const prev = last;
        last = v;
        cb(v, prev);
      }
    });
  }
}

export const shallowEqualArray = <A>(a: A[], b: A[]) => a.length === b.length && a.every((x, i) => x === b[i]);
