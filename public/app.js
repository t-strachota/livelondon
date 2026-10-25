import { createInterface } from '/ui.js';
import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { BusMotionStore, pitchForZoom, toGeoJSON } from '/lib/motion.mjs';
import { createTraffic } from '/traffic.js';
import { createSimulatedCars } from '/sim-cars.js';
import { createCameras } from '/cameras.js';

const interfaceUI = createInterface();

maplibregl.setWorkerUrl('/vendor/maplibre-gl-worker.mjs');

const MAPTILER_KEY = 'Piqlzte12zD4i2H9jha1';
const SOURCE = 'maptiler_planet';
const HIDDEN_LAYERS = [
  'Public', 'Sport', 'Education', 'Tourism', 'Culture', 'Shopping', 'Food', 'Transport', 'Park', 'Healthcare', 'Station',
  'Major rail', 'Major rail hatching', 'Minor rail', 'Minor rail hatching', 'Railway tunnel', 'Railway tunnel hatching',
  'Ferry line', 'Ferry', 'Cablecar', 'Cablecar dash', 'Gondola', 'Airport', 'Airport gate',
  'Oneway', 'Housenumber', 'Highway junction', 'Highway shield', 'River labels', 'Ocean labels', 'Lake labels',
];
const statusElement = document.querySelector('#feed-status');
const countElement = document.querySelector('#bus-count');
const detailElement = document.querySelector('#feed-detail');
const stopDetailElement = document.querySelector('#stop-detail');
const hintElement = document.querySelector('#map-hint');
const busToggle = document.querySelector('#toggle-buses');
const busInfo = document.querySelector('#bus-info');
let busesEnabled = true;
try { busesEnabled = localStorage.getItem('london-map:buses') !== 'off'; } catch { /* Storage can be unavailable in private sessions. */ }
busToggle.checked = busesEnabled;
busInfo.hidden = !busesEnabled;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const store = new BusMotionStore();
let snapshot = null, requestFailed = false, modelsReady = false, modelLayer;
let dirty = true, dataDirty = true, wasMoving = false;
let renderedBuses = [], lastRender = 0, lastDots = 0, lastStatus = 0;
let popup, selectedBus = null, pollTimer, polling = false, pollController;
const overlayToggles = ['traffic', 'cars', 'cameras'].map(name => {
  const toggle = document.querySelector(`#toggle-${name}`);
  try { toggle.checked = localStorage.getItem(`london-map:${name}`) === 'on'; } catch { /* Default off. */ }
  toggle.addEventListener('change', () => { try { localStorage.setItem(`london-map:${name}`, toggle.checked ? 'on' : 'off'); } catch { /* Optional persistence. */ } });
  return toggle;
});
const layers = {};

