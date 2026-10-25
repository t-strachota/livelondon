# LiveLondon

Live TfL bus GPS positions, a persistent simulated car traffic layer for central London, traffic flow colours and JamCam snapshots on one London map. Zoomed-out buses are red dots; between zoom 16 and 17 they crossfade into small 3D double-deckers, while the map tilts gradually to 40 degrees. Grey dots are bus stops. Click a bus to see its route, destination, vehicle and GPS recording time.

## Run locally

Requires Node.js 24.5 or newer.

```sh
npm install
```

Provide your own Bus Open Data Service credential as `BODS_API_KEY` in your local `.env`. Use `.env.example` as a configuration reference. See [Provider configuration](#provider-configuration) for other providers.

```sh
npm start
```

For the simulated cars, build the road network once first (see [Simulated cars](#simulated-cars)); without it the map still runs and the car panel says what is missing.

Open **http://localhost:3000**. Set `PORT` in `.env` if needed. The app is served by Node; opening `index.html` directly or using a static-only server will not provide the live API. The start command honours existing HTTP/HTTPS proxy environment variables.

## Map layers

Use the **Live TfL buses** switch in the map panel to show or hide the bus overlay. It starts enabled and remembers your selection in this browser. Turning it off hides the dots, 3D buses, stop markers and bus information, closes bus popups, pauses bus requests, and restores a flat map. Turning it on immediately loads fresh positions and restores the zoom-dependent bus models and tilt. The basemap remains available throughout. **Traffic flow**, **Simulated cars**, and **Live cameras** are independent switches, initially off. All four choices are remembered. Simulated cars remain available when buses are hidden; cars and cameras keep the main map’s bus-controlled 0–40° tilt.

## Interface and appearance

The rounded controls use four tabs: **Explore** for buses, traffic and cameras; **Simulation** for model settings; **Live stats** for counts, speeds and feed status; and **Performance** for browser rendering settings and diagnostics. On phones, controls sit in a scrollable bottom sheet. Use minus/plus to minimize or reopen it, and moon/sun to switch the controls and basemap between light and dark themes. The selected tab, theme and minimized state persist in this browser. Arrow keys navigate the tabs. **Back to central London** returns the map to its starting view. The stop tools retain road, train-line and bus controls. **Impact & history** expands economic impact, affected roads and saved closure sessions.

The application opens directly into a two-message text introduction about the cost of poorly managed transport and data-driven decisions. Press a key or tap to advance, then **Enter simulator** to open the rounded individual interface without changing saved layer visibility. **Skip intro** or Escape enters immediately. There is no workspace chooser or separate professional interface, and onboarding has no vehicle animations.

**Replay introduction** starts the text sequence again. Reduced-motion preferences are respected. Intro navigation changes only this browser's view and never resets or pauses the shared run. Road closure scenarios remain exploratory; automatic route recommendations, passenger crowding forecasts and rail line closure scenarios are planned capabilities. The prototype's forecasts have not been validated for operational decisions.

Traffic flow uses thinner, partially transparent TomTom lines with a small free-flow/congested legend. Tile refreshes keep the existing layer in place. **Congestion epicenters** adds soft red glows over clusters of slow *simulated* cars, independently of the car-dot toggle. Every second it groups received cars into 250 m cells and highlights cells with at least eight cars below 3 m/s (10.8 km/h), where at least half the cell's cars are slow. This is a viewport-derived visual estimate, not city-wide incident detection or live congestion tracking; traffic lights can also create these queues. Reconnecting holds the last confirmed state. Rendering these glows never changes vehicle positions or simulation state.

## Provider configuration

Obtain your own credentials from each provider. Keep private credentials in local configuration or deployment secrets, and do not include real credentials in documentation, commits or shared examples.

| Service | Configuration | Used for |
| --- | --- | --- |
| DfT Bus Open Data Service (BODS) | `BODS_API_KEY` in the server environment or local `.env`. | Live TfL bus GPS positions. |
| MapTiler | `MAPTILER_KEY` in `public/app.js`. | Browser basemap tiles, buildings and road labels. |
| TomTom Traffic | `TOMTOM_KEY` in `public/config.js`; the server also accepts the `TOMTOM_KEY` environment variable. | Traffic raster tiles and numeric vector observations for simulation seeding. |
| TfL Unified API | Current stop and JamCam requests are anonymous. | Route-specific stops and street cameras. |
| OpenStreetMap / Overpass | No credential required. | Fallback display of bus-stop markers. |

Browser tile credentials are visible to visitors; apply the provider's supported origin and usage restrictions. Restart `npm start` after changing server environment variables, and refresh the page after changing browser configuration.

Before making an existing repository public, remove committed credentials from tracked files and history and revoke or rotate credentials that were previously committed. Removing a value from this README does not remove earlier versions from Git history.

| Setting | Default / behaviour |
| --- | --- |
| Runtime | Node.js 24.5 or newer; install dependencies with `npm install`. |
| Start | `npm start`, then open `http://localhost:3000`. |
| Port | `PORT=3000` in `.env`; server binds to the local machine. |
| BODS feed | `https://data.bus-data.dft.gov.uk/api/v1/datafeed/`, filtered to `operatorRef=TFLO`. |
| TfL stop catalog | `https://api.tfl.gov.uk/StopPoint/Mode/bus?page=1` and subsequent pages; cached locally for 24 hours. |
| Browser endpoint | `GET /api/buses`; the server keeps upstream keys out of this response. |
| Refresh and movement | Poll every 15 seconds; interpolate to confirmed GPS fixes over the next 15 seconds. |
| Stop holding | Only stops serving the same route, within 20 m and with a compatible heading; hold until a newer fix confirms movement beyond the 12 m jitter allowance. |
| GPS freshness | Dim after 60 seconds; remove after three minutes without a fresh fix. |
| Zoom | Red dots below zoom 16; crossfade to 3D at 16–17; 40° tilt at zoom 17+. |
| Local cache | `.cache/tfl-stops.json`; generated data is excluded from Git. |
| Tests | `npm test`; `npm run test:sim`; `npx playwright install chromium --only-shell`; `npm run test:browser`; `npm run test:overlays`. |
| Live browser check | With the server running: `LIVE_URL=http://localhost:3000 npm run test:browser`. |

Initial route-stop loading can take about a minute. During loading, buses continue to use confirmed GPS positions and the panel reports stop-catalog progress. Normal movement trails the source by roughly one update; it never predicts beyond the latest confirmed fix.

## How it works

- The server fetches the BODS SIRI-VM feed with `operatorRef=TFLO`, shared across clients and cached for 15 seconds. Bounds match the map: longitude -0.65 to 0.42, latitude 51.24 to 51.74.
- `GET /api/buses` returns `{ configured, status, fetchedAt, upstreamAt, stopDataStatus, stopDataUpdatedAt, buses }`. Each bus includes `id`, `vehicle`, `longitude`, `latitude`, `bearing`, `route`, `direction`, `destination`, `recordedAt`, and a nullable `routeStop`. Coordinates are WGS84. Times are UTC ISO strings. SIRI stop flags are retained when supplied, but the current TfL feed does not include them.
- Movement interpolates over the full 15-second polling interval, adding roughly one update of visual delay. It only travels between confirmed GPS fixes and never extrapolates beyond the latest fix. Regular movement is linear; arrivals decelerate and departures accelerate. Reduced-motion preferences disable transitions.
- TfL's paginated `/StopPoint/Mode/bus` catalog supplies physical stops and the exact lines serving them. The server caches it in ignored `.cache/tfl-stops.json` for 24 hours and spaces requests to remain within the anonymous API allowance. The first startup may take about a minute to load all stops; the panel shows loading or partial coverage instead of guessing from arbitrary map markers.
- A stop is considered only when it serves the bus's exact route, is within 20 metres of its latest fix, and has a compatible travel heading when known. Route `29` does not match `19` or `N29`. Opposite-direction stops are rejected using the stop's compass direction.
- At a matched route stop, the bus approaches its last confirmed GPS anchor, then holds there despite small GPS jitter. Only a newer fix more than 12 metres from that anchor, or an explicit departure flag, releases it. Departing buses do not immediately re-latch to the same stop. Route/direction changes clear old stop holds. Repeated timestamps never trigger a departure or restart an approach.
- Stop holding is a conservative inference from periodic GPS and TfL route membership, not a real-time door sensor. A stop completely missed between source fixes cannot be reconstructed; the animation still never projects beyond a confirmed fix.
- Duplicate or older observations cannot rewind a bus. Missing bearings are derived from movement when possible. Vehicles dim after 60 seconds without a fresh observation and disappear after three minutes. Feed outages retain recent positions with a visible status indicator.
- Three.js instancing shares the red body, windows and wheel geometry across visible buses. Models use the reported heading and front-of-bus GPS anchor. The low-poly double-decker is an illustrative vehicle, not a statement about the actual model on each route. If 3D fails, the red dots remain visible.
- The existing MapTiler Streets map and Overpass stop fallback are retained. MapLibre was updated to 6.15.0 to address the older version’s published sanitizer vulnerability; the custom layer uses the current render interface.

The GPS feed and route-specific stop catalog are handled by the server. The BODS key never appears in API responses or frontend assets. Browser tile credentials are configured separately and remain visible in browser requests. The local server binds to loopback. Deployment needs a Node-capable host; publishing only static files will not run the feed.

## Simulated cars

> Simulated car positions are seeded from live TomTom traffic observations and then evolve independently. They are estimates, not live tracking of individual vehicles.

The black dots come from one server-owned, agent-based simulation of all of Greater London, running on a worker thread inside `npm start`. Every tab, reload and visitor joins the same run; panning, zooming or toggling layers never creates, moves or removes cars. Stopping the server stops the simulation.

### Setup (one time)

The simulation itself is plain Node. Building the road network needs Python 3.12 with `osmium` (pinned in `sim/requirements.txt`):

```sh
# Windows
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r sim/requirements.txt
# macOS (Apple Silicon) / Linux
python3.12 -m venv .venv
.venv/bin/python -m pip install -r sim/requirements.txt

npm run build-roads        # downloads the Geofabrik Greater London extract once, writes data/network/roads.json
```

`build_roads.py` keeps car-usable roads inside the configured box (`network.bbox` in `sim/config.json`, default `-0.52,51.28,0.34,51.7`, all of Greater London) and classes (motorway, trunk, primary, secondary, tertiary, their links, unclassified; residential and service roads are left out for now). It drops ways that forbid private cars (`access`, `vehicle`, `motor_vehicle`, `motorcar` = `no`, `private`, `delivery`, …), imports one-way direction (including roundabouts and motorways), lanes per direction (capped at 4), and `maxspeed` with mph converted. Roads without a limit get the class default from `speedDefaultsMph` and are flagged as inferred. Only the largest strongly connected part is kept, so no car can reach a dead end. It also reads `highway=traffic_signals` nodes from the same extract and snaps each to the nearest road junction (3+ connected roads) within 25 m; signals that match no junction (e.g. pedestrian-only crossings) are dropped. It prints counts, exclusions, signals and file size.

Current build (all of Greater London): 5,227 signalised junctions, 107,634 directed road segments, 9,037 road-km (10,728 lane-km), `roads.json` 14.3 MB, about 26 s. Earlier zones 1–3 build: 2,638 signalised junctions (6,105 approaches), 47,235 directed road segments, 2,546 road-km (3,051 lane-km), 2.9% inferred limits, 2,515 disconnected segments dropped, `roads.json` 5.5 MB, about 30 s.

```sh
npm run build-roads -- --bbox=-0.15,51.49,-0.10,51.52     # a small test area
npm run build-roads -- --classes +residential             # add a class
npm run build-roads -- --input other.osm.pbf              # another extract
```

Rebuild after changing the area or classes, then restart `npm start`. Delete `data/osm/greater-london-latest.osm.pbf` to download a fresh extract.

### Model

- Cars follow the road polylines, offset to the left of the centre line by lane (UK driving).
- Car-following uses a charged-particle-inspired model along each directed lane/path. Cars gently accelerate toward a distant leader and brake under inverse-square short-range repulsion, with relative-speed damping to reduce oscillation. The preferred **bumper-to-bumper gap** is 1–2 car lengths (4.5–9 m, normally 6.75 m), varied by driver personality. Attraction cannot exceed the posted speed limit or the driver’s preferred speed. A braking-distance envelope, emergency braking and hard spacing checks override the interaction. At higher approach speeds, braking can begin well beyond the preferred gap. This is a modelling heuristic, not physical electrostatics or a validated traffic forecast. No attraction acts between parallel/crossing streets, live buses or map markers. Existing routing, closures, signals and identities remain independent of the force.
- At the end of a road a car takes a weighted random legal successor (busier road classes preferred, U-turns a last resort) and enters it only when there is room in the chosen lane.
- Cars change lane when the next lane offers clearly more room and the gaps ahead and behind are safe; at most one car moves into a lane per step, with a 3 s pause between a car's changes.
- 0.2 s steps in real time, all state in typed arrays indexed by car ID. Car IDs never change, cars are never removed or respawned, and cars waiting over 120 s are reported as gridlocked.
- **Simulated signals.** Traffic light locations come from OpenStreetMap (© OpenStreetMap contributors). Live signal states are not available, so timing is simulated: each signalised junction runs a fixed 90 s cycle with a seeded random offset. Its incoming roads are split into two phases by approach angle (roughly north–south vs east–west). Each phase gets 40 s green, 3 s amber and 2 s all-red. The 35 s green requested would leave the 90 s cycle 10 s short, so green was lengthened to fill it. State is computed from the simulation clock alone (`(t + offset) mod 90`); there are no per-signal timers. On red, and on amber when the car can stop at 3 m/s², the stop line 6 m before the junction acts as a stationary barrier with a minimum stand-off gap. A car is never let into the junction on red, and the existing room check still applies on green.
- Not modelled yet: congestion-scaled green times, turn restrictions, and conflicts at junctions without signals (these behave as simple merges).

### Seeding from TomTom

1. TomTom vector flow tiles (`relative` and `absolute`) are fetched server-side at zoom 12 for the network box (32 requests), 4 at a time, with a 400-request budget, backoff on 429/503 and a 10-minute cache in `data/observations/`. The key comes from `TOMTOM_KEY` or `public/config.js` and is never sent to the browser or logged.
2. Flow lines are de-duplicated and matched to directed roads within 15 m and 45° of their direction. Closed roads get no cars.
3. Each road's weight is `lane_km × (5 + 95 × (1 − r))`, with `r` = current/free-flow speed clamped to 0–1, so congested roads get more cars. Roads without an observation use the median of same-class observed roads within 1 km, then the class median, then `r = 0.9`.
4. Cars are placed by weight at safe spacing (at least 7.5 m per car per lane) with exactly the requested count, and start at the observed speed, bounded by the limit and the gap ahead.

The first run tries live data and falls back to a labelled **fallback** (`r = 0.9` everywhere) if TomTom is unreachable. Data older than 30 minutes is labelled **stale**. Neither is shown as live. After seeding, traffic evolves only through the simulation. Last measured: 58% of roads matched directly, the rest inferred.

The car count is a modelling choice, not a measured count of London traffic.

### Controls

- **Pause / Play** pauses the one shared simulation for everyone.
- **Manual population**: 5,000–300,000 in steps of 500. It applies only when you re-initialize, and it switches the count from London time to manual for everyone (see Performance tab below).
- **Traffic lights** (default on) shows simulated signal states as red/amber/green points at each approach's stop line, at zoom 15 and above, for signals in view only.
- **Re-initialize with live data** fetches TomTom while the current run continues, then moves the same cars (IDs kept; added or removed above the new count) to new live-weighted positions in one step under a new run ID. Duplicate requests get `409`. If live data is unavailable or stale, the current run continues and the panel shows why.
- The panel shows the global count separately from the visible count, simulation time, average speed, data freshness and matched share, real-time factor, step time, gridlocked cars and browser FPS.

### Performance tab

The left panel has two tabs, **Controls** and **Performance**. The Performance tab shows live indicators: browser FPS, simulation step and encode time, simulation speed (real-time factor), simulated cars drawn and on screen, and live bus and train counts. They refresh once a second, only while the tab is open and the page is visible.

**This browser only.** These are saved in this browser's `localStorage` under `london-map:performance`. They change how much this browser draws; other viewers and the simulation are unaffected.

| Setting | Options (default first) | Effect |
| --- | --- | --- |
| Preset | High, Balanced, Low (Custom when you change a single setting) | High is the original behaviour. Balanced: 30 updates/s, 3D on, resolution up to 1.5×. Low: 20 updates/s, 2D only, 1×. |
| Vehicle render rate | Every display frame, 30/s, 20/s | How often moving cars, buses and trains are redrawn. Motion stays smooth because positions are still interpolated. |
| 3D vehicles | On, off | Off keeps the lighter 2D dots for buses, trains, cars and traffic lights at every zoom. |
| Map resolution | Device, up to 1.5×, 1× | Caps the map's pixel ratio on high-density screens. |

"Reset to default" returns to High.

**Shared simulation (affects everyone).** The car population belongs to the one shared simulation. By default it follows London time. The **Manual population** slider in the Controls tab, which the Performance tab links to, takes effect only when someone re-initializes with live data. It then stays manual until **Live** or **Back to live** is chosen. A refused request (invalid count, or a re-initialization already running) leaves the count source unchanged. Starting the server with `SIM_POPULATION` also sets a manual count. No browser-only setting changes the population, the timing or the state of the simulation.

While the page is hidden, the browser stops asking for car snapshots and signal frames and skips its drawing work. The shared simulation keeps running.

### Interfaces

| Endpoint | Purpose |
| --- | --- |
| `GET /api/simulation/status` | Lifecycle, run ID, population, sim time, average speed, observation summary, seed, performance, health, re-initialization job. |
| `POST /api/simulation/reinitialize` `{"population": 5000}` | `202` with the job; `400` invalid count; `409` already running; `503` no running simulation. Same-origin only. |
| `POST /api/simulation/pause` `{"paused": true}` | Shared pause/resume. Same-origin only. |
| `GET /api/simulation/signals` | Static stop-line positions of every signal approach, `{simulated: true, positions: [lon, lat, ...]}`. |
| `GET /api/simulation/stream` (WebSocket) | JSON status/progress frames and 5 Hz binary snapshots, culled to each client's viewport plus a margin. Clients sending `signals: true` (zoom ≥ 15) also get 2 Hz `'SIG1'` frames. |

Binary snapshot: 24-byte header (`'SNP1'`, run ID u32, sim time f64, count u32, flags u32), then columns sorted by car ID: ID u32, lon/lat i32 (1e-7°), edge×4+lane u32, position along the road f32, heading u16 (0.01°), speed u16 (cm/s). Signal frame: `'SIG1'`, run ID u32, count u32, 4 bytes reserved, then approach indices u32 and states u8 (0 green, 1 amber, 2 red), only for approaches inside the union of the boxes of clients that want signals. The browser draws instanced points in a Three.js MapLibre layer, interpolating ~400 ms behind the newest snapshot, holds the last state if snapshots stop, and re-adds the layer after a style change.

### Measured performance

This laptop: Intel Core Ultra 5 226V, Intel Arc 130V, Windows 11, Node 24.

| | 5,000 cars | 15,000 cars |
| --- | --- | --- |
| Simulation step | 4 ms | 4–7 ms (12 ms with the browser also rendering) |
| Snapshot encoding | 2 ms | 3 ms |
| Real-time headroom | ~30× | ~12–19× |
| Server memory (whole process) | ~330–390 MB | ~320 MB |
| Browser (Chromium, GPU) | 60 FPS | 60 FPS at zoom 11.5 (all cars in view), 13 and 16 |
| Live re-initialization | — | 1.5 s total; about 1 s pause in stepping while roads are matched |
| Signals (2,638 junctions), step time without → with | 2.0 → 2.1 ms (+0–3%) | 6.8 → 6.9 ms (+0–3%); 7.3 ms live with the browser rendering, still 60 FPS |

### Linux deployment

Install Node 24 and Python 3.12, build the network once, then run `npm start` under a process manager — for example a systemd unit with `WorkingDirectory=` the checkout, `ExecStart=/usr/bin/npm start`, `Restart=on-failure`. SIGINT/SIGTERM stop the simulation worker cleanly. Allow about 0.5 GB of RAM. The server binds to 127.0.0.1; put a reverse proxy that forwards WebSocket upgrades in front of it for remote access.

## Cameras

Live cameras use `https://api.tfl.gov.uk/Place/Type/JamCam`. Green camera markers show up to eight nearby preview cards from zoom 13. Previews refresh every 15 seconds; clicking opens a draggable/resizable viewer refreshing every five seconds. Images are snapshots rather than a video stream. Turning cameras off closes the viewer and clears image timers. The map places cards around its controls and shows complete camera frames.

## Trains

"Trains" shows Tube, London Overground and Elizabeth line trains at an **estimated position from TfL arrival predictions**: TfL publishes when each train is due at each station, not where it is. The server fetches line geometry once (`/Line/{id}/Route/Sequence/{direction}`, cached in `data/trains/routes.json`), polls `/Line/{ids}/Arrivals` every 15 seconds, and places each train between its previous and next station by time to arrival. Ids come from TfL vehicle ids. A train missing from the predictions holds for 60 seconds, then disappears. DLR predictions carry no vehicle ids, so DLR trains are not shown (the DLR line is). Browsers run trains on along the track between polls and ease in corrections; from zoom 16 they are 3D carriages, with Tube trains semi-transparent because they are mostly underground. An optional `TFL_APP_KEY` in `.env` is used only by the server.

## Checks

```sh
npm test
npm run test:sim          # road builder (Python)
npx playwright install chromium --only-shell
npm run test:browser
npm run test:overlays
```

Unit and HTTP tests cover XML parsing, freshness, caching, outage recovery, full-interval interpolation, no overshoot, stop jitter, confirmed departures, route ownership, night routes, headings, route changes, stop pagination and cache reuse. Simulation tests cover exact seeding and capacity refusal, no lane overlaps over 10 simulated minutes, braking behind a stopped car, overtaking by lane change, positions on the road geometry, TomTom caching/budget/stale fallback, freshness labels, directional matching, inference and weights, the shared run across clients, shared pause, and re-initialization success, refusal and duplicate requests. Road-builder tests cover exclusions, one-way roads, mph limits and bridges. Browser tests use isolated map, speed and camera fixtures to check WebGL rendering, independent toggles, saved selections, paused requests, camera preview placement, viewer drag/resize, simulated cars (rendering after style reloads, smooth motion, shared pause, reload joining the same run), 8,000 bus dots and the 3D fallback. Screenshots are written to ignored `test-results/`. Set `LIVE_URL=http://localhost:3000` when running the bus browser checks to also verify the running authenticated live map.

## Data credits

- Bus locations: TfL iBus via DfT Bus Open Data Service, [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
- Route-to-stop memberships, JamCam snapshots, train lines and arrival predictions: Transport for London Unified API.
- Traffic flow tiles and simulation seed observations: TomTom.
- Road network: OpenStreetMap contributors via the Geofabrik Greater London extract (ODbL).
- Basemap: MapTiler and OpenStreetMap contributors, as credited on the map.
- Bus stops: OpenStreetMap contributors via map tiles and Overpass.

### Integrated UI verification

The UX2 onboarding and sliding tabs are integrated with main’s trains, stop tools, London-time demand controls, personality display, closure history, economics and Performance settings. Replaying or skipping onboarding never writes layer preferences or changes the shared simulation. Run `npm test`, `npm run test:browser`, `npm run test:overlays` and `npm run test:integration` for fixture-based checks.
