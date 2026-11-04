import { cumulative, distance, pointAt } from '../core/geo';
import type { LngLat, LngLatBounds, Place } from '../types';

/**
 * Demo mode data: a hand-traced street graph over the bundled backdrop image
 * (Kazbegi Ave / Tamarashvili St, Tbilisi) plus a coarse inter-city corridor.
 * Only used when running without an API key.
 */

// Backdrop image is 2290×1310 px; this is the geographic box it is stretched over.
export const DEMO_BOUNDS: LngLatBounds = [[44.748, 41.73], [44.772, 41.71975]];
const W = 2290;
const H = 1310;
/** Backdrop pixel → coordinate. Traced values are at half scale, hence ×2. */
export const px = (x: number, y: number): LngLat => [
  DEMO_BOUNDS[0][0] + ((x * 2) / W) * (DEMO_BOUNDS[1][0] - DEMO_BOUNDS[0][0]),
  DEMO_BOUNDS[0][1] - ((y * 2) / H) * (DEMO_BOUNDS[0][1] - DEMO_BOUNDS[1][1]),
];

export const DEMO_START: LngLat = px(417, 440);

interface Road { name: string; pts: [number, number][] }
const ROADS: Road[] = [
  { name: 'Mikheil Tamarashvili St', pts: [[442, 655], [436, 610], [432, 560], [422, 470], [412, 400], [405, 320], [398, 243], [385, 150], [366, 45]] },
  { name: 'Aleksandre Kazbegi Ave', pts: [[0, 290], [140, 271], [270, 258], [398, 243], [460, 236], [588, 212], [712, 195], [870, 172], [1040, 150], [1145, 135]] },
  { name: 'Ana Antonovskaia St', pts: [[712, 195], [716, 250], [722, 300], [728, 350], [733, 400], [742, 470], [750, 540]] },
  { name: 'Ana Antonovskaia St', pts: [[690, 0], [700, 100], [712, 195]] },
  { name: 'Givi Kartozia St', pts: [[1040, 150], [1037, 230], [1035, 300], [1030, 420], [1035, 560]] },
  { name: 'Vazha-Pshavela Ave', pts: [[0, 100], [180, 72], [366, 45], [520, 12]] },
  { name: 'Kazbegi Ave service road', pts: [[565, 472], [655, 462], [742, 470]] },
  { name: 'Ilia Skhirtladze St', pts: [[140, 271], [125, 420], [110, 560]] },
];

// Inter-city corridor (simplified E60/E70 alignment) for long-distance demo routes.
export const CORRIDOR: { name: string; at: LngLat }[] = [
  { name: 'Tbilisi', at: [44.748, 41.7255] },
  { name: 'Mtskheta', at: [44.68, 41.81] },
  { name: 'Igoeti', at: [44.42, 41.92] },
  { name: 'Gori', at: [44.11, 41.98] },
  { name: 'Khashuri', at: [43.6, 41.995] },
  { name: 'Rikoti Pass', at: [43.47, 42.03] },
  { name: 'Zestafoni', at: [43.04, 42.11] },
  { name: 'Kutaisi', at: [42.7, 42.25] },
  { name: 'Samtredia', at: [42.34, 42.16] },
  { name: 'Lanchkhuti', at: [42.03, 42.09] },
  { name: 'Kobuleti', at: [41.78, 41.82] },
  { name: 'Batumi', at: [41.6367, 41.6168] },
];

const p = (id: string, name: string, subtitle: string, coord: LngLat, kind: Place['kind'], category?: string): Place => ({ id, name, subtitle, coord, kind, category });

