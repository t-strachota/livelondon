import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CarSim } from '../lib/car-sim.mjs';
import { fetchTiles, freshness, inferRatios, matchFeatures, placementWeights, tilesFor } from '../lib/observations.mjs';
import { squareRoads } from './fixtures.mjs';

test('freshness never labels stale, old or missing data as live', () => {
  const now = Date.now(), tile = (source, age) => ({ source, fetchedAt: source === 'missing' ? null : now - age * 1000 });
  assert.equal(freshness([tile('live', 5), tile('cache', 300)], 1800, now).status, 'live');
  assert.equal(freshness([tile('live', 5), tile('stale', 4000)], 1800, now).status, 'stale');
  assert.equal(freshness([tile('cache', 4000)], 1800, now).status, 'stale');
  assert.equal(freshness([tile('missing'), tile('missing')], 1800, now).status, 'fallback');
});

test('tiles are fetched once per cache period within the request budget, then fall back to stale cache', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tiles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheDir = pathToFileURL(`${dir}/`);
  const urls = [];
  const ok = async url => { urls.push(url); return new Response(new Uint8Array([1, 2, 3])); };
  const tiles = tilesFor([-.13, 51.5, -.12, 51.51], 12);
  const options = { key: 'k', cacheDir, tiles, styles: ['relative'], cacheSeconds: 600, concurrency: 2 };
  const first = await fetchTiles({ ...options, maxRequests: 1, fetchImpl: ok });
  assert.equal(urls.length, 1);
  assert.deepEqual(first.map(r => r.source).sort(), [...Array(tiles.length - 1).fill('missing'), 'live'].sort());
  const second = await fetchTiles({ ...options, maxRequests: 10, fetchImpl: ok });
  assert.ok(second.every(r => r.source !== 'missing'));
  assert.equal(urls.length, tiles.length); // the cached tile was not fetched again
  for (const r of second) utimesSync(new URL(`relative-${r.tile.join('-')}.pbf`, cacheDir), new Date(0), new Date(0));
  const failing = async () => new Response('', { status: 500 });
  const third = await fetchTiles({ ...options, maxRequests: 10, fetchImpl: failing });
  assert.ok(third.every(r => r.source === 'stale'));
});

test('flow is matched by direction, closures are excluded and unobserved roads are inferred', () => {
  const roads = squareRoads(), sim = new CarSim(roads, { population: 10 });
  const eastbound = roads.edges[0][8];
  const { ratio, closed } = matchFeatures(sim, [
    { style: 'relative', coords: eastbound, value: .2, closure: false },
    { style: 'relative', coords: roads.edges[3][8], value: null, closure: true },
  ]);
  assert.ok(Math.abs(ratio[0] - .2) < 1e-6);
  assert.ok(Number.isNaN(ratio[1]), 'the westbound direction is not matched');
  assert.equal(closed[3], 1);
  const { ratio: inferred, counts } = inferRatios(sim, ratio);
  assert.equal(counts.observed, 1);
  assert.ok(Math.abs(inferred[1] - .2) < 1e-6, 'same-class road nearby');
  const weights = placementWeights(sim, inferred, closed);
  assert.equal(weights[3], 0);
  assert.ok(Math.abs(weights[0] - sim.length[0] * sim.lanes[0] / 1000 * (5 + 95 * .8)) < 1e-3);
});
