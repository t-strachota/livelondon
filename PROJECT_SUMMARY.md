# LiveLondon — project summary and return guide

*Snapshot: 25 October 2026. Describes the implementation on `main` after the UX2 integration and charged-particle car-following update.*

## What this project is

LiveLondon combines live transport observations and a shared road-traffic simulation on an interactive London map. It began as a way to see TfL buses moving smoothly, then grew into an exploratory tool for asking what happens when roads or public-transport services are disrupted.

The motivation is practical: poorly managed transport costs people time, money and convenience. Councils and transport planners could use scenario exploration to understand knock-on congestion; individuals could eventually use the same information to make better journey choices. The current application is a prototype for that ambition. It does not yet provide validated forecasts or automatic low-congestion journey planning.

> Simulated car positions are seeded from live TomTom traffic observations and then evolve independently. They are estimates, not live tracking of individual vehicles.

## What you can do now

- View observed buses, estimated train positions, rail lines, station-derived busyness, TomTom traffic colours and TfL camera snapshots.
- Watch simulated cars follow roads, queue, change lanes and respond to signals and closures across the configured London network, including outside the visible map.
- Stop roads, train lines, individual buses or bus routes; inspect affected roads, estimated displaced passengers, extra car demand and economic impact.
- Inspect saved closure sessions and compare the model's traffic before and after a disruption.
- Change London-time demand, choose a manual population for reinitialization, pause the shared simulation or reseed it from fresh traffic observations.
- Adjust this browser's rendering through the Performance tab without changing the shared simulation.

The interface uses a short, text-only introduction followed by rounded, minimizable controls with four sliding tabs: **Explore**, **Simulation**, **Live stats** and **Performance**. Light/dark theme, layer choices and browser settings persist locally. Replaying the introduction preserves those choices and does not reset the simulation.

## The most important distinction: observations versus assumptions

| Layer or result | What it actually represents |
| --- | --- |
| Buses | Observed GPS fixes from BODS, animated between confirmed updates. Stop holding is inferred from route-specific stops and movement. |
| Trains | Positions estimated from TfL arrival predictions and station/line geometry, not train GPS. |
| Rail busyness | Station crowding spread along lines, with live/typical source handling; not measured passenger load on each train. |
| Traffic colours | TomTom's display overlay. Numeric traffic observations are fetched separately for car initialization. |
| Black car dots | Persistent simulated agents, not observed vehicles. Population is a modelling choice. |
| Red congestion glows | Clusters of slow simulated cars received for the viewport; not global live incident detection. |
| Closure impact and money | Model-derived comparisons and explicit assumptions, not measured real-world losses or proven causal forecasts. |

Scenario stop tools change the application's displayed/modelled service state. They do not close real roads or stop real buses or trains. The bus data source continues independently.

## How the application fits together

```text
BODS / TfL / TomTom            Geofabrik OpenStreetMap extract
          |                                |
   Node HTTP server              Python road builder (one time)
          |                                |
          +---- simulation supervisor ---- roads.json
          |               |
          |         Node worker thread
          |         agent state + stepping
          |               |
          +---- HTTP + WebSocket snapshots
                          |
              MapLibre + Three.js browser
```

There is no frontend build step. `npm start` serves the HTML, JavaScript, API routes and WebSocket stream, and starts the shared simulation worker. Python is needed to prepare roads, not to run the simulation. Earlier discussions proposed SUMO/libsumo; **the current runtime is the custom Node engine**, not SUMO.

The worker owns car state in typed arrays indexed by identity and advances in 0.2-second steps. The HTTP server remains separate from simulation work. Clients receive approximately five binary snapshots per second, with transmission culled to their viewport. The browser renders instanced vehicles and buffers movement by roughly 400 ms. Hiding a layer, reloading or opening another tab does not create a separate run. Pause and scenario controls affect all clients connected to that server.

The run survives browsers closing, but **not a server restart**: there is no durable checkpoint of all car positions. Finished closure history is saved separately.

## Roads, initial conditions and vehicle behaviour

### Road preparation

`build_roads.py` and `sim/roads.py` download/cache the Geofabrik Greater London extract and produce `data/network/roads.json`. The builder reads configured car-usable road classes, access permissions, one-way direction, lanes and speed limits, converting mph. Missing limits use documented class defaults. The largest strongly connected component keeps agents from reaching ordinary network dead ends.

The configured footprint spans Greater London, but this is **not every London street**: residential and service classes are excluded by default. Cars use directed polylines with left-side lane offsets. Turn restrictions and unsignalised junction conflicts are not fully modelled, so the graph must not be treated as a comprehensive legal routing engine.

### Initialization

TomTom numeric vector tiles are fetched with concurrency limits, caching, request budgets and backoff. Features are matched to directed roads. Congested roads receive more initial cars using:

