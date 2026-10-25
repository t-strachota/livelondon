// Server-side TomTom vector flow tiles: fetch (bounded, cached, budgeted), decode, label freshness,
// and turn them into per-road placement weights for the car simulation.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';

const TAGS = '[road_type,traffic_level,road_closure,left_hand_traffic]';
const MATCH_METRES = 15, MAX_BEARING_DIFF = 45, SAMPLE_METRES = 20, NEARBY_METRES = 1000, DEFAULT_RATIO = .9;

export function tilesFor([west, south, east, north], zoom) {
  const n = 2 ** zoom;
  const tx = lon => Math.floor((lon + 180) / 360 * n);
  const ty = lat => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  const tiles = [];
  for (let x = tx(west); x <= tx(east); x++) for (let y = ty(north); y <= ty(south); y++) tiles.push([zoom, x, y]);
  return tiles;
}

export function tomtomKey(root) {
  if (process.env.TOMTOM_KEY) return process.env.TOMTOM_KEY.trim();
  try { return readFileSync(new URL('public/config.js', root), 'utf8').match(/'([^']+)'/)?.[1] ?? null; } catch { return null; }
}

// Fetches each tile once per cache period. Never logs URLs (they carry the key).
export async function fetchTiles({ key, cacheDir, tiles, styles = ['relative', 'absolute'], cacheSeconds, maxRequests, concurrency, fetchImpl = fetch, onProgress = () => {} }) {
  await mkdir(cacheDir, { recursive: true });
  let budget = maxRequests, done = 0;
  const jobs = styles.flatMap(style => tiles.map(tile => ({ style, tile })));
  const results = [];
  async function get({ style, tile: [z, x, y] }) {
    const path = new URL(`${style}-${z}-${x}-${y}.pbf`, cacheDir);
    const cached = await stat(path).catch(() => null);
    if (cached && Date.now() - cached.mtimeMs < cacheSeconds * 1000) return { data: await readFile(path), fetchedAt: cached.mtimeMs, source: 'cache' };
    if (key && budget > 0) {
      budget--;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const response = await fetchImpl(`https://api.tomtom.com/traffic/map/4/tile/flow/${style}/${z}/${x}/${y}.pbf?key=${encodeURIComponent(key)}&tags=${TAGS}`, { signal: AbortSignal.timeout(20_000) });
          if ((response.status === 429 || response.status === 503) && attempt < 3) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
          if (!response.ok) break;
          const data = Buffer.from(await response.arrayBuffer());
          await writeFile(new URL(`${path.href}.part`), data);
          await rename(new URL(`${path.href}.part`), path);
          return { data, fetchedAt: Date.now(), source: 'live' };
        } catch { break; }
      }
    }
    // Older cached data is still usable, but is labelled stale.
    return cached ? { data: await readFile(path), fetchedAt: cached.mtimeMs, source: 'stale' } : { data: null, fetchedAt: null, source: 'missing' };
  }
  const queue = [...jobs.entries()];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const [index, job] = queue.shift();
      results[index] = { ...job, ...(await get(job)) };
      onProgress(++done / jobs.length);
    }
  }));
  return results;
}

// Line features as { style, coords: [lon, lat, ...], value, closure }; value is r (relative, 0–1) or m/s (absolute).
export function decodeTiles(results) {
  const features = [], seen = new Set();
  for (const { style, tile: [z, x, y], data } of results) {
    if (!data) continue;
    const n = 2 ** z;
    for (const layer of Object.values(new VectorTile(new Pbf(data)).layers)) {
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i), props = feature.properties;
        if (feature.type !== 2) continue; // lines only
        for (const line of feature.loadGeometry()) {
          const coords = line.flatMap(p => [(x + p.x / layer.extent) / n * 360 - 180,
            Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + p.y / layer.extent) / n))) * 180 / Math.PI]);
          if (coords.length < 4) continue;
          // Overlapping tile margins repeat features: keep each geometry once per style.
          const id = [style, ...[0, 1, coords.length - 2, coords.length - 1].map(k => coords[k].toFixed(6))].join();
          if (seen.has(id)) continue;
          seen.add(id);
          const level = typeof props.traffic_level === 'number' ? props.traffic_level : null;
          features.push({ style, coords, value: level === null ? null : style === 'absolute' ? level / 3.6 : level, closure: props.road_closure === true || props.road_closure === 'true' });
        }
      }
    }
  }
  return features;
}

// 'live' only when every used tile is fresh; stale or missing data is never labelled live.
export function freshness(results, staleSeconds, now = Date.now()) {
  const counts = { tiles: results.length, live: 0, cache: 0, stale: 0, missing: 0 };
  let oldest = null;
  for (const r of results) { counts[r.source]++; if (r.fetchedAt) oldest = Math.min(oldest ?? Infinity, r.fetchedAt); }
  const used = counts.live + counts.cache + counts.stale;
  const status = !used ? 'fallback' : counts.stale || now - oldest > staleSeconds * 1000 ? 'stale' : 'live';
  return { status, observedAt: oldest && new Date(oldest).toISOString(), tiles: counts };
}