const map = new maplibregl.Map({
  container: 'map',
  style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`,
  center: [-0.128, 51.507], zoom: 14, minZoom: 10, maxZoom: 20,
  maxBounds: [[-0.65, 51.24], [0.42, 51.74]],
  attributionControl: false,
  pitch: 0, maxPitch: 45, dragRotate: false, touchPitch: false, pitchWithRotate: false,
  canvasContextAttributes: { antialias: true },
});
interfaceUI.attach(map);
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'Traffic: TomTom · Cameras: TfL · Bus data: TfL / <a href="https://www.gov.uk/guidance/find-and-use-bus-open-data" target="_blank" rel="noopener">DfT BODS</a> · <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">OGL v3.0</a>',
}), 'bottom-right');

map.on('zoom', () => {
  const pitch = busesEnabled || layers.cars?.enabled ? pitchForZoom(map.getZoom()) : 0;
  if (Math.abs(map.getPitch() - pitch) > .01) map.setPitch(pitch);
});
map.on('move', () => { dirty = true; });

function updateBusVisibility() {
  for (const id of ['live-bus-dots', 'live-bus-hit', 'bus-stops', 'bus-stops-osm']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', busesEnabled ? 'visible' : 'none');
  }
  busInfo.hidden = !busesEnabled;
  if (!busesEnabled) modelLayer?.update([]);
  map.setPitch(busesEnabled ? pitchForZoom(map.getZoom()) : 0);
  dirty = true;
}

busToggle.addEventListener('change', () => {
  busesEnabled = busToggle.checked;
  try { localStorage.setItem('london-map:buses', busesEnabled ? 'on' : 'off'); } catch { /* The toggle still works without persistence. */ }
  clearTimeout(pollTimer);
  clearTimeout(stopTimer);
  if (!busesEnabled) {
    pollController?.abort();
    stopRequest?.abort();
    popup?.remove();
    selectedBus = null;
    store.states.clear();
    store.movingUntil = 0;
    renderedBuses = [];
    map.getSource('live-buses')?.setData(toGeoJSON([]));
    map.getCanvas().style.cursor = '';
  }
  updateBusVisibility();
  if (busesEnabled && map.getSource('live-buses')) { dataDirty = true; void poll(); void fetchStops(); }
});

function setDotOpacity() {
  if (!map.getLayer('live-bus-dots')) return;
  const ageOpacity = ['case', ['get', 'stale'], .35, 1];
  const opacity = modelsReady ? ['interpolate', ['linear'], ['zoom'], 16, ageOpacity, 17, 0] : ageOpacity;
  map.setPaintProperty('live-bus-dots', 'circle-opacity', opacity);
  map.setPaintProperty('live-bus-dots', 'circle-stroke-opacity', opacity);
}

function modelFailure() {
  modelsReady = false;
  setDotOpacity();
  hintElement.textContent = 'Live buses are shown as red dots. 3D rendering is unavailable in this browser.';
  dirty = true;
}

map.on('load', async () => {
  map.setProjection({ type: 'mercator' });
  for (const { id } of map.getStyle().layers) {
    if (HIDDEN_LAYERS.includes(id) || id.startsWith('Highway shield')) map.setLayoutProperty(id, 'visibility', 'none');
  }
  if (map.getLayer('Building 3D')) map.removeLayer('Building 3D');
  if (map.getLayer('Building')) {
    map.setLayerZoomRange('Building', 14, 24);
    map.setPaintProperty('Building', 'fill-color', '#ddd5c8');
    map.setPaintProperty('Building', 'fill-outline-color', '#c6bcac');
    map.setPaintProperty('Building', 'fill-opacity', 1);
  }
  const stopPaint = { 'circle-radius': 2.5, 'circle-color': '#727a72', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 };
  if (map.getSource(SOURCE)) map.addLayer({
    id: 'bus-stops', type: 'circle', source: SOURCE, 'source-layer': 'poi', minzoom: 15,
    filter: ['all', ['==', ['get', 'class'], 'bus'], ['==', ['get', 'subclass'], 'bus_stop']], paint: stopPaint,
  });
  map.addSource('overpass-bus', { type: 'geojson', data: toGeoJSON([]) });
  map.addLayer({ id: 'bus-stops-osm', type: 'circle', source: 'overpass-bus', minzoom: 15, paint: stopPaint });
  map.addSource('live-buses', { type: 'geojson', data: toGeoJSON([]) });
  map.addLayer({
    id: 'live-bus-dots', type: 'circle', source: 'live-buses',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 4], 'circle-color': '#d32f2f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 },
  });
  map.addLayer({
    id: 'live-bus-hit', type: 'circle', source: 'live-buses',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 16, 9, 18, 24, 20, 80], 'circle-opacity': 0, 'circle-pitch-alignment': 'viewport' },
  });
  setDotOpacity();
  try {
    const { BusLayer } = await import('/bus-layer.js');
    modelLayer = new BusLayer(map, modelFailure);
    map.addLayer(modelLayer);
    modelsReady = true;
    setDotOpacity();
  } catch { modelFailure(); }
  layers.traffic = createTraffic(map, overlayToggles[0]);
  layers.cars = createSimulatedCars(map, overlayToggles[1], document.getElementById('toggle-signals'));
  layers.cameras = createCameras(map, overlayToggles[2], document.querySelector('.panel'));
  updateBusVisibility();
  dirty = true;
  void poll();
  requestAnimationFrame(frame);
});

function updateStatus(now) {
  const allStale = renderedBuses.length > 0 && renderedBuses.every(bus => bus.stale);
  const age = snapshot?.fetchedAt ? Math.max(0, Math.floor((now - Date.parse(snapshot.fetchedAt)) / 1000)) : null;
  const state = snapshot?.status === 'unconfigured' ? 'unconfigured'
    : !snapshot?.fetchedAt ? (requestFailed || snapshot ? 'unavailable' : 'loading')
    : requestFailed || snapshot.status !== 'live' || allStale || age >= 60 ? 'stale' : 'live';
  statusElement.dataset.status = state;
  statusElement.textContent = ({ loading: 'Connecting to live buses', live: 'Live bus locations', stale: 'Waiting for fresh locations', unavailable: 'Live feed unavailable', unconfigured: 'Live feed not configured' })[state];
  countElement.textContent = `${renderedBuses.length.toLocaleString()} ${renderedBuses.length === 1 ? 'bus' : 'buses'} reporting`;
  detailElement.textContent = state === 'unconfigured' ? 'Set BODS_API_KEY in your local .env file to connect.'
    : age === null ? 'Waiting for GPS data from TfL via BODS.'
    : `Feed checked ${age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} ago · 15s smoothing`;
  stopDetailElement.textContent = ({ loading: 'Loading route-specific stop data…', refreshing: 'Refreshing route-specific stop data…', partial: 'Route stop data partially loaded.', unavailable: 'Route stop matching is temporarily unavailable.', ready: 'Route-specific stop holding active.' })[snapshot?.stopDataStatus] ?? '';
}

async function poll() {
  clearTimeout(pollTimer);
  if (document.hidden || !busesEnabled || polling) return;
  polling = true;
  const controller = new AbortController();
  pollController = controller;
  const startedAt = Date.now();
  try {
    const response = await fetch('/api/buses', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
    const incoming = await response.json();
    if (!busesEnabled || controller.signal.aborted) return;
    if (!Array.isArray(incoming.buses) || !['live', 'stale', 'unavailable', 'unconfigured'].includes(incoming.status)) throw new Error('Invalid feed response');
    snapshot = incoming;
    requestFailed = !response.ok && incoming.status !== 'unconfigured';
    store.ingest(incoming.buses, Date.now(), { animate: !reducedMotion.matches });
  } catch { if (!controller.signal.aborted) requestFailed = true; }
  finally {
    polling = false;
    dirty = true;
    dataDirty = true;
    if (!document.hidden && busesEnabled) pollTimer = setTimeout(poll, controller.signal.aborted ? 0 : Math.max(0, 15_000 - (Date.now() - startedAt)));
  }
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(pollTimer);
  if (!document.hidden && busesEnabled && map.getSource('live-buses')) { dirty = true; void poll(); }
});

function frame() {
  if (!busesEnabled) { requestAnimationFrame(frame); return; }
  const now = Date.now(), moving = store.movingUntil > now;
  if (!document.hidden && (((dirty || moving || wasMoving) && now - lastRender >= 32) || now - lastRender >= 1000)) {
    renderedBuses = store.sample(now);
    if (modelsReady) modelLayer.update(renderedBuses);
    // Panning only changes the camera; do not re-send thousands of unchanged points.
    if (dataDirty || (moving && now - lastDots >= 100) || (wasMoving && !moving) || now - lastDots >= 1000) {
      map.getSource('live-buses').setData(toGeoJSON(renderedBuses));
      lastDots = now;
      dataDirty = false;
    }
    if (now - lastStatus >= 1000 || dirty) { updateStatus(now); lastStatus = now; }
    if (selectedBus && popup?.isOpen()) {
      const bus = renderedBuses.find(bus => bus.id === selectedBus);
      if (bus) {
        popup.setLngLat([bus.longitude, bus.latitude]);
        updatePopup(popup.getElement().querySelector('.bus-popup'), bus);
      }
      else { popup.remove(); selectedBus = null; }
    }
    dirty = false;
    wasMoving = moving;
    lastRender = now;
  }
  requestAnimationFrame(frame);
}

function busAt(point) {
  if (!busesEnabled) return null;
  if (!map.getLayer('live-bus-hit')) return null;
  const hits = map.queryRenderedFeatures(point, { layers: ['live-bus-hit'] });
  const ids = new Set(hits.map(feature => feature.properties.id));
  let closest = null, closestDistance = Infinity;
  for (const bus of renderedBuses) {
    if (!ids.has(bus.id)) continue;
    const screen = map.project([bus.longitude, bus.latitude]);
    const d = Math.hypot(screen.x - point.x, screen.y - point.y);
    if (d < closestDistance) { closest = bus; closestDistance = d; }
  }
  return closest;
}

function updatePopup(content, bus) {
  if (!content) return;
  content.querySelector('strong').textContent = bus.route ? `Bus ${bus.route}` : 'TfL bus';
  content.querySelector('[data-destination]').textContent = bus.destination ? `Towards ${bus.destination}` : 'Destination unavailable';
  content.querySelector('small').textContent = `GPS update: ${new Date(bus.recordedAt).toLocaleTimeString()}${bus.stale ? ' · delayed' : ''}`;
  content.querySelector('[data-motion]').textContent = bus.holdingAtStop ? `Waiting at ${bus.heldStop.name}`
    : bus.heldStop ? `Approaching ${bus.heldStop.name}` : bus.moving ? 'Moving between GPS updates' : 'At latest confirmed position';
}

map.on('click', event => {
  if (map.getLayer('cctv-dots') && map.queryRenderedFeatures(event.point, { layers: ['cctv-dots'] }).length) return;
  if (!busesEnabled) return;
  const bus = busAt(event.point);
  popup?.remove();
  selectedBus = bus?.id ?? null;
  if (bus) {
    const content = document.createElement('div');
    content.className = 'bus-popup';
    const title = document.createElement('strong');
    title.textContent = bus.route ? `Bus ${bus.route}` : 'TfL bus';
    const destination = document.createElement('div');
    destination.dataset.destination = '';
    destination.textContent = bus.destination ? `Towards ${bus.destination}` : 'Destination unavailable';
    const vehicle = document.createElement('div');
    vehicle.textContent = `Vehicle ${bus.vehicle}`;
    const time = document.createElement('small');
    time.textContent = `GPS update: ${new Date(bus.recordedAt).toLocaleTimeString()}${bus.stale ? ' · delayed' : ''}`;
    const motion = document.createElement('div');
    motion.dataset.motion = '';
    content.append(title, destination, vehicle, motion, time);
    updatePopup(content, bus);
    popup = new maplibregl.Popup().setLngLat([bus.longitude, bus.latitude]).setDOMContent(content).addTo(map);
  } else {
    const layers = ['bus-stops', 'bus-stops-osm'].filter(id => map.getLayer(id));
    const stop = layers.length ? map.queryRenderedFeatures(event.point, { layers })[0] : null;
    if (stop) popup = new maplibregl.Popup().setLngLat(stop.geometry.coordinates).setText(stop.properties.name || 'Bus stop').addTo(map);
  }
});
map.on('mousemove', event => { map.getCanvas().style.cursor = busAt(event.point) ? 'pointer' : ''; });

// Stop queries follow viewport changes, independently of live vehicle animation.
const fetchedViews = new Set(), osmStops = new Map();
let stopTimer, stopRequest;
async function fetchStops() {
  if (!busesEnabled || map.getZoom() < 15 || !map.getSource('overpass-bus')) return;
  if (map.getLayer('bus-stops') && map.queryRenderedFeatures({ layers: ['bus-stops'] }).length) return;
  const b = map.getBounds();
  const key = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(value => value.toFixed(3)).join(',');
  if (fetchedViews.has(key)) return;
  stopRequest?.abort();
  stopRequest = new AbortController();
  fetchedViews.add(key);
  try {
    const query = `[out:json][timeout:25];node[highway=bus_stop](${key});out;`;
    const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: stopRequest.signal });
    if (!response.ok) throw new Error('Stop data unavailable');
    for (const node of (await response.json()).elements) osmStops.set(node.id, { type: 'Feature', geometry: { type: 'Point', coordinates: [node.lon, node.lat] }, properties: { name: node.tags?.name } });
    map.getSource('overpass-bus').setData({ type: 'FeatureCollection', features: [...osmStops.values()] });
    if (fetchedViews.size > 100) fetchedViews.delete(fetchedViews.values().next().value);
  } catch { fetchedViews.delete(key); }
}
map.on('moveend', () => { clearTimeout(stopTimer); stopTimer = setTimeout(fetchStops, 500); });
map.on('load', () => { stopTimer = setTimeout(fetchStops, 500); });

// Read-only state for browser checks and map debugging.
window.londonBuses = { map, get enabled() { return busesEnabled; }, get buses() { return renderedBuses; }, get modelsReady() { return modelsReady; }, get modelCount() { return modelLayer?.meshes?.[0]?.count ?? 0; } };
window.londonLayers = layers;