\[
w = \text{lane kilometres}\,[5 + 95(1-r)],\qquad r\in[0,1].
\]

Unobserved roads infer congestion from nearby observed roads of the same class, then a class median, then a default relative speed of 0.9. Initial placement respects available lane capacity and spacing; starting speeds are bounded by observations, road limits and room ahead. Unavailable cold-start observations produce a labelled fallback, and old observations are labelled stale.

Explicit reinitialization fetches fresh observations while the current run continues, then reseeds positions under a new run ID. It is deliberately a reset, unlike routine animation or feed refresh. Failure to obtain usable fresh data leaves the existing run running. Inspect actual population and capacity in status rather than assuming a requested target always fits.

### Charged-particle-inspired following

The latest change replaced IDM following with a traffic heuristic inspired by attraction and repulsion. Each car responds to the leader along its directed lane/path, including a leader on its next road. There are no forces through buildings, across unrelated roads or from observed buses.

- A large gap produces gentle forward attraction, subject to the driver's cruise speed and the posted limit.
- A small gap produces inverse-square repulsion and braking.
- Relative-speed damping reduces oscillation. A braking-distance envelope and hard spacing checks override the force.
- Preferred bumper-to-bumper distance is about one to two 4.5 m car lengths: normally 6.75 m, varied by personality. Closing quickly can require braking much farther away.

The interaction term is `acceleration × (1 − (targetGap / gap)²)`, plus relative-speed damping. This is not literal atomic physics or a calibrated traffic model. Acceleration and braking remain bounded; speed limits also apply when entering a slower road. Personalities retain different acceleration, braking, spacing and lane-change preferences.

Cars choose connected successor roads and seek detours around closures. Signals use imported locations with simulated fixed-time phases, not live TfL timings. Existing same-lane spacing and next-road entry checks remain essential safety rules.

### What persistence means here

Cars retain identities while driving, queuing, extending their journeys and reconnecting to browsers. However, the fleet is not always a fixed-size cohort:

- Live/custom London-time modes gradually adjust demand by adding cars where there is room and allowing departing cars to leave at junctions.
- Stopped services can introduce additional modelled demand; reopening releases those demand groups.
- Explicit reinitialization replaces positions and changes the run ID; server restart creates a new run.

The current configuration uses a nominal weekday night/day demand of 50,000/200,000 cars, ramps between them, a weekend multiplier of 0.8 and a manual range of 5,000–300,000. These are assumptions in `sim/config.json`, not measured London counts. `SIM_POPULATION` selects manual startup demand.

## Closures, bottlenecks and economic impact

Road closure selections map to simulation segments; cars are blocked from entering closed segments and attempt alternate paths. Train/bus stop tools estimate displaced passengers from assumed capacity and occupancy. A configured share switches to cars, creating demand near the affected service.

The worker samples road speeds and queues, maintains roughly three-minute rolling averages, and freezes a baseline at the first active disruption. It highlights sustained changes near disruptions, compensating for median local drift and excluding already-gridlocked roads. This is a before/after heuristic, not a parallel control simulation proving that the closure caused every slowdown. Allow time for the baseline and impact averages to develop.

Economic estimates combine modelled extra road delay with assumed passenger disruption costs. Parameters live in `lib/assumptions.mjs`, including £12.50 per person-hour, 20 minutes of extra passenger delay, 10% switching to cars and 1.3 people per car. Changing these assumptions changes the result substantially.

`lib/history.mjs` records sessions from the first disruption until everything reopens, or the server stops. Up to 50 finished sessions are saved in `data/history.json`. This file is local runtime data; back it up if sessions matter.

## How we developed it, and what we learned

1. **Live map first.** Started with TfL bus positions, a MapLibre/MapTiler basemap, traffic colours and cameras. Added red dots at overview zoom and instanced 3D buses close up.
2. **Trustworthy animation.** Replaced visible jumps with interpolation between confirmed fixes. Added route-specific stop holding, jitter tolerance, confirmed departures and stale indicators. The key lesson was that smoother motion must not invent observations or carry a bus beyond its confirmed position.
3. **From estimates to shared simulation.** Moved car ownership away from viewport/browser behaviour into one server worker. Built a reusable London road graph, seeded agents from numeric congestion data and separated rendering from model state.
4. **Disruption experiments.** Added road closures, rerouting, impact comparisons, train/bus stopping, extra demand, economic estimates and saved history. Clear closure markers and visible consequences became as important as the controls themselves.
5. **Interface iteration.** Tried more elaborate introductions and separate audiences, then simplified to text onboarding and one interface. UX2 contributed rounded controls, dark mode and animated tab navigation. Its interface was integrated with newer `main` features rather than replacing trains, stop tools, London-time controls, history, economics or Performance.
6. **Following-model experiment.** Added bounded attraction/repulsion while retaining speed caps, spacing checks, signals and closures. Tests exposed that damping against distant stopped cars could make followers crawl too early; scaling damping with distance fixed that while preserving near-field response.

