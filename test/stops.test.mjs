import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StopCatalog, StopIndex, parseStops } from '../lib/stops.mjs';

const point = (id = 'stop-29', route = '29', lon = -.128) => ({
  id, commonName: `${route} stop`, stopType: 'NaptanPublicBusCoachTram', status: true,
  lat: 51.507, lon, lines: [{ id: route }],
  additionalProperties: [{ key: 'CompassPoint', value: 'N' }],
});
const bus = { route: '29', longitude: -.128, latitude: 51.507, bearing: 0 };

test('only physical, in-bounds bus stops with actual route memberships are indexed', () => {
  const stops = parseStops([point(), { ...point('station'), stopType: 'NaptanBusCoachStation' }, { ...point('closed'), status: false }, { ...point('none'), lines: [] }, { ...point('outside'), lat: 53 }]);
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].routes, ['29']);
  assert.equal(stops[0].bearing, 0);
});

test('a nearby route 19 stop cannot stop bus 29', () => {
  const index = new StopIndex(parseStops([point('stop-19', '19'), point('stop-29', '29', -.12)]));
  assert.equal(index.match(bus), null);
  assert.equal(index.match({ ...bus, route: '19' }).id, 'stop-19');
  assert.equal(index.match({ ...bus, longitude: -.12 }).id, 'stop-29');
});

test('heading rejects opposite-direction stops and route matching distinguishes night routes', () => {
  const index = new StopIndex(parseStops([point()]));
  assert.equal(index.match({ ...bus, bearing: 180 }), null);
  assert.equal(index.match({ ...bus, route: 'N29' }), null);
  assert.equal(index.match({ ...bus, route: ' 29 ' }).route, '29');
});

test('explicit stop flags are honoured only after verifying the stop serves this route', () => {
  const index = new StopIndex(parseStops([point()]));
  assert.equal(index.match({ ...bus, atStop: false }), null);
  assert.equal(index.match({ ...bus, atStop: true, stopRef: 'stop-29', bearing: 180 }).id, 'stop-29');
  assert.equal(index.match({ ...bus, route: '19', atStop: true, stopRef: 'stop-29' }), null);
  assert.equal(new StopIndex().match(bus), null);
});

test('stop catalog follows pagination, shares loading work and reuses its daily disk cache', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oxhack-stops-'));
  const cacheFile = join(directory, 'stops.json');
  const pages = [];
  const catalog = new StopCatalog({ cacheFile, intervalMs: 0, fetchImpl: async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    const stopPoints = page === 1 ? [point('stop-1', '1'), point('stop-2', '2')] : [point('stop-3', '3')];
    return Response.json({ page, pageSize: stopPoints.length, total: 3, stopPoints });
  } });
  t.after(async () => { catalog.close(); await rm(directory, { recursive: true, force: true }); });
  await Promise.all([catalog.start(), catalog.start()]);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(catalog.status, 'ready');
  assert.equal(catalog.index.byId.size, 3);
  const cached = new StopCatalog({ cacheFile, fetchImpl: () => assert.fail('Fresh cache should avoid another download') });
  t.after(() => cached.close());
  await cached.start();
  assert.equal(cached.status, 'ready');
  assert.equal(cached.index.byId.size, 3);
});

test('an upstream stop-catalog failure preserves a previous index without inventing route matches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oxhack-stops-'));
  const cacheFile = join(directory, 'stops.json');
  await writeFile(cacheFile, JSON.stringify({ version: 1, updatedAt: new Date(Date.now() - 90_000_000).toISOString(), stops: parseStops([point()]) }));
  const catalog = new StopCatalog({ cacheFile, fetchImpl: async () => { throw new Error('Offline'); } });
  t.after(async () => { catalog.close(); await rm(directory, { recursive: true, force: true }); });
  await catalog.start();
  assert.equal(catalog.status, 'partial');
  assert.equal(catalog.match(bus).id, 'stop-29');
  assert.equal(catalog.match({ ...bus, route: '19' }), null);
});
