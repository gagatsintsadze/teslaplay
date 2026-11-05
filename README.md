# Teslaplay — navigation for Tesla's in-car browser

A web navigation app built to run in Tesla's built-in browser in places where the car's own
navigation falls short (Georgia, much of Central Asia). It uses Yandex Maps JS API v3 for the map,
search, traffic and routing, and adds EV trip planning, turn-by-turn guidance and an interface in Apple's Liquid Glass design language,
sized for a car screen.

- **Zero runtime dependencies.** TypeScript compiled to one ~132 KB script (≈48 KB gzipped) plus ~42 KB of CSS. It stays light on older Tesla hardware (MCU2).
- **Demo mode** runs without any API key or network access, so you can work on the UI without spending Yandex quota.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173/?demo=1  (live-reloading dev server)
npm run typecheck    # tsc --noEmit
npm run build        # → dist/  static files, deploy anywhere
npm run build:demo   # → dist-demo/teslaplay-demo.html  one self-contained offline demo
```

URL switches: `?demo=1` (offline demo) · `?sim=1` (always simulate the drive) · `?key=…` (try a key without saving it) · `?lang=ru_RU` · `?tesla=1` (force Tesla tuning on a desktop browser).

## Keys and configuration

Edit **`public/config.js`** (copied to `dist/config.js`; you can change it on the server without rebuilding). You can also enter keys in the app under **Settings → Map data**; those are stored only in that browser.

| Key | Where | Used for | If it's missing |
|---|---|---|---|
| `yandexApiKey` (required) | Yandex Developer Dashboard → *JavaScript API and HTTP Geocoder* | map; also the HTTP Geocoder | — |
| `yandexSuggestKey` | *Geosuggest API* (free tier) | search-as-you-type | falls back to Places search, then to the Yandex Geocoder merged with OpenStreetMap (Photon) |
| `yandexSearchKey` | *Places API* (free tier, 500 requests/day) | businesses, categories (cafés, parking…) | OpenStreetMap: Photon for search, Overpass for nearby categories |
| `yandexRouterKey` | *Router API* | driving routes with live traffic (`ymaps3.route`) | falls back to OpenStreetMap routing (public OSRM server) |
| `yandexGeocoderKey` | *Geocoder API* | addresses, reverse geocoding for street names (`geocode-maps.yandex.ru/v1`) | the JS API key on the legacy `1.x` endpoint |
| `yandexMatrixKey` | *Distance Matrix API* | real drive times on nearby results, ranked by time | results ranked by straight-line distance |
| `openChargeMapKey` | openchargemap.org → My profile → API keys (free) | charger power and connector data | chargers come from OpenStreetMap (Overpass, incl. GB/T and power where mapped), then Yandex Places |

**Settings → Map services → Check services** tests every service with the keys in that browser (Yandex map, Geosuggest, Places, routing, Geocoder, traffic; OSRM, Photon, Overpass, Open Charge Map, weather, GPS). It shows what the app is using for search, places, directions and chargers, and *Copy report* puts the results on the clipboard.

### ⚠️ JS API v3 keys need an HTTP Referer restriction
Yandex only activates a v3 key once its **HTTP Referer restriction** field is filled in. In the Developer Dashboard, open the key's settings and add every host you'll use, for example:

```
teslaplay.pages.dev
localhost
```

Do the same for the Router, Geocoder and Distance Matrix keys: they sit in the public `config.js`, so the referer list is what keeps others from spending their quota. Save it and wait for the key status to say **Active**; that can take up to 15 minutes. If the map still won't load, the app's error screen says whether Yandex rejected the key or the domain. Browser keys are always visible in page source; the referer list is what protects them.

### Yandex plan notes (worth reading before launch)
- **Live traffic** (`YMapTrafficLayer`) only works on **paid** Yandex tariffs. The app tries to load it, and if your key doesn't allow it, hides the toggle.
- Routing and geocoding/search requests count against your daily limits. The app prefetches a route once per place card and reuses it when you tap Directions, and street-name lookups are limited to the next two maneuvers.
- The free tier's terms exclude transport monitoring and limited-access commercial products. A public or paid Teslaplay will very likely need a **commercial license** (paid-api-maps@yandex-team.ru).
- Don't hide the Yandex logo or copyright. The UI keeps the bottom-right corner clear for them.

## Deploying

**Quickest:** build (or use the pre-built `dist/` folder in the zip), then drag the `dist` folder into *Cloudflare Pages → Create → Upload assets* or *Netlify → Add new site → Deploy manually*. Add the resulting domain (e.g. `teslaplay.pages.dev`) to the key's HTTP Referer list.

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
    yandex.ts        Yandex JS API v3 implementation (YMap, markers, features, traffic, listener)
    demo.ts          offline Web-Mercator engine used by demo mode
    markers.ts       pins, charger badges, the user puck
    gestures.ts      detects real user pans/zooms → drops out of follow mode
  nav/
    session.ts       turn-by-turn: map-matching, progress, ETA, off-route → reroute, voice prompts
    follow.ts        60 fps puck interpolation between 1 Hz GPS fixes + follow / heading-up camera
  services/
    search.ts        ymaps3.suggest / ymaps3.search (+ reverse geocoding for street names)
    routing.ts       ymaps3.route → RouteResult (steps, alternatives, waypoint distances)
    maneuvers.ts     builds turn instructions from route geometry (see below)
    ev.ts            vehicle presets, energy model, charging-stop planner
    chargers.ts      Open Charge Map along-route search, Yandex fallback
    matrix.ts        Yandex Distance Matrix: drive times for nearby results
    osm.ts           OpenStreetMap fallbacks: Photon search, Overpass categories and chargers
    diagnostics.ts   Settings → Map services: live check of every service + copyable report
    weather.ts       Open-Meteo weather at origin/destination + elevation profile
    location.ts      GPS with Tesla workarounds + route simulator
    voice.ts         speech synthesis with chime fallback
    demo*.ts         demo data, street graph, mock services
  ui/                panel (search / place / planner), controls, navigation HUD, settings, icons, glyphs
    glass.ts         Liquid Glass engine: per-element lens filters, sun-lit rims, touch light, frame-rate guard
    segmented.ts     segmented control with a sliding thumb
styles/              design tokens + Liquid Glass material + component styles (light/dark)
```

