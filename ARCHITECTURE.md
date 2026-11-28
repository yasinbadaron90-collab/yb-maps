# YB Maps: architecture and rules

Read this first. Then open only the file(s) the task needs.

YB Maps is a small phone-first driving map for Yasin: live position, speed, road speed limit, search, routes with turn directions, traffic, speed cameras and saved places. It is a separate project. Nothing is shared with the YB Dashboard: not code, not storage, not a repo.

Live: https://yasinbadaron90-collab.github.io/yb-maps/ (GitHub Pages, deploys from `main` root).

## Stack

Plain HTML, CSS and JavaScript. Leaflet (saved in `vendor/`, not loaded from a CDN). No build step, no framework, no backend. Everything runs on the phone. All user data lives in `localStorage` on that phone.

## File map

| File | Job |
|---|---|
| `index.html` | Page shell: map, From/stops/To bar, results list, next-turn banner, trip bar, status line, camera warning banner, Undo bar, speed card with the speed-limit sign |
| `app.js` | All the logic, one IIFE, sections below |
| `style.css` | All styling. The speed gauge and the speed-limit sign (both 48 px, same size as the 🚦 button) are stacked on the right (km/h on top, limit under it, map credit line below them). Last blocks are the sideways (landscape) layout, used whenever the phone is turned sideways, and the folded driving bar (sideways + driving, like Google Maps: turn banner top-left with a "Then" line for the next turn, trip bar bottom-left, gauges stay on the right) |
| `sw.js` | Service worker: caches the app files, network first. Cross-origin calls (maps, routing, search, traffic) go straight to the network and are never cached |
| `manifest.webmanifest` | Phone-app install details (name, icons, colours); `orientation: any` lets the installed app turn with the phone (portrait or sideways); app.js only makes a harmless `screen.orientation.unlock()` call; the manifest is what decides. An installed copy keeps the old `portrait` manifest until Chrome refreshes it or the app is reinstalled |
| `icons/` | App icons, 192 and 512 |
| `vendor/` | Leaflet JS, CSS and marker images |

## app.js sections (in file order)

