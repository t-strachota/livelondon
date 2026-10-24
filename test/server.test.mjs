import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

test('HTTP endpoint serves live data, keeps credentials private and restricts static files', async t => {
  const server = createApp({ feed: { getSnapshot: async () => ({ configured: true, status: 'live', fetchedAt: new Date().toISOString(), buses: [] }) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  for (const path of ['/vendor/maplibre-gl.mjs', '/vendor/maplibre-gl-worker.mjs', '/vendor/maplibre-gl-shared.mjs', '/vendor/three.module.js', '/vendor/BufferGeometryUtils.js', '/traffic.js', '/estimated-cars.js', '/cameras.js', '/config.js', '/lib/traffic.mjs']) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200, `${path} must be served`);
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    await asset.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/flow_table.json`)).status, 200);
  assert.equal((await fetch(`${base}/cameras.css`)).status, 200);
  const api = await fetch(`${base}/api/buses`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).status, 'live');
  for (const path of ['/.env', '/.git/config', '/server.mjs', '/package.json', '/public/../.env']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(`${base}/api/buses`, { method: 'POST' })).status, 405);
});

test('unconfigured feeds return an actionable 503 response', async t => {
  const server = createApp({ feed: { getSnapshot: async () => ({ configured: false, status: 'unconfigured', buses: [] }) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/buses`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 'unconfigured');
});
