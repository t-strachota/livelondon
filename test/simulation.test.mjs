import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server.mjs';
import { SimulationSupervisor, cullSnapshot, snapshotView } from '../lib/simulation.mjs';
import { squareRoads } from './fixtures.mjs';

function snapshot(cars) {
  const out = Buffer.alloc(24 + cars.length * 24);
  out.writeUInt32LE(0x31504E53, 0); out.writeUInt32LE(9, 4); out.writeDoubleLE(12.5, 8); out.writeUInt32LE(cars.length, 16);
  const n = cars.length;
  cars.forEach(([id, lon, lat], i) => {
    out.writeUInt32LE(id, 24 + 4 * i);
    out.writeInt32LE(Math.round(lon * 1e7), 24 + 4 * n + 4 * i);
    out.writeInt32LE(Math.round(lat * 1e7), 24 + 8 * n + 4 * i);
    out.writeUInt32LE(id * 10, 24 + 12 * n + 4 * i);
    out.writeFloatLE(id + 0.5, 24 + 16 * n + 4 * i);
    out.writeUInt16LE(id * 100, 24 + 20 * n + 2 * i);
    out.writeUInt16LE(id * 7, 24 + 22 * n + 2 * i);
  });
  return out;
}

test('viewport culling keeps whole car records and marks the snapshot', () => {
  const culled = cullSnapshot(snapshot([[1, -0.2, 51.5], [2, -0.1, 51.5], [3, 0.1, 51.6]]), [-0.15, 51.4, 0.2, 51.7]);
  assert.deepEqual(snapshotView(culled), { runId: 9, time: 12.5, count: 2 });
  assert.equal(culled.readUInt32LE(20), 1);
  assert.deepEqual([culled.readUInt32LE(24), culled.readUInt32LE(28)], [2, 3]);
  assert.deepEqual([culled.readUInt16LE(24 + 40), culled.readUInt16LE(24 + 42)], [200, 300]);
  assert.deepEqual([culled.readUInt16LE(24 + 44), culled.readUInt16LE(24 + 46)], [14, 21]);
  assert.throws(() => snapshotView(culled.subarray(0, 30)), /Malformed/);
});

test('one server-owned run streams the same cars to every client and pauses for everyone', { timeout: 30_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-roads-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'roads.json'), JSON.stringify(squareRoads()));
  // Stand-in for TomTom: the first fetch fails (labelled fallback), then stale, then live congestion on one road.
  const answers = [() => { throw new Error('offline'); }, () => ({ features: [], observation: { status: 'stale', observedAt: new Date(0).toISOString() } })];
  const live = { features: [{ style: 'relative', coords: squareRoads().edges[0][8], value: .1, closure: false }], observation: { status: 'live', observedAt: new Date().toISOString() } };
  const observe = async () => { await new Promise(r => setTimeout(r, 200)); return answers.length ? answers.shift()() : live; };
  const limits = { minPopulation: 50, maxPopulation: 100, populationStep: 10 };
  const simulation = new SimulationSupervisor({ roads: join(dir, 'roads.json'), population: 60, observe, limits }).start();
  const server = createApp({ feed: { getSnapshot: async () => ({ status: 'live', buses: [] }) }, simulation });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await simulation.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async () => (await fetch(`${base}/api/simulation/status`)).json();
  const until = async check => { const end = Date.now() + 15_000; while (!(await check())) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

  await until(async () => (await status()).lifecycle === 'running');
  const first = await status();
  assert.equal(first.population.actual, 60);
  assert.equal(first.observation.status, 'fallback');

  const clients = [0, 1].map(() => new WebSocket(`${base.replace('http', 'ws')}/api/simulation/stream`));
  t.after(() => clients.forEach(ws => ws.close()));
  const frames = clients.map(ws => { const seen = []; ws.on('message', (data, binary) => { if (binary) seen.push(snapshotView(data)); }); return seen; });
  await until(() => frames.every(seen => seen.length >= 3));
  for (const seen of frames) assert.ok(seen.every(view => view.runId === first.runId && view.count === 60));

  assert.equal((await fetch(`${base}/api/simulation/pause`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{"paused":true}' })).status, 403);
  assert.equal((await fetch(`${base}/api/simulation/pause`, { method: 'POST', body: '{"paused":true}' })).status, 200);
  await new Promise(r => setTimeout(r, 400));
  const pausedAt = frames[0].length;
  await new Promise(r => setTimeout(r, 600));
  assert.equal(frames[0].length, pausedAt, 'no snapshots while paused');
  assert.equal((await status()).pausedForEveryone, true);

  const post = body => fetch(`${base}/api/simulation/reinitialize`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ population: 55 })).status, 400);
  assert.equal((await post({ population: 110 })).status, 400);
  // Stale data: refused, and the current run carries on.
  assert.equal((await post({ population: 80 })).status, 202);
  assert.equal((await post({ population: 80 })).status, 409);
  await until(async () => (await status()).job.state === 'failed');
  const refused = await status();
  assert.match(refused.job.reason, /live traffic unavailable \(stale\)/);
  assert.equal(refused.runId, first.runId);
  assert.equal(refused.population.actual, 60);
  // Live data: the same cars (IDs 0..79, extra IDs added) move in place under a new run ID.
  assert.equal((await post({ population: 80 })).status, 202);
  await until(async () => (await status()).job.state === 'succeeded');
  const second = await status();
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.observation.status, 'live');
  assert.ok(second.observation.matchedShare > 0);
  assert.equal(second.pausedForEveryone, false);
  frames.forEach(seen => { seen.length = 0; });
  await until(() => frames.every(seen => seen.length >= 2));
  for (const seen of frames) assert.ok(seen.every(view => view.runId === second.runId && view.count === 80));
});

test('population for the next run: the time-of-day count by default, manual only when a valid slider value is accepted', () => {
  const limits = { minPopulation: 50, maxPopulation: 100, populationStep: 10 };
  const observe = () => new Promise(() => {}); // the fetch never finishes; only the accepted job matters here
  const simulation = new SimulationSupervisor({ observe, limits });
  assert.equal(simulation.getStatus().clock.mode, 'live');
  // Refused requests never change who controls the count.
  assert.throws(() => simulation.reinitialize({ population: 55 }), error => error.status === 400);
  assert.throws(() => simulation.reinitialize({ population: 80 }), error => error.status === 503);
  assert.equal(simulation.clock.mode, 'live');
  // Running (a stand-in worker): no population means the clock's count; a slider value switches to manual.
  Object.assign(simulation, { worker: { postMessage() {} }, lifecycle: 'running' });
  assert.equal(simulation.reinitialize({}).population, simulation.clockTarget());
  assert.equal(simulation.clock.mode, 'live');
  simulation.job = { state: 'idle' };
  assert.equal(simulation.reinitialize({ population: 80 }).population, 80);
  assert.equal(simulation.clock.mode, 'manual');
  simulation.setClock({ mode: 'live' });
  assert.equal(simulation.getStatus().clock.mode, 'live');
  // An explicitly configured population (SIM_POPULATION) is a manual count from the start.
  assert.equal(new SimulationSupervisor({ population: 60, observe, limits }).clock.mode, 'manual');
});
