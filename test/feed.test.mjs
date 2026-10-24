import test from 'node:test';
import assert from 'node:assert/strict';
import { BusFeed, parseFeed, EXPIRE_MS } from '../lib/feed.mjs';
import { activity, feedXML } from './fixtures.mjs';

const NOW = Date.parse('2026-10-24T15:00:00Z');

test('SIRI parsing preserves vehicle IDs, coordinates, bearings and destination text', () => {
  const { buses } = parseFeed(feedXML([activity({ recordedAt: NOW })], NOW), NOW);
  assert.equal(buses.length, 1);
  assert.equal(buses[0].id, 'TFLO:0001');
  assert.equal(buses[0].destination, 'Camden & Town');
  assert.equal(buses[0].bearing, 90);
  assert.equal(buses[0].longitude, -.128);
});

test('prefixed namespaces and multiple monitoring deliveries are accepted', () => {
  const xml = `<s:Siri xmlns:s="http://www.siri.org.uk/siri"><s:ServiceDelivery><s:VehicleMonitoringDelivery>${activity({ vehicle: 'A', recordedAt: NOW })}</s:VehicleMonitoringDelivery><s:VehicleMonitoringDelivery>${activity({ vehicle: 'B', recordedAt: NOW })}</s:VehicleMonitoringDelivery></s:ServiceDelivery></s:Siri>`;
  assert.equal(parseFeed(xml, NOW).buses.length, 2);
});

test('invalid, expired, non-TfL, out-of-London and future records are excluded', () => {
  const entries = [
    activity({ vehicle: 'ok', recordedAt: NOW, bearing: null }),
    activity({ vehicle: 'outside', recordedAt: NOW, latitude: 53 }),
    activity({ vehicle: 'invalid', recordedAt: NOW, longitude: 'bad' }),
    activity({ vehicle: 'other', recordedAt: NOW, operator: 'OTHER' }),
    activity({ vehicle: 'old', recordedAt: NOW - EXPIRE_MS }),
    activity({ vehicle: 'future', recordedAt: NOW + 120_000 }),
    activity({ vehicle: 'expired', recordedAt: NOW, validUntil: NOW - 1 }),
  ];
  const buses = parseFeed(feedXML(entries, NOW), NOW).buses;
  assert.deepEqual(buses.map(bus => bus.vehicle), ['ok']);
  assert.equal(buses[0].bearing, null);
});

test('duplicate vehicles retain the newest observation', () => {
  const xml = feedXML([activity({ recordedAt: NOW, longitude: -.12 }), activity({ recordedAt: NOW - 15_000, longitude: -.13 })], NOW);
  assert.equal(parseFeed(xml, NOW).buses[0].longitude, -.12);
});

test('malformed, error and stale snapshots fail instead of pretending to be an empty live feed', () => {
  assert.throws(() => parseFeed('<Siri>', NOW));
  assert.throws(() => parseFeed('<Siri><ServiceDelivery><VehicleMonitoringDelivery><Status>false</Status></VehicleMonitoringDelivery></ServiceDelivery></Siri>', NOW));
  assert.throws(() => parseFeed(feedXML([], NOW - EXPIRE_MS), NOW));
  assert.deepEqual(parseFeed(feedXML([], NOW), NOW).buses, []);
});

test('an absent API key never makes an upstream request', async () => {
  const feed = new BusFeed({ fetchImpl: () => assert.fail('Unexpected request') });
  assert.equal((await feed.getSnapshot()).status, 'unconfigured');
});

test('concurrent clients share one request and a 15-second cache', async () => {
  let requests = 0, now = NOW;
  const feed = new BusFeed({ apiKey: 'test-secret', now: () => now, fetchImpl: async url => {
    requests++;
    assert.equal(url.searchParams.get('operatorRef'), 'TFLO');
    assert.equal(url.searchParams.get('api_key'), 'test-secret');
    return new Response(feedXML([activity({ recordedAt: now })], now));
  } });
  const snapshots = await Promise.all([feed.getSnapshot(), feed.getSnapshot(), feed.getSnapshot()]);
  assert.equal(requests, 1);
  assert.ok(snapshots.every(snapshot => snapshot.buses.length === 1));
  await feed.getSnapshot();
  assert.equal(requests, 1);
  now += 15_000;
  await feed.getSnapshot();
  assert.equal(requests, 2);
});

test('an older upstream fix never moves the cached vehicle backwards', async () => {
  let now = NOW, calls = 0;
  const feed = new BusFeed({ apiKey: 'test', now: () => now, fetchImpl: async () => new Response(feedXML([activity({ recordedAt: ++calls === 1 ? NOW : NOW - 15_000, longitude: calls === 1 ? -.12 : -.13 })], now)) });
  await feed.getSnapshot();
  now += 15_000;
  assert.equal((await feed.getSnapshot()).buses[0].longitude, -.12);
});

test('upstream outages retain the last snapshot, mark it stale, and eventually expire buses', async () => {
  let now = NOW, fail = false;
  const feed = new BusFeed({ apiKey: 'never-expose-me', now: () => now, fetchImpl: async () => {
    if (fail) throw new Error('private upstream error');
    return new Response(feedXML([activity({ recordedAt: now })], now));
  } });
  assert.equal((await feed.getSnapshot()).status, 'live');
  fail = true; now += 15_000;
  const stale = await feed.getSnapshot();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.buses.length, 1);
  assert.ok(!JSON.stringify(stale).includes('never-expose-me'));
  now += EXPIRE_MS;
  assert.equal((await feed.getSnapshot()).buses.length, 0);
  fail = false; now += 15_000;
  const recovered = await feed.getSnapshot();
  assert.equal(recovered.status, 'live');
  assert.equal(recovered.buses.length, 1);
  assert.equal(recovered.buses[0].recordedAt, new Date(now).toISOString());
});
