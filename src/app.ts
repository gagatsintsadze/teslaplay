import type { AppConfig } from './config';
import { isTesla, likelyLowEnd, measureSluggish } from './core/env';
import { setUnits } from './core/format';
import { boundsOf, destination, distance, padBounds, pointAt, pointInRing, projectOnRoute, slice } from './core/geo';
import { storage } from './core/storage';
import { shallowEqualArray, Store } from './core/store';
import { isDaylight, sunPosition } from './core/sun';
import { DemoEngine } from './map/demo';
import type { MapClick, MapEngine, Padding } from './map/engine';
import { createPuck } from './map/markers';
import { OsmEngine } from './map/osm';
import { FollowController, type FollowMode } from './nav/follow';
import { NavigationSession } from './nav/session';
import { type ChargerService, LiveChargers } from './services/chargers';
import { DemoChargers, DemoRouting, DemoSearch } from './services/demo';
import { DEMO_BOUNDS, DEMO_START } from './services/demo-data';
import { type EnergyModel, energyModel, evaluateStops, midpoint, planTrip, quickArrival, vehicleById } from './services/ev';
import { LocationService } from './services/location';
import { FallbackRouting, type NamedRouter, type RoutingService } from './services/routing';
import { MapboxMatrix, MapboxRouting } from './services/mapbox';
import { OsmPlaces } from './services/osm';
import { OsrmRouting } from './services/osrm';
import { OsmSearch, type SearchService } from './services/search';
import { RoadDetails } from './services/roads';
import { laneOfFix, placeOnLanes } from './nav/laneroute';
import { trafficOnLanes } from './nav/lanetraffic';
import { Voice } from './services/voice';
import { WeatherService } from './services/weather';
import { type AppState, initialState } from './state';
import type { ChargeStop, Fix, LngLat, Place, RouteResult, Settings } from './types';
import { FrameGuard, lensSupported, type Material } from './ui/glass';
import type { Category } from './ui/icons';

const TBILISI: LngLat = [44.7934, 41.7151];
/** How often a live-traffic route is re-checked while driving. */
const TRAFFIC_REFRESH = 4 * 60e3;

/** Application controller: owns services + state, exposes intent methods to the UI. */
export class App {
  store: Store<AppState>;
  engine: MapEngine;
  search: SearchService;
  routing: RoutingService;
  chargers: ChargerService;
  weather: WeatherService;
  osm: OsmPlaces | null = null;
  matrix: MapboxMatrix | null = null;
  /** Lane-level OpenStreetMap detail (lanes, painted arrows, traffic lights, speed limits). */
  roads: RoadDetails | null = null;
  location = new LocationService();
  voice = new Voice();
  puck = createPuck();
  follow!: FollowController;
  session: NavigationSession | null = null;
  energy: EnergyModel | null = null;
  /** Unmodified alternatives (before re-routing via chargers). */
  private baseRoutes: RouteResult[] = [];
  private prefetch: { placeId: string; tolls: boolean; at: number; routes: RouteResult[] } | null = null;
  private seq = { suggest: 0, route: 0, plan: 0, place: 0 };
  private suggestTimer: number | undefined;
  private planTimer: number | undefined;
  private toastId = 0;
  private lastSavedPos = 0;
  private measured = false;
  private measuredSlow = false;
  private mapReady = false;
  private bootCenter: LngLat = TBILISI;
  /** How many steps Auto glass has backed off (Liquid → Frosted → Solid) after choppy frames. */
  private materialStep = 0;
  private frameGuard = new FrameGuard(() => this.stepDownMaterial());
  layoutListeners: (() => void)[] = [];
  private trafficTimer = 0;

  constructor(public cfg: AppConfig) {
    this.store = new Store(initialState(cfg.demo));
    const demo = cfg.demo;
    this.engine = demo
      ? new DemoEngine({ url: cfg.demoBackdropUrl, trafficUrl: cfg.demoBackdropUrl.startsWith('data:') ? undefined : 'demo/backdrop-traffic.jpg', bounds: DEMO_BOUNDS })
      : new OsmEngine(cfg.mapLang, cfg.mapboxToken);
    if (demo) {
      this.search = new DemoSearch();
      this.routing = new DemoRouting();
    } else {
      this.osm = new OsmPlaces(cfg.mapLang);
      this.search = new OsmSearch(this.osm);
      this.roads = new RoadDetails();
      // Mapbox (live traffic) when a token is set; OpenStreetMap routing (OSRM) always behind it.
      const chain: NamedRouter[] = [];
      if (cfg.mapboxToken) {
        this.matrix = new MapboxMatrix(cfg.mapboxToken);
        chain.push({ name: 'Mapbox (live traffic)', router: new MapboxRouting(cfg.mapboxToken, ['ru', 'uk', 'tr'].includes(cfg.mapLang.slice(0, 2)) ? cfg.mapLang.slice(0, 2) : 'en') });
      }
      chain.push({ name: 'OpenStreetMap (OSRM)', router: new OsrmRouting() });
      let warned = false;
      this.routing = new FallbackRouting(chain, () => {
        if (!warned) { warned = true; this.toast('Live-traffic routing didn’t answer — using OpenStreetMap routes without traffic.', 'warn', 6000); }
      });
    }
    this.chargers = demo ? new DemoChargers() : new LiveChargers(cfg.openChargeMapKey, this.osm!);
    this.weather = new WeatherService(demo);
  }

  get state() { return this.store.get(); }

