import test from 'node:test';
import assert from 'node:assert/strict';
import { TrafficSimulation, snapshotToGeoJSON } from '../lib/traffic-simulation.mjs';

const line = [[-.13, 51.507], [-.116, 51.507]];
const road = { id: 'road-a', line, lanes: 2, m: 970, kmh: 36, vehicles: 3 };

test('vehicle IDs persist through steps and compatible live-data updates', () => {
  const simulation = new TrafficSimulation({ roads: [road], seed: 7 });
  const initialIds = simulation.snapshot().vehicles.map(vehicle => vehicle.id);
  simulation.step(20);
  assert.deepEqual(simulation.snapshot().vehicles.map(vehicle => vehicle.id), initialIds);

  simulation.updateRoads([{ ...road, kmh: 18, vehicles: 5 }]);
  const grownIds = simulation.snapshot().vehicles.map(vehicle => vehicle.id);
  assert.deepEqual(grownIds.slice(0, initialIds.length), initialIds);
  assert.equal(new Set(grownIds).size, grownIds.length);

  simulation.updateRoads([{ ...road, vehicles: 2 }]);
  assert.deepEqual(simulation.snapshot().vehicles.map(vehicle => vehicle.id), initialIds.slice(0, 2));
});

test('equal seeds and inputs produce identical runs', () => {
  const options = { roads: [road, { ...road, id: 'road-b' }], seed: 1234 };
  const first = new TrafficSimulation(options);
  const second = new TrafficSimulation(options);
  first.step(1000);
  second.step(1000);
  assert.deepEqual(first.snapshot(), second.snapshot());

  const different = new TrafficSimulation({ ...options, seed: 1235 });
  assert.notDeepEqual(different.snapshot(), new TrafficSimulation(options).snapshot());
});

test('step advances by the configured fixed timestep and wraps both directions', () => {
  const forward = new TrafficSimulation({ roads: [{ ...road, oneway: 1, vehicles: 1 }], seed: 2, timestepSeconds: .1 });
  const before = forward.snapshot().vehicles[0];
  forward.step(10);
  const after = forward.snapshot().vehicles[0];
  assert.equal(after.speedMps, 10);
  assert.ok(Math.abs(((after.positionMetres - before.positionMetres + 970) % 970) - 10) < .05);
  assert.equal(forward.snapshot().simulationTimeSeconds, 1);

  const reverse = new TrafficSimulation({ roads: [{ ...road, oneway: -1, vehicles: 1 }], seed: 2, timestepSeconds: .1 });
  const reverseBefore = reverse.snapshot().vehicles[0].positionMetres;
  reverse.step(10);
  const reverseAfter = reverse.snapshot().vehicles[0].positionMetres;
  assert.ok(Math.abs(((reverseBefore - reverseAfter + 970) % 970) - 10) < .05);
});

test('snapshot is side-effect free and converts at the rendering boundary', () => {
  const simulation = new TrafficSimulation({ roads: [road], seed: 9 });
  const first = simulation.snapshot();
  assert.deepEqual(simulation.snapshot(), first);
  const geojson = snapshotToGeoJSON(first);
  assert.equal(geojson.features.length, first.vehicles.length);
  assert.ok(geojson.features.every(feature => Number.isFinite(feature.properties.weightKg)));
  assert.ok(geojson.features.every(feature => feature.geometry.coordinates.every(Number.isFinite)));
});
