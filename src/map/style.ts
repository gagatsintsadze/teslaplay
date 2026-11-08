/**
 * Teslaplay "Drive" map style for the OpenStreetMap map (MapLibre + OpenFreeMap vector tiles,
 * OpenMapTiles schema). Built for in-car navigation, after Apple Maps' driving look:
 *  - roads drawn at their real width in metres when zoomed in, as asphalt with kerbs,
 *    white edge lines and dashed centre lines; clean light lines when zoomed out
 *  - soft land, green parks, blue water; solid 3D buildings
 *  - Latin street names (English where OSM has them), POIs as coloured dots
 */

const TILES = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const SRC = 'omt';

/** Pixels per metre at zoom 0 for Georgia's latitude (≈41.7°): 2^z / (156543 · cos φ). */
const PX_PER_M_Z0 = 1 / 58440;

export interface Palette {
  land: string; residential: string; park: string; wood: string; water: string; sand: string;
  kerb: string; roadLow: string; motorwayLow: string; asphalt: string; asphaltMinor: string; service: string;
  marking: string; path: string; rail: string; bridgeKerb: string; tunnel: string;
  buildingLow: string; buildingMid: string; buildingHigh: string;
  label: string; labelMuted: string; halo: string; waterLabel: string; boundary: string;
}

export const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    land: '#f2efe9', residential: '#ece8e0', park: '#cde6bc', wood: '#bfdea9', water: '#9ccdf3', sand: '#f2e8c9',
    kerb: '#dcd7cd', roadLow: '#ffffff', motorwayLow: '#fbe3a2', asphalt: '#6a707a', asphaltMinor: '#7d838c', service: '#a9adb3',
    marking: '#ffffff', path: '#c7c1b6', rail: '#b8b3ab', bridgeKerb: '#bdb7ac', tunnel: '#e3dfd8',
    buildingLow: '#ebe4d8', buildingMid: '#e2daca', buildingHigh: '#d7cdbd',
    label: '#33363b', labelMuted: '#6b6f76', halo: '#ffffff', waterLabel: '#3f78ad', boundary: '#b9a6c9',
  },
  dark: {
    land: '#1b1e24', residential: '#1f2229', park: '#1d3326', wood: '#1a3024', water: '#0f2b47', sand: '#2a2822',
    kerb: '#2d313a', roadLow: '#3b404a', motorwayLow: '#5c5136', asphalt: '#3c414b', asphaltMinor: '#353a43', service: '#30343c',
    marking: '#d2d6dd', path: '#3a3e47', rail: '#3d414a', bridgeKerb: '#4a4f5a', tunnel: '#262a31',
    buildingLow: '#2c3038', buildingMid: '#363b46', buildingHigh: '#424a5a',
    label: '#dfe2e8', labelMuted: '#9aa0aa', halo: '#1b1e24', waterLabel: '#7fb0e0', boundary: '#5d5470',
  },
};

/**
 * Carriageway width per OSM class, metres, at street zooms. The lane model (map/roadlayers.ts) draws the
 * exact asphalt on top of these at z15.3+, so they only need to be a plausible underlay (and the look
 * where no lane data exists). Motorways/trunks are mapped per carriageway in OSM.
 */
const ROAD_W: Record<string, number> = { motorway: 7, trunk: 6.5, primary: 6, secondary: 5, tertiary: 4.5, minor: 3.5, service: 2.2, track: 1.6 };
const RANK: Record<string, number> = { service: 1, track: 1, minor: 2, tertiary: 3, secondary: 4, primary: 5, trunk: 6, motorway: 7 };
const ROAD_CLASSES = Object.keys(ROAD_W);

const byClass = (table: Record<string, number>, fallback: number): any =>
  ['match', ['get', 'class'], ...Object.keys(table).flatMap((k) => [k, table[k]]), fallback];

/** Width that tracks the real road width (metres) at street zooms and stays legible when zoomed out. */
const metres = (w: any, extraM = 0): any => {
  const W = extraM ? ['+', w, extraM] : w;
  const at = (z: number, k: number) => ['*', W, k];
  return ['interpolate', ['exponential', 2], ['zoom'],
    5, at(5, 0.035), 11, at(11, 0.14), 14, at(14, 0.26), 15, at(15, 2 ** 15 * PX_PER_M_Z0), 20, at(20, 2 ** 20 * PX_PER_M_Z0)];
};
const fixedM = (m: number, minPx: number): any => ['interpolate', ['exponential', 2], ['zoom'],
  14, Math.max(minPx, m * 2 ** 14 * PX_PER_M_Z0), 20, Math.max(minPx, m * 2 ** 20 * PX_PER_M_Z0)];

