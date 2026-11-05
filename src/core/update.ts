declare const __BUILD__: string;

/**
 * GitHub Pages lets browsers cache index.html for ~10 minutes, so a car can keep running an old
 * build after a deploy. Compare our build id with the deployed version.json and reload onto a
 * fresh URL (a new query string bypasses the cached page) when they differ.
 */
export function watchForUpdates(isBusy: () => boolean) {
  if (typeof __BUILD__ === 'undefined' || __BUILD__ === 'dev') return;
  const check = async () => {
    try {
      const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      const { build } = await r.json();
      if (!build || build === __BUILD__) return;
      // Never yank the map away mid-drive; and only try once per build.
      if (isBusy()) return;
      const key = `tp:reloaded:${build}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      const url = new URL(location.href);
      url.searchParams.set('v', build);
      location.replace(url.toString());
    } catch { /* offline: try later */ }
  };
  check();
  setInterval(check, 15 * 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}
