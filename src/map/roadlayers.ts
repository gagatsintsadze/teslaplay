import type { RoadScene } from '../services/roads';
import { signalImage } from './arrows';
import { PALETTES } from './style';
import { MeshLayer, type Strip } from './mesh3d';

/**
 * MapLibre layers for the pre-built lane model (services/roads.ts, built by scripts/roads/lanes.py).
 * The geometry already is in metres on the ground, so polygons need no width at all and the
 * line layers only need a metric stroke: `metres()` turns metres into pixels per zoom
 * (exponential base 2 — the exact Web Mercator scale), with a pixel floor so hairlines never vanish.
 *
 * Level of detail: the asphalt and junctions fade in at z15.5 over the base style's roads, the
 * markings at z16.3, painted arrows at z16.8. Bridge parapets and tunnel portals are real 3-D.
 */

export const PX_PER_M_Z0 = 1 / 58440; // pixels per metre at zoom 0 around 41.7°N (Georgia): 512 px world ÷ (40 075 km · cos φ)

/** Pixels for `m` metres at every zoom (an expression per feature is fine), never below `minPx`. */
export function metres(m: any, minPx = 0): any {
  const stops: any[] = [];
  for (const z of [10, 13, 15, 17, 19, 22]) {
    const k = 2 ** z * PX_PER_M_Z0;
    stops.push(z, typeof m === 'number' ? Math.max(minPx, m * k) : ['max', minPx, ['*', m, k]]);
  }
  return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
}

export const ROAD_SOURCES = ['tp-surf', 'tp-jn', 'tp-mk', 'tp-ar', 'tp-ex', 'tp-sh', 'tp-sig'] as const;

const fade = (from: number, to: number, max: any = 1): any => ['interpolate', ['linear'], ['zoom'], from, 0, to, max];

/**
 * Dash pattern in ground metres for a line drawn `wM` metres wide with a `minPx` pixel floor.
 * MapLibre measures dashes in line widths, so where the floor applies the pattern is rescaled per zoom step.
 */
function dashM(dash: number, gap: number, wM: number, minPx: number): any {
  const out: any[] = ['step', ['zoom']];
  const at = (z: number) => { const k = 2 ** z * PX_PER_M_Z0; const w = Math.max(minPx / k, wM); return ['literal', [+(dash / w).toFixed(3), +(gap / w).toFixed(3)]]; };
  out.push(at(15.5));
  for (let z = 16; z <= 21; z += 0.5) out.push(z, at(z));
  return out;
}

