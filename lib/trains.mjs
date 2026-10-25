import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Live Tube, DLR, Overground and Elizabeth line trains, placed on the line geometry from TfL arrival
// predictions. Positions are estimates: TfL publishes when each train is due at each station, not where it is.
export const TRAIN_POLL_MS = 15_000;
export const HOLD_MS = 60_000; // a train missing from the predictions holds its position this long, then is dropped
export const NOTICE = 'Estimated position from TfL arrival predictions';
// Official line colours; cars per drawn train; typical speed between stations including dwell (m/s).
const TUBE = { mode: 'tube', underground: true, cars: 6, speed: 9 };
const OVERGROUND = { mode: 'overground', underground: false, cars: 5, speed: 11 };
export const TRAIN_LINES = {
  bakerloo: { ...TUBE, name: 'Bakerloo', color: '#B36305' },
  central: { ...TUBE, name: 'Central', color: '#E32017' },
  circle: { ...TUBE, name: 'Circle', color: '#FFD300' },
  district: { ...TUBE, name: 'District', color: '#00782A' },
  'hammersmith-city': { ...TUBE, name: 'Hammersmith & City', color: '#F3A9BB' },
  jubilee: { ...TUBE, name: 'Jubilee', color: '#A0A5A9' },
  metropolitan: { ...TUBE, name: 'Metropolitan', color: '#9B0056' },
  northern: { ...TUBE, name: 'Northern', color: '#000000' },
  piccadilly: { ...TUBE, name: 'Piccadilly', color: '#003688' },
  victoria: { ...TUBE, name: 'Victoria', color: '#0098D4' },
  'waterloo-city': { ...TUBE, name: 'Waterloo & City', color: '#95CDBA' },
  dlr: { mode: 'dlr', underground: false, cars: 3, speed: 8, name: 'DLR', color: '#00A4A7' },
  elizabeth: { mode: 'elizabeth-line', underground: false, cars: 8, speed: 14, name: 'Elizabeth', color: '#6950A1' },
  liberty: { ...OVERGROUND, name: 'Liberty', color: '#676767' },
  lioness: { ...OVERGROUND, name: 'Lioness', color: '#F1B41C' },
  mildmay: { ...OVERGROUND, name: 'Mildmay', color: '#437EC1' },
  suffragette: { ...OVERGROUND, name: 'Suffragette', color: '#39B97A' },
  weaver: { ...OVERGROUND, name: 'Weaver', color: '#972861' },
  windrush: { ...OVERGROUND, name: 'Windrush', color: '#EF4D5E' },
};
const M_PER_LAT = 111_320, M_PER_LON = 111_320 * Math.cos(51.5 * Math.PI / 180);
const ON_LINE_M = 250; // a station counts as on a line string within this distance of it
const normal = name => String(name ?? '').toLowerCase().replace(/\b(underground|rail|dlr|station)\b/g, '').replace(/[^a-z0-9]/g, '');

// Keeps only what positioning needs from a /Line/{id}/Route/Sequence/{direction} response.
export function compactSequence(raw) {
  return {
    line: raw.lineId,
    strings: (raw.lineStrings ?? []).flatMap(text => JSON.parse(text)),
    stations: (raw.stopPointSequences ?? []).flatMap(seq => seq.stopPoint.map(p => [p.id, p.stationId, p.topMostParentId, p.name, p.lon, p.lat])),
    routes: (raw.orderedLineRoutes ?? []).map(route => route.naptanIds),
  };
}

// Per line: line strings with cumulative distances, stations by every id they go by (and name), the
// ordered station lists of each route, and each station's distance along each string it lies on.
export function buildNetwork(sequences) {
  const lines = {};
  for (const seq of sequences) {
    const line = lines[seq.line] ??= { strings: [], keys: new Set(), stations: new Map(), names: new Map(), routes: [] };
    for (const coords of seq.strings) {
      const key = JSON.stringify([coords[0], coords.at(-1), coords.length]), reverse = JSON.stringify([coords.at(-1), coords[0], coords.length]);
      if (coords.length < 2 || line.keys.has(key) || line.keys.has(reverse)) continue; // same track listed for both directions
      line.keys.add(key);
      const cum = [0];
      for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + Math.hypot((coords[k][0] - coords[k - 1][0]) * M_PER_LON, (coords[k][1] - coords[k - 1][1]) * M_PER_LAT));
      line.strings.push({ coords, cum, at: new Map() });
    }
    for (const [id, stationId, parentId, name, lon, lat] of seq.stations) {
      const station = { id, name, lon, lat };
      for (const key of [id, stationId, parentId]) if (key && !line.stations.has(key)) line.stations.set(key, station);
      if (!line.names.has(normal(name))) line.names.set(normal(name), station);
    }
    line.routes.push(...seq.routes);
  }
  for (const line of Object.values(lines)) {
    delete line.keys;
    for (const station of new Set(line.stations.values())) {
      line.strings.forEach(string => {
        const [d, off] = project(string, station.lon, station.lat);
        if (off < ON_LINE_M) string.at.set(station.id, d);
      });
    }
  }
  return lines;
}

