// Runs one CarSim in real time on a worker thread; posts binary snapshots (5 Hz), signal states for
// the boxes clients are looking at (2 Hz) and 1 Hz status.
// Re-initialization re-seeds the same cars (same IDs) in place and switches the run ID in one step.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { CarSim } from './car-sim.mjs';
import { inferRatios, matchFeatures, placementWeights } from './observations.mjs';

const { roadsPath, population, seed, runId, stepSeconds, gridlockSeconds, features, observation } = workerData;
let sim, paused = false, currentObservation, signalPositions, signalBoxes = [];

// Placement weights from live features, or the labelled fallback (r = 0.9 everywhere) without them.
function seeding(features, observation) {
  if (!features?.length) {
    return { weights: placementWeights(sim, new Float32Array(sim.E).fill(.9), new Uint8Array(sim.E)), speeds: undefined,
      observation: { ...observation, status: 'fallback', matchedShare: 0, closedEdges: 0, inference: { observed: 0, nearby: 0, classMedian: 0, default: sim.E } } };
  }
  const { ratio, speed, closed } = matchFeatures(sim, features);
  const { ratio: inferred, counts } = inferRatios(sim, ratio);
  return {
    weights: placementWeights(sim, inferred, closed), speeds: speed,
    observation: { ...observation, matchedShare: +(counts.observed / sim.E).toFixed(4), closedEdges: closed.reduce((a, b) => a + b, 0), inference: counts },
  };
}

try {
  parentPort.postMessage({ type: 'progress', stage: 'Loading roads', fraction: .6 });
  sim = new CarSim(JSON.parse(readFileSync(roadsPath, 'utf8')), { population, seed, runId });
  parentPort.postMessage({ type: 'progress', stage: 'Placing cars', fraction: .8 });
  const plan = seeding(features, observation);
  sim.reseed({ population, weights: plan.weights, speeds: plan.speeds, runId });
  currentObservation = plan.observation;
  signalPositions = sim.approachPositions();
} catch (error) {
  parentPort.postMessage({ type: 'error', reason: error.message });
  process.exit(2);
}
// Road closures (applied in place to this run) and their measured impact. Every SAMPLE_SECONDS of
// simulated time each road's speed ratio (mean speed / limit; empty = 1), queue (cars < 2 m/s) and car
// count feed ~3-minute rolling averages. The first closure freezes those as the baseline; impact is
// baseline ratio - current ratio (positive = slower), minus the median change near the closures so
// network-wide drift cancels. A road counts only within RADIUS_M of a closure, with MIN_CARS cars
// (now or in the baseline), not already gridlocked in the baseline, and past THRESHOLD twice running.
const SAMPLE_SECONDS = 5, ALPHA = SAMPLE_SECONDS / 180, SLOW = 2, RADIUS_M = 2000, THRESHOLD = .15, MIN_CARS = 2, MAX_FEATURES = 400;
let closures = [], nearby = null, lastSample = 0, top = [];
const E = sim.E, sum = new Float32Array(E), cars = new Uint16Array(E), queue = new Uint16Array(E);
const ratio = new Float32Array(E).fill(1), queueAvg = new Float32Array(E), carsAvg = new Float32Array(E), streak = new Uint8Array(E);
let baseRatio, baseQueue, baseCars;

function closeSegment(pair) {
  if (!closures.length) { baseRatio = ratio.slice(); baseQueue = queueAvg.slice(); baseCars = carsAvg.slice(); streak.fill(0); sim.rerouted = 0; }
  sim.setClosed(pair, true);
  closures.push({ id: pair[0], edges: pair, name: sim.roadName(pair[0]), coordinates: sim.edgeCoordinates(pair[0]), closedAt: sim.time });
  updateNearby();
}

function reopen(id) {
  const k = closures.findIndex(c => c.id === id);
  if (k < 0) return false;
  sim.setClosed(closures[k].edges, false);
  closures.splice(k, 1);
  updateNearby();
  return true;
}

