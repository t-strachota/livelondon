import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { createApp } from '../server.mjs';
import { makeBuses } from './fixtures.mjs';
import { metres } from '../lib/traffic.mjs';

await mkdir('test-results', { recursive: true });
const server = createApp({ feed: { getSnapshot: async () => ({ status: 'live', configured: true, fetchedAt: new Date().toISOString(), buses: makeBuses(300) }) } });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const roadFeatures = [];
for (const latitude of [51.3, 51.4, 51.5, 51.506, 51.5065, 51.507, 51.5075, 51.508, 51.6, 51.7]) roadFeatures.push({ type: 'Feature', properties: { class: 'primary' }, geometry: { type: 'LineString', coordinates: [[-.65, latitude], [.42, latitude]] } });
for (const longitude of [-.5, -.3, -.13, -.129, -.128, -.127, -.126, .1, .3]) roadFeatures.push({ type: 'Feature', properties: { class: 'primary' }, geometry: { type: 'LineString', coordinates: [[longitude, 51.24], [longitude, 51.74]] } });
const tileIndex = new GeoJSONVT({ type: 'FeatureCollection', features: roadFeatures }, { maxZoom: 14, tolerance: 0, extent: 4096 });
const photo = new PNG({ width: 320, height: 180 });
for (let i = 0; i < photo.data.length; i += 4) { photo.data[i] = 80; photo.data[i + 1] = 110; photo.data[i + 2] = 130; photo.data[i + 3] = 255; }
const image = PNG.sync.write(photo);
const transparent = PNG.sync.write(new PNG({ width: 256, height: 256 }));
const cameras = Array.from({ length: 24 }, (_, index) => ({
  id: `JamCams_test-${index}`, commonName: `Test camera ${index}`,
  lon: -.128 + ((index % 6) - 3) * .002, lat: 51.507 + (Math.floor(index / 6) - 2) * .0015,
  additionalProperties: [{ key: 'imageUrl', value: `https://camera.test/${index}.png` }],
}));
let browser, page;
const errors = [], calls = { speeds: 0, tiles: 0, cameraList: 0, images: 0, buses: 0 };
try {
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/buses') calls.buses++; });
  await page.route('https://api.maptiler.com/**', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: {
    version: 8, sources: { maptiler_planet: { type: 'vector', tiles: [`${base}/test-roads/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14 } },
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f2f2ef' } }, { id: 'roads', type: 'line', source: 'maptiler_planet', 'source-layer': 'transportation', paint: { 'line-color': '#decfa6', 'line-width': 8 } }],
  } }));
  await page.route('**/test-roads/**', route => {
    const [, z, x, y] = new URL(route.request().url()).pathname.match(/test-roads\/(\d+)\/(\d+)\/(\d+)/);
    const tile = tileIndex.getTile(Number(z), Number(x), Number(y));
    return route.fulfill({ contentType: 'application/x-protobuf', body: tile ? Buffer.from(fromGeojsonVt({ transportation: tile })) : Buffer.alloc(0) });
  });
  await page.route('https://api.tomtom.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('flowSegmentData')) { calls.speeds++; return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { flowSegmentData: { currentSpeed: 15, freeFlowSpeed: 30 } } }); }
    calls.tiles++;
    return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'image/png', body: transparent });
  });
  await page.route('https://api.tfl.gov.uk/Place/Type/JamCam', route => { calls.cameraList++; return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: cameras }); });
  await page.route('https://camera.test/**', route => { calls.images++; return route.fulfill({ contentType: 'image/png', body: image }); });
  await page.route('https://overpass-api.de/**', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { elements: [] } }));
  await page.goto(base);
  await page.waitForFunction(() => window.londonLayers?.cameras && window.londonBuses.buses.length === 300);
  assert.equal(calls.speeds, 0); assert.equal(calls.tiles, 0); assert.equal(calls.cameraList, 0);

  // Cars work independently of buses, including the whole-London overview.
  await page.locator('#toggle-buses').uncheck();
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 10 }));
  await page.locator('#toggle-cars').check();
  await page.waitForFunction(() => window.londonLayers.cars.count > 0);
  assert.ok(await page.evaluate(() => window.londonLayers.cars.count <= 300));
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPaintProperty('estimated-cars', 'circle-color')), '#000000');
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPitch()), 0);
  assert.equal(await page.evaluate(() => window.londonBuses.buses.length), 0);
  assert.ok(calls.speeds <= 9);
  const positions = await page.evaluate(async () => (await window.londonBuses.map.getSource('estimated-cars').getData()).features.map(feature => feature.geometry.coordinates));
  await page.waitForTimeout(500);
  const moved = await page.evaluate(async () => (await window.londonBuses.map.getSource('estimated-cars').getData()).features.map(feature => feature.geometry.coordinates));
  assert.notDeepEqual(positions, moved);

  // The layer only draws sim snapshots: pan/zoom, a style reload and a traffic refresh keep the same vehicles moving on.
  const vehicles = () => page.evaluate(async () => Object.fromEntries((await window.londonBuses.map.getSource('estimated-cars').getData()).features
    .map(feature => [feature.properties.id, { position: feature.geometry.coordinates, speed: feature.properties.speed }])));
  await page.evaluate(() => { window.testSim = window.londonLayers.cars.sim; });
  const start = await vehicles(), startedAt = Date.now();
  await page.evaluate(() => { const { map } = window.londonBuses; map.jumpTo({ center: [-.127, 51.5072], zoom: 15 }); map.fire('style.load'); });
  await page.evaluate(() => window.londonLayers.cars.refresh());
  await page.waitForTimeout(800);
  const end = await vehicles(), elapsed = (Date.now() - startedAt) / 1000;
  assert.equal(await page.evaluate(() => window.londonLayers.cars.sim === window.testSim), true);
  assert.ok(Object.keys(start).length > 0);
  assert.deepEqual(Object.keys(end).sort(), Object.keys(start).sort());
  for (const [id, { position, speed }] of Object.entries(start)) {
    const distance = metres(position, end[id].position);
    assert.ok(distance > 0 && distance <= speed * (elapsed + .2) + 5, `${id} moved ${distance.toFixed(1)} m in ${elapsed}s`);
  }
  await page.screenshot({ path: 'test-results/cars-london-overview.png' });

  await page.locator('#toggle-traffic').check();
  await page.waitForFunction(() => window.londonBuses.map.getLayer('traffic'));
  await page.waitForTimeout(400);
  assert.ok(calls.tiles > 0);
  assert.equal(await page.locator('#toggle-buses').isChecked(), false);
  await page.locator('#toggle-traffic').uncheck();
  assert.equal(await page.evaluate(() => !!window.londonBuses.map.getLayer('traffic')), false);

  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 14, center: [-.128, 51.507] }));
  await page.locator('#toggle-cameras').check();
  await page.waitForFunction(() => window.londonLayers.cameras.previews > 0);
  assert.equal(calls.cameraList, 1);
  assert.ok(await page.evaluate(() => window.londonLayers.cameras.previews <= 8));
  await page.waitForFunction(() => [...document.querySelectorAll('.cctv-wrap img')].some(image => image.complete && image.naturalWidth));
  const overlaps = await page.evaluate(() => {
    const controls = document.querySelector('.panel').getBoundingClientRect();
    return [...document.querySelectorAll('.cctv-wrap')].some(tile => { const r = tile.getBoundingClientRect(); return r.left < controls.right && r.right > controls.left && r.top < controls.bottom && r.bottom > controls.top; });
  });
  assert.equal(overlaps, false);
  await page.locator('.cctv-tile').first().click();
  assert.equal(await page.locator('#cctv-viewer').isVisible(), true);
  const before = await page.locator('#cctv-viewer').boundingBox();
  await page.mouse.move(before.x + 100, before.y + 15); await page.mouse.down(); await page.mouse.move(before.x + 40, before.y + 75, { steps: 5 }); await page.mouse.up();
  const dragged = await page.locator('#cctv-viewer').boundingBox();
  assert.ok(Math.abs(dragged.y - before.y) > 20);
  await page.mouse.move(dragged.x + dragged.width - 5, dragged.y + dragged.height - 5); await page.mouse.down(); await page.mouse.move(dragged.x + dragged.width - 65, dragged.y + dragged.height + 35, { steps: 5 }); await page.mouse.up();
  const resized = await page.locator('#cctv-viewer').boundingBox();
  assert.ok(resized.width < dragged.width);

  // All layers can coexist with main's bus-only tilt policy.
  await page.locator('#cv-close').click();
  await page.locator('#toggle-buses').check();
  await page.locator('#toggle-traffic').check();
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 17, center: [-.128, 51.507] }));
  await page.waitForFunction(() => window.londonBuses.modelCount > 0 && window.londonLayers.cars.count > 0);
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPitch()), 40);
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPaintProperty('estimated-cars', 'circle-color')), '#000000');
  await page.screenshot({ path: 'test-results/all-layers.png' });

  // Disabling cameras closes the viewer and stops snapshot refreshes.
  await page.locator('#toggle-cameras').uncheck();
  assert.equal(await page.locator('#cctv-viewer').isVisible(), false);
  assert.equal(await page.locator('.cctv-wrap').count(), 0);
  await page.locator('#toggle-cars').uncheck();
  await page.locator('#toggle-traffic').uncheck();
  await page.locator('#toggle-buses').uncheck();
  const paused = { ...calls };
  await page.evaluate(() => { window.londonBuses.map.jumpTo({ zoom: 14 }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1000);
  assert.deepEqual(calls, paused);
  assert.equal(await page.evaluate(async () => (await window.londonBuses.map.getSource('estimated-cars').getData()).features.length), 0);
  await page.reload();
  await page.waitForFunction(() => window.londonLayers?.cameras);
  for (const name of ['buses', 'cars', 'traffic', 'cameras']) assert.equal(await page.locator(`#toggle-${name}`).isChecked(), false);
  assert.deepEqual(calls, paused);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/layers-mobile.png' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS: independent overlays', maxCars: 300, calls, screenshots: 'test-results/' }));
} catch (error) {
  console.error(JSON.stringify({ errors, calls, state: page ? await page.evaluate(() => ({ carSummary: document.querySelector('#car-summary')?.textContent, layers: window.londonLayers ? Object.keys(window.londonLayers) : [] })).catch(() => null) : null }));
  await page?.screenshot({ path: 'test-results/overlays-failure.png' }).catch(() => {});
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
