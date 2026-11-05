// Runtime configuration — edit on the server without rebuilding.
// Keys are public in any browser app: restrict them to your domain (HTTP Referer)
// in the Yandex Developer Dashboard: https://developer.tech.yandex.ru/
window.TESLAPLAY_CONFIG = {
  // Yandex Maps JavaScript API v3 key (required for the live map; also used for the HTTP Geocoder).
  yandexApiKey: '2fbb3d78-297d-4630-a734-446821138ab6',
  // Separate product keys. Leave empty to reuse yandexApiKey.
  yandexSuggestKey: '', // Geosuggest API (search-as-you-type). Without it: Geocoder + OpenStreetMap.
  yandexSearchKey: '',  // Places API (businesses, categories). Without it: OpenStreetMap.
  yandexRouterKey: '0b9a09a9-1a04-4951-94d0-5d57d6c1ad60', // Router API — Yandex driving routes with live traffic. Without it: OpenStreetMap (OSRM).
  yandexGeocoderKey: '8f4d18bc-b6bb-4baf-908a-960d6a99e122', // Geocoder API — addresses, street names for turn-by-turn.
  yandexMatrixKey: '6d861659-8d49-474e-8298-c5711d4b2358',   // Distance Matrix API — drive times on nearby results.
  // Map + search language: en_US, ru_RU, uk_UA, tr_TR, en_RU …
  mapLang: 'en_US',
  // Free key from https://openchargemap.org/site/profile/applications — EV chargers along routes.
  openChargeMapKey: '',
  // true = run with the offline demo map and mock services (no keys needed).
  demo: false,
};