/** Label in the map language: English (or OSM's Latin transliteration) for en, else that language, then local. */
export function labelExpr(lang: string): any {
  const l = lang.slice(0, 2).toLowerCase();
  if (l === 'ka') return ['coalesce', ['get', 'name:ka'], ['get', 'name']];
  if (l === 'ru') return ['coalesce', ['get', 'name:ru'], ['get', 'name']];
  if (l === 'uk') return ['coalesce', ['get', 'name:uk'], ['get', 'name:ru'], ['get', 'name']];
  if (l === 'tr') return ['coalesce', ['get', 'name:tr'], ['get', 'name:latin'], ['get', 'name']];
  return ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
}

const isLine: any = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const isPoly: any = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const notBrunnel = (b: string): any => ['!=', ['get', 'brunnel'], b];

export function buildStyle(theme: 'light' | 'dark', lang: string): any {
  const P = PALETTES[theme];
  const name = labelExpr(lang);
  const roadFilter = (extra: any[]): any => ['all', isLine, ['match', ['get', 'class'], ROAD_CLASSES, true, false], ...extra];
  const W = byClass(ROAD_W, 6);
  // Light lines when zoomed out → asphalt at street level.
  const roadColor: any = ['interpolate', ['linear'], ['zoom'],
    15, ['match', ['get', 'class'], ['motorway', 'trunk'], P.motorwayLow, ['service', 'track'], P.roadLow, P.roadLow],
    16.5, ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], P.asphalt, ['service', 'track'], P.service, P.asphaltMinor]];
  const kerbColor: any = ['interpolate', ['linear'], ['zoom'], 15, P.kerb, 16.5, P.kerb];
  const font = (w: 'Regular' | 'Bold' | 'Italic') => [`Noto Sans ${w}`];

  const roadLayers = (prefix: string, filter: any[], opts: { kerb: string; opacity?: number; dash?: boolean } ) => [
    {
      id: `${prefix}-kerb`, type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 12,
      filter: roadFilter(filter),
      layout: { 'line-join': 'round', 'line-cap': prefix === 'tunnel' ? 'butt' : 'round', 'line-sort-key': byClass(RANK, 0) },
      paint: { 'line-color': opts.kerb, 'line-width': metres(W, 3.5), 'line-opacity': opts.opacity ?? 1, ...(opts.dash ? { 'line-dasharray': [0.6, 0.4] } : {}) },
    },
    {
      id: `${prefix}-fill`, type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 5,
      filter: roadFilter(filter),
      layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': byClass(RANK, 0) },
      paint: { 'line-color': prefix === 'tunnel' ? P.tunnel : roadColor, 'line-width': metres(W), 'line-opacity': opts.opacity ?? 1 },
    },
  ];

  return {
    version: 8,
    name: `Teslaplay Drive ${theme}`,
    glyphs: GLYPHS,
    sources: { [SRC]: { type: 'vector', url: TILES } },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': P.land } },
      { id: 'residential', type: 'fill', source: SRC, 'source-layer': 'landuse', filter: ['match', ['get', 'class'], ['residential', 'suburb', 'neighbourhood'], true, false], paint: { 'fill-color': P.residential, 'fill-opacity': 0.7 } },
      { id: 'wood', type: 'fill', source: SRC, 'source-layer': 'landcover', filter: ['match', ['get', 'class'], ['wood', 'forest'], true, false], paint: { 'fill-color': P.wood } },
      { id: 'grass', type: 'fill', source: SRC, 'source-layer': 'landcover', filter: ['match', ['get', 'class'], ['grass', 'farmland', 'wetland'], true, false], paint: { 'fill-color': P.park, 'fill-opacity': 0.7 } },
      { id: 'sand', type: 'fill', source: SRC, 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'sand'], paint: { 'fill-color': P.sand } },
      { id: 'park', type: 'fill', source: SRC, 'source-layer': 'park', filter: isPoly, paint: { 'fill-color': P.park } },
      { id: 'landuse-green', type: 'fill', source: SRC, 'source-layer': 'landuse', filter: ['match', ['get', 'class'], ['pitch', 'cemetery', 'stadium', 'playground', 'garden'], true, false], paint: { 'fill-color': P.park, 'fill-opacity': 0.8 } },
      { id: 'water', type: 'fill', source: SRC, 'source-layer': 'water', filter: notBrunnel('tunnel'), paint: { 'fill-color': P.water } },
      { id: 'waterway', type: 'line', source: SRC, 'source-layer': 'waterway', filter: ['all', isLine, notBrunnel('tunnel')], paint: { 'line-color': P.water, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 0.5, 14, 2, 20, 12] } },
      { id: 'aeroway', type: 'fill', source: SRC, 'source-layer': 'aeroway', filter: isPoly, minzoom: 11, paint: { 'fill-color': P.residential } },

      // Tunnels (faded), then roads, paths and rail, then bridges on top.
      ...roadLayers('tunnel', [['==', ['get', 'brunnel'], 'tunnel']], { kerb: P.tunnel, opacity: 0.6, dash: true }),
      {
        id: 'path', type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 15,
        filter: ['all', isLine, ['match', ['get', 'class'], ['path', 'pedestrian'], true, false], notBrunnel('tunnel')],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': P.path, 'line-width': fixedM(1.6, 1), 'line-dasharray': [2, 1.2] },
      },
      {
        id: 'pedestrian-area', type: 'fill', source: SRC, 'source-layer': 'transportation', minzoom: 15,
        filter: ['all', isPoly, ['match', ['get', 'class'], ['pedestrian', 'path'], true, false]],
        paint: { 'fill-color': P.kerb, 'fill-opacity': 0.6 },
      },
      ...roadLayers('road', [notBrunnel('tunnel'), notBrunnel('bridge')], { kerb: P.kerb }),
      {
        id: 'rail', type: 'line', source: SRC, 'source-layer': 'transportation', minzoom: 11,
        filter: ['all', isLine, ['match', ['get', 'class'], ['rail', 'transit'], true, false], notBrunnel('tunnel')],
        paint: { 'line-color': P.rail, 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 11, 0.6, 20, 4], 'line-dasharray': [3, 2] },
      },
      ...roadLayers('bridge', [['==', ['get', 'brunnel'], 'bridge']], { kerb: P.bridgeKerb }),
      {
        id: 'oneway', type: 'symbol', source: SRC, 'source-layer': 'transportation', minzoom: 17,
        filter: ['all', isLine, ['match', ['coalesce', ['get', 'oneway'], 0], [1, -1], true, false], ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'minor', 'service', 'trunk'], true, false]],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 140, 'text-field': ['case', ['==', ['get', 'oneway'], -1], '‹', '›'],
          'text-font': font('Bold'), 'text-size': ['interpolate', ['linear'], ['zoom'], 17, 16, 20, 30], 'text-keep-upright': false,
          'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map', 'text-allow-overlap': false,
        },
        paint: { 'text-color': P.marking, 'text-opacity': 0.75 },
      },
      { id: 'boundary', type: 'line', source: SRC, 'source-layer': 'boundary', filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': P.boundary, 'line-width': 1, 'line-dasharray': [3, 2] } },

      // 3D buildings — the engine splits these around the route while driving (see OsmEngine).
      {
        id: 'tp-buildings', type: 'fill-extrusion', source: SRC, 'source-layer': 'building', minzoom: 13.5,
        filter: ['!', ['has', 'hide_3d']],
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, P.buildingLow, 40, P.buildingMid, 120, P.buildingHigh],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 15, ['coalesce', ['get', 'render_height'], 8]],
          'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 15, ['coalesce', ['get', 'render_min_height'], 0]],
          'fill-extrusion-opacity': 1,
          'fill-extrusion-vertical-gradient': true,
        },
      },

      // Labels
      {
        id: 'water-name', type: 'symbol', source: SRC, 'source-layer': 'water_name',
        layout: { 'text-field': name, 'text-font': font('Italic'), 'text-size': 13, 'text-max-width': 6 },
        paint: { 'text-color': P.waterLabel, 'text-halo-color': P.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'poi-dot', type: 'circle', source: SRC, 'source-layer': 'poi', minzoom: 16,
        filter: ['all', ['has', 'name'], ['<=', ['get', 'rank'], 30]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 16, 3.5, 19, 6],
          'circle-color': poiColor(), 'circle-stroke-color': P.halo, 'circle-stroke-width': 1.5,
          'circle-pitch-alignment': 'viewport',
        },
      },
      {
        id: 'poi-label', type: 'symbol', source: SRC, 'source-layer': 'poi', minzoom: 16,
        filter: ['all', ['has', 'name'], ['<=', ['get', 'rank'], 30]],
        layout: {
          'text-field': name, 'text-font': font('Regular'), 'text-size': 12, 'text-anchor': 'left', 'text-offset': [0.8, 0],
          'text-max-width': 9, 'symbol-sort-key': ['get', 'rank'], 'text-optional': true,
        },
        paint: { 'text-color': poiColor(theme === 'dark' ? 0.25 : -0.25), 'text-halo-color': P.halo, 'text-halo-width': 1.4 },
      },
      {
        id: 'road-name', type: 'symbol', source: SRC, 'source-layer': 'transportation_name', minzoom: 13,
        filter: ['all', isLine, ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false]],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 420, 'text-field': name, 'text-font': font('Bold'),
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 17, 13, 20, 16],
          'text-rotation-alignment': 'map', 'text-pitch-alignment': 'viewport', 'text-letter-spacing': 0.02,
          'symbol-sort-key': ['-', 10, byClass(RANK, 0)],
        },
        paint: { 'text-color': P.label, 'text-halo-color': P.halo, 'text-halo-width': 1.6 },
      },
      {
        id: 'housenumber', type: 'symbol', source: SRC, 'source-layer': 'housenumber', minzoom: 18,
        layout: { 'text-field': ['get', 'housenumber'], 'text-font': font('Regular'), 'text-size': 10.5 },
        paint: { 'text-color': P.labelMuted, 'text-halo-color': P.halo, 'text-halo-width': 1 },
      },
      {
        id: 'place-minor', type: 'symbol', source: SRC, 'source-layer': 'place', minzoom: 12,
        filter: ['match', ['get', 'class'], ['suburb', 'quarter', 'neighbourhood', 'hamlet'], true, false],
        layout: { 'text-field': name, 'text-font': font('Bold'), 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 14], 'text-transform': 'uppercase', 'text-letter-spacing': 0.08, 'text-max-width': 8 },
        paint: { 'text-color': P.labelMuted, 'text-halo-color': P.halo, 'text-halo-width': 1.4 },
      },
      {
        id: 'place-village', type: 'symbol', source: SRC, 'source-layer': 'place', minzoom: 9,
        filter: ['match', ['get', 'class'], ['village', 'town'], true, false],
        layout: { 'text-field': name, 'text-font': font('Bold'), 'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 14, 16], 'text-max-width': 8 },
        paint: { 'text-color': P.label, 'text-halo-color': P.halo, 'text-halo-width': 1.6 },
      },
      {
        id: 'place-city', type: 'symbol', source: SRC, 'source-layer': 'place', minzoom: 4, maxzoom: 15,
        filter: ['==', ['get', 'class'], 'city'],
        layout: { 'text-field': name, 'text-font': font('Bold'), 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 12, 10, 20], 'text-max-width': 8 },
        paint: { 'text-color': P.label, 'text-halo-color': P.halo, 'text-halo-width': 2 },
      },
      {
        id: 'place-country', type: 'symbol', source: SRC, 'source-layer': 'place', maxzoom: 8,
        filter: ['==', ['get', 'class'], 'country'],
        layout: { 'text-field': name, 'text-font': font('Bold'), 'text-size': 14, 'text-transform': 'uppercase', 'text-letter-spacing': 0.1 },
        paint: { 'text-color': P.labelMuted, 'text-halo-color': P.halo, 'text-halo-width': 1.6 },
      },
    ],
  };

  /** POI category colours (Apple-like): food orange, shopping purple, health red, transport blue… */
  function poiColor(shift = 0): any {
    const c = (hex: string) => (shift ? tint(hex, shift) : hex);
    return ['match', ['get', 'class'],
      ['restaurant', 'fast_food', 'cafe', 'bar', 'beer', 'ice_cream', 'bakery'], c('#ff8a1f'),
      ['shop', 'grocery', 'clothing_store', 'jewelry', 'furniture', 'florist', 'alcohol_shop', 'hardware'], c('#b35ee6'),
      ['hospital', 'pharmacy', 'doctors', 'dentist'], c('#ff4d5e'),
      ['fuel', 'charging_station', 'car', 'car_repair'], c('#1fb954'),
      ['parking', 'bus', 'railway', 'rail', 'aerialway', 'ferry_terminal'], c('#1e88ff'),
      ['lodging', 'hotel'], c('#8e6cf0'),
      ['school', 'college', 'library', 'town_hall', 'post'], c('#a78452'),
      ['park', 'garden', 'playground', 'pitch', 'stadium', 'sports_centre'], c('#34a853'),
      ['attraction', 'museum', 'monument', 'place_of_worship', 'castle', 'theatre', 'cinema'], c('#e8508f'),
      c('#8a8f98')];
  }
}

/** Lighten (+) or darken (−) a hex colour. */
function tint(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(Math.max(0, Math.min(255, amt > 0 ? v + (255 - v) * amt : v * (1 + amt))));
  return '#' + [ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
