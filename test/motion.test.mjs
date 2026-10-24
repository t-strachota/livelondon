import test from 'node:test';
import assert from 'node:assert/strict';
import { BusMotionStore, distance, modelOpacity, pitchForZoom, toGeoJSON } from '../lib/motion.mjs';
import { makeBuses } from './fixtures.mjs';

const NOW = Date.parse('2026-10-24T15:00:00Z');
const fix = (overrides = {}) => ({ ...makeBuses(1, NOW)[0], ...overrides });

test('fresh GPS fixes interpolate for the full 15-second interval, then stop at the confirmed position', () => {
  const store = new BusMotionStore();
  const first = fix({ longitude: -.128, bearing: 350 });
  store.ingest([first], NOW);
  store.ingest([fix({ longitude: -.127, bearing: 10, recordedAt: new Date(NOW + 15_000).toISOString() })], NOW + 15_000);
  const middle = store.sample(NOW + 22_500)[0];
  assert.ok(Math.abs(middle.longitude - -.1275) < .000001);
  assert.ok(Math.abs(middle.bearing) < .001);
  assert.notEqual(store.sample(NOW + 16_000)[0].longitude, -.127);
  assert.equal(store.sample(NOW + 30_000)[0].longitude, -.127);
  assert.equal(store.sample(NOW + 90_000)[0].longitude, -.127);
});

test('repeated and older fixes cannot rewind a vehicle', () => {
  const store = new BusMotionStore();
  store.ingest([fix()], NOW);
  store.ingest([fix({ longitude: -.2 })], NOW + 500);
  assert.equal(store.sample(NOW + 500)[0].longitude, fix().longitude);
});

test('stale vehicles dim at 60 seconds and disappear at three minutes', () => {
  const store = new BusMotionStore();
  store.ingest([fix()], NOW);
  assert.equal(store.sample(NOW + 59_000)[0].stale, false);
  assert.equal(store.sample(NOW + 60_000)[0].stale, true);
  assert.equal(store.sample(NOW + 180_000).length, 0);
});

test('missing bearings use movement direction and large jumps do not glide across London', () => {
  const store = new BusMotionStore();
  store.ingest([fix({ longitude: -.128, latitude: 51.507 })], NOW);
  store.ingest([fix({ longitude: -.127, latitude: 51.507, bearing: null, recordedAt: new Date(NOW + 15_000).toISOString() })], NOW + 15_000);
  assert.ok(Math.abs(store.sample(NOW + 30_000)[0].bearing - 90) < .01);
  store.ingest([fix({ longitude: -.2, recordedAt: new Date(NOW + 30_000).toISOString() })], NOW + 30_000);
  assert.equal(store.sample(NOW + 30_000)[0].longitude, -.2);
});

const ownStop = { id: 'stop-29', name: 'Route 29 stop', route: '29' };
const metresNorth = metres => metres / 111_195;

test('a bus waits at its own stop despite GPS jitter, until a newer fix confirms departure', () => {
  const store = new BusMotionStore();
  const atStop = fix({ route: '29', routeStop: ownStop, bearing: 0 });
  store.ingest([atStop], NOW);
  assert.equal(store.sample(NOW)[0].holdingAtStop, true);
  store.ingest([{ ...atStop, latitude: atStop.latitude + metresNorth(4), bearing: 180, recordedAt: new Date(NOW + 15_000).toISOString() }], NOW + 15_000);
  const waiting = store.sample(NOW + 20_000)[0];
  assert.equal(waiting.latitude, atStop.latitude);
  assert.equal(waiting.bearing, 0);
  assert.equal(waiting.holdingAtStop, true);
  // Replayed timestamps cannot release the hold, even if coordinates differ.
  store.ingest([{ ...atStop, latitude: atStop.latitude + metresNorth(100) }], NOW + 25_000);
  assert.equal(store.sample(NOW + 25_000)[0].holdingAtStop, true);
  const departed = { ...atStop, latitude: atStop.latitude + metresNorth(16), recordedAt: new Date(NOW + 30_000).toISOString() };
  store.ingest([departed], NOW + 30_000);
  assert.equal(store.sample(NOW + 30_000)[0].latitude, atStop.latitude);
  const leaving = store.sample(NOW + 37_500)[0];
  assert.equal(leaving.holdingAtStop, false);
  assert.equal(leaving.heldStop, null); // Do not re-latch to the same nearby stop during departure.
  assert.ok(leaving.latitude > atStop.latitude && leaving.latitude < departed.latitude);
  assert.equal(store.sample(NOW + 45_000)[0].latitude, departed.latitude);
});

