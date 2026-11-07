# Teslaplay — navigation for Tesla's in-car browser

A web navigation app built to run in Tesla's built-in browser in places where the car's own
navigation falls short (Georgia, much of Central Asia). The map is OpenStreetMap data in its own "Drive"
style (MapLibre GL + OpenFreeMap tiles, 3D buildings), live traffic comes from Mapbox, and it adds EV trip
planning, turn-by-turn guidance and an interface in Apple's Liquid Glass design language, sized for a car screen.

- **Zero runtime dependencies.** TypeScript compiled to one ~179 KB script (≈60 KB gzipped) plus ~42 KB of CSS. It stays light on older Tesla hardware (MCU2).
- **Runs without any key.** Map, search, places, chargers and routing are free OpenStreetMap services; a Mapbox token adds live traffic.
- **Demo mode** runs without network access, so you can work on the UI offline.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173/?demo=1  (live-reloading dev server)
npm run typecheck    # tsc --noEmit
npm run build        # → dist/  static files, deploy anywhere
npm run build:demo   # → dist-demo/teslaplay-demo.html  one self-contained offline demo
```

URL switches: `?demo=1` (offline demo) · `?sim=1` (always simulate the drive) · `?mapbox=pk.…` (try a Mapbox token without saving it) · `?lang=ka_GE` · `?tesla=1` (force Tesla tuning on a desktop browser).

## Keys and configuration

Edit **`public/config.js`** (copied to `dist/config.js`; you can change it on the server without rebuilding). You can also enter keys in the app under **Settings → Map data**; those are stored only in that browser.

| Key | Where | Used for | If it's missing |
|---|---|---|---|
| `mapboxToken` | account.mapbox.com → *Tokens* (public `pk.` token) | live traffic: traffic-aware routes and ETAs (Directions `driving-traffic`), traffic colours on the map (Traffic v1 tiles) and on the route, drive times on nearby results (Matrix), ETA re-checked every 4 minutes while driving with "faster route" switching | routes from OpenStreetMap (public OSRM server) without traffic |
| `openChargeMapKey` | openchargemap.org → My profile → API keys (free) | charger power and connector data | chargers come from OpenStreetMap (Overpass, incl. GB/T and power where mapped) |
| `mapLang` | — | label and search language: `en_US`, `ka_GE`, `ru_RU`, `uk_UA`, `tr_TR` | English |

Always free, no key: map tiles (OpenFreeMap), search (Photon), nearby places and chargers (Overpass), weather and elevation (Open-Meteo).

**Mapbox free tier** (enough for one car): 100,000 directions requests, 100,000 matrix elements and 200,000 vector tile requests a month. Restrict the token to your site under *URL restrictions* (e.g. `https://gagatsintsadze.github.io/teslaplay/`); the page sends its full URL as referrer so a path restriction matches. Live traffic in Georgia is covered by Mapbox's real-time + typical traffic.

**Settings → Map services → Check services** tests every service from that browser (map tiles, Mapbox routes, traffic tiles and drive times, OSRM, Photon, Overpass, Open Charge Map, weather, GPS) and shows what the app is using for each job; *Copy report* puts the results on the clipboard.

## Deploying

**Quickest:** build (or use the pre-built `dist/` folder in the zip), then drag the `dist` folder into *Cloudflare Pages → Create → Upload assets* or *Netlify → Add new site → Deploy manually*. Add the resulting URL to the Mapbox token's URL restrictions.

Any static host with **HTTPS** works; geolocation requires it (Cloudflare Pages, Netlify, Vercel, GitHub Pages, nginx). Asset paths are relative, so it also works from a sub-path. In the car, open the URL, allow location when asked, and bookmark it.

## Tesla browser notes
- **GPS:** `navigator.geolocation` works in the Tesla browser, but several firmware versions have been reported to freeze the position stream. `LocationService` derives speed and heading when they're missing, holds the heading while stopped, and runs a watchdog that restarts the watch after 12 s of silence.
- **Voice:** Tesla's Linux Chromium may not have any speech voices. Prompts then fall back to a soft chime, and the banner carries the details.
- **Performance:** Settings → Glass defaults to *Auto*: Liquid on capable Chromium, Solid on low-core Tesla browsers, Frosted (no lensing) when frame pacing measures under 40 fps a few seconds after start. While driving, Auto also watches the frame rate and steps down (Liquid → Frosted → Solid) if the map stutters for 6 s, with a short notice.
- **Layout:** cards sit on the driver side (left by default, switchable in Settings), touch targets are ≥ 56 px, and the Tesla browser gets the *Large* text size by default. There's no hover-only UI.
- **Fullscreen:** the community `youtube.com/redirect?q=<your-url>` trick opens a site fullscreen, but Tesla only allows fullscreen while parked. The app is designed for the normal windowed browser.
- **Compatibility:** syntax is down-levelled to Chrome 79. CSS uses flexbox `gap` (Chrome 84+), which every reasonably recent Tesla firmware supports.