function updateNearby() {
  nearby = null; top = [];
  if (!closures.length) { postImpact([]); return; }
  const centres = closures.map(c => c.coordinates[Math.floor(c.coordinates.length / 2)]), list = [];
  for (let e = 0; e < E; e++) {
    const p = sim.ptStart[e];
    if (centres.some(([lon, lat]) => Math.hypot((sim.lon[p] - lon) * sim.mPerLon, (sim.lat[p] - lat) * sim.mPerLat) < RADIUS_M)) list.push(e);
  }
  nearby = Int32Array.from(list);
  postImpact([]);
}

function sampleImpact() {
  sum.fill(0); cars.fill(0); queue.fill(0);
  for (let i = 0; i < sim.n; i++) { const e = sim.edge[i]; sum[e] += sim.v[i]; cars[e]++; if (sim.v[i] < SLOW) queue[e]++; }
  for (let e = 0; e < E; e++) {
    const r = cars[e] ? Math.min(1, sum[e] / cars[e] / sim.speed[e]) : 1;
    ratio[e] += ALPHA * (r - ratio[e]); queueAvg[e] += ALPHA * (queue[e] - queueAvg[e]); carsAvg[e] += ALPHA * (cars[e] - carsAvg[e]);
  }
  if (!nearby) return;
  const deltas = Array.from(nearby, e => baseRatio[e] - ratio[e]).sort((a, b) => a - b), median = deltas[deltas.length >> 1] ?? 0;
  const hits = [];
  for (const e of nearby) {
    if (sim.closed[e] || Math.max(carsAvg[e], baseCars[e]) < MIN_CARS) { streak[e] = 0; continue; }
    if (baseQueue[e] >= .8 * sim.laneCapacity(e) * sim.lanes[e]) { streak[e] = 0; continue; } // gridlocked before the closure
    const impact = baseRatio[e] - ratio[e] - median;
    streak[e] = Math.abs(impact) > THRESHOLD ? Math.min(streak[e] + 1, 2) : 0;
    if (streak[e] >= 2) hits.push({ e, impact, queue: queueAvg[e] - baseQueue[e] });
  }
  hits.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const seen = new Set();
  top = [];
  for (const h of hits) {
    const name = sim.roadName(h.e);
    if (h.impact <= 0 || seen.has(name)) continue;
    seen.add(name);
    top.push({ name, slowerPercent: Math.round(h.impact * 100), extraQueue: +h.queue.toFixed(1) });
    if (top.length === 5) break;
  }
  postImpact(hits.slice(0, MAX_FEATURES));
}

function postImpact(hits) {
  const features = hits.map(h => ({ type: 'Feature', properties: { impact: +h.impact.toFixed(3), name: sim.roadName(h.e) }, geometry: { type: 'LineString', coordinates: sim.edgeCoordinates(h.e) } }));
  for (const c of closures) features.push({ type: 'Feature', properties: { closed: true, id: c.id, name: c.name }, geometry: { type: 'LineString', coordinates: c.coordinates } });
  parentPort.postMessage({ type: 'impact', geojson: { type: 'FeatureCollection', features } });
}

parentPort.postMessage({ type: 'ready', runId, population: sim.n, capacity: sim.capacity(), seed, observation: currentObservation, signalPositions });

