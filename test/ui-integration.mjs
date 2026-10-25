import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApp } from '../server.mjs';
import { makeBuses } from './fixtures.mjs';
import { enterMap, selectTab } from './ui-helpers.mjs';

// Exercise the integrated UI through real Node routes, with deterministic transport observations.
const calls = [], empty = { type: 'FeatureCollection', features: [] };
const state = { lifecycle: 'running', runId: 19, pausedForEveryone: false, population: { actual: 30000, target: 30000, capacity: 90000 }, simTime: 120,
  averageSpeedMps: 8, observation: { status: 'live', observedAt: new Date().toISOString(), matchedShare: .6 },
  performance: { stepMs: 10, encodeMs: 1, realtimeFactor: 18 }, health: { gridlocked: 0 }, job: { state: 'idle' }, closures: [], rerouted: 0,
  personalities: { aggressive: 6000, neutral: 18000, calm: 4500, 'error-prone': 1500 },
  clock: { mode: 'live', londonTime: '12:00', target: 30000 } };
const simulation = Object.assign(new EventEmitter(), { snapshot: null, signalPositions: [], getStatus: () => structuredClone(state) });
simulation.setClock = body => {
  calls.push({ path: 'clock', body }); state.clock = { mode: body.mode, londonTime: '12:00', target: 30000,
    simulating: body.mode === 'custom' ? { time: `${String(Math.floor(body.minutes / 60)).padStart(2, '0')}:${String(body.minutes % 60).padStart(2, '0')}`, weekend: body.weekend, demand: body.demand } : null };
  simulation.emit('status', simulation.getStatus()); return simulation.getStatus();
};
simulation.reinitialize = body => { calls.push({ path: 'reinitialize', body }); return { state: 'succeeded', runId: 19, finishedAt: new Date().toISOString() }; };
simulation.closure = async body => { calls.push({ path: 'closure', body }); state.closures = body.action === 'close' ? [{ id: 1, name: 'Fixture Road' }] : []; simulation.emit('status', simulation.getStatus()); return state.closures; };
simulation.setPaused = value => { calls.push({ path: 'pause', body: value }); state.pausedForEveryone = value; simulation.emit('status', simulation.getStatus()); return true; };
const lines = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { line: 'central', string: 0, name: 'Central', color: '#e32017', underground: true, cars: 1 }, geometry: { type: 'LineString', coordinates: [[-.14, 51.507], [-.12, 51.507]] } }] };
const trains = { linesGeoJSON: lines, getSnapshot: () => ({ status: 'live', fetchedAt: new Date().toISOString(), notice: 'Fixture arrival estimates', trains: [{ id: 'central-1', line: 'central', string: 0, dir: 1, distance: 650, limit: 1200, speed: 2, age: 0, nextStation: 'Test Station', destination: 'Test Terminus', timeToStation: 100 }] }) };
let stopped = [];
const economics = { active: true, total: 125, perHour: 50, roadCost: 25, servicesCost: 100, delayVehicleHours: 1.5, startedAt: new Date().toISOString() };
const session = { id: 1, startedAt: '2026-01-01T12:00:00Z', endedAt: '2026-01-01T12:10:00Z', closed: [{ kind: 'road', label: 'Fixture Road' }], total: 125, roadCost: 25, servicesCost: 100, delayVehicleHours: 1.5, peakPeople: 120, peakExtraCars: 12, mostAffected: [{ name: 'Nearby Road', slowerPercent: 20 }] };
const stopControl = { applyToBuses: buses => buses,
  summary: () => ({ items: stopped, people: stopped.length * 100, extraCars: 10, extraCarsTarget: 12, stoppedLines: stopped.filter(item => item.kind === 'line').map(item => item.line), economics, historyCount: 1, mostAffected: [{ name: 'Nearby Road', slowerPercent: 20, extraQueue: 3 }] }),
  history: { list: () => ({ current: null, sessions: [session] }) },
  act: async body => { calls.push({ path: 'stops', body }); if (body.action === 'reopen') stopped = []; else stopped = [{ key: body.action === 'stop-line' ? `line:${body.line}` : `bus:${body.id}`, kind: body.action === 'stop-line' ? 'line' : 'bus', line: body.line, label: body.line ? 'Central line' : 'Bus 10', vehicles: 1 }]; return stopControl.summary(); } };