// Per-edge relative ratio r, absolute speed (m/s) and closures from features, matched by direction.
export function matchFeatures(sim, features) {
  const mPerLon = sim.mPerLon, mPerLat = sim.mPerLat, cell = 50, grid = new Map();
  for (let e = 0; e < sim.E; e++) {
    for (let p = sim.ptStart[e]; p < sim.ptStart[e + 1] - 1; p++) {
      const x0 = sim.lon[p] * mPerLon, y0 = sim.lat[p] * mPerLat, x1 = sim.lon[p + 1] * mPerLon, y1 = sim.lat[p + 1] * mPerLat;
      for (let cx = Math.floor(Math.min(x0, x1) / cell); cx <= Math.floor(Math.max(x0, x1) / cell); cx++) {
        for (let cy = Math.floor(Math.min(y0, y1) / cell); cy <= Math.floor(Math.max(y0, y1) / cell); cy++) {
          const k = `${cx},${cy}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(e, p);
        }
      }
    }
  }
  const nearest = (x, y, heading) => {
    let best = -1, bestDistance = MATCH_METRES;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = grid.get(`${cx + dx},${cy + dy}`);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 2) {
        const e = list[k], p = list[k + 1];
        const ax = sim.lon[p] * mPerLon, ay = sim.lat[p] * mPerLat, bx = sim.lon[p + 1] * mPerLon, by = sim.lat[p + 1] * mPerLat;
        const sx = bx - ax, sy = by - ay, len2 = sx * sx + sy * sy || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / len2));
        const distance = Math.hypot(ax + t * sx - x, ay + t * sy - y);
        const diff = Math.abs(((Math.atan2(sx, sy) * 180 / Math.PI - heading) % 360 + 540) % 360 - 180);
        if (distance < bestDistance && diff <= MAX_BEARING_DIFF) { best = e; bestDistance = distance; }
      }
    }
    return best;
  };
  const sums = { relative: new Float64Array(sim.E), absolute: new Float64Array(sim.E) };
  const weights = { relative: new Float64Array(sim.E), absolute: new Float64Array(sim.E) };
  const closed = new Uint8Array(sim.E);
  for (const { style, coords, value, closure } of features) {
    for (let k = 2; k < coords.length; k += 2) {
      const ax = coords[k - 2] * mPerLon, ay = coords[k - 1] * mPerLat, bx = coords[k] * mPerLon, by = coords[k + 1] * mPerLat;
      const length = Math.hypot(bx - ax, by - ay);
      if (length < 1) continue;
      const heading = Math.atan2(bx - ax, by - ay) * 180 / Math.PI, steps = Math.max(1, Math.floor(length / SAMPLE_METRES));
      for (let s = 0; s < steps; s++) {
        const t = (s + .5) / steps, e = nearest(ax + t * (bx - ax), ay + t * (by - ay), heading);
        if (e < 0) continue;
        if (closure) closed[e] = 1;
        else if (value !== null) { sums[style][e] += value * length / steps; weights[style][e] += length / steps; }
      }
    }
  }
  const ratio = new Float32Array(sim.E).fill(NaN), speed = new Float32Array(sim.E).fill(NaN);
  for (let e = 0; e < sim.E; e++) {
    if (weights.relative[e]) ratio[e] = Math.min(1, Math.max(0, sums.relative[e] / weights.relative[e]));
    if (weights.absolute[e]) speed[e] = sums.absolute[e] / weights.absolute[e];
  }
  return { ratio, speed, closed };
}

const median = values => { const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

// Fills unobserved roads: same-class median within 1 km, else London-wide class median, else 0.9.
export function inferRatios(sim, observed) {
  const ratio = Float32Array.from(observed), source = new Uint8Array(sim.E); // 0 observed, 1 nearby, 2 class, 3 default
  const mid = e => { const p = (sim.ptStart[e] + sim.ptStart[e + 1] - 1) >> 1; return [sim.lon[p] * sim.mPerLon, sim.lat[p] * sim.mPerLat]; };
  const byClassCell = new Map(), byClass = new Map();
  for (let e = 0; e < sim.E; e++) {
    if (Number.isNaN(observed[e])) continue;
    const [x, y] = mid(e), cls = sim.cls[e], key = `${cls}:${Math.floor(x / NEARBY_METRES)},${Math.floor(y / NEARBY_METRES)}`;
    if (!byClassCell.has(key)) byClassCell.set(key, []);
    byClassCell.get(key).push(x, y, observed[e]);
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(observed[e]);
  }
  const classMedian = new Map([...byClass].map(([cls, values]) => [cls, median(values)]));
  for (let e = 0; e < sim.E; e++) {
    if (!Number.isNaN(observed[e])) continue;
    const [x, y] = mid(e), cls = sim.cls[e], cx = Math.floor(x / NEARBY_METRES), cy = Math.floor(y / NEARBY_METRES), nearby = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = byClassCell.get(`${cls}:${cx + dx},${cy + dy}`) ?? [];
      for (let k = 0; k < list.length; k += 3) if (Math.hypot(list[k] - x, list[k + 1] - y) <= NEARBY_METRES) nearby.push(list[k + 2]);
    }
    if (nearby.length) { ratio[e] = median(nearby); source[e] = 1; }
    else if (classMedian.has(cls)) { ratio[e] = classMedian.get(cls); source[e] = 2; }
    else { ratio[e] = DEFAULT_RATIO; source[e] = 3; }
  }
  const counts = { observed: 0, nearby: 0, classMedian: 0, default: 0 };
  for (const s of source) counts[['observed', 'nearby', 'classMedian', 'default'][s]]++;
  return { ratio, counts };
}

// Placement weight per road: lane-km × [5 + 95(1 − r)]; closed roads get no cars.
export function placementWeights(sim, ratio, closed) {
  const weights = new Float32Array(sim.E);
  for (let e = 0; e < sim.E; e++) weights[e] = closed[e] ? 0 : sim.length[e] * sim.lanes[e] / 1000 * (5 + 95 * (1 - Math.min(1, Math.max(0, ratio[e]))));
  return weights;
}