  // ───────────────────────── boot ─────────────────────────
  async start(mapEl: HTMLElement) {
    this.applySettings(this.state.settings, true);
    const last = storage.get<LngLat | null>('lastPos', null);
    const center = this.cfg.demo ? DEMO_START : last || TBILISI;
    this.bootCenter = center;
    this.applyTheme();
    await this.engine.init(mapEl, { center, zoom: this.cfg.demo ? 17.2 : 15, theme: this.state.theme });
    this.mapReady = true;

    this.follow = new FollowController(this.engine, this.puck, {
      lite: () => this.state.lite,
      onMode: (m) => this.store.set({ follow: m }),
    });
    this.follow.tilt3D = this.state.settings.view3D;
    this.puck.setCar(this.state.settings.carMarker, this.state.settings.carColor);
    this.applyCarModel(this.state.settings);
    // 3D on: open tilted so buildings stand up (the engine caps it; the demo map stays flat).
    if (this.follow.exploreTilt) this.engine.setView({ tilt: this.follow.exploreTilt, zoom: Math.max(16.2, this.engine.getView().zoom), duration: 1200 });
    this.engine.onUserGesture(() => { if (this.follow.mode !== 'none') this.follow.setMode('none'); });
    this.engine.onViewChange((v) => {
      if (Math.abs(v.azimuth - this.state.azimuth) > 0.5) this.store.set({ azimuth: v.azimuth });
      this.roadsForView(v.center, v.zoom);
    });
    if (this.roads && this.engine.setRoadDetails) {
      this.roads.onTile(() => { this.renderRoads(true); this.store.set({ roadsVersion: this.state.roadsVersion + 1 }); this.paintTrafficLanes(); });
      if ('onTrafficTiles' in this.engine) this.engine.onTrafficTiles = () => this.paintTrafficLanes();
      // The puck glides along the drawn (lane-aligned) line, not the road's centre line.
      this.store.select((s) => [s.navRoute, s.roadsVersion], () => this.syncDisplayRoute(), { equals: shallowEqualArray });
    }
    this.engine.onClick((e) => this.onMapTap(e));
    this.engine.onLongPress((e) => this.dropPin(e.coord));

    this.location.onFix((f) => this.onFix(f));
    this.location.onStatus((s) => {
      this.store.set({ locStatus: s });
      if (s === 'denied') this.toast('Location access is off — allow it in the browser to navigate.', 'warn', 6000);
    });
    if (this.cfg.demo) {
      this.location.push({ coord: DEMO_START, accuracy: 5, speed: 0, heading: 350, time: Date.now(), simulated: true });
    } else {
      this.location.start();
    }

    this.store.set({ trafficAvailable: this.engine.supportsTraffic });
    if (this.engine instanceof OsmEngine) {
      this.engine.onTrafficError = (msg) => {
        if (!this.state.trafficAvailable) return;
        this.store.set({ trafficAvailable: false });
        this.toast(msg, 'warn', 7000);
      };
    }
    if (this.state.settings.traffic) this.setTraffic(true);
    setInterval(() => this.applyTheme(), 5 * 60e3);
    setInterval(() => this.refreshWeather(), 15 * 60e3);
    this.refreshWeather();

    if (!this.measured) {
      this.measured = true;
      // Measure once the map has settled (tile loading right after init would skew it).
      new Promise((r) => setTimeout(r, 4000)).then(() => measureSluggish()).then((slow) => {
        this.measuredSlow = slow;
        if (slow && this.state.settings.glass === 'auto') this.applySettings(this.state.settings, false);
      });
    }
    window.addEventListener('resize', () => this.layoutListeners.forEach((l) => l()));

    // Watch frame pacing while driving; Auto glass steps down rather than let guidance stutter.
    this.store.select((s) => [s.navigating, s.material, s.settings.glass], () => {
      const s = this.state;
      if (s.navigating && s.settings.glass === 'auto' && s.material !== 'solid') this.frameGuard.start();
      else this.frameGuard.stop();
    }, { equals: shallowEqualArray as any });
  }

  /** Direction the glass is lit from, in screen degrees: the sun relative to the map's heading by day. */
  lightAngle(): number {
    const sun = sunPosition(new Date(), this.here());
    return sun.elevation > -2 ? sun.azimuth - this.state.azimuth : 320;
  }

  private resolveMaterial(s: Settings, slow: boolean): Material {
    const order: Material[] = ['liquid', 'frosted', 'solid'];
    // Low-power Tesla browsers get Solid; a device that merely measured slow keeps the glass but drops lensing.
    let m: Material = s.glass === 'auto' ? (likelyLowEnd ? 'solid' : slow || !lensSupported ? 'frosted' : 'liquid') : s.glass;
    if (m === 'liquid' && !lensSupported) m = 'frosted';
    if (s.glass === 'auto') m = order[Math.min(2, order.indexOf(m) + this.materialStep)];
    return m;
  }

  private stepDownMaterial() {
    if (this.state.material === 'solid' || this.state.settings.glass !== 'auto') return;
    this.materialStep++;
    this.applySettings(this.state.settings, false);
    this.toast(this.state.material === 'frosted' ? 'Glass lensing paused to keep the map smooth' : 'Using solid panels to keep the map smooth', 'info', 4500);
  }

  // ───────────────────────── lane-level road detail ─────────────────────────
  private roadsCenter: LngLat | null = null;
  private roadsKey = '';
  private roadsTimer = 0;

  /** Load lane detail around the view once zoomed in to street level (debounced). */
  private roadsForView(center: LngLat, zoom: number) {
    if (!this.roads || zoom < 15) return;
    this.roadsCenter = center;
    if (this.roadsTimer) return; // throttle: the view changes every frame while driving
    this.roadsTimer = window.setTimeout(() => {
      this.roadsTimer = 0;
      const c = this.roadsCenter!;
      this.roads!.request(this.roads!.around(c), 0);
      this.renderRoads(false);
    }, 600);
  }

