// Runtime configuration — edit on the server without rebuilding.
window.TESLAPLAY_CONFIG = {
  // Mapbox public token (pk.…) from https://account.mapbox.com/access-tokens/
  // Turns on live traffic: traffic-aware routes and ETAs, traffic colours on the map and the route,
  // and drive times on nearby results. Restrict it to your site's URL in the Mapbox account.
  // Without it the app still works: OpenStreetMap routing without traffic.
  mapboxToken: '',
  // Labels and search language: en_US, ka_GE, ru_RU, uk_UA, tr_TR
  mapLang: 'en_US',
  // Free key from https://openchargemap.org/site/profile/applications — EV charger power and connectors.
  openChargeMapKey: '',
  // true = run with the offline demo map and mock services (no keys needed).
  demo: false,
};
