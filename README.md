# OxHack2026

MapTiler API key: `Piqlzte12zD4i2H9jha1`

## TomTom Traffic
Key: `CPnPmYj0K9TjSsJsQ7cQp3NJ6vjm0c8C` (Traffic API, Evaluation tier, ~2,500 requests/day).

## Bus GPS (handled by teammate)
BODS key: `e5f1a3ff2cedd7e7cdd90c9eb38c58741a0b9ea3`. Bus Open Data Service live bus GPS. **Never use in browser code.**

## TfL Unified API
Key: `f8f5ffa16163428b8f2ceaa86afdb967` (https://api.tfl.gov.uk). Not needed for the map's JamCam camera list, which TfL serves without a key; use it for higher rate limits (BikePoint, road disruptions, line status).

## National Highways WebTRIS
No key needed. Base: `https://webtris.nationalhighways.co.uk/api/v1.0`
- `/sites`
- `/reports/{start_date}/to/{end_date}/Daily?sites=<ID>&page=1&page_size=100` (dates `DDMMYYYY`)

Motorways and major A-roads only. Historical training data.

## Vehicle estimate method
All numbers on the map are **estimates**, shown from zoom 15 (3D vehicles from zoom 16).
1. **TomTom speed ratio.** Flow Segment Data for the view centre plus up to 8 points along visible major roads gives `speed_ratio = currentSpeed / freeFlowSpeed`. Each road takes the ratio of the nearest point within ~300 m, otherwise the view average. Calls are cached and capped at 9 a minute and 2,000 a day (counter in localStorage).
2. **Greenshields density.** `density = 120 * (1 - speed_ratio)` vehicles per lane per km; vehicles on a road = density × lanes × length in view (lanes: motorway/trunk 3, primary 2, others 1).
3. **WebTRIS-trained calibration.** `train.py` fits a gradient boosting model (hour, day of week, speed ratio, lanes → flow per lane per hour) on 4 weeks of 15-minute data from ~30 National Highways sensors near London. The map looks up `flow_table.json`, converts flow to density (flow ÷ speed), and if the two densities differ by more than 2× uses the lower one. The holdout MAE (last week) is shown on the panel.

The 3D layer spawns that many cars (plus ~5% red buses on primary/secondary roads, max 300) moving at the live speed. `renderBuses([{ lng, lat, bearing }])` swaps the simulated buses for real ones (BODS); `renderBuses(null)` switches back.

### Run
```
pip install scikit-learn numpy
python train.py          # writes flow_table.json (WebTRIS data lags by months; the script finds the newest 4 weeks)
python -m http.server    # then open http://localhost:8000
```