  /** Draw the loaded tiles around the view. */
  private renderRoads(force: boolean) {
    const roads = this.roads;
    if (!roads || !this.engine.setRoadDetails || !this.roadsCenter) return;
    const keys = roads.around(this.roadsCenter).map(([x, y]) => `14/${x}/${y}`).filter((k) => roads.tiles.has(k));
    const sig = keys.join(' ');
    if (!force && sig === this.roadsKey) return;
    this.roadsKey = sig;
    this.engine.setRoadDetails(roads.scene(keys));
  }

  private trafficLanesTimer = 0;
  /** Paint live traffic onto the lane model (throttled; see nav/lanetraffic.ts). */
  private paintTrafficLanes() {
    if (this.trafficLanesTimer || !this.roads || !this.engine.trafficFeatures || !this.engine.setTrafficLanes) return;
    this.trafficLanesTimer = window.setTimeout(() => {
      this.trafficLanesTimer = 0;
      const feats = this.engine.trafficFeatures!();
      this.engine.setTrafficLanes!(feats.length ? trafficOnLanes(feats, this.roads!) : { type: 'FeatureCollection', features: [] });
    }, 400);
  }

  /** Give the puck the route as drawn on its lanes (and its heights) — after the follow controller has the route. */
  private syncDisplayRoute() {
    const r = this.state.navRoute;
    if (!r) return;
    const g = this.drawGeometry(r);
    this.follow.setDisplayCoords(g.coords, g.heights.length ? g.heights : null);
  }

  private xrayIds = '';
  /**
   * Structures the car is about to drive under (car on the ground, a deck within ~70 m ahead over
   * the route) are drawn see-through so the road below stays readable.
   */
  private updateXray() {
    if (!this.roads || !this.engine.setXray || !this.roadsCenter) return;
    const pos = this.follow.position;
    const ids: string[] = [];
    if (pos && this.follow.height < 0.3) {
      const h = this.follow.displayHeading || 0;
      const probes = [pos, destination(pos, h, 25), destination(pos, h, 50), destination(pos, h, 75)];
      const keys = this.roads.around(pos).map(([x, y]) => `14/${x}/${y}`);
      for (const k of keys) {
        const t = this.roads.tiles.get(k);
        if (!t) continue;
        for (const f of t.draw.ex || []) {
          if (f.properties.k !== 'deck' || f.properties.h < 2) continue;
          const ring = f.geometry.coordinates[0] as LngLat[];
          if (probes.some((p) => pointInRing(p, ring)) && !ids.includes(f.properties.s)) ids.push(f.properties.s);
        }
      }
    }
    const sig = ids.join(',');
    if (sig !== this.xrayIds) { this.xrayIds = sig; this.engine.setXray(ids); }
  }

  private laneSeen: { shift: number; n: number } = { shift: 0, n: 0 };
  /**
   * The car is drawn on the recommended lane; when GPS says it is really in another lane of the same
   * road for 3 fixes running (and the fix is good enough to tell lanes apart), it moves over there.
   */
  private trackLane(fix: Fix) {
    if (!this.session || !this.roads || !this.state.navRoute || !this.session.snap) return;
    let shift = 0;
    if (!fix.simulated && fix.heading !== null && (fix.accuracy || 99) <= 12) {
      const r = this.state.navRoute;
      const placed = this.drawGeometry(r);
      const d = this.session.snap.d;
      let i = 0;
      while (i < r.cum.length - 1 && r.cum[i + 1] < d) i++;
      const here = laneOfFix(fix.coord, fix.heading, this.roads.lanesAt(fix.coord));
      if (here && placed.lanes[i] >= 0 && placed.counts[i] === here.count) shift = (here.lane - placed.lanes[i]) * here.lw;
    }
    this.laneSeen = this.laneSeen.shift === shift ? { shift, n: this.laneSeen.n + 1 } : { shift, n: 1 };
    if (this.laneSeen.n >= 3 || shift === 0) this.follow.setLaneShift(shift);
  }

  private drawCache = new Map<string, { v: number; coords: LngLat[]; widths: number[]; lanes: number[]; counts: number[]; heights: number[] }>();
  /** Route geometry on its lanes (nav/laneroute.ts), plus the lane-band width per vertex (0 = no lane data). */
  drawGeometry(r: RouteResult): { coords: LngLat[]; widths: number[]; lanes: number[]; counts: number[]; heights: number[] } {
    if (!this.roads) return { coords: r.coords, widths: [], lanes: [], counts: [], heights: [] };
    const v = this.state.roadsVersion;
    const hit = this.drawCache.get(r.id);
    if (hit && hit.v === v) return hit;
    const placed = placeOnLanes(r.coords, r.cum, r.maneuvers, this.roads);
    const entry = { v, ...placed };
    if (this.drawCache.size > 12) this.drawCache.clear();
    this.drawCache.set(r.id, entry);
    return entry;
  }
  drawCoords(r: RouteResult): LngLat[] { return this.drawGeometry(r).coords; }

  /** Best current position: GPS fix, else the map centre, else the boot centre. */
  here(): LngLat {
    const f = this.state.fix;
    if (f) return f.coord;
    if (this.mapReady) return this.engine.getView().center;
    return this.bootCenter;
  }

  private onFix(fix: Fix) {
    const first = !this.state.fix;
    this.store.set({ fix });
    if (this.session) {
      this.session.handleFix(fix);
      this.follow.setFix(fix, this.session.snap ? this.session.snap.d : null);
      this.trackLane(fix);
    }
    if (this.roads) {
      this.updateXray();
    } else {
      this.follow.setFix(fix, null);
    }
    if (first) { this.refreshWeather(); this.applyTheme(); }
    if (!fix.simulated && Date.now() - this.lastSavedPos > 30000) {
      this.lastSavedPos = Date.now();
      storage.set('lastPos', fix.coord);
    }
  }

