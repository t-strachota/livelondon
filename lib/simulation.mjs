import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeTiles, fetchTiles, freshness, tilesFor, tomtomKey } from './observations.mjs';
import { hhmm, londonClock, targetCars } from './london-time.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const SIM_CONFIG = JSON.parse(readFileSync(new URL('../sim/config.json', import.meta.url)));
export const DEFAULT_ROADS = `${root}data/network/roads.json`;
const HEADER_BYTES = 24, BYTES_PER_CAR = 24;
const RESTART_MS = 5000;

export function pythonPath() {
  if (process.env.SIM_PYTHON) return process.env.SIM_PYTHON;
  return `${root}.venv/${process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'}`;
}

// Columnar snapshot: header [magic u32, runId u32, simTime f64, count u32, flags u32], then
// ids u32, lon i32 (1e-7°), lat i32, lane u32, lanePos f32, angle u16 (0.01°), speed u16 (cm/s).
export function snapshotView(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = view.getUint32(16, true);
  if (view.getUint32(0, true) !== 0x31504E53 || buffer.byteLength !== HEADER_BYTES + count * BYTES_PER_CAR) throw new Error('Malformed snapshot');
  return { runId: view.getUint32(4, true), time: view.getFloat64(8, true), count };
}

// Keeps cars inside [west, south, east, north] (degrees, margin already applied by the client).
export function cullSnapshot(buffer, bbox) {
  const { count } = snapshotView(buffer);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const lonAt = i => view.getInt32(HEADER_BYTES + 4 * count + 4 * i, true) / 1e7;
  const latAt = i => view.getInt32(HEADER_BYTES + 8 * count + 4 * i, true) / 1e7;
  const keep = [];
  for (let i = 0; i < count; i++) {
    const lon = lonAt(i), lat = latAt(i);
    if (lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]) keep.push(i);
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + keep.length * BYTES_PER_CAR);
  buffer.copy(out, 0, 0, HEADER_BYTES);
  out.writeUInt32LE(keep.length, 16);
  out.writeUInt32LE(1, 20); // flags bit 0: culled to a viewport
  // [byte offset of column, element size] for the six 4-byte and two 2-byte columns.
  const columns = [[0, 4], [4, 4], [8, 4], [12, 4], [16, 4], [20, 2], [22, 2]];
  for (const [offset, size] of columns) {
    const from = HEADER_BYTES + offset * count, to = HEADER_BYTES + offset * keep.length;
    for (let k = 0; k < keep.length; k++) buffer.copy(out, to + k * size, from + keep[k] * size, from + keep[k] * size + size);
  }
  return out;
}

// Owns the one server-side simulation, running on a worker thread. Every client sees this run.
export class SimulationSupervisor extends EventEmitter {
  constructor({ roads = DEFAULT_ROADS, population = SIM_CONFIG.simulation.population, seed = SIM_CONFIG.simulation.seed,
    limits = SIM_CONFIG.simulation, observe = observeTomTom } = {}) {
    super();
    Object.assign(this, { roads, population, seed, limits, observe });
    this.worker = null;
    this.runId = null;
    this.status = null;
    this.ready = null;
    this.snapshot = null;
    this.paused = false;
    this.lifecycle = 'stopped';
    this.reason = null;
    this.job = { state: 'idle' };
    this.closed = false;
    this.closureRequests = new Map();
    this.closurePairs = []; // kept here so closures survive a worker restart
    this.demand = []; // extra-car groups from stopped trains/buses, re-sent after a worker restart
    this.impact = null;
    // Car count source: 'live' follows London time, 'custom' a chosen time/day/demand, 'manual' the slider.
    this.clock = { mode: 'live', minutes: 18 * 60, weekend: false, demand: 1 };
  }

