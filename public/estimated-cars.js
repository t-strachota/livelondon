import { TOMTOM_KEY } from '/config.js';
import { FlowClient, extractRoads, estimateTraffic, metres } from '/lib/traffic.mjs';

const empty = () => ({ type: 'FeatureCollection', features: [] });

// Draws simulation snapshots only: vehicles are keyed by id, and nothing here creates, resets or moves them.
export function createCarRenderer(map) {
  const features = new Map();
  const data = () => ({ type: 'FeatureCollection', features: [...features.values()] });
  return {
    renderSnapshot(snapshot) {
      const seen = new Set();
      for (const { id, type, weight, speed, heading, position } of snapshot) {
        seen.add(id);
        const feature = features.get(id);
        if (feature) { feature.geometry.coordinates = position; Object.assign(feature.properties, { speed, heading }); }
        else features.set(id, { type: 'Feature', geometry: { type: 'Point', coordinates: position }, properties: { id, type, weight, speed, heading, estimated: true, kind: 'estimated-car' } });
      }
      for (const id of features.keys()) if (!seen.has(id)) features.delete(id);
      map.getSource('estimated-cars')?.setData(data());
    },
    clear() { features.clear(); map.getSource('estimated-cars')?.setData(empty()); },
    get data() { return data(); },
    get count() { return features.size; },
  };
}

// sim: { dt, step(), snapshot(), setTraffic?(estimate) } (Person A's core, or the fixture in /sim-fixture.js).
// Created once by the caller; map moves, style reloads and traffic refreshes only feed it new inputs.
export function createEstimatedCars(map, toggle, sim) {
  const info = document.querySelector('#car-info'), summary = document.querySelector('#car-summary');
  const details = document.querySelector('#car-details');
  let storage;
  try { storage = localStorage; } catch { /* No persistence available. */ }
  const client = new FlowClient({ key: TOMTOM_KEY, storage });
  const renderer = createCarRenderer(map);
  let enabled = false, model = null, controller, generation = 0, refreshTimer, periodicTimer, animation;
  let lastFrame = 0, lastPaint = 0, pending = 0, modelPromise;

  function addLayers() {
    if (!map.getSource('estimated-cars')) map.addSource('estimated-cars', { type: 'geojson', data: enabled ? renderer.data : empty(), promoteId: 'id' });
    if (!map.getLayer('estimated-cars')) map.addLayer({
      id: 'estimated-cars', type: 'circle', source: 'estimated-cars',
      layout: { visibility: enabled ? 'visible' : 'none' },
      paint: { 'circle-color': '#000000', 'circle-opacity': 1, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 3], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': .5, 'circle-pitch-alignment': 'viewport', 'circle-pitch-scale': 'viewport' },
    }, map.getLayer('live-bus-dots') ? 'live-bus-dots' : undefined);
  }
  addLayers();

  async function refresh(tries = 0) {
    clearTimeout(refreshTimer);
    if (!enabled || document.hidden) return;
    if (!map.areTilesLoaded() && tries < 10) { refreshTimer = setTimeout(() => refresh(tries + 1), 300); return; }
    const id = ++generation;
    controller?.abort();
    controller = new AbortController();
    const roadLayers = map.getStyle().layers.filter(layer => layer['source-layer'] === 'transportation' && layer.type === 'line').map(layer => layer.id);
    const b = map.getBounds();
    const roads = extractRoads(roadLayers.length ? map.queryRenderedFeatures({ layers: roadLayers }) : [], [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    if (!roads.length) { summary.textContent = 'No mapped roads in this view'; return; }
    const c = map.getCenter(), points = [[c.lng, c.lat]];
    for (const road of roads.filter(road => ['motorway', 'trunk', 'primary', 'secondary'].includes(road.cls)).sort((a, b) => b.m - a.m)) {
      if (points.length >= 9) break;
      const point = road.line[road.line.length >> 1];
      if (points.every(other => metres(point, other) > 300)) points.push(point);
    }
    const samples = (await Promise.all(points.map(async point => {
      const sample = await client.flowAt(point[1], point[0], controller.signal);
      return sample ? { ...sample, p: point } : null;
    }))).filter(Boolean);
    if (!enabled || id !== generation) return;
    const estimate = estimateTraffic(roads, samples, model);
    if (!estimate) { summary.textContent = 'Traffic estimates unavailable · retry after moving the map'; return; }
    sim.setTraffic?.(estimate);
    summary.textContent = `${Math.round(estimate.total).toLocaleString()} estimated road vehicles in view`;
    const stale = samples.some(sample => sample.stale);
    details.textContent = `${sim.snapshot().length} illustrative black dots · speed ratio ${estimate.ratio.toFixed(2)} from ${samples.length} sample(s)${stale ? ' · cached speeds' : ''}. Predicted flow: ${estimate.flow == null ? 'unavailable' : Math.round(estimate.flow) + ' veh/h/lane'}. Model MAE: ${model?.metrics?.mae ?? 'unavailable'} veh/h/lane. Speed-data calls: ${client.calls.n}/2,000 today.`;
  }

  function refreshSoon() {
    if (!enabled) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 400);
  }
  // The one loop: advance the sim on its fixed timestep, then hand the snapshot to the renderer (at most 10 paints/s)
  function frame(time) {
    if (!enabled || document.hidden) { lastFrame = 0; animation = undefined; return; }
    pending += lastFrame ? Math.min(1, (time - lastFrame) / 1000) : 0; // cap catch-up after a stalled tab
    lastFrame = time;
    const dt = sim.dt ?? .1;
    for (; pending >= dt; pending -= dt) sim.step();
    if (time - lastPaint >= 100) { renderer.renderSnapshot(sim.snapshot()); lastPaint = time; }
    animation = requestAnimationFrame(frame);
  }
  function animate() { if (animation === undefined && enabled && !document.hidden) animation = requestAnimationFrame(frame); }
  function loadModel() {
    if (!modelPromise) modelPromise = fetch('/flow_table.json').then(response => response.ok ? response.json() : null).then(value => { model = value; refreshSoon(); }).catch(() => {});
  }
  function update() {
    enabled = toggle.checked;
    info.hidden = !enabled;
    generation++;
    controller?.abort();
    clearTimeout(refreshTimer); clearInterval(periodicTimer);
    map.setLayoutProperty('estimated-cars', 'visibility', enabled ? 'visible' : 'none');
    if (enabled) { summary.textContent = 'Loading traffic estimates…'; loadModel(); refreshSoon(); animate(); periodicTimer = setInterval(refreshSoon, 180_000); }
    else { renderer.clear(); cancelAnimationFrame(animation); animation = undefined; lastFrame = 0; }
  }
  toggle.addEventListener('change', update);
  map.on('moveend', refreshSoon);
  map.on('style.load', () => { addLayers(); if (enabled) refreshSoon(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { controller?.abort(); generation++; clearTimeout(refreshTimer); }
    else if (enabled) { refreshSoon(); animate(); }
  });
  update();
  return { sim, refresh: () => refresh(), get enabled() { return enabled; }, get count() { return renderer.count; } };
}
