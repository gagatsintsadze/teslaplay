// Runtime configuration — edit on the server without rebuilding.
// Keys are public in any browser app: restrict them to your domain (HTTP Referer)
// in the Yandex Developer Dashboard: https://developer.tech.yandex.ru/
window.TESLAPLAY_CONFIG = {
  // Yandex Maps JavaScript API v3 key (required for the live map; also used for the HTTP Geocoder).
  yandexApiKey: '2fbb3d78-297d-4630-a734-446821138ab6',
  // Separate product keys. Leave empty to reuse yandexApiKey.
  yandexSuggestKey: '', // Geosuggest API (search-as-you-type)
  yandexSearchKey: '',  // Places API (businesses, categories). Without it: address search via Geocoder.
  yandexRouterKey: '',  // Router. If routing isn't enabled on the key, OpenStreetMap (OSRM) is used.
  // Map + search language: en_US, ru_RU, uk_UA, tr_TR, en_RU …
  mapLang: 'en_US',
  // Free key from https://openchargemap.org/site/profile/applications — EV chargers along routes.
  openChargeMapKey: '',
  // true = run with the offline demo map and mock services (no keys needed).
  demo: false,
};