export const DEMO_PLACES: Place[] = [
  p('d-batumi', 'Batumi', 'Adjara, Georgia', [41.6367, 41.6168], 'city'),
  p('d-kutaisi', 'Kutaisi', 'Imereti, Georgia', [42.6997, 42.2679], 'city'),
  p('d-gori', 'Gori', 'Shida Kartli, Georgia', [44.1134, 41.9842], 'city'),
  p('d-airport', 'Tbilisi International Airport', 'Airport · Tbilisi', [44.9547, 41.6692], 'business', 'airport'),
  p('d-axis', 'Axis Shopping', 'Shopping mall · Kazbegi Ave', px(612, 280), 'business'),
  p('d-nikora', 'Nikora', 'Supermarket · Ana Antonovskaia St', px(752, 388), 'business'),
  p('d-gourmet', 'Gourmet', 'Grocery · Givi Kartozia St', px(1012, 366), 'business'),
  p('d-mo', 'Mo coffee spot', 'Café · Kazbegi Ave', px(418, 214), 'business', 'cafe'),
  p('d-delice', 'Café Délice', 'Café · Vazha-Pshavela Ave', px(205, 100), 'business', 'cafe'),
  p('d-dunkin', "Dunkin'", 'Café · Kazbegi Ave', px(122, 300), 'business', 'cafe'),
  p('d-thai', 'Thai indy restaurant', 'Restaurant · Kazbegi Ave', px(253, 302), 'business', 'restaurant'),
  p('d-khashi', 'Khashi House', 'Restaurant', px(178, 438), 'business', 'restaurant'),
  p('d-pelagoni', 'Restaurant Pelagoni', 'Restaurant', px(178, 550), 'business', 'restaurant'),
  p('d-juxianju', 'JuXianJu', 'Restaurant · Givi Kartozia St', px(965, 325), 'business', 'restaurant'),
  p('d-evex', 'Evex Clinic', 'Hospital · Kazbegi Ave', px(672, 52), 'business', 'hospital'),
  p('d-snap', 'Snap Fitness', 'Gym · Axis Towers', px(638, 244), 'business'),
  p('d-park1', 'Axis Underground Parking', 'Parking · Kazbegi Ave', px(560, 300), 'business', 'parking'),
  p('d-park2', 'Vake Parking', 'Parking', px(300, 360), 'business', 'parking'),
  p('d-wash', 'Kartozia Car Wash', 'Car wash', px(1060, 470), 'business', 'carwash'),
  p('d-pharm', 'PSP Pharmacy', 'Pharmacy · Kazbegi Ave', px(820, 200), 'business', 'pharmacy'),
  p('d-atm', 'TBC Bank ATM', 'ATM', px(480, 250), 'business', 'atm'),
  p('d-hotel', 'Vake Boutique Hotel', 'Hotel', px(260, 140), 'business', 'hotel'),
  p('d-rustaveli', 'Rustaveli Avenue', 'Street · Tbilisi', [44.7985, 41.699], 'address'),
  p('d-gudauri', 'Gudauri', 'Ski resort · Mtskheta-Mtianeti', [44.4776, 42.4775], 'city'),
];

export const DEMO_CHARGERS: Place[] = [
  { id: 'dc-axis', name: 'Axis Towers EV Hub', subtitle: 'Demo charger · Kazbegi Ave', coord: px(560, 255), kind: 'charger', charger: { powerKW: 60, connectors: ['CCS2', 'Type 2'], points: 4, operational: true, source: 'demo' } },
  { id: 'dc-mtskheta', name: 'Mtskheta Fast Charge', subtitle: 'Demo charger · E60', coord: [44.683, 41.808], kind: 'charger', charger: { powerKW: 50, connectors: ['CCS2', 'CHAdeMO'], points: 2, operational: true, source: 'demo' } },
  { id: 'dc-gori', name: 'Gori Highway Chargers', subtitle: 'Demo charger · E60', coord: [44.112, 41.977], kind: 'charger', charger: { powerKW: 120, connectors: ['CCS2'], points: 4, operational: true, source: 'demo' } },
  { id: 'dc-khashuri', name: 'Khashuri Rest Stop', subtitle: 'Demo charger · E60', coord: [43.602, 41.992], kind: 'charger', charger: { powerKW: 160, connectors: ['CCS2'], points: 6, operational: true, source: 'demo' } },
  { id: 'dc-zestafoni', name: 'Zestafoni Charge Point', subtitle: 'Demo charger · E60', coord: [43.043, 42.108], kind: 'charger', charger: { powerKW: 50, connectors: ['CCS2', 'Type 2'], points: 2, operational: true, source: 'demo' } },
  { id: 'dc-kutaisi', name: 'Kutaisi Bypass Supercharge', subtitle: 'Demo charger · E70', coord: [42.703, 42.247], kind: 'charger', charger: { powerKW: 150, connectors: ['CCS2'], points: 8, operational: true, source: 'demo' } },
  { id: 'dc-kobuleti', name: 'Kobuleti Seaside Charging', subtitle: 'Demo charger · E70', coord: [41.781, 41.823], kind: 'charger', charger: { powerKW: 100, connectors: ['CCS2'], points: 2, operational: true, source: 'demo' } },
];