## Design: Liquid Glass

The interface follows Apple's Liquid Glass design language (iOS / iPadOS 26), adapted for the web and a car screen:

- **Two layers.** The map is the content layer and stays clear of glass. Everything you touch — the driver-side panel, the control column, the guidance banner, the trip bar, toasts — floats above it in a functional layer of glass. Glass never sits on glass; inside a panel, cards and buttons use vibrant fills.
- **The material.** Regular glass only (never mixed with the clear variant). Each glass element bends the map beneath it through a lens: an SVG displacement map shaped to that element's size and corner radius, applied with `backdrop-filter` (`ui/glass.ts`). The middle stays flat and the edge refracts, like a thick pane. Large glass is thicker: more blur, deeper shadows and softer scattering. The rims carry a specular highlight lit from the sun's direction relative to the map heading (`core/sun.ts`), with a fixed top-left light at night.
- **Response to touch.** Glass lights up from the fingertip, and nearby glass catches a little of that light. Floating controls swell slightly under the finger and spring back. New glass materializes, growing into place rather than fading in. Toggle and slider knobs turn into glass while you drag them.
- **Shape.** Controls are capsules. Nested shapes are concentric: the panel radius equals the search field's capsule radius plus the panel padding. When the panel collapses to just the search field, it is already a capsule. Map controls are grouped by function (settings · layers · compass … zoom · locate) and use icons only.
- **Tint with purpose.** Only primary actions carry colour (Directions, Go, End Route), as tinted glass rather than flat fills.
- **Hierarchy.** Scroll edges dissolve content under the panel's edges instead of using divider lines. Section headers use title case. Rows are taller. Settings is an inspector that grows out of the gear button, on thicker and more opaque glass, while the rest of the interface recedes. While driving, map controls fade away after 6 s idle; a tap brings them back.
- **Fallbacks and accessibility.** Lensing needs Chromium (the Tesla browser is Chromium). Elsewhere glass is *Frosted*. *Solid* is used for low-power cars, and also when the system asks for reduced transparency. Increase Contrast switches to black or white surfaces with a contrasting border. Reduce Motion removes the elastic effects.

## Architecture

```
src/
  main.ts            boot: config → onboarding or app, mounts UI
  app.ts             controller: state + intent methods (search, directions, plan, navigate, reroute…)
  state.ts           AppState shape, defaults, persisted settings
  mapsync.ts         keeps routes / pins / insets on the map in sync with state
  map/
    engine.ts        MapEngine interface (the only thing the app knows about maps)
    osm.ts           the map (self-hosted MapLibre GL): routes with traffic colours, Mapbox traffic layer, ghosted buildings on the route, turn arrows
    style.ts         "Drive" map style on OpenFreeMap tiles: real-width asphalt roads with markings, 3D buildings, labels
    lanes.ts         lane-level features from OSM tags: lane-width carriageways, lane lines, painted arrows
    arrows.ts        painted turn-arrow shapes (map icons + banner glyphs), traffic-light icon
    demo.ts          offline Web-Mercator engine used by demo mode
    markers.ts       pins, charger badges, the user puck
    gestures.ts      detects real user pans/zooms → drops out of follow mode
  nav/
    session.ts       turn-by-turn: map-matching, progress, ETA, off-route → reroute, voice prompts
    follow.ts        60 fps puck interpolation between 1 Hz GPS fixes + follow / heading-up camera
  services/
    search.ts        search on OpenStreetMap (Photon search-as-you-type, Overpass categories, reverse geocoding)
    routing.ts       RouteResult builder + router chain (Mapbox live traffic, then OSRM)
    mapbox.ts        Mapbox: driving-traffic routes with real maneuvers, lanes, speed limits, signals and congestion; Matrix drive times; traffic tiles
    roads.ts         lane detail: pre-built OSM tiles (roads-data branch), Overpass fallback, IndexedDB cache, speed-limit lookup
    osrm.ts          OpenStreetMap routing (public OSRM server), no traffic
    maneuvers.ts     builds turn instructions from route geometry for routers without them
    ev.ts            vehicle presets, energy model, charging-stop planner
    chargers.ts      Open Charge Map along-route search, OpenStreetMap fallback
    osm.ts           OpenStreetMap services: Photon search, Overpass categories and chargers
    diagnostics.ts   Settings → Map services: live check of every service + copyable report
    weather.ts       Open-Meteo weather at origin/destination + elevation profile
    location.ts      GPS with Tesla workarounds + route simulator
    voice.ts         speech synthesis with chime fallback
    demo*.ts         demo data, street graph, mock services
  ui/                panel (search / place / planner), controls, navigation HUD, settings, icons, glyphs
    glass.ts         Liquid Glass engine: per-element lens filters, sun-lit rims, touch light, frame-rate guard
    segmented.ts     segmented control with a sliding thumb
styles/              design tokens + Liquid Glass material + component styles (light/dark)
scripts/roads/       build.py: Geofabrik extract → road-detail tiles (run by .github/workflows/roads.yml)
```