  // ───────────────────────── settings / appearance ─────────────────────────
  private applyCarModel(s: Settings) {
    if (this.engine.setCarModel) this.engine.setCarModel(s.carMarker === 'model', s.carColor);
  }

  updateSettings(patch: Partial<Settings>) {
    const settings = { ...this.state.settings, ...patch };
    if ('glass' in patch) this.materialStep = 0;
    storage.set('settings', settings);
    this.store.set({ settings });
    this.applySettings(settings, false);
    if ('themeMode' in patch) this.applyTheme();
    if ('traffic' in patch) this.setTraffic(!!patch.traffic);
    if ('carMarker' in patch || 'carColor' in patch) { this.puck.setCar(settings.carMarker, settings.carColor); this.applyCarModel(settings); }
    if ('view3D' in patch) {
      this.follow.tilt3D = !!patch.view3D;
      if (!this.state.navigating) this.engine.setView({ tilt: this.follow.exploreTilt, duration: 500 });
    }
    if ('avoidTolls' in patch && this.state.panel === 'planner') this.computeRoutes();
    if (['vehicleId', 'usableKWh', 'consumption', 'reserveSoc', 'maxChargeSoc'].some((k) => k in patch) && this.state.panel === 'planner') this.schedulePlan();
    if ('voice' in patch) this.voice.muted = this.state.muted || !settings.voice;
  }

  private applySettings(s: Settings, initial: boolean) {
    const root = document.documentElement;
    const scale = s.textSize === 'larger' ? 1.25 : s.textSize === 'large' ? 1.12 : 1;
    root.style.setProperty('--ui-scale', String(scale));
    setUnits(s.units);
    const slow = likelyLowEnd || this.measuredSlow;
    const lite = s.glass === 'solid' || (s.glass === 'auto' && slow);
    const material = this.resolveMaterial(s, slow);
    if (lite !== this.state.lite || material !== this.state.material || initial) this.store.set({ lite, material });
    this.voice.muted = this.state.muted || !s.voice;
    this.layoutListeners.forEach((l) => l());
  }

  applyTheme() {
    const s = this.state.settings;
    const theme = s.themeMode === 'auto' ? (isDaylight(new Date(), this.here()) ? 'light' : 'dark') : s.themeMode;
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b0d12' : '#f2f3f5');
    if (theme !== this.state.theme) {
      this.store.set({ theme });
      // Before init the engine is created with `theme` directly.
      if (this.mapReady) this.engine.setTheme(theme);
      // re-tint route lines for the new palette
      this.layoutListeners.forEach((l) => l());
    }
  }

  async setTraffic(on: boolean) {
    if (!this.engine.supportsTraffic) { this.store.set({ trafficAvailable: false }); return; }
    const ok = await this.engine.setTraffic(on);
    if (!ok && on) {
      this.store.set({ trafficAvailable: false });
      this.toast('Live traffic needs a Mapbox token (Settings → Map data).', 'info', 5000);
    }
  }

  async refreshWeather() {
    const w = await this.weather.get(this.here());
    if (w) this.store.set({ weatherHere: w });
  }

