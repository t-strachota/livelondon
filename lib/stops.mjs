import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { distance, normalizeRoute } from './motion.mjs';
import { LONDON_BOUNDS } from './feed.mjs';

export const STOP_RADIUS_METRES = 20;
const DAY_MS = 86_400_000;
const compass = new Map(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((point, i) => [point, i * 45]));

export function parseStops(points) {
  const [west, south, east, north] = LONDON_BOUNDS;
  return points.flatMap(point => {
    if (point.stopType !== 'NaptanPublicBusCoachTram' || point.status === false || !point.id || !Number.isFinite(point.lon) || !Number.isFinite(point.lat)) return [];
    if (point.lon < west || point.lon > east || point.lat < south || point.lat > north) return [];
    const routes = [...new Set((point.lines ?? []).map(line => normalizeRoute(line.id)).filter(Boolean))];
    if (!routes.length) return [];
    const direction = point.additionalProperties?.find(property => property.key === 'CompassPoint')?.value;
    return [{ id: point.id, name: point.commonName || point.name || 'Bus stop', longitude: point.lon, latitude: point.lat, routes, bearing: compass.get(direction) ?? null }];
  });
}

export class StopIndex {
  constructor(stops = []) { this.byId = new Map(); this.byRoute = new Map(); this.add(stops); }

  add(stops) {
    for (const stop of stops) {
      if (this.byId.has(stop.id)) continue;
      this.byId.set(stop.id, stop);
      for (const route of stop.routes) {
        if (!this.byRoute.has(route)) this.byRoute.set(route, []);
        this.byRoute.get(route).push(stop);
      }
    }
  }

  match(bus) {
    const route = normalizeRoute(bus.route);
    if (!route || bus.atStop === false) return null;
    const explicit = bus.atStop === true && bus.stopRef ? this.byId.get(bus.stopRef) : null;
    if (explicit?.routes.includes(route)) return { id: explicit.id, name: explicit.name, route };
    let nearest = null, nearestDistance = STOP_RADIUS_METRES;
    for (const stop of this.byRoute.get(route) ?? []) {
      if (Number.isFinite(bus.bearing) && Number.isFinite(stop.bearing)) {
        const angle = Math.abs(((bus.bearing - stop.bearing + 540) % 360) - 180);
        if (angle > 67.5) continue;
      }
      const metres = distance(bus, stop);
      if (metres <= nearestDistance) { nearest = stop; nearestDistance = metres; }
    }
    return nearest ? { id: nearest.id, name: nearest.name, route } : null;
  }
}

export class StopCatalog {
  constructor({ cacheFile = new URL('../.cache/tfl-stops.json', import.meta.url), fetchImpl = fetch, now = Date.now, intervalMs = 1500 } = {}) {
    this.cacheFile = cacheFile instanceof URL ? fileURLToPath(cacheFile) : cacheFile;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.intervalMs = intervalMs;
    this.index = new StopIndex();
    this.status = 'loading';
    this.updatedAt = null;
    this.pending = null;
  }

  match(bus) { return this.index.match(bus); }

  start() {
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  async load() {
    try {
      const cached = JSON.parse(await readFile(this.cacheFile, 'utf8'));
      if (cached.version === 1 && Array.isArray(cached.stops) && cached.stops.length && Number.isFinite(Date.parse(cached.updatedAt))) {
        this.index = new StopIndex(cached.stops);
        this.updatedAt = cached.updatedAt;
        this.status = 'ready';
        if (this.now() - Date.parse(cached.updatedAt) < DAY_MS) { this.schedule(DAY_MS - (this.now() - Date.parse(cached.updatedAt))); return; }
      }
    } catch { /* A missing cache is normal on a fresh checkout. */ }
    const next = new StopIndex();
    const initial = this.index.byId.size === 0;
    if (initial) this.index = next;
    this.status = initial ? 'loading' : 'refreshing';
    try {
      let totalPages = 1, requestedAt = -Infinity;
      for (let page = 1; page <= totalPages; page++) {
        const delay = this.intervalMs - (this.now() - requestedAt);
        if (delay > 0) await sleep(delay);
        requestedAt = this.now();
        const response = await this.fetchImpl(`https://api.tfl.gov.uk/StopPoint/Mode/bus?page=${page}`, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error('TfL stop data unavailable');
        const data = await response.json();
        if (!Array.isArray(data.stopPoints) || !Number.isFinite(data.total) || !Number.isFinite(data.pageSize) || data.pageSize <= 0) throw new Error('Invalid TfL stop data');
        // TfL reports the number RETURNED on this page, including a shorter final page.
        // Recomputing from that final size would invent extra pages and never finish.
        if (page === 1) totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
        if (totalPages > 100) throw new Error('Unexpected stop pagination');
        next.add(parseStops(data.stopPoints));
      }
      if (!next.byId.size) throw new Error('Empty TfL stop catalog');
      this.index = next;
      this.updatedAt = new Date(this.now()).toISOString();
      this.status = 'ready';
      try {
        await mkdir(dirname(this.cacheFile), { recursive: true });
        await writeFile(this.cacheFile, JSON.stringify({ version: 1, updatedAt: this.updatedAt, stops: [...next.byId.values()] }));
      } catch { /* In-memory stop matching still works on read-only deployments. */ }
      this.schedule(DAY_MS);
    } catch {
      this.status = this.index.byId.size ? 'partial' : 'unavailable';
      this.schedule(60_000);
    }
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.start(); }, delay);
    this.timer.unref();
  }

  close() { clearTimeout(this.timer); }
}