parentPort.on('message', message => {
  if (message.cmd === 'pause') paused = true;
  if (message.cmd === 'resume') paused = false;
  if (message.cmd === 'signalViews') signalBoxes = message.boxes;
  if (message.cmd === 'closure') {
    let result;
    if (message.action === 'close') {
      const pair = sim.nearestSegment(message.lon, message.lat);
      if (!pair) result = { error: 'No simulated road within 30 m of that point (residential and service roads are not simulated)', status: 404 };
      else if (closures.some(c => c.edges.includes(pair[0]))) result = { error: 'That road is already closed', status: 409 };
      else closeSegment(pair);
    } else if (!reopen(message.closureId)) result = { error: 'No such closure', status: 404 };
    parentPort.postMessage({ type: 'closureResult', id: message.id, ...result, closures: closureSummary() });
  }
  if (message.cmd === 'restoreClosures') {
    // After a worker restart: same road network, so edge ids are stable; validate anyway.
    for (const pair of message.pairs) if (pair.every(e => Number.isInteger(e) && e >= 0 && e < E) && !closures.some(c => c.id === pair[0])) closeSegment(pair);
  }
  if (message.cmd === 'reseed') {
    // Runs between steps, so the switch is atomic: the next snapshot already belongs to the new run.
    try {
      const plan = seeding(message.features, message.observation);
      sim.reseed({ population: message.population, weights: plan.weights, speeds: plan.speeds, runId: message.runId });
      currentObservation = plan.observation;
      paused = false;
      parentPort.postMessage({ type: 'reseeded', runId: message.runId, population: sim.n, capacity: sim.capacity(plan.weights), seed, observation: currentObservation });
    } catch (error) {
      parentPort.postMessage({ type: 'reseedFailed', runId: message.runId, reason: error.message });
    }
  }
});

function closureSummary() { return closures.map(({ id, edges, name, closedAt }) => ({ id, edges, name, closedAt })); }

const stepMs = [], encodeMs = [];
let nextAt = performance.now(), lastStatus = 0, lastSignals = 0, behind = 0;
function tick() {
  const now = performance.now();
  if (!paused) {
    const started = performance.now();
    sim.step(stepSeconds);
    const stepped = performance.now();
    const buffer = sim.snapshot();
    if (sim.time - lastSample >= SAMPLE_SECONDS) { lastSample = sim.time; sampleImpact(); }
    stepMs.push(stepped - started); encodeMs.push(performance.now() - stepped);
    if (stepMs.length > 25) { stepMs.shift(); encodeMs.shift(); }
    parentPort.postMessage({ type: 'snapshot', buffer }, [buffer]);
    nextAt += stepSeconds * 1000;
    const lag = performance.now() - nextAt;
    if (lag > 1000) { behind += lag / 1000; nextAt = performance.now(); } // cannot keep up: report it
  } else nextAt = now + stepSeconds * 1000;
  if (signalBoxes.length && now - lastSignals >= 500) {
    lastSignals = now;
    const buffer = sim.signalFrame(signalBoxes, signalPositions);
    parentPort.postMessage({ type: 'signals', buffer }, [buffer]);
  }
  if (now - lastStatus >= 1000) {
    lastStatus = now;
    const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const work = mean(stepMs) + mean(encodeMs);
    const { averageSpeedMps, gridlocked } = sim.stats(gridlockSeconds);
    parentPort.postMessage({
      type: 'status', runId: sim.runId, lifecycle: paused ? 'paused' : 'running', simTime: sim.time,
      population: { target: sim.n, actual: sim.n, capacity: sim.capacity() }, averageSpeedMps: Math.round(averageSpeedMps * 100) / 100, seed,
      observation: currentObservation,
      performance: { stepMs: +mean(stepMs).toFixed(1), encodeMs: +mean(encodeMs).toFixed(1), realtimeFactor: +(stepSeconds * 1000 / Math.max(work, .001)).toFixed(1),
        secondsBehind: +behind.toFixed(1), memoryMB: Math.round(process.memoryUsage().rss / 2 ** 20) },
      health: { gridlocked, laneChanges: sim.laneChanges ?? 0, signals: sim.signalCount, redHolds: sim.redHolds },
      closures: closureSummary(), rerouted: closures.length ? sim.rerouted : 0, mostAffected: top,
    });
  }
  setTimeout(tick, Math.max(0, nextAt - performance.now()));
}
tick();
