const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

/** Tesla's in-car Chromium appends "Tesla/<firmware>" to its user agent. */
export const isTesla = /\bTesla\//i.test(ua) || /[?&]tesla=1\b/.test(location.search);
export const teslaFirmware = (ua.match(/Tesla\/([\w.\-]+)/i) || [])[1] || null;
export const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
export const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

/** Older MCU2 (Intel Atom, 4 cores) struggles with blur over WebGL. */
export const likelyLowEnd = isTesla && cores <= 4;

/** Measure frame pacing for ~2 s; resolves true when the device can't sustain ~40 fps. */
export function measureSluggish(ms = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    const start = last;
    const tick = (t: number) => {
      frames++;
      worst = Math.max(worst, t - last);
      last = t;
      if (t - start < ms) requestAnimationFrame(tick);
      else resolve(frames / ((t - start) / 1000) < 40);
    };
    requestAnimationFrame(tick);
  });
}

export const params = new URLSearchParams(location.search);
