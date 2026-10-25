import { enterMap, selectTab, fixtureOptionalFeeds } from './ui-helpers.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { createApp } from '../server.mjs';
import { makeBuses } from './fixtures.mjs';
import { EventEmitter } from 'node:events';

await mkdir('test-results', { recursive: true });
// Stands in for the simulation supervisor: 200 cars driving east at 10 m/s, 5 snapshots a second.
const simulation = Object.assign(new EventEmitter(), { paused: false, time: 0, snapshot: null });
simulation.getStatus = () => ({ lifecycle: 'running', runId: 7, pausedForEveryone: simulation.paused, population: { target: 200, actual: 200, capacity: 9000 }, simTime: simulation.time,
  averageSpeedMps: 10, observation: { status: 'fallback', observedAt: null, matchedShare: 0 }, performance: { stepMs: 1, encodeMs: 0, realtimeFactor: 50, secondsBehind: 0 }, health: { gridlocked: 0 }, job: { state: 'idle' } });
simulation.setPaused = paused => { simulation.paused = paused; simulation.emit('status', simulation.getStatus()); return true; };
const simTimer = setInterval(() => {
  if (simulation.paused) return;
  simulation.time += .2;
  const n = 200, out = Buffer.alloc(24 + n * 24);
  out.writeUInt32LE(0x31504E53, 0); out.writeUInt32LE(7, 4); out.writeDoubleLE(simulation.time, 8); out.writeUInt32LE(n, 16);
  for (let i = 0; i < n; i++) {
    out.writeUInt32LE(i, 24 + 4 * i);
    out.writeInt32LE(Math.round((-.135 + (i % 20) * .0007 + simulation.time * 10 / 69_400) * 1e7), 24 + 4 * n + 4 * i);
    out.writeInt32LE(Math.round((51.503 + Math.floor(i / 20) * .0008) * 1e7), 24 + 8 * n + 4 * i);
    out.writeUInt16LE(simulation.congested && i < 30 ? 0 : 1000, 24 + 22 * n + 2 * i);
    if (simulation.congested && i < 30) {
      out.writeInt32LE(Math.round((-.128 + i * .000001) * 1e7), 24 + 4 * n + 4 * i);
      out.writeInt32LE(Math.round(51.507 * 1e7), 24 + 8 * n + 4 * i);
    }
  }
  simulation.snapshot = out;
  simulation.emit('snapshot', out);
}, 200);
const server = createApp({ simulation, feed: { getSnapshot: async () => ({ status: 'live', configured: true, fetchedAt: new Date().toISOString(), buses: makeBuses(300) }) } });
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
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await fixtureOptionalFeeds(context);
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
  await enterMap(page);
  await page.waitForFunction(() => window.londonLayers?.cameras && window.londonBuses.buses.length === 300);
  assert.equal(calls.speeds, 0); assert.equal(calls.tiles, 0); assert.equal(calls.cameraList, 0);

  await page.waitForFunction(() => document.getElementById('loading-screen').hidden);
  assert.deepEqual(await page.locator('.section-heading h2').allTextContents(), ['Explore live conditions', 'Scenario workspace', 'The city right now']);
  assert.equal(await page.locator('#tab-btn-performance').count(), 1);
  await page.locator('#panel-minimize').click();
  assert.equal(await page.locator('#panel-content').isVisible(), false);
  assert.equal(await page.locator('#panel-minimize').getAttribute('aria-expanded'), 'false');
  await page.locator('#panel-minimize').click();
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPaintProperty('background', 'background-color')), '#1b2632');
  await page.screenshot({ path: 'test-results/ux-dark.png' });
  await page.locator('#theme-toggle').click();
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPaintProperty('background', 'background-color')), '#f2f2ef');

  // Cars come only from the server's run: the browser draws what it is sent and never spawns its own.
  await selectTab(page, 'explore');
  await page.locator('#toggle-buses').uncheck();
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 13, center: [-.128, 51.507] }));
  await selectTab(page, 'simulation');
  await page.locator('#toggle-cars').check();
  await page.waitForFunction(() => window.londonLayers.cars.renderedCount === 200);
  assert.equal(await page.evaluate(() => window.londonLayers.cars.runId), 7);
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPitch()), 0);
  assert.equal(await page.evaluate(() => window.londonBuses.buses.length), 0);
  await page.waitForFunction(() => document.querySelector('#sim-global').textContent.startsWith('200'));
  assert.match(await page.locator('#sim-data').textContent(), /Fallback/);
  assert.match(await page.locator('.about-details').textContent(), /They are estimates, not live tracking of individual vehicles\./);
  // Smooth motion between 5 Hz snapshots: positions change between consecutive animation frames.
  const frameMoves = await page.evaluate(() => new Promise(resolve => {
    const seen = [];
    const sample = () => { seen.push(window.londonLayers.cars.positions()[0]); if (seen.length < 12) requestAnimationFrame(sample); else resolve(new Set(seen).size); };
    requestAnimationFrame(sample);
  }));
  assert.ok(frameMoves > 6, `only ${frameMoves} distinct positions in 12 frames`);

  // Pan/zoom and a style reload keep the same run and cars; the global count is not the visible count.
  await page.evaluate(() => { const { map } = window.londonBuses; map.jumpTo({ center: [-.127, 51.5072], zoom: 16.5 });
    // A style change clears custom layers and sources; style.load must bring the car layer back.
    for (const id of ['simulated-cars', 'cctv-label', 'cctv-dots', 'cctv-glow']) if (map.getLayer(id)) map.removeLayer(id);
    map.removeSource('cctv');
    map.fire('style.load');
  });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.londonLayers.cars.runId), 7);
  assert.ok(await page.evaluate(() => window.londonBuses.map.getLayer('simulated-cars')));
  // Check black dots below the 3D crossfade; close-zoom car models are grey.
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 15 }));
  await page.waitForTimeout(300);
  // The re-added layer actually draws: dark car pixels on the canvas.
  const darkPixels = await page.evaluate(() => {
    const { map } = window.londonBuses, gl = map.painter.context.gl;
    map.triggerRepaint();
    return new Promise(resolve => map.once('render', () => {
      const { width, height } = gl.canvas, pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 40 && pixels[i + 1] < 40 && pixels[i + 2] < 40 && pixels[i + 3] > 200) dark++;
      resolve(dark);
    }));
  });
  assert.ok(darkPixels > 50, `only ${darkPixels} dark pixels after the style reload`);
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 16.5 }));
  await page.waitForTimeout(300);
  const visible = await page.evaluate(() => window.londonLayers.cars.visibleCount);
  assert.ok(visible > 0 && visible < 200, `visible ${visible}`);
  await page.waitForFunction(() => document.querySelector('#sim-visible').textContent !== '200');

  // Queue clusters are visual estimates; they work independently of car dots.
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 13, center: [-.128, 51.507] }));
  simulation.congested = true;
  await selectTab(page, 'simulation');
  await page.locator('#toggle-hotspots').check();
  await page.waitForFunction(async () => (await window.londonBuses.map.getSource('congestion-epicenters').getData()).features.length > 0);
  await selectTab(page, 'simulation');
  await page.locator('#toggle-cars').uncheck();
  const beforeHotspotFrames = await page.evaluate(() => window.londonLayers.cars.snapshotsReceived);
  await page.waitForFunction(n => window.londonLayers.cars.snapshotsReceived > n, beforeHotspotFrames);
  assert.equal(await page.evaluate(() => window.londonBuses.map.getLayoutProperty('congestion-glow', 'visibility')), 'visible');
  assert.equal(await page.evaluate(() => window.londonLayers.cars.runId), 7);
  await page.waitForTimeout(700);
  const hotspotImage = PNG.sync.read(await page.locator('.maplibregl-canvas').screenshot());
  let glowPixels = 0;
  for (let i = 0; i < hotspotImage.data.length; i += 4) {
    const [r, g, b] = hotspotImage.data.subarray(i, i + 3);
    if (r > 160 && r > g * 1.2 && r > b * 1.2) glowPixels++;
  }
  assert.ok(glowPixels > 30, `Expected a visible red queue glow, got ${glowPixels} pixels`);
  await page.screenshot({ path: 'test-results/ux-hotspots.png' });
  simulation.congested = false;
  await page.waitForFunction(async () => (await window.londonBuses.map.getSource('congestion-epicenters').getData()).features.length === 0);
  await selectTab(page, 'simulation');
  await page.locator('#toggle-hotspots').uncheck();
  await selectTab(page, 'simulation');
  await page.locator('#toggle-cars').check();
  await page.waitForFunction(() => window.londonLayers.cars.renderedCount > 0);

  // Pause is shared and holds positions; play resumes.
  await selectTab(page, 'simulation');
  await page.locator('#sim-pause').click();
  await page.waitForFunction(() => window.londonLayers.cars.status.pausedForEveryone);
  await page.waitForTimeout(300);
  const held = await page.evaluate(() => window.londonLayers.cars.positions().slice(0, 4));
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => window.londonLayers.cars.positions().slice(0, 4)), held);
  await selectTab(page, 'simulation');
  await page.locator('#sim-pause').click();
  await page.waitForFunction(() => !window.londonLayers.cars.status.pausedForEveryone);
  await page.screenshot({ path: 'test-results/cars-close.png' });
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 13, center: [-.128, 51.507] }));

  await selectTab(page, 'explore');
  await page.locator('#toggle-traffic').check();
  await page.waitForFunction(() => window.londonBuses.map.getLayer('traffic'));
  await page.waitForTimeout(400);
  assert.ok(calls.tiles > 0);
  assert.equal(await page.locator('#toggle-buses').isChecked(), false);
  await selectTab(page, 'explore');
  await page.locator('#toggle-traffic').uncheck();
  assert.equal(await page.evaluate(() => !!window.londonBuses.map.getLayer('traffic')), false);

  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 14, center: [-.128, 51.507] }));
  await selectTab(page, 'explore');
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
  await selectTab(page, 'explore');
  await page.locator('#toggle-buses').check();
  await selectTab(page, 'explore');
  await page.locator('#toggle-traffic').check();
  await page.evaluate(() => window.londonBuses.map.jumpTo({ zoom: 17, center: [-.128, 51.507] }));
  await page.waitForFunction(() => window.londonBuses.modelCount > 0 && window.londonLayers.cars.renderedCount > 0);
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPitch()), 40);
  await page.screenshot({ path: 'test-results/all-layers.png' });

  // Disabling cameras closes the viewer and stops snapshot refreshes.
  await selectTab(page, 'explore');
  await page.locator('#toggle-cameras').uncheck();
  assert.equal(await page.locator('#cctv-viewer').isVisible(), false);
  assert.equal(await page.locator('.cctv-wrap').count(), 0);
  await selectTab(page, 'simulation');
  await page.locator('#toggle-cars').uncheck();
  await selectTab(page, 'explore');
  await page.locator('#toggle-traffic').uncheck();
  await selectTab(page, 'explore');
  await page.locator('#toggle-buses').uncheck();
  const paused = { ...calls };
  await page.evaluate(() => { window.londonBuses.map.jumpTo({ zoom: 14 }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1000);
  assert.deepEqual(calls, paused);
  assert.equal(await page.evaluate(() => window.londonLayers.cars.renderedCount), 0);
  await page.reload();
  await enterMap(page);
  await page.waitForFunction(() => window.londonLayers?.cameras);
  // A reload joins the same server-owned run.
  await selectTab(page, 'simulation');
  await page.locator('#toggle-cars').check();
  await page.waitForFunction(() => window.londonLayers.cars.renderedCount === 200 && window.londonLayers.cars.runId === 7);
  await selectTab(page, 'simulation');
  await page.locator('#toggle-cars').uncheck();
  for (const name of ['buses', 'cars', 'traffic', 'cameras']) assert.equal(await page.locator(`#toggle-${name}`).isChecked(), false);
  assert.deepEqual(calls, paused);
  await page.locator('#theme-toggle').click();
  await page.locator('#panel-minimize').click();
  await page.reload();
  await enterMap(page);
  await page.waitForFunction(() => window.londonLayers?.cameras && document.getElementById('loading-screen').hidden);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('#panel-content').isVisible(), false);
  assert.equal(await page.evaluate(() => window.londonBuses.map.getPaintProperty('background', 'background-color')), '#1b2632');
  await page.locator('#panel-minimize').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/layers-mobile.png' });
  // A failed map provider must not trap the user behind the loader.
  const offline = await context.newPage();
  await offline.emulateMedia({ reducedMotion: 'reduce' });
  await offline.route('https://api.maptiler.com/**', route => route.abort());
  await offline.goto(base);
  await enterMap(offline);
  await offline.waitForFunction(() => document.getElementById('loading-screen').hidden);
  const offlineExpanded = await offline.locator('#panel-minimize').getAttribute('aria-expanded');
  await offline.locator('#panel-minimize').click();
  assert.equal(await offline.locator('#panel-minimize').getAttribute('aria-expanded'), String(offlineExpanded !== 'true'));
  await offline.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS: independent overlays', calls, screenshots: 'test-results/' }));
} catch (error) {
  console.error(JSON.stringify({ errors, calls, state: page ? await page.evaluate(() => ({ carStatus: document.querySelector('#sim-connection')?.textContent, layers: window.londonLayers ? Object.keys(window.londonLayers) : [] })).catch(() => null) : null }));
  await page?.screenshot({ path: 'test-results/overlays-failure.png' }).catch(() => {});
  throw error;
} finally { clearInterval(simTimer); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