  // The time-of-day car count for the live or custom clock, rounded to the slider step and kept in range.
  clockTarget() {
    const live = londonClock(), c = this.clock.mode === 'custom' ? this.clock : { ...live, demand: 1 };
    const { minPopulation, maxPopulation, populationStep } = this.limits;
    const cars = Math.round(targetCars(c.minutes, c.weekend, c.demand, SIM_CONFIG.timeOfDay) / populationStep) * populationStep;
    return Math.min(maxPopulation, Math.max(minPopulation, cars));
  }

  #sendTarget() {
    this.worker?.postMessage({ cmd: 'target', cars: this.clock.mode === 'manual' ? null : this.clockTarget(), maxChange: SIM_CONFIG.timeOfDay.maxChangePerMinute });
  }

  // {mode: 'live'} or {mode: 'custom', minutes 0-1440, weekend, demand 0.5-2}; the count follows gradually.
  setClock({ mode, minutes, weekend, demand }) {
    if (mode === 'live') this.clock = { ...this.clock, mode };
    else if (mode === 'custom') {
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw Object.assign(new RangeError('minutes must be 0-1440'), { status: 400 });
      if (typeof weekend !== 'boolean') throw Object.assign(new RangeError('weekend must be true or false'), { status: 400 });
      if (typeof demand !== 'number' || !(demand >= .5 && demand <= 2)) throw Object.assign(new RangeError('demand must be 0.5-2.0'), { status: 400 });
      this.clock = { mode, minutes: minutes % 1440, weekend, demand };
    } else throw Object.assign(new RangeError("mode must be 'live' or 'custom'"), { status: 400 });
    this.#sendTarget();
    return this.getStatus();
  }

  start() {
    if (!existsSync(this.roads)) {
      this.lifecycle = 'unavailable';
      this.reason = `Road network not built. Run: ${process.platform === 'win32' ? '.venv\\Scripts\\python' : '.venv/bin/python'} build_roads.py`;
      return this;
    }
    this.lifecycle = 'initializing';
    void this.#initial();
    this.clockTimer = setInterval(() => this.#sendTarget(), 60_000); // follow the real clock
    this.clockTimer.unref?.();
    return this;
  }

  #progress(kind, stage, fraction) {
    if (kind === 'initial') this.job = { state: 'initializing', stage, fraction };
    else this.job = { ...this.job, stage, fraction };
    this.emit('progress', { stage, fraction, kind });
  }

  // The first run may start from a labelled fallback when TomTom is unavailable.
  async #initial() {
    this.#progress('initial', 'Fetching live traffic', 0);
    const seeding = await this.observe({ onProgress: f => this.#progress('initial', 'Fetching live traffic', f * .5) })
      .catch(() => ({ features: [], observation: { status: 'fallback', observedAt: null } }));
    if (!this.closed) this.#launch(seeding);
  }

  #launch({ features, observation }) {
    this.lifecycle = 'initializing';
    this.runId = randomInt(1, 2 ** 32 - 1);
    if (this.clock.mode !== 'manual') this.population = this.clockTarget();
    const { stepSeconds, gridlockSeconds } = SIM_CONFIG.simulation;
    const worker = this.worker = new Worker(new URL('./sim-worker.mjs', import.meta.url), {
      workerData: { roadsPath: this.roads, population: this.population, seed: this.seed, runId: this.runId, stepSeconds, gridlockSeconds, features, observation },
    });
    worker.on('message', message => {
      if (worker !== this.worker) return;
      if (message.type === 'snapshot') {
        this.snapshot = Buffer.from(message.buffer);
        this.emit('snapshot', this.snapshot);
      } else if (message.type === 'signals') {
        this.emit('signals', Buffer.from(message.buffer));
      } else if (message.type === 'closureResult') {
        this.closurePairs = message.closures.map(c => c.edges);
        this.closureRequests.get(message.id)?.(message);
        this.closureRequests.delete(message.id);
      } else if (message.type === 'impact') {
        this.impact = message.geojson;
        this.emit('impact', this.impact);
      } else if (message.type === 'progress') {
        this.#progress('initial', message.stage, message.fraction);
      } else if (message.type === 'ready' || message.type === 'reseeded') {
        const reseeded = message.type === 'reseeded';
        if (!reseeded && this.closurePairs.length) worker.postMessage({ cmd: 'restoreClosures', pairs: this.closurePairs });
        if (!reseeded && this.demand.length) worker.postMessage({ cmd: 'demand', groups: this.demand, maxTotal: this.limits.maxPopulation });
        if (message.signalPositions) {
          this.signalPositions = message.signalPositions;
          if (this.signalBoxes?.length) worker.postMessage({ cmd: 'signalViews', boxes: this.signalBoxes }); // after a restart
        }
        Object.assign(this, { ready: message, status: null, lifecycle: 'running', reason: null, paused: false, runId: message.runId, population: message.population });
        this.#sendTarget();
        this.job = reseeded ? { state: 'succeeded', runId: message.runId, finishedAt: new Date().toISOString() } : { state: 'idle' };
        this.emit('run', this.getStatus());
      } else if (message.type === 'reseedFailed') {
        this.#failJob(message.reason);
      } else if (message.type === 'status') {
        this.status = message;
        this.closurePairs = message.closures.map(c => c.edges);
        this.lifecycle = message.lifecycle;
        this.emit('status', this.getStatus());
      } else if (message.type === 'error') {
        this.lifecycle = 'failed';
        this.reason = message.reason;
        this.emit('status', this.getStatus());
      }
    });
    worker.on('error', error => { this.reason = error.message; });
    worker.on('exit', code => {
      if (worker !== this.worker || this.closed) return;
      // Supervised: an unexpected exit after a good start restarts; a failed start stays failed with its reason.
      const failedDuringStart = this.lifecycle === 'initializing' || this.lifecycle === 'failed';
      this.lifecycle = failedDuringStart ? 'failed' : 'crashed';
      this.reason ??= `Simulation exited (${code})`;
      this.worker = null;
      if (this.job.state === 'preparing') this.job = { state: 'failed', reason: 'Simulation stopped during re-initialization' };
      this.emit('status', this.getStatus());
      if (!failedDuringStart) this.restartTimer = setTimeout(() => { if (!this.closed) void this.#initial(); }, RESTART_MS);
    });
  }

  #failJob(reason) {
    this.job = { state: 'failed', reason, finishedAt: new Date().toISOString() };
    this.emit('status', this.getStatus());
  }

  // Fetches live traffic while the current run keeps going, then re-seeds the same cars in place
  // under a new run ID. Without live data the current run continues and the job reports why.
  // A population from the slider switches the count to manual; without one the clock's count is used.
  reinitialize({ population } = {}) {
    if (population !== undefined) this.clock = { ...this.clock, mode: 'manual' };
    population ??= this.clock.mode === 'manual' ? this.population : this.clockTarget();
    const { minPopulation, maxPopulation, populationStep } = this.limits;
    if (!Number.isInteger(population) || population < minPopulation || population > maxPopulation || population % populationStep) {
      throw Object.assign(new RangeError(`population must be ${minPopulation}–${maxPopulation} in steps of ${populationStep}`), { status: 400 });
    }
    if (this.job.state === 'preparing') throw Object.assign(new Error('A re-initialization is already in progress'), { status: 409 });
    if (!this.worker || !['running', 'paused'].includes(this.lifecycle)) throw Object.assign(new Error(this.reason ?? 'Simulation is not running'), { status: 503 });
    this.job = { state: 'preparing', population, stage: 'Fetching live traffic', fraction: 0, startedAt: new Date().toISOString() };
    this.emit('status', this.getStatus());
    void (async () => {
      try {
        const { features, observation } = await this.observe({ onProgress: f => this.#progress('reinitialize', 'Fetching live traffic', f * .8) });
        if (observation.status !== 'live') return this.#failJob(`live traffic unavailable (${observation.status}); the current run continues`);
        if (!this.worker) return this.#failJob('Simulation stopped during re-initialization');
        this.#progress('reinitialize', 'Placing cars', .9);
        this.worker.postMessage({ cmd: 'reseed', population, features, observation, runId: randomInt(1, 2 ** 32 - 1) });
      } catch (error) {
        this.#failJob(`live traffic unavailable (${error.message}); the current run continues`);
      }
    })();
    return this.job;
  }

  // Union of the boxes clients want signal states for; the worker encodes only those approaches.
  setSignalViews(boxes) {
    this.signalBoxes = boxes;
    this.worker?.postMessage({ cmd: 'signalViews', boxes });
  }

  // Closes the road nearest (lon, lat) or reopens closure `closureId`, in place in the running simulation.
  closure({ action, lon, lat, closureId }) {
    if (!this.worker || !['running', 'paused'].includes(this.lifecycle)) return Promise.reject(Object.assign(new Error('Simulation is not running'), { status: 503 }));
    const id = randomInt(1, 2 ** 32 - 1);
    this.worker.postMessage({ cmd: 'closure', id, action, lon, lat, closureId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.closureRequests.delete(id); reject(new Error('Simulation did not respond')); }, 10_000);
      this.closureRequests.set(id, message => {
        clearTimeout(timer);
        if (message.error) reject(Object.assign(new Error(message.error), { status: message.status ?? 400 }));
        else resolve(message.closures);
      });
    });
  }

  setPaused(paused) {
    if (!this.worker || this.lifecycle === 'initializing') return false;
    this.paused = paused;
    this.worker.postMessage({ cmd: paused ? 'pause' : 'resume' });
    return true;
  }

  // Extra-car demand groups [{id, cars, points: [[lon, lat], ...]}], replacing the previous set. Total cars
  // (original + extra) never exceed the population slider's maximum.
  setDemand(groups) {
    this.demand = groups;
    this.worker?.postMessage({ cmd: 'demand', groups, maxTotal: this.limits.maxPopulation });
  }

  getStatus() {
    const status = this.status ?? {};
    return {
      lifecycle: this.lifecycle, reason: this.reason, runId: this.worker && this.ready ? this.runId : null,
      pausedForEveryone: this.paused,
      population: status.population ?? (this.ready ? { target: this.ready.population, actual: this.ready.population, capacity: this.ready.capacity } : null),
      simTime: status.simTime ?? null, averageSpeedMps: status.averageSpeedMps ?? null,
      observation: status.observation ?? this.ready?.observation ?? null,
      seed: this.seed, performance: status.performance ?? null, health: status.health ?? null, job: this.job,
      closures: status.closures ?? [], rerouted: status.rerouted ?? 0, mostAffected: status.mostAffected ?? [],
      extraCars: status.extraCars ?? 0, demand: status.demand ?? [], personalities: status.personalities ?? null,
      clock: this.#clockStatus(),
    };
  }

  #clockStatus() {
    const live = londonClock();
    return { mode: this.clock.mode, londonTime: hhmm(live.minutes), londonDay: live.day, target: this.clock.mode === 'manual' ? null : this.clockTarget(),
      simulating: this.clock.mode === 'custom' ? { time: hhmm(this.clock.minutes), weekend: this.clock.weekend, demand: this.clock.demand } : null };
  }

  async close() {
    this.closed = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.clockTimer);
    await this.worker?.terminate();
  }
}

// TomTom flow tiles for the network area at the configured zoom, labelled live / stale / fallback.
export async function observeTomTom({ onProgress } = {}) {
  const config = SIM_CONFIG.observations, root = new URL('../', import.meta.url);
  const key = tomtomKey(root);
  if (!key) return { features: [], observation: { status: 'fallback', observedAt: null, reason: 'no TomTom key' } };
  const results = await fetchTiles({ key, cacheDir: new URL('data/observations/', root), tiles: tilesFor(SIM_CONFIG.network.bbox, config.zoom),
    cacheSeconds: config.cacheSeconds, maxRequests: config.maxRequests, concurrency: config.concurrency, onProgress });
  return { features: decodeTiles(results), observation: freshness(results, config.staleSeconds) };
}