// ── tiny street graph + Dijkstra so any tap inside the backdrop gets a road-following route ──
interface Node { id: number; c: LngLat; edges: { to: number; w: number; name: string }[] }
const nodes: Node[] = [];
const keyOf = (pt: [number, number]) => `${pt[0]},${pt[1]}`;
const index = new Map<string, number>();
for (const r of ROADS) {
  let prev = -1;
  for (const pt of r.pts) {
    const k = keyOf(pt);
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ id, c: px(pt[0], pt[1]), edges: [] });
      index.set(k, id);
    }
    if (prev >= 0) {
      const w = distance(nodes[prev].c, nodes[id].c);
      nodes[prev].edges.push({ to: id, w, name: r.name });
      nodes[id].edges.push({ to: prev, w, name: r.name });
    }
    prev = id;
  }
}

export interface Snap { coord: LngLat; u: number; v: number; name: string; dist: number }

/** Nearest point on any demo road: the edge (u→v) it lies on and the road's name. */
export function snapToRoads(c: LngLat): Snap {
  let best: Snap = { coord: nodes[0].c, u: 0, v: 0, name: ROADS[0].name, dist: Infinity };
  for (const n of nodes) {
    for (const e of n.edges) {
      if (e.to < n.id) continue;
      const coords = [n.c, nodes[e.to].c];
      const cum = cumulative(coords);
      for (let t = 0; t <= 1.0001; t += 0.04) {
        const q = pointAt(coords, cum, cum[1] * t).coord;
        const d = distance(q, c);
        if (d < best.dist) best = { coord: q, u: n.id, v: e.to, name: e.name, dist: d };
      }
    }
  }
  return best;
}

export interface GraphPath { pts: LngLat[]; names: string[]; length: number }

/** Shortest path between two nodes. names[i] is the road of the edge arriving at pts[i]. */
export function graphPath(fromNode: number, toNode: number): GraphPath {
  const dist = new Array(nodes.length).fill(Infinity);
  const prev = new Array<number>(nodes.length).fill(-1);
  const via = new Array<string>(nodes.length).fill('');
  const done = new Array<boolean>(nodes.length).fill(false);
  dist[fromNode] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity || u === toNode) break;
    done[u] = true;
    for (const e of nodes[u].edges) {
      const nd = dist[u] + e.w;
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; via[e.to] = e.name; }
    }
  }
  const pts: LngLat[] = [];
  const names: string[] = [];
  for (let v = toNode; v >= 0; v = prev[v]) {
    pts.unshift(nodes[v].c);
    names.unshift(via[v]);
    if (v === fromNode) break;
  }
  return { pts, names, length: dist[toNode] };
}

export const nodeCoord = (id: number) => nodes[id].c;

export const insideBackdrop = (c: LngLat) =>
  c[0] >= DEMO_BOUNDS[0][0] && c[0] <= DEMO_BOUNDS[1][0] && c[1] <= DEMO_BOUNDS[0][1] && c[1] >= DEMO_BOUNDS[1][1];

/** West exit of the local graph (Kazbegi Ave), where long routes leave the backdrop. */
export const EXIT_NODE = index.get('0,290')!;

/** Fake but plausible elevation (m) for demo routes: Tbilisi ~480 m, Rikoti ~990 m, coast ~0 m. */
export function demoElevation(c: LngLat): number {
  const lng = c[0];
  if (lng > 44.6) return 470 + (44.75 - lng) * 300;
  if (lng > 43.6) return 520 + (44.6 - lng) * 120 + Math.sin(lng * 40) * 25;
  if (lng > 43.3) return 640 + 350 * Math.sin(((43.6 - lng) / 0.3) * Math.PI);
  if (lng > 42.7) return Math.max(120, 300 - (43.3 - lng) * 300) + Math.sin(lng * 30) * 20;
  return Math.max(2, 120 - (42.7 - lng) * 110);
}