const server = createApp({ simulation, trains, crowding: { geojson: { type: 'FeatureCollection', features: lines.features.map(feature => ({ ...feature, properties: { ...feature.properties, busyness: .7 } })) } }, stopControl,
  feed: { getSnapshot: async () => ({ status: 'live', configured: true, fetchedAt: new Date().toISOString(), buses: makeBuses(1) }) } });
server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const prefs = { buses: 'on', cars: 'off', hotspots: 'off', traffic: 'off', cameras: 'off', trains: 'on', 'train-lines': 'on', 'train-busyness': 'on', personality: 'on' };
  await context.addInitScript(values => { if (!sessionStorage.seeded) { for (const [key, value] of Object.entries(values)) localStorage.setItem(`london-map:${key}`, value); localStorage.setItem('london-map:theme', 'light'); sessionStorage.seeded = 'yes'; } }, prefs);
  await context.route('https://api.maptiler.com/**', route => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0eb' } }] } }));
  await context.route('https://overpass-api.de/**', route => route.fulfill({ json: { elements: [] } }));
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.waitForFunction(() => window.londonLayers?.performance && window.londonBuses.buses.length === 1);
  assert.equal(await page.locator('#project-intro').isVisible(), true); await enterMap(page);
  async function requestAfter(path, action) { const response = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'POST'); await action(); await (await response).finished(); }
  const saved = () => page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(`london-map:${key}`)])), Object.keys(prefs));
  assert.deepEqual(await saved(), prefs); assert.deepEqual(calls, []);
  for (const tab of ['explore', 'simulation', 'statistics', 'performance']) { await selectTab(page, tab); assert.equal(await page.locator(tab === 'performance' ? '#tab-performance' : `#section-${tab}`).isVisible(), true); }
  await selectTab(page, 'explore'); await page.waitForFunction(() => window.londonLayers.trains.trains.length === 1);
  assert.equal(await page.locator('#toggle-train-busyness').isChecked(), true);
  await page.waitForFunction(() => !!window.londonBuses.map.getLayer('train-busyness'));
  const originalRailPaint = await page.evaluate(() => window.londonBuses.map.getPaintProperty('train-lines', 'line-color'));
  assert.match(JSON.stringify(originalRailPaint), /color/);
  await page.locator('#theme-toggle').click(); assert.deepEqual(await page.evaluate(() => window.londonBuses.map.getPaintProperty('train-lines', 'line-color')), originalRailPaint);
  await page.locator('#theme-toggle').click();
  await page.locator('#closure-details-toggle').click(); if (!await page.locator('#closure-body').isVisible()) await page.locator('#closure-details-toggle').click();
  await page.waitForSelector('#economics'); assert.equal(await page.locator('#econ-total').textContent(), '£125'); await page.locator('#history > summary').click();
  await page.waitForFunction(() => document.getElementById('history-list').textContent.includes('£125')); await page.locator('#history-list details summary').click(); assert.match(await page.locator('#history-list').textContent(), /Fixture Road/);
  await page.locator('#closure-body').evaluate(el => { el.style.height = '300px'; });
  await page.waitForFunction(() => Number(localStorage.getItem('london-map:closure-height')) > 0);
  const closureHeight = await page.evaluate(() => localStorage.getItem('london-map:closure-height'));
  await page.locator('#closure-details-toggle').click();
  await page.waitForFunction(() => document.getElementById('closure-body').offsetHeight === 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('london-map:closure-height')), closureHeight);
  await page.locator('#closure-details-toggle').click();
  await selectTab(page, 'simulation'); assert.equal(await page.locator('#clock-line').textContent(), 'London time: 12:00 (live)');
  await requestAfter('/api/simulation/clock', () => page.locator('#clock-custom').click()); await page.waitForSelector('#clock-controls'); assert.equal(calls.at(-1).body.mode, 'custom');
  await page.locator('#clock-time').evaluate(el => { el.value = '600'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.getElementById('clock-line').textContent.includes('10:00'));
  await requestAfter('/api/simulation/clock', () => page.locator('#clock-weekend').check()); assert.equal(calls.at(-1).body.weekend, true);
  await page.locator('#clock-demand').evaluate(el => { el.value = '1.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.getElementById('clock-line').textContent.includes('1.5×'));
  await requestAfter('/api/simulation/clock', () => page.locator('#clock-back').click()); await page.waitForFunction(() => document.getElementById('clock-live').getAttribute('aria-pressed') === 'true');
  await requestAfter('/api/simulation/reinitialize', () => page.locator('#sim-reinit').click()); assert.equal(calls.at(-1).path, 'reinitialize'); assert.equal(calls.at(-1).body.population, undefined);
  await page.waitForFunction(() => !document.getElementById('sim-reinit').disabled);
  await page.locator('#sim-population').evaluate(el => { el.value = '35000'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await requestAfter('/api/simulation/reinitialize', () => page.locator('#sim-reinit').click()); assert.equal(calls.at(-1).body.population, 35000);
  const beforePerformance = calls.length; await selectTab(page, 'performance'); await page.getByRole('radio', { name: /^Low/ }).check(); assert.equal(await page.locator('#perf-models').isChecked(), false); assert.equal(calls.length, beforePerformance);
  await page.locator('#perf-population-link').click(); assert.equal(await page.locator('#section-simulation').isVisible(), true); assert.equal(await page.evaluate(() => document.activeElement.id), 'sim-population');
  // Replay must preserve all current layers and the custom browser performance setting.
  const beforeReplay = await saved(), beforeReplayCalls = calls.length;
  await page.locator('#intro-replay').click(); await page.locator('#intro-next').click(); await page.locator('#intro-enter').click(); await page.waitForSelector('#loading-screen', { state: 'hidden' });
  assert.deepEqual(await saved(), beforeReplay); assert.equal(calls.length, beforeReplayCalls); await selectTab(page, 'performance'); assert.equal(await page.locator('#perf-models').isChecked(), false);
  await page.reload(); await enterMap(page); assert.deepEqual(await saved(), beforeReplay); assert.equal(await page.locator('#tab-performance').isVisible(), true);
  const mapPoint = await page.evaluate(() => { const p = window.londonBuses.map.project([-.128, 51.507]); return { x: p.x, y: p.y }; });
  await page.waitForFunction(() => window.londonLayers?.stopTools);
  await page.locator('#stop-line-mode').click(); assert.equal(await page.evaluate(() => window.londonLayers.stopTools.tool), 'train'); await page.mouse.click(mapPoint.x, mapPoint.y);
  await page.waitForFunction(() => document.getElementById('stopped-summary').textContent.includes('1 train line'));
  assert.ok(calls.some(call => call.path === 'stops' && call.body.action === 'stop-line' && call.body.line === 'central'));
  await page.locator('#stop-bus-mode').click(); assert.equal(await page.evaluate(() => window.londonLayers.stopTools.tool), 'bus'); await page.mouse.click(mapPoint.x, mapPoint.y); await page.waitForSelector('.bus-popup');
  assert.ok(calls.some(call => call.path === 'stops' && call.body.action === 'stop-bus'));
  await page.locator('#closure-mode').click(); assert.equal(await page.evaluate(() => window.londonLayers.stopTools.tool), 'road'); await page.mouse.click(mapPoint.x, mapPoint.y);
  await page.waitForFunction(() => document.getElementById('sim-closure-list').textContent.includes('Fixture Road')); assert.ok(calls.some(call => call.path === 'closure' && call.body.action === 'close'));
  await page.locator('#exit-focus').click(); assert.equal(await page.evaluate(() => window.londonLayers.stopTools.tool), null);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/integrated-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await selectTab(page, 'performance'); await page.screenshot({ path: 'test-results/integrated-mobile.png' });
  assert.deepEqual(errors, []); console.log('PASS: main features under UX2 UI; trains/crowding; live/custom London clock; manual demand; road/train/bus stops and focus; economics/history; four tabs and Performance; onboarding replay/reload preserves layers and performance settings; mobile bounds.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
