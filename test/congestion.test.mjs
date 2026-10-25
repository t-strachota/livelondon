import test from 'node:test';
import assert from 'node:assert/strict';
import { congestionCells } from '../lib/congestion.mjs';
const sample = (speeds, x = speeds.map(() => 20)) => ({ count: speeds.length, speed: Uint16Array.from(speeds), x, y: x.map(() => 20), lon: x.map(() => -1280000), lat: x.map(() => 515070000) });
test('epicenters require both enough slow cars and a slow majority, with speeds decoded in cm/s', () => {
  assert.equal(congestionCells(sample(Array(7).fill(0))).features.length, 0);
  assert.equal(congestionCells(sample([...Array(8).fill(299), ...Array(9).fill(1000)])).features.length, 0);
  const data = sample([...Array(8).fill(299), ...Array(8).fill(1000)]);
  const original = [...data.speed];
  const [feature] = congestionCells(data).features;
  assert.equal(feature.properties.slowCars, 8);
  assert.deepEqual(feature.geometry.coordinates, [-.128, 51.507]);
  assert.deepEqual([...data.speed], original);
  assert.equal(congestionCells(sample(Array(30).fill(300))).features.length, 0);
});
test('separate cells do not combine sparse cars into false epicenters and empty data clears hotspots', () => {
  assert.equal(congestionCells(sample(Array(12).fill(0), Array.from({ length: 12 }, (_, i) => i * 300))).features.length, 0);
  assert.deepEqual(congestionCells(sample([])), { type: 'FeatureCollection', features: [] });
});