test('route 29 is never latched by a stop belonging to route 19', () => {
  const store = new BusMotionStore();
  const first = fix({ route: '29', routeStop: { ...ownStop, route: '19' } });
  store.ingest([first], NOW);
  assert.equal(store.sample(NOW)[0].holdingAtStop, false);
  const next = { ...first, latitude: first.latitude + metresNorth(8), recordedAt: new Date(NOW + 15_000).toISOString() };
  store.ingest([next], NOW + 15_000);
  const middle = store.sample(NOW + 22_500)[0];
  assert.equal(middle.heldStop, null);
  assert.ok(middle.latitude > first.latitude);
});

test('arriving buses reach their own stop and cannot interpolate past it', () => {
  const store = new BusMotionStore();
  const first = fix({ route: '29', longitude: -.128, latitude: 51.507, bearing: 0 });
  const arrival = { ...first, routeStop: ownStop, latitude: first.latitude + metresNorth(60), recordedAt: new Date(NOW + 15_000).toISOString() };
  store.ingest([first], NOW);
  store.ingest([arrival], NOW + 15_000);
  assert.equal(store.sample(NOW + 20_000)[0].holdingAtStop, false);
  // A newer stationary reading must not restart the approach and keep the bus chasing its stop.
  store.ingest([{ ...arrival, latitude: arrival.latitude + metresNorth(2), recordedAt: new Date(NOW + 25_000).toISOString() }], NOW + 25_000);
  const arrived = store.sample(NOW + 30_000)[0];
  assert.equal(arrived.holdingAtStop, true);
  assert.equal(arrived.latitude, arrival.latitude);
  assert.equal(store.sample(NOW + 90_000)[0].latitude, arrival.latitude);
});

test('retargeting an unfinished interval is continuous, and missing updates do not extrapolate', () => {
  const store = new BusMotionStore();
  const first = fix({ longitude: -.128 });
  store.ingest([first], NOW);
  store.ingest([{ ...first, longitude: -.127, recordedAt: new Date(NOW + 15_000).toISOString() }], NOW + 15_000);
  const before = store.sample(NOW + 25_000)[0];
  const latest = { ...first, longitude: -.126, recordedAt: new Date(NOW + 25_000).toISOString() };
  store.ingest([latest], NOW + 25_000);
  assert.ok(distance(before, store.sample(NOW + 25_000)[0]) < .001);
  assert.equal(store.sample(NOW + 40_000)[0].longitude, latest.longitude);
  assert.equal(store.sample(NOW + 80_000)[0].longitude, latest.longitude);
});

test('fresh unchanged coordinates preserve the original interpolation timeline', () => {
  const store = new BusMotionStore();
  const first = fix({ longitude: -.128 });
  const next = { ...first, longitude: -.127, recordedAt: new Date(NOW + 15_000).toISOString() };
  store.ingest([first], NOW);
  store.ingest([next], NOW + 15_000);
  store.ingest([{ ...next, recordedAt: new Date(NOW + 25_000).toISOString() }], NOW + 25_000);
  assert.equal(store.sample(NOW + 30_000)[0].longitude, -.127);
});

test('changing routes clears the previous route stop hold', () => {
  const store = new BusMotionStore();
  const first = fix({ route: '29', routeStop: ownStop });
  store.ingest([first], NOW);
  store.ingest([{ ...first, route: '19', longitude: first.longitude + .0001, recordedAt: new Date(NOW + 15_000).toISOString() }], NOW + 15_000);
  assert.equal(store.sample(NOW + 20_000)[0].heldStop, null);
});

test('reduced motion uses the latest fix immediately', () => {
  const store = new BusMotionStore();
  store.ingest([fix()], NOW);
  store.ingest([fix({ longitude: -.12, recordedAt: new Date(NOW + 15_000).toISOString() })], NOW + 15_000, { animate: false });
  assert.equal(store.sample(NOW + 15_000)[0].longitude, -.12);
});

test('dot and model zoom ranges crossfade with a linked 0–40 degree tilt', () => {
  assert.equal(modelOpacity(14), 0);
  assert.equal(modelOpacity(16.5), .5);
  assert.equal(modelOpacity(18), 1);
  assert.equal(pitchForZoom(16), 0);
  assert.equal(pitchForZoom(16.5), 20);
  assert.equal(pitchForZoom(17), 40);
  assert.equal(toGeoJSON([{ ...fix(), stale: false }]).features[0].properties.id, fix().id);
});
