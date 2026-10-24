export const LANES = { motorway: 3, trunk: 3, primary: 2, secondary: 1, tertiary: 1, minor: 1 };
export const MAX_CARS = 300;
export const metres = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 110540);

export class FlowClient {
  constructor({ key, fetchImpl = fetch, storage, now = Date.now } = {}) {
    this.key = key; this.fetchImpl = (...args) => fetchImpl(...args); this.storage = storage; this.now = now;
    this.cache = new Map(); this.pending = new Map(); this.callTimes = []; this.calls = { day: '', n: 0 };
  }

  flowAt(lat, lon, signal) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`, hit = this.cache.get(key), now = this.now();
    if (hit && now - hit.at < 180_000) return Promise.resolve(hit);
    if (this.pending.has(key)) return this.pending.get(key);
    this.callTimes = this.callTimes.filter(time => now - time < 60_000);
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.calls.day !== day) {
      this.calls = { day, n: 0 };
      try { this.calls.n = Math.max(0, Number(this.storage?.getItem(`tomtom-flow-${day}`)) || 0); } catch { /* Optional storage. */ }
    }
    const stale = () => hit ? { ...hit, stale: true } : null;
    if (this.callTimes.length >= 9 || this.calls.n >= 2000 || signal?.aborted) return Promise.resolve(stale());
    this.callTimes.push(now); this.calls.n++;
    try { this.storage?.setItem(`tomtom-flow-${day}`, String(this.calls.n)); } catch { /* Optional storage. */ }
    const promise = (async () => {
      try {
        const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${lat},${lon}&key=${this.key}`;
        const response = await this.fetchImpl(url, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error('Traffic speeds unavailable');
        const { flowSegmentData: data } = await response.json();
        if (!Number.isFinite(data?.currentSpeed) || data.currentSpeed < 0 || !Number.isFinite(data.freeFlowSpeed) || data.freeFlowSpeed <= 0) throw new Error('Invalid traffic speed');
        const value = { at: this.now(), ratio: Math.min(1, data.currentSpeed / data.freeFlowSpeed), kmh: data.currentSpeed, stale: false };
        this.cache.set(key, value);
        return value;
      } catch { return stale(); }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}

// Clip crossing segments too: both original endpoints can lie outside the viewport.
export function clipLine(line, bounds) {
  const [west, south, east, north] = bounds;
  const runs = [];
  let run = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let low = 0, high = 1, outside = false;
    for (const [p, q] of [[-dx, a[0] - west], [dx, east - a[0]], [-dy, a[1] - south], [dy, north - a[1]]]) {
      if (p === 0) { if (q < 0) outside = true; continue; }
      const t = q / p;
      if (p < 0) low = Math.max(low, t); else high = Math.min(high, t);
    }
    if (outside || low > high) { if (run.length > 1) runs.push(run); run = []; continue; }
    const start = [a[0] + low * dx, a[1] + low * dy], end = [a[0] + high * dx, a[1] + high * dy];
    if (run.length && metres(run.at(-1), start) > .01) { if (run.length > 1) runs.push(run); run = []; }
    if (!run.length) run.push(start);
    if (metres(run.at(-1), end) > .01) run.push(end);
    if (high < 1) { if (run.length > 1) runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

export function extractRoads(features, bounds) {
  const seen = new Set(), roads = [];
  for (const feature of features) {
    const cls = feature.properties?.class, lanes = LANES[cls], geometry = feature.geometry;
    if (!lanes || !geometry) continue;
    const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
    for (const original of lines) for (const line of clipLine(original, bounds)) {
      const forward = JSON.stringify(line), reverse = JSON.stringify([...line].reverse());
      const id = cls + (forward < reverse ? forward : reverse);
      if (seen.has(id)) continue;
      seen.add(id);
      const m = line.slice(1).reduce((sum, point, i) => sum + metres(line[i], point), 0);
      if (m > 5) roads.push({ id, cls, lanes, line, m, oneway: feature.properties.oneway });
    }
  }
  return roads;
}

export function londonTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return { day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find(part => part.type === 'weekday').value), hour: Number(parts.find(part => part.type === 'hour').value) };
}

