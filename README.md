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
