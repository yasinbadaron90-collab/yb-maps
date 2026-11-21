# YB Maps: architecture and rules

Read this first. Then open only the file(s) the task needs.

YB Maps is a small phone-first driving map for Yasin: live position, speed, road speed limit, search, routes with turn directions, traffic, speed cameras and saved places. It is a separate project. Nothing is shared with the YB Dashboard: not code, not storage, not a repo.

Live: https://yasinbadaron90-collab.github.io/yb-maps/ (GitHub Pages, deploys from `main` root).

## Stack

Plain HTML, CSS and JavaScript. Leaflet (saved in `vendor/`, not loaded from a CDN). No build step, no framework, no backend. Everything runs on the phone. All user data lives in `localStorage` on that phone.

## File map

| File | Job |
|---|---|
| `index.html` | Page shell: map, From/To bar, results list, next-turn banner, trip bar, status line, speed card with the speed-limit sign |
| `app.js` | All the logic, one IIFE, sections below |
| `style.css` | All styling |
| `sw.js` | Service worker: caches the app files, network first. Cross-origin calls (maps, routing, search, traffic) go straight to the network and are never cached |
| `manifest.webmanifest` | Phone-app install details (name, icons, colours) |
| `icons/` | App icons, 192 and 512 |
| `vendor/` | Leaflet JS, CSS and marker images |

## app.js sections (in file order)

1. Arrow marker: the heading arrow for the car
2. Geometry helpers: `distM`, `bearing`, angle maths
3. Speed limit: reads the nearest road's `maxspeed` from OpenStreetMap (Overpass). Shows "?" when the road has no limit recorded
4. Destination search and route: place search (Nominatim) and the free OSRM route
5. Business search key (TomTom): optional key for shops and businesses, pasted by Yasin into Settings
6. Saved places: Home, Work and favourites
7. Turn-by-turn: next-turn banner, spoken directions, voice on/off
8. TomTom routing: live-traffic fastest route and alternatives; falls back to OSRM
9. Speed cameras: from OpenStreetMap, warns about 500 m ahead
10. Live traffic overlay: TomTom flow tiles
11. GPS: the position handler that feeds everything above. Touching the map pauses auto-follow for 10 s; the 🎯 recentre button brings it back at once
12. Keep screen awake: Screen Wake Lock
13. Service worker registration

## Outside services

| Service | Used for | Key needed |
|---|---|---|
| OpenStreetMap tiles | The map picture | No |
| Overpass (3 servers, tried in turn) | Speed limit and speed cameras | No |
| Nominatim | Place search | No |
| OSRM (with a backup server) | Free routes | No |
| TomTom | Business search, traffic routes, traffic overlay | Yes, optional, Yasin's own free key |

Every one of these sees the phone's position when it is used. Public servers have usage limits and can be slow or down; each call needs a timeout and a visible error.

## Stored on the phone (`localStorage`)

| Key | Holds |
|---|---|
| `yb-maps-tomtom-key` | Yasin's TomTom key. Never in the repo, never in chat |
| `yb-maps-places` | Saved places |
| `yb-maps-cams` | Cached speed-camera list |
| `yb-maps-muted` | Voice on or off |
| `yb-maps-traffic` | Traffic overlay on or off |

A new key goes in this table the same day it is added.

## Rules

- Separate repo `yb-maps`, public. Commit straight to `main`. No other branches, no pull requests. Do not ask before committing; report what changed.
- Output full working files, never `// ... existing code`.
- Every change to a cached file bumps `CACHE_VERSION` in `sw.js` and the "App version" text in Settings, together (v14 to v15 and so on).
- Keys and passwords: Yasin types them himself. Never in the repo, never in chat, never hardcoded.
- Every network call has a timeout and a clear error message. A busy server must never freeze the screen.
- Speed limits and camera warnings are a guide. The road signs always win. Show "?" instead of guessing.
- The phone is for a mounted screen: nothing the driver must tap while moving.
- Before pushing: `node --check app.js`, then a phone-size browser test (390 x 844) with no page errors, and send Yasin a screenshot.
- After pushing: confirm `sw.js` on the live site shows the new version, then tell Yasin to open Settings, tap "Refresh app", and look for the new version number plus 1 to 3 specific things to try.
- Yasin is on his phone and is a visual learner: short plain English, say what changed and what to check, use a diagram or screenshot when explaining something new.
- When a mistake is found, a separate sub-agent that did not build the fix checks the corrected work before it is called right.
- **Every time anything is added or changed, update this file in the same commit.** New or changed feature, behaviour, section, file, service, storage key or rule: all of it. Check the file before saying the work is done. No exceptions.
