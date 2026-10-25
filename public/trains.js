import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { modelOpacity } from '/lib/motion.mjs';

// Live trains (Tube, Overground, Elizabeth line) at positions the server estimates from TfL arrival
// predictions. Between polls each train runs on along its own line string at its estimated speed, never
// past its next station; a new estimate is eased in over EASE_MS instead of jumping.
const POLL_MS = 15_000, EASE_MS = 4_000, FRAME_MS = 33;
const empty = { type: 'FeatureCollection', features: [] };

// Map marker image: a filled 'diamond' or 'square' with a white edge (16 px at icon-size 1).
export function addShapeIcon(map, id, shape, fill) {
  if (map.hasImage(id)) return;
  const size = 32, m = size / 2, r = m - 3, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.beginPath();
  if (shape === 'diamond') { g.moveTo(m, m - r); g.lineTo(m + r, m); g.lineTo(m, m + r); g.lineTo(m - r, m); g.closePath(); }
  else g.rect(m - r * .8, m - r * .8, r * 1.6, r * 1.6);
  g.fillStyle = fill; g.fill();
  g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
  map.addImage(id, g.getImageData(0, 0, size, size), { pixelRatio: 2 });
}

export function createTrains(map, trainToggle, lineToggle, statusLine) {
  const pref = (name, fallback) => { try { const v = localStorage.getItem(`london-map:${name}`); return v ? v === 'on' : fallback; } catch { return fallback; } };
  const save = (name, on) => { try { localStorage.setItem(`london-map:${name}`, on ? 'on' : 'off'); } catch { /* Optional persistence. */ } };
  trainToggle.checked = pref('trains', false);
  lineToggle.checked = pref('train-lines', true);
  let lines = null, strings = new Map(), info = new Map(), states = new Map(), snapshot = null, failed = false;
  let pollTimer, lastFrame = 0, popup, selected = null, surface = null, tube = null, carLength = 17, frameRequested = false;

  import('/bus-layer.js').then(({ BusLayer, makeTrainCar, TRAIN_CAR_LENGTH }) => {
    carLength = TRAIN_CAR_LENGTH;
    surface = new BusLayer(map, () => { surface = null; }, { id: 'train-models', makeParts: makeTrainCar });
    tube = new BusLayer(map, () => { tube = null; }, { id: 'tube-models', makeParts: makeTrainCar, alpha: .45 }); // underground
    addLayers();
  }).catch(() => {});

  function addLayers() {
    if (!lines) return;
    const before = map.getLayer('live-bus-dots') ? 'live-bus-dots' : undefined;
    if (!map.getSource('train-lines')) map.addSource('train-lines', { type: 'geojson', data: lines });
    if (!map.getLayer('train-lines')) map.addLayer({ id: 'train-lines', type: 'line', source: 'train-lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2, 17, 3.5], 'line-opacity': ['case', ['get', 'underground'], .5, .85] } }, before);
    if (!map.getSource('trains')) map.addSource('trains', { type: 'geojson', data: empty });
    const fade = value => surface ? ['interpolate', ['linear'], ['zoom'], 16, value, 17, 0] : value;
    for (const [line, { color }] of info) addShapeIcon(map, `train-${line}`, 'diamond', color);
    if (!map.getLayer('train-dots')) map.addLayer({ id: 'train-dots', type: 'symbol', source: 'trains',
      layout: { 'icon-image': ['concat', 'train-', ['get', 'line']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, .55, 16, .9], 'icon-allow-overlap': true, 'icon-ignore-placement': true } }, before);
    map.setPaintProperty('train-dots', 'icon-opacity', fade(['case', ['get', 'underground'], .75, 1]));
    if (!map.getLayer('train-hit')) map.addLayer({ id: 'train-hit', type: 'circle', source: 'trains',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 12, 18, 40], 'circle-opacity': 0, 'circle-pitch-alignment': 'viewport' } }, before);
    for (const layer of [tube, surface]) if (layer && !map.getLayer(layer.id)) map.addLayer(layer);
    updateVisibility();
  }

  function updateVisibility() {
    const show = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
    show('train-lines', lineToggle.checked);
    for (const id of ['train-dots', 'train-hit']) show(id, trainToggle.checked);
    if (!trainToggle.checked) { surface?.update([]); tube?.update([]); popup?.remove(); }
  }

  async function loadLines() {
    try {
      const response = await fetch('/api/trains/lines');
      if (!response.ok) throw new Error('Train lines unavailable');
      lines = await response.json();
      for (const { properties: p, geometry } of lines.features) {
        const coords = geometry.coordinates, cum = [0];
        for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + metres(coords[k - 1], coords[k]));
        strings.set(`${p.line}:${p.string}`, { coords, cum });
        info.set(p.line, p);
      }
      addLayers();
      void poll(); // trains need their line strings before they can be placed
    } catch { setTimeout(loadLines, 30_000); }
  }

  async function poll() {
    clearTimeout(pollTimer);
    if (!trainToggle.checked || document.hidden) return;
    try {
      const response = await fetch('/api/trains', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const incoming = await response.json();
      if (!Array.isArray(incoming.trains)) throw new Error('Invalid train response');
      ingest(incoming);
      failed = !response.ok;
    } catch { failed = true; }
    updateStatus();
    pollTimer = setTimeout(poll, POLL_MS);
  }

  function ingest(incoming) {
    const now = performance.now(), next = new Map();
    for (const train of incoming.trains) {
      if (!strings.has(`${train.line}:${train.string}`)) continue;
      // Where the estimate says it is now (it was made `age` seconds ago), never past its next station.
      const base = train.distance + train.dir * Math.min(Math.abs(train.limit - train.distance), train.speed * train.age);
      const state = { train, base, t0: now, offset: 0, offsetAt: now };
      const old = states.get(train.id);
      if (old && old.train.line === train.line && old.train.string === train.string) {
        const offset = position(old, now) - base;
        if (Math.abs(offset) < 2000) state.offset = offset; // ease from where it is drawn; a big change snaps
      }
      next.set(train.id, state);
    }
    states = next;
    snapshot = incoming;
    if (!frameRequested) { frameRequested = true; requestAnimationFrame(frame); }
  }

  function position(state, now) {
    const { train, base, t0, offset, offsetAt } = state;
    const d = base + train.dir * Math.min(Math.abs(train.limit - base), train.speed * (now - t0) / 1000);
    const left = Math.max(0, 1 - (now - offsetAt) / EASE_MS);
    return d + offset * left * left * (3 - 2 * left); // smoothstep fade of the correction
  }

  // [lon, lat, bearing] at distance d along a string, facing the direction of travel.
  function pointAt(string, d, dir) {
    const { coords, cum } = string, length = cum.at(-1);
    d = Math.max(0, Math.min(length, d));
    let lo = 1, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
    const a = coords[lo - 1], b = coords[lo], t = (d - cum[lo - 1]) / (cum[lo] - cum[lo - 1] || 1);
    const bearing = (Math.atan2((b[0] - a[0]) * Math.cos(51.5 * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + (dir < 0 ? 540 : 360)) % 360;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, bearing];
  }

  function frame() {
    frameRequested = false;
    if (!trainToggle.checked) return;
    frameRequested = true;
    requestAnimationFrame(frame);
    const now = performance.now();
    if (now - lastFrame < FRAME_MS || document.hidden) return;
    lastFrame = now;
    const features = [], models = modelOpacity(map.getZoom()) > 0, above = [], below = [];
    for (const state of states.values()) {
      const { train } = state, string = strings.get(`${train.line}:${train.string}`), line = info.get(train.line);
      const d = position(state, now), [lon, lat] = pointAt(string, d, train.dir);
      state.lngLat = [lon, lat];
      features.push({ type: 'Feature', properties: { id: train.id, line: train.line, underground: line.underground }, geometry: { type: 'Point', coordinates: [lon, lat] } });
      if (!models) continue;
      for (let k = 0; k < line.cars; k++) { // carriages follow the track behind the front one
        const [longitude, latitude, bearing] = pointAt(string, d - train.dir * k * carLength, train.dir);
        (line.underground ? below : above).push({ longitude, latitude, bearing, color: line.color });
      }
    }
    map.getSource('trains')?.setData({ type: 'FeatureCollection', features });
    surface?.update(above);
    tube?.update(below);
    if (selected && popup?.isOpen()) {
      const state = states.get(selected);
      if (state?.lngLat) { popup.setLngLat(state.lngLat); fillPopup(popup.getElement().querySelector('.bus-popup'), state); }
    }
  }

  function updateStatus() {
    if (!statusLine) return;
    statusLine.hidden = !trainToggle.checked;
    statusLine.textContent = !snapshot ? (failed ? 'Train data unavailable' : 'Loading trains…')
      : `${states.size.toLocaleString()} trains · ${snapshot.notice}${failed || snapshot.status === 'stale' ? ' · waiting for fresh data' : ''}`;
  }

  function fillPopup(content, state) {
    const { train } = state, line = info.get(train.line);
    const due = Math.max(0, Math.round(train.timeToStation - train.age - (performance.now() - state.t0) / 1000));
    content.querySelector('strong').textContent = train.line === 'dlr' ? 'DLR' : `${line.name} line`;
    content.querySelector('[data-destination]').textContent = train.destination ? `To ${train.destination}` : 'Destination unavailable';
    content.querySelector('[data-next]').textContent = `Next: ${train.nextStation} · ${due < 30 ? 'due now' : `in ${Math.floor(due / 60)}:${String(due % 60).padStart(2, '0')}`}`;
    content.querySelector('small').textContent = `${train.held ? 'No fresh prediction · held · ' : ''}${snapshot?.notice ?? ''}`;
  }

  // Returns true when the click was on a train (and opens its popup).
  function click(event) {
    if (!trainToggle.checked || !map.getLayer('train-hit')) return false;
    const hits = map.queryRenderedFeatures(event.point, { layers: ['train-hit'] });
    let best = null, bestD = Infinity;
    for (const hit of hits) {
      const state = states.get(hit.properties.id);
      if (!state?.lngLat) continue;
      const p = map.project(state.lngLat), d = Math.hypot(p.x - event.point.x, p.y - event.point.y);
      if (d < bestD) { bestD = d; best = state; }
    }
    if (!best) return false;
    popup?.remove();
    selected = best.train.id;
    const content = document.createElement('div');
    content.className = 'bus-popup';
    const title = document.createElement('strong'), destination = document.createElement('div'), next = document.createElement('div'), note = document.createElement('small');
    destination.dataset.destination = ''; next.dataset.next = '';
    content.append(title, destination, next, note);
    fillPopup(content, best);
    popup = new maplibregl.Popup().setLngLat(best.lngLat).setDOMContent(content).addTo(map);
    popup.on('close', () => { selected = null; });
    return true;
  }

  trainToggle.addEventListener('change', () => {
    save('trains', trainToggle.checked);
    updateVisibility();
    updateStatus();
    if (trainToggle.checked) void poll(); else { clearTimeout(pollTimer); states.clear(); map.getSource('trains')?.setData(empty); }
  });
  lineToggle.addEventListener('change', () => { save('train-lines', lineToggle.checked); updateVisibility(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && trainToggle.checked) void poll(); });
  map.on('style.load', addLayers);
  void loadLines();
  updateStatus();
  return { click, get enabled() { return trainToggle.checked; }, get trains() { return [...states.values()].map(s => s.train); } };
}

function metres(a, b) {
  return Math.hypot((b[0] - a[0]) * 111_320 * Math.cos(51.5 * Math.PI / 180), (b[1] - a[1]) * 111_320);
}
