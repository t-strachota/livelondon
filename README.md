# London live buses

Live TfL bus GPS positions on a London street map. Zoomed-out buses are red dots; between zoom 16 and 17 they crossfade into small 3D double-deckers, while the map tilts gradually to 40 degrees. Grey dots are bus stops. Click a bus to see its route, destination, vehicle and GPS recording time.

## Run locally

Requires Node.js 24.5 or newer.

```sh
npm install
```

The supplied [Bus Open Data Service](https://data.bus-data.dft.gov.uk/) key is included in the Git-tracked `.env`, as requested, so a checkout can run immediately. Edit `BODS_API_KEY` there to use another key. `.env.example` remains a blank template. The server does not serve `.env` or send the key to the browser.

```sh
npm start
```

Open **http://localhost:3000**. Set `PORT` in `.env` if needed. The app is served by Node; opening `index.html` directly or using a static-only server will not provide the live API. The start command honours existing HTTP/HTTPS proxy environment variables.

## Map layers

Use the **Live TfL buses** switch in the map panel to show or hide the bus overlay. It starts enabled and remembers your selection in this browser. Turning it off hides the dots, 3D buses, stop markers and bus information, closes bus popups, pauses bus requests, and restores a flat map. Turning it on immediately loads fresh positions and restores the zoom-dependent bus models and tilt. The basemap remains available throughout.

## API keys and configuration

The shared project keys are included below as requested. The BODS key is also in the Git-tracked `.env`; the MapTiler browser key is configured in `public/app.js`.

| Service | Project API key | Used for |
| --- | --- | --- |
| DfT Bus Open Data Service (BODS) | `e5f1a3ff2cedd7e7cdd90c9eb38c58741a0b9ea3` | Live TfL bus GPS positions; used by the Node server. |
| MapTiler | `Piqlzte12zD4i2H9jha1` | Streets, buildings, road labels and basemap tiles in the browser. |
| TfL Unified API | No key needed at this usage level | Physical bus stops, route memberships and compass directions. |
| OpenStreetMap / Overpass | No key | Fallback display of bus-stop markers. |

To replace a key, edit `BODS_API_KEY` in `.env` or `MAPTILER_KEY` in `public/app.js`. Changing the BODS key requires restarting `npm start`; changing the MapTiler key requires refreshing the page.

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
| Tests | `npm test`; `npx playwright install chromium --only-shell`; `npm run test:browser`. |
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

The GPS feed and route-specific stop catalog are handled by the server. The BODS key never appears in API responses or frontend assets. The map retains its existing public MapTiler browser key. The local server binds to loopback. Deployment needs a Node-capable host; publishing only static files will not run the feed.

## Checks

```sh
npm test
npx playwright install chromium --only-shell
npm run test:browser
```

Unit and HTTP tests cover XML parsing, freshness, caching, outage recovery, full-interval interpolation, no overshoot, stop jitter, confirmed departures, route ownership, night routes, headings, route changes, stop pagination and cache reuse. Browser tests use clearly isolated fixtures to check WebGL rendering, zoom crossfades, tilt, popups, culling, 8,000 overview vehicles and the 3D fallback. Screenshots are written to ignored `test-results/`. Set `LIVE_URL=http://localhost:3000` when running browser checks to also verify the running authenticated live map.

## Data credits

- Bus locations: TfL iBus via DfT Bus Open Data Service, [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
- Route-to-stop memberships: Transport for London Unified API.
- Basemap: MapTiler and OpenStreetMap contributors, as credited on the map.
- Bus stops: OpenStreetMap contributors via map tiles and Overpass.
