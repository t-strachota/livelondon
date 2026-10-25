import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork, estimateTrain, TrainTracker, HOLD_MS } from '../lib/trains.mjs';

// A straight east-west Victoria line with stations A, B, C about 1.4 km apart.
const network = buildNetwork([{
  line: 'victoria',
  strings: [[[-0.14, 51.5], [-0.12, 51.5], [-0.10, 51.5]]],
  stations: [['A', 'A', 'A', 'Alpha', -0.14, 51.5], ['B', 'B', 'B', 'Bravo', -0.12, 51.5], ['C', 'C', 'C', 'Charlie', -0.10, 51.5]],
  routes: [['A', 'B', 'C'], ['C', 'B', 'A']],
}]);
const at = id => network.victoria.strings[0].at.get(id);
const prediction = (vehicleId, naptanId, timeToStation, extra = {}) => ({ lineId: 'victoria', vehicleId, naptanId, stationName: naptanId, timeToStation, destinationName: 'Charlie', ...extra });

test('a train is placed between its previous and next station, clamped to that segment', () => {
  for (const t of [0, 10, 60, 120, 5000]) {
    const train = estimateTrain(network, [prediction('1', 'B', t), prediction('1', 'C', t + 180)]);
    assert.equal(train.dir, 1);
    assert.equal(train.limit, Math.round(at('B') * 10) / 10);
    assert.ok(train.distance >= at('A') - .1 && train.distance <= at('B') + .1, `t=${t}: ${train.distance}`);
  }
  assert.ok(Math.abs(estimateTrain(network, [prediction('1', 'B', 0), prediction('1', 'C', 180)]).distance - at('B')) < .2, 'due now: at the next station');
  assert.ok(Math.abs(estimateTrain(network, [prediction('1', 'B', 5000), prediction('1', 'C', 5180)]).distance - at('A')) < .2, 'far off: at the previous station');
});

test('direction follows the order of the predicted stations', () => {
  const train = estimateTrain(network, [prediction('2', 'B', 60), prediction('2', 'A', 240)]);
  assert.equal(train.dir, -1);
  assert.ok(train.distance >= at('B') - .1 && train.distance <= at('C') + .1);
});

test('ids are stable across polls and blank vehicle ids are skipped', () => {
  const tracker = new TrainTracker();
  tracker.update(network, [prediction('7', 'B', 90), prediction('7', 'C', 270), prediction('', 'B', 30), prediction('000', 'C', 30)], 0);
  assert.deepEqual(tracker.list(0).map(t => t.id), ['victoria:7']);
  tracker.update(network, [prediction('7', 'B', 75), prediction('7', 'C', 255)], 15_000);
  const [train] = tracker.list(15_000);
  assert.equal(train.id, 'victoria:7');
  assert.equal(train.held, false);
});

test('a train missing from the predictions holds its position, then is dropped after HOLD_MS', () => {
  const tracker = new TrainTracker();
  tracker.update(network, [prediction('9', 'B', 90), prediction('9', 'C', 270)], 0);
  const before = tracker.list(0)[0];
  tracker.update(network, [], 15_000);
  const held = tracker.list(15_000)[0];
  assert.equal(held.held, true);
  assert.equal(held.speed, 0);
  assert.ok(held.distance >= before.distance && held.distance <= before.limit, 'held between where it was and its next station');
  tracker.update(network, [], 30_000);
  assert.equal(tracker.list(30_000)[0].distance, held.distance, 'stays put while held');
  tracker.update(network, [], HOLD_MS + 1);
  assert.equal(tracker.list(HOLD_MS + 1).length, 0);
});

test('a train at an unknown station is not placed', () => {
  assert.equal(estimateTrain(network, [prediction('5', 'ZZZ', 30, { stationName: 'Nowhere' })]), null);
});
