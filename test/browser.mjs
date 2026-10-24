import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { createApp } from '../server.mjs';
import { makeBuses } from './fixtures.mjs';

await mkdir('test-results', { recursive: true });
const server = createApp({ feed: { getSnapshot: async () => ({ status: 'live', configured: true, fetchedAt: new Date().toISOString(), buses: makeBuses(300) }) } });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('503')) errors.push(message.text()); });
  // Fixtures isolate rendering checks from third-party map quotas and availability.
  await context.route('https://api.maptiler.com/**', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f2f2ef' } }] } }));
  await context.route('https://overpass-api.de/**', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { elements: [] } }));
  await page.goto(base);
  await page.waitForFunction(() => window.londonBuses?.buses.length === 300 && window.londonBuses.modelsReady);
  await page.waitForFunction(() => window.londonBuses.map.queryRenderedFeatures({ layers: ['live-bus-dots'] }).length > 10);
  assert.equal(await page.locator('#feed-status').textContent(), 'Live bus locations');
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPitch()), 0);
  await page.screenshot({ path: 'test-results/overview.png' });

  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 16.5 }));
  await page.waitForFunction(() => window.londonBuses.modelCount > 0);
  assert.ok(Math.abs(await page.evaluate(() => window.londonBuses.map.getPitch()) - 20) < .1);
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 18, center: [-.128, 51.507] }));
  await page.waitForFunction(() => window.londonBuses.modelCount > 50);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPitch()), 40);
  const image = await page.locator('.maplibregl-canvas').screenshot({ path: 'test-results/models-canvas.png' });
  const png = PNG.sync.read(image);
  let redPixels = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = png.data.subarray(i, i + 3);
    if (r > 130 && r > g * 1.5 && r > b * 1.2) redPixels++;
  }
  assert.ok(redPixels > 500, `Expected visible red 3D buses, found ${redPixels} red pixels`);
  await page.screenshot({ path: 'test-results/street-level.png' });

  const streetLevelModels = await page.evaluate(() => window.londonBuses.modelCount);
  const point = await page.evaluate(() => { const { x, y } = window.londonBuses.map.project([-.128, 51.507]); return [x, y]; });
  await page.mouse.click(...point);
  await page.waitForSelector('.bus-popup');
  assert.match(await page.locator('.bus-popup').textContent(), /Bus .*Towards Waterloo.*GPS update/);
  await page.locator('.maplibregl-popup-close-button').click();

  // Fresh fixes must spread movement across the interval instead of completing in one second.
  const previousPosition = await page.evaluate(() => window.londonBuses.buses.find(bus => bus.id === 'TFLO:test-165').longitude);
  await page.route('**/api/buses', route => route.fulfill({ json: {
    status: 'live', configured: true, fetchedAt: new Date().toISOString(),
    buses: makeBuses(300).map(bus => ({ ...bus, longitude: bus.longitude + .0003, recordedAt: new Date(Date.now() + 1000).toISOString() })),
  } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => window.londonBuses.buses.some(bus => bus.moving));
  await page.waitForTimeout(1500);
  const interpolated = await page.evaluate(() => window.londonBuses.buses.find(bus => bus.id === 'TFLO:test-165').longitude);
  assert.ok(interpolated > previousPosition && interpolated < previousPosition + .00015, 'Bus should still be interpolating after 1.5 seconds');

  // Move the viewport: models must be culled and re-created in the new bounds.
  await page.evaluate(() => window.londonBuses.map.jumpTo({ center: [-.3, 51.55] }));
  await page.waitForFunction(() => window.londonBuses.modelCount === 0);
  await page.evaluate(() => window.londonBuses.map.jumpTo({ center: [-.128, 51.507], zoom: 14 }));
  await page.waitForFunction(() => window.londonBuses.map.getPitch() === 0);

  // Force the next poll to update thousands of vehicles, then check rendering work.
  await page.route('**/api/buses', route => route.fulfill({ json: { status: 'live', configured: true, fetchedAt: new Date().toISOString(), buses: makeBuses(8000) } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => window.londonBuses.buses.length === 8000);
  await page.evaluate(() => window.londonBuses.map.easeTo({ center: [-.126, 51.508], duration: 1500 }));
  const frameTimes = await page.evaluate(() => new Promise(resolve => {
    const times = []; let previous;
    function tick(time) { if (previous) times.push(time - previous); previous = time; if (times.length >= 60) resolve(times); else requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  }));
  const medianMs = frameTimes.toSorted((a, b) => a - b)[30];
  await page.screenshot({ path: 'test-results/8000-buses.png' });

  await page.route('**/api/buses', route => route.fulfill({ status: 503, json: { status: 'unavailable', configured: true, fetchedAt: null, buses: [] } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.querySelector('#feed-status').dataset.status === 'unavailable');
  assert.equal(await page.evaluate(() => window.londonBuses.buses.length), 8000);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', overviewVehicles: 8000, streetLevelModels, redModelPixels: redPixels, medianRafIntervalMs: Math.round(medianMs * 10) / 10, screenshots: 'test-results/' }));

  // A failed 3D module must leave the dots visible at street level.
  const fallback = await context.newPage();
  await fallback.route('**/bus-layer.js', route => route.abort());
  await fallback.goto(base);
  await fallback.waitForFunction(() => window.londonBuses?.buses.length === 300);
  await fallback.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 18 }));
  assert.equal(await fallback.evaluate(() => window.londonBuses.modelsReady), false);
  assert.match(await fallback.locator('#map-hint').textContent(), /3D rendering is unavailable/);
  const opacity = await fallback.evaluate(() => window.londonBuses.map.getPaintProperty('live-bus-dots', 'circle-opacity'));
  assert.equal(opacity[0], 'case');
  console.log('PASS: red-dot fallback when 3D is unavailable');

  if (process.env.LIVE_URL) {
    const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const liveErrors = [];
    live.on('pageerror', error => liveErrors.push(error.message));
    // Forward the real basemap through Node's configured network proxy, if present.
    await live.route('https://api.maptiler.com/**', async route => {
      try {
        const response = await fetch(route.request().url(), { signal: AbortSignal.timeout(25_000) });
        await route.fulfill({ status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream', 'access-control-allow-origin': '*' } });
      } catch { await route.abort(); }
    });
    await live.route('https://overpass-api.de/**', route => route.fulfill({ json: { elements: [] } }));
    await live.goto(process.env.LIVE_URL);
    await live.waitForFunction(() => window.londonBuses?.buses.length > 0 && window.londonBuses.modelsReady, undefined, { timeout: 60_000 });
    await live.waitForFunction(() => window.londonBuses.map.queryRenderedFeatures({ layers: ['live-bus-dots'] }).length > 10);
    let liveFeed;
    for (let attempt = 0; attempt < 60; attempt++) {
      liveFeed = await live.evaluate(async () => (await fetch('/api/buses', { cache: 'no-store' })).json());
      if (liveFeed.stopDataStatus === 'ready') break;
      await live.waitForTimeout(2000);
    }
    assert.equal(liveFeed.stopDataStatus, 'ready', 'Live route stop catalog must be fully loaded');
    const stopMatches = liveFeed.buses.filter(bus => bus.routeStop);
    assert.ok(stopMatches.length > 0, 'Expected live buses near their own stops');
    assert.ok(stopMatches.every(bus => bus.route.trim().toLowerCase().replace(/\s+/g, '') === bus.routeStop.route));
    await live.screenshot({ path: 'test-results/live-overview.png' });
    const vehicle = await live.evaluate(() => window.londonBuses.buses.filter(bus => !bus.stale).toSorted((a, b) => Math.hypot(a.longitude + .128, a.latitude - 51.507) - Math.hypot(b.longitude + .128, b.latitude - 51.507))[0]);
    assert.ok(vehicle && vehicle.route && vehicle.bearing >= 0 && vehicle.bearing < 360);
    await live.evaluate(bus => window.londonBuses.map.jumpTo({ center: [bus.longitude, bus.latitude], zoom: 19 }), vehicle);
    await live.waitForFunction(() => window.londonBuses.modelCount > 0);
    await live.waitForTimeout(1500);
    await live.screenshot({ path: 'test-results/live-street-level.png' });
    assert.deepEqual(liveErrors, []);
    console.log(JSON.stringify({ result: 'PASS: authenticated live map', buses: await live.evaluate(() => window.londonBuses.buses.length), routeSpecificStopMatches: stopMatches.length, inspectedRoute: vehicle.route, modelsVisible: await live.evaluate(() => window.londonBuses.modelCount) }));
  }
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: 'test-results/failure.png' }).catch(() => {});
    const state = await page.evaluate(() => ({ buses: window.londonBuses?.buses.length, modelsReady: window.londonBuses?.modelsReady, status: document.querySelector('#feed-status')?.textContent, hint: document.querySelector('#map-hint')?.textContent })).catch(() => null);
    console.error(JSON.stringify({ errors, state }));
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