export function addRoadLayers(map: any, theme: 'light' | 'dark') {
  if (map.getSource('tp-surf')) return;
  mesh = null;
  const P = PALETTES[theme];
  const empty = { type: 'FeatureCollection', features: [] };
  for (const id of ROAD_SOURCES) map.addSource(id, { type: 'geojson', data: empty, tolerance: 0.15 });

  // Ground-level roads go just under the rail layer (so the base style's bridges still cross on
  // top); bridges go after it. Everything is sorted by OSM `layer` so stacked roads draw in order.
  const ground = map.getLayer('rail') ? 'rail' : undefined;
  const above = map.getLayer('oneway') ? 'oneway' : map.getLayer('tp-buildings') ? 'tp-buildings' : undefined;
  const asphalt: any = ['case', ['==', ['get', 'tu'], 1], P.tunnel, ['match', ['get', 'c'], ['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'], P.asphalt, ['service'], P.service, P.asphaltMinor]];
  for (const br of [0, 1]) {
    const sfx = br ? '-br' : '';
    const before = br ? above : ground;
    const onBridge: any = ['==', ['coalesce', ['get', 'br'], 0], br];
    map.addLayer({
      id: `tp-surf${sfx}`, type: 'fill', source: 'tp-surf', minzoom: 15.3, filter: onBridge,
      layout: { 'fill-sort-key': ['get', 'ly'] },
      paint: { 'fill-color': asphalt, 'fill-opacity': fade(15.3, 16, ['case', ['==', ['get', 'tu'], 1], 0.55, 1]), 'fill-antialias': true, 'fill-outline-color': br ? P.bridgeKerb : P.kerb },
    }, before);
    if (!br) {
      map.addLayer({
        id: 'tp-jn', type: 'fill', source: 'tp-jn', minzoom: 15.3,
        layout: { 'fill-sort-key': ['get', 'ly'] },
        paint: { 'fill-color': P.asphalt, 'fill-opacity': fade(15.3, 16), 'fill-antialias': false },
      }, before);
    }
    // Markings — white, as Georgian markings are (yellow is only for special lines).
    const mark = (k: string, width: any, extra: any = {}, layout: any = {}) => map.addLayer({
      id: `tp-mk-${k}${sfx}`, type: 'line', source: 'tp-mk', minzoom: 16.1,
      filter: ['all', ['==', ['get', 'k'], k], onBridge],
      layout: { 'line-cap': 'butt', 'line-join': 'round', ...layout },
      paint: { 'line-color': P.marking, 'line-width': width, 'line-opacity': fade(16.1, 16.8, 0.92), ...extra },
    }, before);
    const hair = metres(0.15, 1);
    mark('edge', hair);
    mark('cl2', hair);
    mark('div', hair, { 'line-dasharray': dashM(3, 9, 0.15, 1) });   // 3 m dash, 9 m gap (line 1.5)
    mark('cl1', hair, { 'line-dasharray': dashM(3, 6, 0.15, 1) });   // 3 m dash, 6 m gap: two-way centre line
    mark('guide', hair, { 'line-dasharray': dashM(0.5, 0.5, 0.15, 1), 'line-opacity': fade(16.1, 16.8, 0.7) }); // lane guide lines across junctions (line 1.7)
    mark('stop', metres(0.4, 1.5));
    mark('zebra', metres(3.2, 2), { 'line-dasharray': dashM(0.5, 0.5, 3.2, 2), 'line-opacity': fade(16.1, 16.8, 0.85) }); // 0.5 m stripes
  }
  // Structures in 3-D: bridge decks (sliced along ramps), their lane markings as thin slabs, parapets,
  // piers, tunnel portals. Shadows are flat fills on the ground. Decks over a car driving underneath go
  // to the x-ray copy of the layer (setXray) so the road below stays visible.
  const exBefore = map.getLayer('tp-buildings') ? 'tp-buildings' : undefined;
  map.addLayer({
    id: 'tp-sh', type: 'fill', source: 'tp-sh', minzoom: 15.5,
    paint: { 'fill-color': '#000', 'fill-opacity': fade(15.5, 16.5, 0.16), 'fill-antialias': false },
  }, exBefore);
  const exColor: any = ['match', ['get', 'k'],
    'portal', theme === 'dark' ? '#5c6676' : '#b6ad9f',
    'dmk', P.marking,
    'pier', theme === 'dark' ? '#4a515c' : '#a9a49a',
    'rail', P.bridgeKerb,
    'deck', ['match', ['get', 'c'], ['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'], P.asphalt, P.asphaltMinor],
    P.bridgeKerb];
  const exPaint = (opacity: number) => ({
    'fill-extrusion-color': exColor,
    'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'b'],
    'fill-extrusion-opacity': opacity,
    'fill-extrusion-vertical-gradient': false,
  });
  map.addLayer({ id: 'tp-ex', type: 'fill-extrusion', source: 'tp-ex', minzoom: 15, filter: ['!', ['in', ['get', 's'], ['literal', []]]], paint: exPaint(1) }, exBefore);
  map.addLayer({ id: 'tp-ex-xray', type: 'fill-extrusion', source: 'tp-ex', minzoom: 15, filter: ['in', ['get', 's'], ['literal', []]], paint: exPaint(0.3) }, exBefore);
  // Painted turn arrows: the icon is 40 × 80 px (@2x) and stands for 1.4 m × 2.8 m on the road.
  map.addLayer({
    id: 'tp-ar', type: 'symbol', source: 'tp-ar', minzoom: 16.6,
    layout: {
      'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': metres(2.8 / 80),
    },
    paint: { 'icon-opacity': fade(16.6, 17.2, 0.92) },
  }, map.getLayer('tp-buildings') ? 'tp-buildings' : undefined);
  const sig = signalImage();
  if (sig && !map.hasImage('tp-signal')) map.addImage('tp-signal', sig, { pixelRatio: 2 });
  map.addLayer({
    id: 'tp-sig', type: 'symbol', source: 'tp-sig', minzoom: 15.5,
    layout: {
      'icon-image': 'tp-signal', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 15.5, 0.45, 17, 0.75, 19, 1.15],
    },
    paint: { 'icon-opacity': fade(15.5, 16) },
  }, map.getLayer('poi-dot') ? 'poi-dot' : undefined);
}

/** Structures (by their `s` id) the car is about to drive under: drawn see-through. */
export function setXray(map: any, ids: string[]) {
  if (!map.getLayer('tp-ex-xray')) return;
  map.setFilter('tp-ex', ['!', ['in', ['get', 's'], ['literal', ids]]]);
  map.setFilter('tp-ex-xray', ['in', ['get', 's'], ['literal', ids]]);
  if (mesh) mesh.setXray(ids);
}

let mesh: MeshLayer | null = null;
const hex = (c: string): [number, number, number] => { const n = parseInt(c.replace('#', ''), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

/** The smooth 3-D strips of the scene → the mesh layer (created on first use, under the buildings). */
function setStrips(map: any, maplibre: any, theme: 'light' | 'dark', items: any[]) {
  if (!mesh || !map.getLayer(mesh.id)) {
    mesh = new MeshLayer('tp-m3', maplibre, map);
    map.addLayer(mesh, map.getLayer('tp-buildings') ? 'tp-buildings' : undefined);
  }
  const P = PALETTES[theme];
  const major = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
  const strips: Strip[] = items.map((f) => ({
    id: f.id, s: f.s, pts: f.q,
    color: hex(f.k === 'dmk' ? P.marking : f.k === 'rail' ? P.bridgeKerb : major.has(f.c) ? P.asphalt : P.asphaltMinor),
  }));
  mesh.setStrips(strips);
}

export function setRoadScene(map: any, scene: RoadScene, maplibre?: any, theme: 'light' | 'dark' = 'dark') {
  const set = (id: string, data: any) => { const s = map.getSource(id); if (s) s.setData(data); };
  set('tp-surf', scene.surf);
  set('tp-jn', scene.jn);
  set('tp-mk', scene.mk);
  set('tp-ar', scene.ar);
  set('tp-ex', scene.ex);
  set('tp-sh', scene.sh);
  if (maplibre) setStrips(map, maplibre, theme, scene.m3 || []);
  set('tp-sig', scene.sig);
}