1. Arrow marker: the heading arrow for the car
2. Geometry helpers: `distM`, `bearing`, angle maths
3. Speed limit: one Overpass call fetches every drivable road within 500 m and keeps the list (`limitCache`); each GPS fix then picks the nearest road (within 30 m, and when moving only roads within 50° of the heading) from it with no network wait. A different value must win 2 fixes in a row before the sign changes (from "?" a value shows at once); GPS drift with no road near keeps the last value. The list is re-fetched after ~150 m (min 3 s apart, backing off to 30 s on failure); the local pick is used up to 450 m from where it was fetched, beyond ~480 m the sign goes to "?" rather than show an old road's limit. When OSM has no limit for the road, TomTom reverse geocoding with `returnSpeedLimit=true` is asked (`ttFallback`, only with a TomTom key; the answer, including "TomTom doesn't know", is kept per OSM road for 300 m so it is about one call per untagged road stretch; backs off 5 s to 60 s on failure; while an answer is pending the sign keeps its number only if it is still the same road, otherwise it changes to "?" so an old road's number does not stay up and a flag goes on the road you are on (both from the 2nd GPS fix on the new road, because of the 2-fix rule below); the call gives up after 6 s, and while TomTom is failing the legal default is used instead of waiting on retries). It is also used, without a road, when the OSM road list is more than 480 m old or the OSM servers are failing so many unrecorded roads still get a number. What counts as OSM's limit (`wayLimit`): `maxspeed`, else `maxspeed:forward`/`maxspeed:backward` for the direction of travel (as CoMaps does; when standing still and the two differ the sign is left alone), else the app's own fallback to `maxspeed:type` / `source:maxspeed`; a value written as `ZA:urban` / `ZA:rural` / `ZA:motorway` counts as 60 / 100 / 120 (the table CoMaps uses, in `parseMaxspeed`). Order of trust: your own saved limit for that OSM road (`yb-maps-limits`), OSM, TomTom, then the legal default from the National Road Traffic Regulations reg. 292 (`legalDefault`): freeway 120, residential/living street/service 60, any other road 60 if 8+ residential-type streets lie within 250 m (built-up) else 100. A legal default shows as a dashed sign (`.guess`) because it is the general rule, not a posted number. Tapping the sign while moving (>= 5 km/h) only flags the road (`yb-maps-flags`, no typing); when stopped it opens the panel (also under the cog, "Road speed limits") to type the real limit, which is locked while moving. Shows "?" when no road is near, and when GPS reports an error (see 11)
4. Destination search and route: place search (Nominatim) and the free OSRM route. Includes **stops**: the ➕ button adds pickup rows between From and To (up to 8, in the order listed). Each stop is picked from saved places (shown when its box is focused and empty) or searched, can be saved with ⭐, and removed with ✕. Remaining stops go into the route as via points; a stop counts as done within 50 m, or when the turn steps drive past it within 100 m (grey ✓ marker, spoken "Stop reached"); a stop driven past from further away stays on the list (reroutes go back for it) until picked up or removed with ✕; reroutes only use stops not yet done. With stops, "You have arrived" only fires after the car has moved 150 m from the start or 100 m from To, so a round trip home does not end on the first GPS fix ✕ on the trip bar (alone on the left, away from mute) clears the stops too, also cancels any route still being fetched, and offers **Undo** for 8 s (`#undo`): the route as chosen (alternative included), stops, place along the route and turn step are restored from memory (works without signal); turns driven past meanwhile are skipped without being spoken (`skipPassedSteps`). Undo itself does not reroute: if the car has left the route, the normal off-route check does. Typing in the From, To or a stop box, adding a stop or starting a new trip ends the offer. The trip bar shows arrival time large, then time and km, then traffic delay and stops left; its buttons are 48 px. While a route is showing, the From/stops/To boxes and results fold away (class `driving` on `#bar`, so only the turn banner and trip row show); ✎ in the trip row opens them again, and a new route or ✕ folds/unfolds them automatically
5. Business search key (TomTom): optional key for shops and businesses, pasted by Yasin into Settings
6. Saved places: Home, Work and favourites. Press and hold on the map drops a 📍 pin (`pinMarker`, `pinPt`) with ⭐ Save place / 🧭 Go here / ✕ in the results area; only Go here sets the destination (`toPt`), so a running route is never touched, and cancel/save/clear/typing remove the pin
7. Turn-by-turn: next-turn banner, spoken directions, voice on/off. Leg ends that are not the destination become "Stop at …" steps (also dropped once driven past)
8. TomTom routing: live-traffic fastest route and alternatives (no alternatives when there are stops); falls back to OSRM. Stops are sent as waypoints to both. TomTom is asked for `sectionType=traffic`; with the 🚦 switch on, the chosen route is drawn green and the slow stretches are painted over it (yellow minor, orange moderate, red major, dark red closed). Switch off, or a free OSRM route, gives the plain blue line
9. Speed cameras: from OpenStreetMap, warns about 500 m ahead with a large red banner (`#warn`, `showWarn`) under the top bar (sideways: top right of the turn banner) for 7 s, plus voice and vibration
10. Live traffic overlay: TomTom flow tiles on the map, shown only while there is no route (with a route the coloured route line, see 8, replaces them); the 🚦 button switches both
11. GPS: the position handler that feeds everything above. On a GPS error the speed shows "--", the limit "?" and late limit answers are ignored until a fix returns. Heading-up map (OFF by default, because street names turn upside down when heading south; the compass button switches it on): when chosen, while a route is being driven (not during the 8 s route overview, not when north-up is chosen) the map box (`#map`) is made bigger than the screen, centred on a pivot 60% down (45% sideways), and turned with CSS `rotate(-heading)`; the arrow's own rotation cancels so it points up, and cam/stop/route-label markers counter-rotate through the `--mr` variable. Leaflet's drag and tap maths assume north-up, so while turned: Leaflet drag is off and a hand-made one-finger pan rotates the finger movement, `touchZoom`/`doubleClickZoom` zoom about the centre, `map.mouseEventToContainerPoint` is wrapped to un-turn long-press, and a fixed `#attrib` credit replaces the one that turns away (`applyRotation`, `setRotBox`, `setMapRot`). The compass button (`#compass`, shown while a route exists); toggles heading-up (saved; lit = heading-up chosen). It only turns for routes that start from the GPS fix, and not until a touched route overview has been let go. Outside driving the map is north-up and only the arrow turns. The faster-route check (every 5 min, TomTom) compares the new route with the time left by distance still to drive (route time x share left), not by the clock. The trip row's km, time and arrival clock shrink as you drive (`updateProgress`: nearest route point within about 300 m ahead along the route; about 150 m back is checked only if nothing ahead is within 40 m, and the whole route only if nothing nearby is within 80 m, so one bad fix does not jump to the same road on the way back (after a long GPS gap on an out-and-back, or with widely spaced route points, it can still pick the wrong leg), time scaled by the share of route left; resets with each new route). The same progress point trims the route line, so the stretch already driven disappears (`trimRouteLine`). Touching the map pauses auto-follow for 10 s; the 🎯 recentre button brings it back at once
12. Keep screen awake: Screen Wake Lock
13. Service worker registration