### Turn-by-turn and live traffic
With a Mapbox token, routes come from Mapbox Directions (`driving-traffic`): real maneuvers (turns, forks, roundabouts) with street names, ETAs from real-time + typical traffic, and congestion for every segment. Slow stretches are drawn over the blue route in orange/red, the route card shows the delay against a normal day, and while driving the route is re-checked every 4 minutes from the car's position: same roads → fresher ETA and colours; a different route that saves 3+ minutes → switch, with a spoken notice. Without a token, OSRM supplies routes and street names, and `services/maneuvers.ts` rebuilds the turns from the geometry.

### Lane-level roads
OpenStreetMap lane data — `lanes`, `lanes:forward/backward`, `turn:lanes`, `maxspeed`, `divider` and `highway=traffic_signals` — is pre-built for all of Georgia by **`.github/workflows/roads.yml`**: every Monday (or on demand: *Actions → Road details → Run workflow*) it downloads the Geofabrik extract (`europe/georgia`), runs `scripts/roads/build.py` and publishes zoom-14 tiles (~1.8 km, 4–60 KB each) to the **`roads-data`** branch. The app (`services/roads.ts`) loads them from raw.githubusercontent.com and keeps them in IndexedDB; only if that branch isn't published does it fall back to Overpass (slow, rate-limited). To cover neighbouring countries, add Geofabrik regions to `REGIONS` in the workflow (e.g. `asia/armenia asia/azerbaijan`).

`map/lanes.ts` turns the tags into carriageways as wide as their lanes, dashed lane lines, double/solid centre lines, edge lines, painted turn arrows 16 m and 52 m before junctions (`map/arrows.ts` draws them, and the same shapes in the banner) and upright traffic-light icons (from zoom ~16). While driving, the speed-limit sign uses Mapbox's `maxspeed` along the route, else the OSM `maxspeed` of the road you're on; it pulses red at 5+ km/h over. Mapbox lane data at each maneuver feeds the lane-guidance row under the turn banner. Coverage follows OpenStreetMap: very good in Tbilisi and Batumi, good in Kutaisi, Rustavi and on the E60, sparser in small towns (roads without lane tags keep the default two-lane look).

### EV model
For each section of the route: base Wh/km (vehicle preset or your override) × a speed factor (taken from that step's average speed) × a temperature factor (heating/AC), plus climbs and descents from the elevation profile (climbs cost ÷0.9, descents recover ×0.65). The planner drives as far as your arrival reserve allows, picks the most powerful charger within the last 40 km of range, charges just enough to finish (capped at your charge limit), and repeats. It then re-routes through the chosen chargers and re-checks the plan on that exact route. The vehicle figures are estimates: set your real usable kWh and consumption in Settings.

## Ideas for next steps
- **Tesla Fleet API** (needs a small backend and OAuth): real battery %, sending the destination to the car, preconditioning before Superchargers.
- Georgian and Russian UI strings (the UI text is centralized enough to extract).
- Bus lanes (`bus:lanes` / `psv:lanes` are well mapped in Tbilisi) painted on the road.
- English street names in the turn banner (Mapbox returns Georgian names; OSM `name:en` could replace them).
- An offline app shell (service worker) for patchy LTE, with recently used map tiles cached.