Recurring challenges were unreliable or delayed feeds, reconciling GPS with route stops, keeping identities stable, modelling meaningful detours, managing many rendered vehicles, preserving preferences through onboarding/style changes and integrating parallel Git branches without losing features. The main engineering lesson is to keep observations, model assumptions and presentation separate—and test their boundaries.

## Where to look in the code

| Area | Main files |
| --- | --- |
| HTTP routes, feeds and startup/shutdown | `server.mjs` |
| Worker lifecycle, clock, reset and WebSocket transport | `lib/simulation.mjs` |
| Simulation loop, demand, closure impact and diagnostics | `lib/sim-worker.mjs` |
| Car state, following force, lane changes and routing | `lib/car-sim.mjs`, `lib/personality.mjs` |
| Traffic observations and matching | `lib/observations.mjs` |
| Road preparation and model configuration | `build_roads.py`, `sim/roads.py`, `sim/config.json` |
| Bus feed, stop matching and animation | `lib/feed.mjs`, `lib/stops.mjs`, `lib/motion.mjs`, `public/bus-layer.js` |
| Train estimates and station busyness | `lib/trains.mjs`, `lib/crowding.mjs`, `public/trains.js` |
| Stop scenarios, assumptions and saved sessions | `lib/stop-control.mjs`, `lib/assumptions.mjs`, `lib/history.mjs`, `public/stop-tools.js` |
| Map, onboarding and styling | `public/app.js`, `public/ui.js`, `index.html`, `public/styles.css` |
| Car drawing, hotspots and browser performance | `public/sim-cars.js`, `lib/congestion.mjs`, `public/performance.js`, `public/performance-settings.js` |

Useful interfaces: `/api/simulation/status`, `/api/simulation/stream` (WebSocket), `/api/simulation/reinitialize`, `/api/simulation/pause`, `/api/simulation/clock`, `/api/simulation/closures`, `/api/stops`, `/api/history` and `/api/buses`. Read `server.mjs` for methods and request validation before scripting changes.

## Returning to the project

1. Check `git status` before switching branches. `main` includes the UX2 integration (`e54e272`) and charged-particle merge (`d1454e8`). The following-model implementation is `f557f65`. Preserve unrelated local work.
2. Use Node **24.5+** and `npm ci`. Configure your own credentials using `.env.example` and the README provider table. This summary contains no credential values.
3. If `data/network/roads.json` is missing, create a Python 3.12 `.venv`, install `sim/requirements.txt` and run `npm run build-roads`. Python is otherwise unnecessary at runtime.
4. Run `npm start` and open **http://localhost:3000**. A static server will not supply feeds, APIs or the simulation. Stop with Ctrl+C; if port 3000 is occupied, identify that listener before stopping it.
5. Check `/api/simulation/status` for lifecycle, observation freshness, actual/target population, clock mode, gridlock and timings. Check each feed's status before trusting a blank layer or apparent freeze.
6. Run checks appropriate to your changes:

```sh
npm test
npm run test:sim          # Python road-builder tests; requires the prepared environment
npx playwright install chromium --only-shell
npm run test:browser
npm run test:overlays
npm run test:integration
```

After the charged-particle update, **58 Node tests passed**, along with the browser overlay suite. The preceding UI integration also passed all three browser suites. These are fixture-based checks, not proof of live provider availability, predictive accuracy or a hardware performance guarantee. The existing README benchmark predates the following-model change; measure again before making performance claims about this version.

Generated network data, observations, train caches and screenshots live in `data/`, `.cache/` and `test-results/`; dependencies and the Python environment are local too. Fresh clones need setup and may initially show missing-network or feed-loading messages.

## Sensible next work

- Calibrate and compare the particle model with observed traffic; test high-speed following, merges and dense queues before treating the short preferred gap as realistic.
- Improve road completeness, turn restrictions and junction conflict handling.
- Add reproducible paired baseline/scenario runs for stronger closure-impact comparisons.
- Benchmark current demand levels on target hardware, including CPU, memory, frame rate and snapshot bandwidth.
- Review deployment configuration and credential handling before public hosting. Documentation cleanup alone does not remove previously committed credentials from source or history.
- Build journey planning and more defensible passenger-flow forecasts as separate features, rather than presenting them as already implemented.

For detailed installation, provider settings, endpoints and historical measurements, use [README.md](README.md). Treat current code and tests as the source of truth when they disagree with older plans or benchmark notes.