## Outside services

| Service | Used for | Key needed |
|---|---|---|
| OpenStreetMap tiles | The map picture | No |
| Overpass (3 servers, tried in turn) | Speed limit and speed cameras | No |
| CARTO Voyager tiles (`basemaps.cartocdn.com`, needs free key) | Base map when a key is saved | Yes |
| TomTom reverse geocode (`returnSpeedLimit`) | Speed limit where OSM has none (needs the TomTom key; sends the position) | Yes |
| Nominatim | Place search | No |
| OSRM (with a backup server) | Free routes | No |
| TomTom | Business search, traffic routes, traffic overlay | Yes, optional, Yasin's own free key |

Every one of these sees the phone's position when it is used. Public servers have usage limits and can be slow or down; each call needs a timeout and a visible error. All data requests in `app.js` go through `fetchJson` (map tiles are loaded by Leaflet), whose time limit also covers reading the reply: TomTom speed limit 6 s, search 8 s, routes 10 s, Overpass 8 s (limits) / 15 s (cameras).

## Stored on the phone (`localStorage`)

| Key | Holds |
|---|---|
| `yb-maps-tomtom-key` | Yasin's TomTom key. Never in the repo, never in chat |
| `yb-maps-places` | Saved places |
| `yb-maps-cams` | Cached speed-camera list |
| `yb-maps-muted` | Voice on or off |
| `yb-maps-traffic` | Traffic overlay on or off |
| `yb-maps-carto-key` | Free CARTO key (carto.com/basemaps/apikey). Present = Voyager base map (`setBase`), absent = standard OSM tiles |
| `yb-maps-limits` | Your own speed limits `{osmWayId: km/h}`, typed in while parked; beat OSM/TomTom |
| `yb-maps-flags` | Roads flagged with one tap while driving, to fix later |
| `yb-maps-headup` | Compass choice: `1` = turn the map to the driving direction (default: north-up, so street names are always upright) |

A new key goes in this table the same day it is added.

## Rules

- Separate repo `yb-maps`, public. Commit straight to `main`. No other branches, no pull requests. Do not ask before committing; report what changed.
- Output full working files, never `// ... existing code`.
- Every change to a cached file bumps `CACHE_VERSION` in `sw.js` and the "App version" text in Settings, together (v14 to v15 and so on). `ARCHITECTURE.md` is not cached, so docs-only commits do not bump.
- Keys and passwords: Yasin types them himself. Never in the repo, never in chat, never hardcoded.
- Every network call has a timeout and a clear error message. A busy server must never freeze the screen.
- Speed limits and camera warnings are a guide. The road signs always win. Show "?" instead of guessing.
- The phone is for a mounted screen: nothing the driver must tap while moving.
- Before pushing: `node --check app.js`, then a phone-size browser test (390 x 844) with no page errors, and send Yasin a screenshot.
- After pushing: confirm `sw.js` on the live site shows the new version, then tell Yasin to open Settings, tap "Refresh app", and look for the new version number plus 1 to 3 specific things to try.
- Yasin is on his phone and is a visual learner: short plain English, say what changed and what to check, use a diagram or screenshot when explaining something new.
- **Every change gets checked by a separate sub-agent that did not build it (fresh eyes) before it is pushed and called done**, not only when a mistake is found. It checks the code, the phone-size test, and that this file matches. Fix what it finds, then have it re-check.
- **Every time anything is added or changed, update this file in the same commit.** New or changed feature, behaviour, section, file, service, storage key or rule: all of it. Check the file before saying the work is done. No exceptions.
