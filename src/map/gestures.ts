/**
 * Detect real user manipulation of the map (drag, pinch, wheel) from DOM events, so the
 * app can drop out of follow mode. Programmatic camera moves never trigger this.
 */
export function attachGestureWatcher(el: HTMLElement, onGesture: () => void) {
  const starts = new Map<number, { x: number; y: number }>();
  let fired = false;
  el.addEventListener('pointerdown', (e) => {
    starts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    fired = false;
    if (starts.size > 1) fire();
  }, { capture: true, passive: true });
  el.addEventListener('pointermove', (e) => {
    const s = starts.get(e.pointerId);
    if (!s || fired) return;
    if (Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) > 10) fire();
  }, { capture: true, passive: true });
  const end = (e: PointerEvent) => { starts.delete(e.pointerId); };
  el.addEventListener('pointerup', end, { capture: true, passive: true });
  el.addEventListener('pointercancel', end, { capture: true, passive: true });
  el.addEventListener('wheel', () => onGesture(), { capture: true, passive: true });
  function fire() {
    fired = true;
    onGesture();
  }
}