### How turn-by-turn works with Yandex
`ymaps3.route` returns geometry, distance, duration and **steps, but no maneuver instructions**. `services/maneuvers.ts` reconstructs them: every step boundary is a candidate, and its turn angle (road bearing 30 m before vs 30 m after) is classified as slight, turn, sharp or U-turn. Without steps, it falls back to detecting sharp, concentrated bends in the geometry, which separates junctions from sweeping mountain curves. Street names come from reverse geocoding 40 m past each upcoming turn.

### EV model
For each section of the route: base Wh/km (vehicle preset or your override) × a speed factor (taken from that step's average speed) × a temperature factor (heating/AC), plus climbs and descents from the elevation profile (climbs cost ÷0.9, descents recover ×0.65). The planner drives as far as your arrival reserve allows, picks the most powerful charger within the last 40 km of range, charges just enough to finish (capped at your charge limit), and repeats. It then re-routes through the chosen chargers and re-checks the plan on that exact route. The vehicle figures are estimates: set your real usable kWh and consumption in Settings.

## Check these on a live key
I built and tested the Yandex adapter against a stand-in API that has the same surface, but not against Yandex's servers. Check these first:
1. **Compass direction:** rotate the map by hand. If the compass needle turns the wrong way, flip `AZIMUTH_SIGN` in `src/map/yandex.ts`.
2. **Tapping map POIs** should open a place card. The hotspot property names are read defensively in `YandexEngine.handleClick`.
3. **Street names in the maneuver banner.** These come from reverse geocoding (`YandexSearch.reverse`), which passes `"lng,lat"` as the query text.
4. **Turn quality:** whether `toSteps()` boundaries line up with junctions. If they don't, maneuvers fall back to geometry detection.
5. **Alternatives:** how many routes `ymaps3.route` returns on your plan.

## Ideas for next steps
- **Tesla Fleet API** (needs a small backend and OAuth): real battery %, sending the destination to the car, preconditioning before Superchargers.
- Georgian and Russian UI strings (the UI text is centralized enough to extract).
- Speed limits from OpenStreetMap `maxspeed`; Yandex doesn't expose them.
- An offline app shell (service worker) for patchy LTE. Map tiles can't be cached under Yandex terms.