export function predictedFlow(model, day, hour, ratio) {
  const value = model?.table?.[day]?.[hour]?.[Math.min(9, Math.max(0, Math.round(ratio * 10) - 1))];
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function estimateTraffic(roads, samples, model, date = new Date()) {
  const usable = samples.filter(sample => Number.isFinite(sample.ratio) && sample.ratio >= 0 && sample.ratio <= 1 && Number.isFinite(sample.kmh) && sample.kmh >= 0);
  if (!usable.length) return null;
  const ratio = usable.reduce((sum, sample) => sum + sample.ratio, 0) / usable.length;
  const kmh = usable.reduce((sum, sample) => sum + sample.kmh, 0) / usable.length;
  const { day, hour } = londonTime(date);
  const estimated = roads.map(road => {
    let best, nearest = 300;
    for (const sample of usable) for (const point of road.line) {
      const d = metres(point, sample.p);
      if (d < nearest) { best = sample; nearest = d; }
    }
    const speedRatio = best?.ratio ?? ratio, speed = best?.kmh ?? kmh;
    let density = 120 * (1 - speedRatio);
    const flow = predictedFlow(model, day, hour, speedRatio);
    if (flow != null) {
      const calibrated = flow / Math.max(speed, 5);
      if (Math.max(density, calibrated) > 2 * Math.min(density, calibrated)) density = Math.min(density, calibrated);
    }
    return { ...road, ratio: speedRatio, kmh: speed, vehicles: density * road.lanes * road.m / 1000 };
  });
  return { roads: estimated, total: estimated.reduce((sum, road) => sum + road.vehicles, 0), ratio, kmh, flow: predictedFlow(model, day, hour, ratio), samples: usable.length };
}

export function spawnCars(roads, random = Math.random) {
  const total = roads.reduce((sum, road) => sum + road.vehicles, 0);
  if (!(total > 0)) return [];
  const factor = Math.min(1, MAX_CARS / total), cars = [];
  for (const road of roads) {
    const desired = road.vehicles * factor, n = Math.floor(desired) + (random() < desired % 1 ? 1 : 0);
    const cumulative = [0];
    for (let i = 1; i < road.line.length; i++) cumulative.push(cumulative[i - 1] + metres(road.line[i - 1], road.line[i]));
    const length = cumulative.at(-1);
    if (length < 5) continue;
    for (let i = 0; i < n && cars.length < MAX_CARS; i++) cars.push({
      id: cars.length, line: road.line, cumulative, length, s: random() * length,
      direction: String(road.oneway) === '1' ? 1 : String(road.oneway) === '-1' ? -1 : random() < .5 ? 1 : -1,
      speed: Number.isFinite(road.kmh) ? road.kmh / 3.6 : 32 / 3.6,
      lane: 1.75 + 3.5 * Math.floor(random() * road.lanes),
    });
  }
  return cars;
}

export function stepCars(cars, deltaSeconds) {
  return { type: 'FeatureCollection', features: cars.map(car => {
    car.s = (car.s + car.direction * car.speed * Math.min(.1, Math.max(0, deltaSeconds)) + car.length) % car.length;
    let i = 1;
    while (i < car.cumulative.length - 1 && car.cumulative[i] < car.s) i++;
    const a = car.line[i - 1], b = car.line[i], segment = car.cumulative[i] - car.cumulative[i - 1] || 1;
    const t = (car.s - car.cumulative[i - 1]) / segment;
    const x = (b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180) / segment * car.direction;
    const y = (b[1] - a[1]) * 110540 / segment * car.direction;
    const latitude = a[1] + (b[1] - a[1]) * t + x * car.lane / 110540;
    const longitude = a[0] + (b[0] - a[0]) * t - y * car.lane / (111320 * Math.cos(latitude * Math.PI / 180));
    return { type: 'Feature', id: car.id, geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties: { estimated: true, kind: 'estimated-car' } };
  }) };
}
