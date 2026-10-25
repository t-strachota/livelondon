import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Station busyness (TfL crowding API) spread along the train lines. This is station-level crowding
// (tap-ins relative to TfL's baseline) interpolated between stations, not measured on-train load.
export const BUSYNESS_MS = 60_000; // map data rebuilt this often
export const BUSYNESS_NOTICE = 'Station crowding spread along the line, not measured on-train load';
const TICK_MS = 10_000;
const LIVE_FRESH_MS = 15 * 60_000; // a live value older than this falls back to typical
const SPLIT = 6; // pieces per station-to-station span, each with its own interpolated busyness
const londonClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const normal = name => String(name ?? '').toLowerCase().replace(/\b(underground|rail|dlr|station)\b/g, '').replace(/[^a-z0-9]/g, '');

export function londonSlot(now) {
  const parts = Object.fromEntries(londonClock.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { day: parts.weekday, slot: Number(parts.hour) * 4 + Math.floor(Number(parts.minute) / 15) };
}

export class CrowdingFeed {
  constructor({ trains, appKey = '', fetchImpl = fetch, now = Date.now, cachePath = new URL('../data/trains/crowding-typical.json', import.meta.url) } = {}) {
    Object.assign(this, { trains, appKey, fetchImpl, now, cachePath });
    this.stations = new Map(); // naptan queried -> { live, liveAt, available }
    this.typical = {}; // `${naptan}:${day}` -> 96 values, or null when TfL has none
    this.geojson = { type: 'FeatureCollection', features: [] };
    this.queue = [];
    this.builtAt = 0;
  }

  url(path) {
    const url = new URL(path, 'https://api.tfl.gov.uk');
    if (this.appKey) url.searchParams.set('app_key', this.appKey);
    return url;
  }

  async start() {
    try { this.typical = JSON.parse(await readFile(this.cachePath, 'utf8')); } catch { this.typical = {}; }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
    return this;
  }

  stop() { clearInterval(this.timer); }

  // Which naptan to ask about for each station: its own if it is a Tube station (940G…), else a Tube
  // station with the same name (shared stations), else its own (TfL may have Elizabeth line data).
  sources() {
    const network = this.trains.network;
    if (!network) return null;
    if (this.sourceMap) return this.sourceMap;
    const tubeByName = new Map(), map = new Map();
    for (const line of Object.values(network)) for (const s of line.stations.values()) if (s.id.startsWith('940GZZLU')) tubeByName.set(normal(s.name), s.id);
    for (const line of Object.values(network)) for (const s of line.stations.values()) {
      if (map.has(s.id)) continue;
      const tube = s.id.startsWith('940GZZLU') ? s.id : tubeByName.get(normal(s.name));
      map.set(s.id, { naptan: tube ?? s.id, viaTube: Boolean(tube) && tube !== s.id });
    }
    return (this.sourceMap = map);
  }

  // Rolling refresh within TfL's rate limit: every station's live value about once a minute with a key,
  // about every 6 minutes without; typical profiles are fetched once per weekday and cached.
  async tick() {
    if (this.busy) return;
    const sources = this.sources();
    if (!sources) return;
    this.busy = true;
    try {
      if (!this.queue.length) this.queue = [...new Set([...sources.values()].map(s => s.naptan))];
      const budget = this.appKey ? 50 : 6, { day } = londonSlot(this.now());
      let dirty = false;
      for (let used = 0; used < budget && this.queue.length;) {
        const naptan = this.queue.shift(), key = `${naptan}:${day}`;
        if (!(key in this.typical)) {
          used++;
          const body = await this.get(`/crowding/${naptan}/${day}`);
          if (body) {
            this.typical[key] = body.isFound && body.timeBands?.length === 96 ? body.timeBands.map(b => Number(b.percentageOfBaseLine) || 0) : null;
            dirty = true;
          }
        }
        if (this.typical[key] === null && !this.stations.get(naptan)?.available) continue; // TfL has no data for it
        used++;
        const live = await this.get(`/crowding/${naptan}/Live`);
        if (live) this.stations.set(naptan, { available: Boolean(live.dataAvailable), live: Number(live.percentageOfBaseline) || 0, liveAt: this.now() });
      }
      if (dirty) { try { await mkdir(new URL('./', this.cachePath), { recursive: true }); await writeFile(this.cachePath, JSON.stringify(this.typical)); } catch { /* Cache is optional. */ } }
      if (this.now() - this.builtAt >= BUSYNESS_MS) this.build();
    } finally { this.busy = false; }
  }

  async get(path) {
    try {
      const response = await this.fetchImpl(this.url(path), { signal: AbortSignal.timeout(10_000) });
      return response.ok ? await response.json() : null;
    } catch { return null; } // Do not log: URLs may carry the key.
  }

  // Busyness 0-1 of a station now: { value, source: 'live' | 'typical', viaTube } or null.
  busyness(stationId, now = this.now()) {
    const source = this.sources()?.get(stationId);
    if (!source) return null;
    const live = this.stations.get(source.naptan), { day, slot } = londonSlot(now);
    if (live?.available && now - live.liveAt < LIVE_FRESH_MS) return { value: Math.min(1, Math.max(0, live.live)), source: 'live', viaTube: source.viaTube };
    const typical = this.typical[`${source.naptan}:${day}`];
    return typical ? { value: Math.min(1, Math.max(0, typical[slot])), source: 'typical', viaTube: source.viaTube } : null;
  }

  // Each station-to-station span of every line string, cut into SPLIT pieces with busyness interpolated
  // between the two stations (one station's value when only one has data).
  build() {
    const network = this.trains.network, now = this.now(), features = [];
    this.builtAt = now;
    for (const [line, { strings, stations }] of Object.entries(network ?? {})) {
      const byId = new Map([...stations.values()].map(s => [s.id, s]));
      for (const string of strings) {
        const stops = [...string.at].sort((a, b) => a[1] - b[1]);
        for (let k = 1; k < stops.length; k++) {
          const [aId, da] = stops[k - 1], [bId, db] = stops[k];
          if (db - da < 1) continue;
          const a = this.busyness(aId, now), b = this.busyness(bId, now);
          if (!a && !b) continue;
          const va = (a ?? b).value, vb = (b ?? a).value;
          for (let piece = 0; piece < SPLIT; piece++) {
            const t0 = piece / SPLIT, t1 = (piece + 1) / SPLIT;
            features.push({
              type: 'Feature',
              properties: {
                line, busyness: Math.round((va + (vb - va) * (t0 + t1) / 2) * 1000) / 1000,
                from: byId.get(aId)?.name ?? '', to: byId.get(bId)?.name ?? '',
                fromValue: a ? Math.round(a.value * 100) : null, toValue: b ? Math.round(b.value * 100) : null,
                fromSource: a ? a.source + (a.viaTube ? ' (via Tube station)' : '') : 'no data', toSource: b ? b.source + (b.viaTube ? ' (via Tube station)' : '') : 'no data',
              },
              geometry: { type: 'LineString', coordinates: slice(string, da + (db - da) * t0, da + (db - da) * t1) },
            });
          }
        }
      }
    }
    this.geojson = { type: 'FeatureCollection', notice: BUSYNESS_NOTICE, builtAt: new Date(now).toISOString(), features };
  }
}

// The part of a line string between two distances along it.
function slice({ coords, cum }, from, to) {
  const point = d => {
    let k = 1;
    while (k < cum.length - 1 && cum[k] < d) k++;
    const t = (d - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
    return [+(coords[k - 1][0] + (coords[k][0] - coords[k - 1][0]) * t).toFixed(6), +(coords[k - 1][1] + (coords[k][1] - coords[k - 1][1]) * t).toFixed(6)];
  };
  const out = [point(from)];
  for (let k = 0; k < coords.length; k++) if (cum[k] > from && cum[k] < to) out.push(coords[k]);
  out.push(point(to));
  return out;
}