  toast(text: string, tone: 'info' | 'ok' | 'warn' | 'err' = 'info', ms = 3200) {
    const id = ++this.toastId;
    this.store.set({ toasts: this.state.toasts.filter((t) => t.text !== text).concat({ id, text, tone }).slice(-3) });
    setTimeout(() => this.store.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), ms);
  }

  // ───────────────────────── search ─────────────────────────
  openSearch() {
    this.store.set({ panel: 'search', collapsed: false, results: null });
  }

  cancelSearch() {
    this.store.set({ panel: 'home', query: '', suggestions: [], results: null, searching: false });
  }

  expandPanel() { this.store.set({ collapsed: false }); }
  collapsePanel() { this.store.set({ collapsed: true }); }

  setQuery(q: string) {
    this.store.set({ query: q, results: null, searching: !!q.trim() });
    clearTimeout(this.suggestTimer);
    if (!q.trim()) { this.store.set({ suggestions: [] }); return; }
    this.suggestTimer = window.setTimeout(() => this.runSuggest(q), 220);
  }

  private async runSuggest(q: string) {
    const id = ++this.seq.suggest;
    try {
      const list = await this.search.suggest(q, this.here());
      if (id !== this.seq.suggest) return;
      this.store.set({ suggestions: list, searching: false });
    } catch (e) {
      if (id !== this.seq.suggest) return;
      console.error(e);
      this.store.set({ searching: false, suggestions: [] });
      this.toast('Search is unavailable — check your connection.', 'err');
    }
  }

  async runCategory(cat: Category) {
    const id = ++this.seq.suggest;
    this.store.set({ panel: 'search', collapsed: false, searching: true, results: { title: cat.label, categoryId: cat.id, places: [] } });
    try {
      const near = this.here();
      let places = cat.id === 'chargers' ? await this.chargers.near(near) : await this.search.category(cat.id, cat.query, near);
      if (id !== this.seq.suggest) return;
      places = places.filter((p) => p.coord).map((p) => ({ ...p, category: p.category || cat.id, distance: p.distance !== undefined ? p.distance : distance(near, p.coord!) }));
      this.store.set({ searching: false, results: { title: cat.label, categoryId: cat.id, places } });
      if (places.length) this.fit(places.slice(0, 12).map((p) => p.coord!).concat([near]));
      else this.toast(`No ${cat.label.toLowerCase()} found nearby`, 'info');
      if (places.length) this.addDriveTimes(id, near, places, cat);
    } catch (e) {
      console.error(e);
      if (id === this.seq.suggest) this.store.set({ searching: false, results: null, panel: 'home' });
      this.toast('Search failed. Try again.', 'err');
    }
  }

  /** Rank nearby results by real driving time with traffic (Mapbox Matrix) once it arrives. */
  private async addDriveTimes(id: number, near: LngLat, places: Place[], cat: Category) {
    if (!this.matrix || !this.matrix.available) return;
    const head = places.slice(0, 18);
    try {
      const times = await this.matrix.from(near, head.map((p) => p.coord!));
      if (id !== this.seq.suggest) return;
      const timed = head.map((p, i) => (times[i] ? { ...p, eta: times[i]!.duration } : p));
      timed.sort((a, b) => (a.eta !== undefined ? a.eta : 1e9) - (b.eta !== undefined ? b.eta : 1e9) || (a.distance || 0) - (b.distance || 0));
      this.store.set({ results: { title: cat.label, categoryId: cat.id, places: timed.concat(places.slice(18)) } });
    } catch (e) {
      console.warn('[matrix] drive times unavailable', e);
    }
  }

  showSaved() {
    const s = this.state;
    const places = [s.home, s.work, ...s.favorites].filter(Boolean) as Place[];
    this.store.set({ panel: 'search', collapsed: false, query: '', results: { title: 'Saved Places', places: places.map((p) => ({ ...p, distance: p.coord ? distance(this.here(), p.coord) : undefined })) } });
  }

  async openPlace(p: Place) {
    const id = ++this.seq.place;
    this.store.set({ panel: 'place', place: p, placeEta: null, collapsed: false });
    let place = p;
    if (!p.coord) {
      try {
        place = await this.search.resolve(p);
      } catch {
        if (id === this.seq.place) { this.toast('Couldn’t locate that place.', 'err'); this.store.set({ panel: 'search' }); }
        return;
      }
      if (id !== this.seq.place) return;
      this.store.set({ place });
    }
    this.flyTo(place.coord!, 16);
    this.addRecent(place);
    // Prefetch the route: shows the drive time on the Directions button, and makes Directions instant.
    try {
      const tolls = this.state.settings.avoidTolls;
      const routes = await this.routing.route({ points: [this.here(), place.coord!], avoidTolls: tolls });
      if (id !== this.seq.place) return;
      this.prefetch = { placeId: place.id, tolls, at: Date.now(), routes };
      this.store.set({ placeEta: { placeId: place.id, duration: routes[0].duration, distance: routes[0].distance } });
    } catch { /* ETA is optional */ }
  }

  closePlace() {
    const s = this.state;
    this.seq.place++;
    this.store.set({ panel: s.results || s.suggestions.length ? 'search' : 'home', place: null, droppedPin: null });
  }

  async dropPin(coord: LngLat) {
    if (this.state.navigating) return;
    const pin: Place = { id: `pin:${coord[0].toFixed(5)},${coord[1].toFixed(5)}`, name: 'Dropped Pin', subtitle: `${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}`, coord, kind: 'pin' };
    this.store.set({ droppedPin: pin });
    this.openPlace(pin);
    const r = await this.search.reverse(coord).catch(() => null);
    if (r && this.state.place && this.state.place.id === pin.id) {
      const named = { ...pin, name: r.name || pin.name, subtitle: r.subtitle ? `Dropped pin · ${r.subtitle}` : pin.subtitle };
      this.store.set({ place: named, droppedPin: named });
    }
  }

  private onMapTap(e: MapClick) {
    const s = this.state;
    if (s.navigating) return;
    if (e.poi) {
      this.openPlace({ id: `poi:${e.poi.coord[0].toFixed(5)},${e.poi.coord[1].toFixed(5)}`, name: e.poi.name, subtitle: e.poi.subtitle, coord: e.poi.coord, kind: 'business' });
      return;
    }
    if (s.panel === 'home') this.store.set({ collapsed: !s.collapsed });
    else if (s.panel === 'place') this.closePlace();
    else if (s.panel === 'search' && !s.query && !s.results) this.cancelSearch();
  }

  // ───────────────────────── saved places ─────────────────────────
  setHome(p: Place) { const v = { ...p, distance: undefined }; storage.set('home', v); this.store.set({ home: v }); this.toast('Saved as Home', 'ok'); }
  setWork(p: Place) { const v = { ...p, distance: undefined }; storage.set('work', v); this.store.set({ work: v }); this.toast('Saved as Work', 'ok'); }
  isFavorite(p: Place) { return this.state.favorites.some((f) => samePlace(f, p)); }
  toggleFavorite(p: Place) {
    const favs = this.isFavorite(p) ? this.state.favorites.filter((f) => !samePlace(f, p)) : [{ ...p, distance: undefined }, ...this.state.favorites].slice(0, 30);
    storage.set('favorites', favs);
    this.store.set({ favorites: favs });
  }
  addRecent(p: Place) {
    if (!p.coord) return;
    const recents = [{ ...p, distance: undefined }, ...this.state.recents.filter((r) => !samePlace(r, p))].slice(0, 15);
    storage.set('recents', recents);
    this.store.set({ recents });
  }
  clearRecents() { storage.set('recents', []); this.store.set({ recents: [] }); }

  // ───────────────────────── routing & EV planning ─────────────────────────
  async directions(p: Place) {
    if (!p.coord) { await this.openPlace(p); return; }
    this.store.set({
      panel: 'planner', destination: p, routes: [], routeIndex: 0, routing: true, plan: null, routeError: null, skipped: [], chargers: [], weatherDest: null, collapsed: false,
      query: '', suggestions: [], results: null,
    });
    this.addRecent(p);
    await this.computeRoutes();
  }

  async computeRoutes() {
    const id = ++this.seq.route;
    const s = this.state;
    const dest = s.destination;
    if (!dest || !dest.coord) return;
    this.store.set({ routing: true, routeError: null, plan: null });
    let routes: RouteResult[];
    try {
      const pf = this.prefetch;
      if (pf && pf.placeId === dest.id && pf.tolls === s.settings.avoidTolls && Date.now() - pf.at < 120000) routes = pf.routes;
      else routes = await this.routing.route({ points: [this.here(), dest.coord], avoidTolls: s.settings.avoidTolls });
    } catch (e) {
      console.error(e);
      if (id === this.seq.route) this.store.set({ routing: false, routeError: 'Couldn’t find a driving route. Check your connection.' });
      return;
    }
    if (id !== this.seq.route) return;
    this.prefetch = null;
    this.baseRoutes = routes;
    const v = vehicleById(s.settings.vehicleId);
    const temp = s.weatherHere ? s.weatherHere.tempC : undefined;
    this.store.set({ routes: routes.slice(), routeIndex: 0, routing: false, quickSoc: routes.map((r) => quickArrival(r, s.battery, v, s.settings, temp)) });
    this.fitRoute(routes[0]);
    this.planSelected();
    // "via" labels and destination weather — best effort, in the background
    // Name each route by a road it uses, unless the router already did (Mapbox's summary).
    routes.filter((r) => !r.via).forEach((r) => this.search.reverse(midpoint(r)).then((rv) => {
      if (rv && id === this.seq.route) { r.via = rv.street || rv.name; this.store.set({ routes: this.state.routes.slice() }); }
    }).catch(() => {}));
    this.weather.get(dest.coord, Date.now() + routes[0].duration * 1000).then((w) => { if (id === this.seq.route) this.store.set({ weatherDest: w }); });
  }

  selectRoute(i: number) {
    if (i === this.state.routeIndex) return;
    this.store.set({ routeIndex: i, routes: this.baseRoutes.slice(), plan: null, skipped: [] });
    this.fitRoute(this.baseRoutes[i]);
    this.planSelected();
  }

  setBattery(v: number) {
    const battery = Math.max(5, Math.min(100, Math.round(v)));
    storage.set('battery', battery);
    const s = this.state;
    const veh = vehicleById(s.settings.vehicleId);
    const temp = s.weatherHere ? s.weatherHere.tempC : undefined;
    this.store.set({ battery, quickSoc: this.baseRoutes.map((r) => quickArrival(r, battery, veh, s.settings, temp)) });
    if (s.panel === 'planner') this.schedulePlan();
  }

  skipCharger(id: string) {
    this.store.set({ skipped: this.state.skipped.concat(id) });
    this.planSelected();
  }

  private schedulePlan() {
    clearTimeout(this.planTimer);
    this.planTimer = window.setTimeout(() => this.planSelected(), 350);
  }

  async planSelected() {
    const id = ++this.seq.plan;
    try {
      await this.planSelectedInner(id);
    } catch (e) {
      console.error('[plan]', e);
      if (id === this.seq.plan) this.store.set({ planBusy: false });
    }
  }

  private async planSelectedInner(id: number) {
    const s = this.state;
    const base = this.baseRoutes[s.routeIndex];
    if (!base || !s.destination || !s.destination.coord) return;
    this.store.set({ planBusy: true });
    const v = vehicleById(s.settings.vehicleId);
    const [elev, wx] = await Promise.all([
      this.weather.elevation(base).catch(() => null),
      s.weatherHere ? Promise.resolve(s.weatherHere) : this.weather.get(this.here()).catch(() => null),
    ]);
    if (id !== this.seq.plan) return;
    const tempC = wx ? wx.tempC : undefined;
    const settings = this.state.settings;
    const battery = this.state.battery;
    let model = energyModel(base, v, settings, elev || undefined, tempC);
    let plan = planTrip({ route: base, model, chargers: [], startSoc: battery, vehicle: v, settings, skip: [], elevation: elev || undefined, tempC });
    let display = base;
    let chargers: Place[] = [];
    if (plan.arrivalSoc < settings.reserveSoc) {
      chargers = await this.chargers.alongRoute(base).catch(() => [] as Place[]);
      if (id !== this.seq.plan) return;
      plan = planTrip({ route: base, model, chargers, startSoc: battery, vehicle: v, settings, skip: this.state.skipped, elevation: elev || undefined, tempC });
      if (plan.stops.length) {
        try {
          const points = [this.here(), ...plan.stops.map((st) => st.place.coord!), s.destination.coord];
          const [via] = await this.routing.route({ points, waypointLabels: plan.stops.map((st) => st.place.name), avoidTolls: settings.avoidTolls });
          if (id !== this.seq.plan) return;
          via.via = base.via;
          const elev2 = await this.weather.elevation(via).catch(() => null);
          if (id !== this.seq.plan) return;
          model = energyModel(via, v, settings, elev2 || elev || undefined, tempC);
          plan = evaluateStops(via, model, plan.stops, battery, v, settings, { elevation: elev2 || elev || undefined, tempC });
          display = via;
        } catch (e) {
          console.warn('[plan] could not route via chargers', e);
        }
      }
    }
    this.energy = model;
    const routes = this.baseRoutes.slice();
    routes[s.routeIndex] = display;
    this.store.set({ plan, planBusy: false, chargers, routes });
  }

  // ───────────────────────── navigation ─────────────────────────
  startNavigation(forceSim = false) {
    const s = this.state;
    const route = s.routes[s.routeIndex];
    const dest = s.destination;
    if (!route || !dest) return;
    this.voice.unlock();
    this.voice.muted = s.muted || !s.settings.voice;
    const v = vehicleById(s.settings.vehicleId);
    const energy = this.energy || energyModel(route, v, s.settings);
    this.session = new NavigationSession(route, s.plan, energy, {
      voice: this.voice,
      destinationName: dest.name,
      usableKWh: s.settings.usableKWh || v.usableKWh,
      reverse: (c) => this.search.reverse(c).then((r) => (r ? r.street || r.name : null)),
      onSnapshot: (snap) => {
        // Router knows no limit here: fall back to OpenStreetMap's maxspeed for the road we're on.
        if (snap.speedLimit === null && this.roads && this.state.fix) snap.speedLimit = this.roads.speedLimitAt(this.follow.position || this.state.fix.coord, this.follow.displayHeading);
        this.store.set({ nav: snap });
        this.follow.setManeuverDistance(snap.distToManeuver);
      },
      onReroute: (from) => this.reroute(from),
      onArrive: () => this.store.set({ arrived: true }),
    });
    this.store.set({ navigating: true, navRoute: route, nav: null, arrived: false, tripOpen: false, rerouting: false });
    if (this.roads) this.roads.request(this.roads.along(route.coords), 1);
    this.follow.setNavigation(route);
    this.syncDisplayRoute();
    this.follow.tilt3D = s.settings.view3D;
    this.follow.setMode('course');
    const simulate = forceSim || this.cfg.demo || this.cfg.autoSimulate || s.locStatus !== 'ok';
    if (simulate) {
      this.location.simulate(route, s.simSpeed);
      this.store.set({ simulating: true });
      if (!this.cfg.demo && !forceSim) this.toast('No GPS — running a simulated drive.', 'info', 4000);
    } else if (s.fix) {
      this.onFix(s.fix);
    }
    this.voice.say(`Starting route to ${dest.name}`);
    clearInterval(this.trafficTimer);
    if (this.cfg.mapboxToken && !this.cfg.demo) this.trafficTimer = window.setInterval(() => this.refreshTraffic(), TRAFFIC_REFRESH);
  }

  endNavigation() {
    clearInterval(this.trafficTimer);
    this.trafficTimer = 0;
    const pos = this.follow.position;
    this.location.stopSimulation();
    this.session = null;
    this.voice.stop();
    this.follow.setNavigation(null);
    this.store.set({
      navigating: false, nav: null, navRoute: null, arrived: false, simulating: false, rerouting: false, tripOpen: false,
      panel: 'home', collapsed: false, routes: [], plan: null, destination: null, chargers: [], place: null,
      query: '', suggestions: [], results: null,
    });
    this.follow.setMode('follow');
    this.engine.setView({ tilt: this.follow.exploreTilt, azimuth: 0, zoom: 16.5, duration: 900 });
    if ((this.cfg.demo || this.state.locStatus !== 'ok') && pos) {
      this.location.push({ coord: pos, accuracy: 5, speed: 0, heading: this.follow.displayHeading, time: Date.now(), simulated: true });
    }
  }

  /** Route from `from` through the charging stops still ahead to the destination. */
  private routeOnward(from: LngLat) {
    const s = this.state;
    const sess = this.session!;
    const progress = s.nav ? s.nav.progress : 0;
    const remainingStops = sess.plan ? sess.plan.stops.filter((st) => st.distAlong > progress + 20) : [];
    const request = this.routing.route({
      points: [from, ...remainingStops.map((st) => st.place.coord!), s.destination!.coord!],
      waypointLabels: remainingStops.map((st) => st.place.name),
      avoidTolls: s.settings.avoidTolls,
    });
    return { request, remainingStops };
  }

  /** Swap the route being driven (reroute, traffic update, faster route). */
  private adoptRoute(r: RouteResult, remainingStops: ChargeStop[], restartSim: boolean) {
    const s = this.state;
    const sess = this.session!;
    const plan = sess.plan;
    const v = vehicleById(s.settings.vehicleId);
    const model = energyModel(r, v, s.settings, undefined, plan ? plan.tempC : undefined);
    const soc = s.nav && s.nav.socNow !== null ? s.nav.socNow : s.battery;
    const plan2 = plan ? evaluateStops(r, model, remainingStops, soc, v, s.settings, { tempC: plan.tempC }) : null;
    sess.setRoute(r, plan2, model);
    this.follow.setNavigation(r);
    this.syncDisplayRoute();
    if (this.roads) this.roads.request(this.roads.along(r.coords), 1);
    this.store.set({ navRoute: r, rerouting: false, plan: plan2 });
    if (restartSim && this.state.simulating) this.location.simulate(r, this.state.simSpeed);
  }

  private async reroute(from: LngLat) {
    const s = this.state;
    const sess = this.session;
    if (!sess || !s.destination || !s.destination.coord) return;
    this.store.set({ rerouting: true });
    try {
      const { request, remainingStops } = this.routeOnward(from);
      const [r] = await request;
      if (this.session !== sess) return;
      this.adoptRoute(r, remainingStops, true);
    } catch (e) {
      console.error(e);
      this.store.set({ rerouting: false });
      this.toast('Couldn’t reroute — retrying shortly.', 'warn');
    }
  }

  /**
   * Live traffic while driving (Mapbox): every few minutes ask again from where the car is.
   * Same roads → quietly take the fresh ETA and traffic colours. A different route that saves
   * at least 3 minutes → switch to it and say so. Otherwise keep going as planned.
   */
  private async refreshTraffic() {
    const s = this.state;
    const sess = this.session;
    if (!sess || !s.navigating || s.rerouting || s.arrived || !s.nav || !s.destination || !s.destination.coord) return;
    const from = this.follow.position || (s.fix && s.fix.coord);
    if (!from || s.nav.remaining < 800) return;
    let r: RouteResult;
    let remainingStops: ChargeStop[];
    try {
      const o = this.routeOnward(from);
      remainingStops = o.remainingStops;
      [r] = await o.request;
    } catch (e) {
      console.warn('[traffic] refresh failed', e);
      return;
    }
    if (this.session !== sess || !this.state.navigating || this.state.rerouting || !r.trafficAware) return;
    const old = sess.route;
    const oldLeft = sess.remainingDriveTime();
    const progress = this.state.nav ? this.state.nav.progress : 0;
    // Does the new route follow the roads we're already on? Sample it against the current route.
    const samples = [0.15, 0.35, 0.55, 0.75, 0.95].map((f) => pointAt(r.coords, r.cum, f * r.distance).coord);
    const same = samples.every((p) => {
      const pr = projectOnRoute(old.coords, old.cum, p, Math.max(0, progress - 50));
      return !!pr && pr.offset < 35;
    });
    if (same) {
      this.adoptRoute(r, remainingStops, false);
      const delta = Math.round((r.duration - oldLeft) / 60);
      if (Math.abs(delta) >= 3) this.toast(delta > 0 ? `Traffic ahead: ETA ${delta} min later` : `Traffic cleared: ETA ${-delta} min earlier`, delta > 0 ? 'warn' : 'ok', 5000);
    } else if (r.duration < oldLeft - 180 && r.duration < oldLeft * 0.92) {
      const saves = Math.round((oldLeft - r.duration) / 60);
      this.adoptRoute(r, remainingStops, true);
      this.toast(`Faster route found — saves ${saves} min`, 'ok', 6000);
      this.voice.say(`Faster route found. It saves ${saves} minutes.`);
    }
  }

  setSimSpeed(x: number) { this.location.setSimSpeed(x); this.store.set({ simSpeed: x }); }
  /** Jump the simulated drive to a fraction (0–1) of the route. */
  setSimProgress(frac: number) { this.location.setSimProgress(frac); }
  toggleMute() {
    const muted = !this.state.muted;
    storage.set('muted', muted);
    this.voice.muted = muted || !this.state.settings.voice;
    if (muted) this.voice.stop();
    this.store.set({ muted });
  }

  overview() {
    const s = this.state;
    const r = s.navRoute;
    if (!r) return;
    this.follow.setMode('none');
    const from = s.nav ? s.nav.progress : 0;
    this.engine.fitBounds(padBounds(boundsOf(slice(r.coords, r.cum, from, r.cum[r.cum.length - 1]))), this.padding(true), 700);
  }

  recenter() {
    if (!this.state.fix) { this.toast('Waiting for location…', 'info'); return; }
    this.follow.setMode(this.state.navigating ? 'course' : 'follow');
  }

  cycleLocate() {
    if (!this.state.fix) { this.toast(this.state.locStatus === 'denied' ? 'Location access is off.' : 'Waiting for location…', 'info'); return; }
    const next: FollowMode = this.follow.mode === 'none' ? 'follow' : this.follow.mode === 'follow' ? 'course' : 'follow';
    this.follow.setMode(next);
  }

  northUp() {
    if (this.follow.mode === 'course') this.follow.setMode('follow');
    this.engine.setView({ azimuth: 0, duration: 400 });
  }

  zoomBy(dz: number) {
    const v = this.engine.getView();
    this.engine.setView({ zoom: Math.max(3, Math.min(20, v.zoom + dz)), duration: 250 });
  }

  // ───────────────────────── camera helpers ─────────────────────────
  /** UI insets so routes and results never hide behind the cards. */
  padding(forFit = false): Padding {
    const s = this.state;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const panel = document.querySelector('.panel, .maneuver') as HTMLElement | null;
    const pw = panel ? panel.getBoundingClientRect().width : Math.min(440, w * 0.31);
    const edge = 16;
    const narrow = w < 760;
    const side = s.settings.driverSide;
    if (s.navigating && !forFit) {
      return { top: h * 0.4, bottom: h * 0.06, left: side === 'left' && !narrow ? pw * 0.55 : 0, right: side === 'right' && !narrow ? pw * 0.55 : 0 };
    }
    const extra = forFit ? 56 : 0;
    const panelOpen = !narrow && (s.navigating || !s.collapsed || s.panel !== 'home');
    const controls = narrow ? 0 : 88;
    const sideL = side === 'left' ? (panelOpen ? pw + edge * 2 : edge) : controls + edge;
    const sideR = side === 'left' ? controls + edge : (panelOpen ? pw + edge * 2 : edge);
    return {
      top: edge + extra + (s.navigating ? 120 : 0),
      bottom: (narrow && panelOpen ? h * 0.55 : edge) + extra + (s.navigating ? 110 : 0),
      left: sideL + extra,
      right: sideR + extra,
    };
  }

  fit(coords: LngLat[]) {
    if (!coords.length) return;
    this.follow.setMode('none');
    this.engine.fitBounds(padBounds(boundsOf(coords)), this.padding(true), 650);
  }

  fitRoute(r: RouteResult) { this.fit(r.coords); }

  flyTo(c: LngLat, zoom: number) {
    this.follow.setMode('none');
    this.engine.setPadding(this.padding(false));
    this.engine.setView({ center: c, zoom: Math.max(zoom, Math.min(17, this.engine.getView().zoom)), duration: 650 });
  }
}

function samePlace(a: Place, b: Place) {
  if (a.id === b.id) return true;
  return !!(a.coord && b.coord && distance(a.coord, b.coord) < 15 && a.name === b.name);
}

export const IS_TESLA = isTesla;
