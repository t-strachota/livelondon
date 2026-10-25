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
parentPort.postMessage({ type: 'ready', runId, population: sim.n, capacity: sim.capacity(), seed, observation: currentObservation, signalPositions });

parentPort.on('message', message => {
  if (message.cmd === 'pause') paused = true;
  if (message.cmd === 'resume') paused = false;
  if (message.cmd === 'signalViews') signalBoxes = message.boxes;
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

const stepMs = [], encodeMs = [];
let nextAt = performance.now(), lastStatus = 0, lastSignals = 0, behind = 0;
function tick() {
  const now = performance.now();
  if (!paused) {
    const started = performance.now();
    sim.step(stepSeconds);
    const stepped = performance.now();
    const buffer = sim.snapshot();
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
    });
  }
  setTimeout(tick, Math.max(0, nextAt - performance.now()));
}
tick();