// Distance along `string` of the point nearest (lon, lat), and how far off the string that point is (m).
function project(string, lon, lat) {
  const { coords, cum } = string;
  let best = 0, bestOff = Infinity;
  for (let k = 1; k < coords.length; k++) {
    const ax = (lon - coords[k - 1][0]) * M_PER_LON, ay = (lat - coords[k - 1][1]) * M_PER_LAT;
    const dx = (coords[k][0] - coords[k - 1][0]) * M_PER_LON, dy = (coords[k][1] - coords[k - 1][1]) * M_PER_LAT;
    const t = Math.max(0, Math.min(1, (ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    const off = Math.hypot(ax - t * dx, ay - t * dy);
    if (off < bestOff) { bestOff = off; best = cum[k - 1] + t * (cum[k] - cum[k - 1]); }
  }
  return [best, bestOff];
}

const stationOf = (line, prediction) => line.stations.get(prediction.naptanId) ?? line.names.get(normal(prediction.stationName));

// Estimates one train from its predictions (any order). Returns null when it cannot be placed.
// distance runs along line string `string`; dir is +1/-1 (direction of travel along it); the train is
// between its previous station (`from`) and next station (`limit`), never beyond either.
export function estimateTrain(network, predictions) {
  const sorted = predictions.filter(p => Number.isFinite(p.timeToStation)).sort((a, b) => a.timeToStation - b.timeToStation);
  const first = sorted[0], line = first && network[first.lineId], spec = first && TRAIN_LINES[first.lineId];
  if (!line || !spec) return null;
  const next = stationOf(line, first);
  if (!next) return null;
  const after = sorted.slice(1).map(p => stationOf(line, p)).find(s => s && s.id !== next.id);
  // Previous station: the one before `next` on a route that also runs on to the following predicted station.
  let previous = null;
  for (const route of line.routes) {
    const k = route.findIndex(id => line.stations.get(id)?.id === next.id);
    if (k <= 0) continue;
    if (after && !route.slice(k + 1).some(id => line.stations.get(id)?.id === after.id)) continue;
    previous = line.stations.get(route[k - 1]) ?? null;
    if (previous) break;
  }
  // The line string carrying both stations (or, at a route's first station, the next one alone).
  let string = -1;
  line.strings.forEach((s, index) => {
    if (string < 0 && s.at.has(next.id) && (!previous || s.at.has(previous.id)) && (previous || !after || s.at.has(after.id))) string = index;
  });
  if (string < 0) return null;
  const at = line.strings[string].at, limit = at.get(next.id);
  const from = previous ? at.get(previous.id) : limit; // no previous station: waiting at the start of its route
  let dir = Math.sign(limit - from);
  if (!dir) dir = after && at.has(after.id) ? Math.sign(at.get(after.id) - limit) || 1 : 1;
  const segment = Math.abs(limit - from), segmentTime = Math.max(30, segment / spec.speed);
  const t = Math.max(0, first.timeToStation);
  const fraction = Math.max(0, Math.min(1, 1 - t / segmentTime));
  const distance = from + (limit - from) * fraction;
  const speed = Math.min(spec.speed * 1.8, Math.abs(limit - distance) / Math.max(t, 5));
  return {
    id: `${first.lineId}:${first.vehicleId}`, line: first.lineId, string, distance: Math.round(distance * 10) / 10, dir,
    speed: Math.round(speed * 100) / 100, limit: Math.round(limit * 10) / 10,
    nextStation: next.name, timeToStation: t, destination: first.destinationName || first.towards || '', location: first.currentLocation || '',
  };
}

// Groups predictions by train and keeps stable ids across polls. A train missing from a poll holds
// where it was (speed 0) for HOLD_MS, then is dropped.
export class TrainTracker {
  constructor() { this.trains = new Map(); }

  // Stopped lines: their trains freeze where they are (and are never dropped), no new ones appear.
  setStopped(line, stopped, now) {
    for (const [id, train] of this.trains) {
      if (train.line !== line) continue;
      if (!stopped) { this.trains.set(id, { ...train, stopped: false, seenAt: now }); continue; }
      const moved = train.held ? 0 : Math.min(Math.abs(train.limit - train.distance), train.speed * (now - train.seenAt) / 1000);
      this.trains.set(id, { ...train, distance: Math.round((train.distance + train.dir * moved) * 10) / 10, speed: 0, held: true, stopped: true });
    }
  }

  update(network, predictions, now, stoppedLines = new Set()) {
    const byTrain = new Map();
    for (const p of predictions) {
      const vehicle = String(p.vehicleId ?? '').trim();
      if (!vehicle || /^0+$/.test(vehicle) || !TRAIN_LINES[p.lineId] || stoppedLines.has(p.lineId)) continue; // blank ids cannot be tracked (e.g. DLR)
      const key = `${p.lineId}:${vehicle}`;
      if (!byTrain.has(key)) byTrain.set(key, []);
      byTrain.get(key).push(p);
    }
    for (const group of byTrain.values()) {
      const train = estimateTrain(network, group);
      if (train) this.trains.set(train.id, { ...train, seenAt: now, held: false });
    }
    for (const [id, train] of this.trains) {
      if (train.seenAt === now || train.stopped) continue;
      if (now - train.seenAt > HOLD_MS) this.trains.delete(id);
      else if (!train.held) {
        // Hold at the position it would have reached by now.
        const moved = Math.min(Math.abs(train.limit - train.distance), train.speed * (now - train.seenAt) / 1000);
        this.trains.set(id, { ...train, distance: Math.round((train.distance + train.dir * moved) * 10) / 10, speed: 0, held: true });
      }
    }
  }

  list(now) {
    return [...this.trains.values()].map(({ seenAt, ...train }) => ({ ...train, age: Math.round((now - seenAt) / 1000) }));
  }
}

export class TrainFeed {
  constructor({ appKey = '', fetchImpl = fetch, now = Date.now, cachePath = new URL('../data/trains/routes.json', import.meta.url) } = {}) {
    this.appKey = appKey;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cachePath = cachePath;
    this.network = null;
    this.linesGeoJSON = { type: 'FeatureCollection', features: [] };
    this.tracker = new TrainTracker();
    this.stoppedLines = new Set();
    this.fetchedAt = null;
    this.failed = false;
    this.polling = false;
  }

  url(path) {
    const url = new URL(path, 'https://api.tfl.gov.uk');
    if (this.appKey) url.searchParams.set('app_key', this.appKey);
    return url;
  }

  // Line geometry: from the disk cache, else fetched once (two directions per line) and cached.
  async loadNetwork() {
    let sequences;
    try { sequences = JSON.parse(await readFile(this.cachePath, 'utf8')); } catch { sequences = null; }
    if (!sequences) {
      sequences = [];
      for (const id of Object.keys(TRAIN_LINES)) {
        for (const direction of ['outbound', 'inbound']) {
          try {
            const response = await this.fetchImpl(this.url(`/Line/${id}/Route/Sequence/${direction}`), { signal: AbortSignal.timeout(20_000) });
            if (response.ok) sequences.push(compactSequence(await response.json()));
          } catch { /* Do not log: URLs may carry the key. A missing line is retried on the next start. */ }
        }
      }
      const complete = Object.keys(TRAIN_LINES).every(id => sequences.some(s => s.line === id));
      if (complete) {
        try { await mkdir(new URL('./', this.cachePath), { recursive: true }); await writeFile(this.cachePath, JSON.stringify(sequences)); } catch { /* Cache is optional. */ }
      }
    }
    this.network = buildNetwork(sequences);
    this.linesGeoJSON = {
      type: 'FeatureCollection',
      features: Object.entries(this.network).flatMap(([line, { strings }]) => strings.map((s, string) => ({
        type: 'Feature', properties: { line, string, name: TRAIN_LINES[line].name, color: TRAIN_LINES[line].color, underground: TRAIN_LINES[line].underground, cars: TRAIN_LINES[line].cars },
        geometry: { type: 'LineString', coordinates: s.coords },
      }))),
    };
  }

  async start() {
    try { await this.loadNetwork(); } catch { this.network = {}; }
    await this.poll();
    this.timer = setInterval(() => void this.poll(), TRAIN_POLL_MS);
    return this;
  }

  stop() { clearInterval(this.timer); }

  async poll() {
    if (this.polling || !this.network) return;
    this.polling = true;
    try {
      const response = await this.fetchImpl(this.url(`/Line/${Object.keys(TRAIN_LINES).join(',')}/Arrivals`), { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`TfL HTTP ${response.status}`);
      const predictions = await response.json();
      if (!Array.isArray(predictions)) throw new Error('Unexpected TfL response');
      const now = this.now();
      this.tracker.update(this.network, predictions, now, this.stoppedLines);
      this.fetchedAt = new Date(now).toISOString();
      this.failed = false;
    } catch {
      // Keep the last trains (they hold, then expire). Do not log: URLs may carry the key.
      this.failed = true;
      this.tracker.update(this.network, [], this.now(), this.stoppedLines);
    } finally { this.polling = false; }
  }

  getSnapshot() {
    const now = this.now();
    const status = !this.fetchedAt ? (this.network ? 'loading' : 'unavailable') : this.failed || now - Date.parse(this.fetchedAt) > HOLD_MS ? 'stale' : 'live';
    return { status, notice: NOTICE, fetchedAt: this.fetchedAt, serverTime: now, trains: this.tracker.list(now) };
  }
}
