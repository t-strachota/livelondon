import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FlowClient, clipLine, extractRoads, estimateTraffic, spawnCars, stepCars, londonTime } from '../lib/traffic.mjs';

const line = [[-.13, 51.507], [-.126, 51.507]];
const road = { id: 'road', cls: 'primary', lanes: 2, line, m: 277, kmh: 20, vehicles: 1000 };

test('road extraction clips crossing segments even when both endpoints are outside the overview', () => {
  const clipped = clipLine([[-1, 51.5], [1, 51.5]], [-.5, 51, .5, 52]);
  assert.deepEqual(clipped, [[[-.5, 51.5], [.5, 51.5]]]);
  assert.deepEqual(clipLine([[-1, 53], [1, 53]], [-.5, 51, .5, 52]), []);
});

test('rendered road casings and reversed duplicates count only once', () => {
  const feature = { properties: { class: 'primary' }, geometry: { type: 'LineString', coordinates: line } };
  const roads = extractRoads([feature, feature, { ...feature, geometry: { type: 'LineString', coordinates: [...line].reverse() } }], [-.5, 51, .5, 52]);
  assert.equal(roads.length, 1);
  assert.equal(roads[0].lanes, 2);
});

test('estimates retain Greenshields density and use finite current speeds', () => {
  const result = estimateTraffic([road], [{ p: line[0], ratio: .5, kmh: 20 }], null);
  assert.equal(result.roads[0].vehicles, 60 * 2 * .277);
  assert.equal(estimateTraffic([road], [{ p: line[0], ratio: NaN, kmh: 20 }], null), null);
  assert.equal(estimateTraffic([road], [{ p: line[0], ratio: .5, kmh: -1 }], null), null);
});

test('the supplied calibration table has the expected dimensions and nonnegative values', async () => {
  const model = JSON.parse(await readFile(new URL('../flow_table.json', import.meta.url), 'utf8'));
  assert.equal(model.table.length, 7);
  assert.ok(model.table.every(day => day.length === 24 && day.every(hour => hour.length === 10 && hour.every(value => Number.isFinite(value) && value >= 0))));
  assert.equal(model.metrics.sites, 30);
  assert.deepEqual(londonTime(new Date('2026-07-01T23:30:00Z')), { day: 3, hour: 0 });
});

test('estimated traffic has at most 300 car dots and never creates simulated buses', () => {
  const cars = spawnCars([road, { ...road, id: 'other' }], () => .25);
  assert.equal(cars.length, 300);
  const features = stepCars(cars, .1).features;
  assert.ok(features.every(feature => feature.properties.kind === 'estimated-car' && feature.properties.estimated === true));
  assert.ok(features.every(feature => feature.geometry.coordinates.every(Number.isFinite)));
});

test('dots follow road speeds, respect zero speed and use the indicated one-way direction', () => {
  const stopped = spawnCars([{ ...road, kmh: 0, oneway: 1 }], () => .25);
  const first = stepCars(stopped, 0).features[0].geometry.coordinates;
  assert.deepEqual(stepCars(stopped, .1).features[0].geometry.coordinates, first);
  const moving = spawnCars([{ ...road, oneway: 1 }], () => .25);
  const before = stepCars(moving, 0).features[0].geometry.coordinates;
  const after = stepCars(moving, .1).features[0].geometry.coordinates;
  assert.ok(after[0] > before[0]);
});

test('speed requests share inflight work and cached cells for three minutes', async () => {
  let calls = 0, now = 1_000_000;
  const client = new FlowClient({ key: 'test', now: () => now, fetchImpl: async () => { calls++; return Response.json({ flowSegmentData: { currentSpeed: 10, freeFlowSpeed: 20 } }); } });
  await Promise.all([client.flowAt(51.5, -.1), client.flowAt(51.5, -.1)]);
  assert.equal(calls, 1);
  await client.flowAt(51.5, -.1);
  assert.equal(calls, 1);
  now += 180_001;
  await client.flowAt(51.5, -.1);
  assert.equal(calls, 2);
});

test('browser fetch is invoked without a class receiver and synchronous failures can recover', async () => {
  let fail = true;
  const client = new FlowClient({ key: 'test', fetchImpl: function () {
    assert.equal(this, undefined);
    if (fail) throw new Error('Temporary failure');
    return Response.json({ flowSegmentData: { currentSpeed: 12, freeFlowSpeed: 24 } });
  } });
  assert.equal(await client.flowAt(51.5, -.1), null);
  fail = false;
  assert.equal((await client.flowAt(51.5, -.1)).ratio, .5);
});

test('per-minute and persisted daily guards prevent excess speed-data requests', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return Response.json({ flowSegmentData: { currentSpeed: 10, freeFlowSpeed: 20 } }); };
  const client = new FlowClient({ key: 'test', fetchImpl });
  await Promise.all(Array.from({ length: 20 }, (_, i) => client.flowAt(51 + i * .01, -.1)));
  assert.equal(requests, 9);
  const daily = new FlowClient({ key: 'test', fetchImpl, storage: { getItem: () => '2000' } });
  assert.equal(await daily.flowAt(51.5, -.1), null);
  assert.equal(requests, 9);
});

test('invalid upstream speeds cannot create NaN estimates and a 429 reuses cached samples', async () => {
  let now = 1_000_000, failing = false;
  const client = new FlowClient({ key: 'test', now: () => now, fetchImpl: async () => failing ? new Response('', { status: 429 }) : Response.json({ flowSegmentData: { currentSpeed: 10, freeFlowSpeed: 20 } }) });
  await client.flowAt(51.5, -.1);
  failing = true; now += 180_001;
  const cached = await client.flowAt(51.5, -.1);
  assert.equal(cached.stale, true);
  assert.equal(cached.kmh, 10);
  const invalid = new FlowClient({ key: 'test', fetchImpl: async () => Response.json({ flowSegmentData: { currentSpeed: 10, freeFlowSpeed: 0 } }) });
  assert.equal(await invalid.flowAt(51.5, -.1), null);
});
