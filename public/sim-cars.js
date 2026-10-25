import * as THREE from 'three';
import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { modelOpacity } from '/lib/motion.mjs';

const HEADER = 24;
// Rendering trails the newest snapshot so there is always a later state to interpolate towards.
// At 5 Hz a car moves at most ~3 m between snapshots, so the chord between two snapshot positions
// stays within ~0.1 m of the lane/junction path even on tight bends.
const BUFFER_SECONDS = .4;
const STALE_AFTER_MS = 2000;
const MARGIN = .25;
const SIGNAL_MAGIC = 0x31474953, SIGNAL_MIN_ZOOM = 15;
// Simulated signal states GREEN, AMBER, RED as RGBA; a point without a recent state stays transparent.
const SIGNAL_COLOURS = [[.18, .65, .27, 1], [1, .7, 0, 1], [.9, .16, .14, 1]];
const clock = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`;

export function decodeSnapshot(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x31504E53) throw new Error('Not a simulation snapshot');
  const count = view.getUint32(16, true);
  const at = (Type, column) => new Type(buffer, HEADER + column * count, count);
  return {
    runId: view.getUint32(4, true), time: view.getFloat64(8, true), count, culled: !!(view.getUint32(20, true) & 1),
    ids: at(Uint32Array, 0), lon: at(Int32Array, 4), lat: at(Int32Array, 8), lane: at(Uint32Array, 12), lanePos: at(Float32Array, 16),
    angle: at(Uint16Array, 20), speed: at(Uint16Array, 22),
  };
}

// Interpolates the positions of cars present in `next`, by ID (both arrays are sorted by ID).
export function interpolate(previous, next, t, out) {
  const fraction = next.time > previous.time ? Math.min(1, Math.max(0, (t - previous.time) / (next.time - previous.time))) : 1;
  let j = 0;
  for (let i = 0; i < next.count; i++) {
    const id = next.ids[i];
    while (j < previous.count && previous.ids[j] < id) j++;
    const both = j < previous.count && previous.ids[j] === id;
    out[2 * i] = both ? previous.x[j] + (next.x[i] - previous.x[j]) * fraction : next.x[i];
    out[2 * i + 1] = both ? previous.y[j] + (next.y[i] - previous.y[j]) * fraction : next.y[i];
  }
  return next.count;
}

class CarLayer {
  constructor() {
    this.id = 'simulated-cars';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.capacity = 0;
    this.count = 0;
    this.origin = maplibregl.MercatorCoordinate.fromLngLat([-0.128, 51.507]);
    this.unit = this.origin.meterInMercatorCoordinateUnits();
  }

  onAdd(map, gl) {
    this.map = map;
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.originMatrix = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, 0).scale(new THREE.Vector3(this.unit, -this.unit, this.unit));
    this.material = new THREE.ShaderMaterial({
      uniforms: { size: { value: 4 }, opacity: { value: 1 } },
      transparent: true, depthTest: false, depthWrite: false,
      vertexShader: 'uniform float size; void main() { gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      // Black dot with a thin white rim so cars stay visible on dark roads and stand apart from red buses.
      fragmentShader: 'uniform float opacity; void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = d > 0.36 ? vec4(1.0, 1.0, 1.0, opacity) : vec4(0.0, 0.0, 0.0, opacity); }',
    });
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
    // A style change re-adds the layer: rebuild the points in the new scene.
    this.points = null;
    this.capacity = 0;
    this.ensureCapacity(1024);
    this.signalMaterial = new THREE.ShaderMaterial({
      uniforms: { size: { value: 8 } }, transparent: true, depthTest: false, depthWrite: false,
      vertexShader: 'uniform float size; attribute vec4 colour; varying vec4 vColour; void main() { vColour = colour; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying vec4 vColour; void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5 || vColour.a == 0.0) discard; gl_FragColor = d > 0.36 ? vec4(0.1, 0.1, 0.1, 1.0) : vColour; }',
    });
    this.signals = null;
    if (this.signalLonLat) this.setSignalPositions(this.signalLonLat);
  }

  // One batched point per signal approach, at its stop line; colours are updated in place.
  setSignalPositions(lonLat) {
    this.signalLonLat = lonLat;
    if (!this.scene) return;
    if (this.signals) { this.scene.remove(this.signals); this.signals.geometry.dispose(); }
    const n = lonLat.length / 2, positions = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) [positions[3 * k], positions[3 * k + 1]] = this.toLayer(lonLat[2 * k], lonLat[2 * k + 1]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('colour', new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage));
    this.signals = new THREE.Points(geometry, this.signalMaterial);
    this.signals.frustumCulled = false;
    this.signals.visible = false;
    this.scene.add(this.signals);
  }

  // indices/states from a 'SIG1' frame; approaches not in the frame are hidden.
  setSignalStates(indices, states) {
    if (!this.signals) return;
    const attribute = this.signals.geometry.getAttribute('colour'), colours = attribute.array;
    colours.fill(0);
    for (let k = 0; k < indices.length; k++) if (indices[k] * 4 < colours.length) colours.set(SIGNAL_COLOURS[states[k]] ?? SIGNAL_COLOURS[2], indices[k] * 4);
    attribute.needsUpdate = true;
  }

  ensureCapacity(count) {
    if (count <= this.capacity) return;
    this.capacity = 2 ** Math.ceil(Math.log2(Math.max(1024, count)));
    if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); }
    this.positions = new Float32Array(this.capacity * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  // xy are metres east/north of the layer origin, as produced by project().
  setPositions(xy, count) {
    this.ensureCapacity(count);
    for (let i = 0; i < count; i++) { this.positions[3 * i] = xy[2 * i]; this.positions[3 * i + 1] = xy[2 * i + 1]; }
    const attribute = this.points.geometry.getAttribute('position');
    attribute.needsUpdate = true;
    attribute.clearUpdateRanges?.();
    attribute.addUpdateRange?.(0, count * 3);
    this.points.geometry.setDrawRange(0, count);
    this.count = count;
  }

  // Web Mercator metres east/north of the layer origin.
  toLayer(lon, lat) {
    const mx = (lon + 180) / 360, my = (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360;
    return [(mx - this.origin.x) / this.unit, -(my - this.origin.y) / this.unit];
  }

  project(snapshot) {
    snapshot.x = new Float32Array(snapshot.count);
    snapshot.y = new Float32Array(snapshot.count);
    for (let i = 0; i < snapshot.count; i++) [snapshot.x[i], snapshot.y[i]] = this.toLayer(snapshot.lon[i] / 1e7, snapshot.lat[i] / 1e7);
    return snapshot;
  }

  render(gl, args) {
    const zoom = this.map.getZoom();
    if (this.signals) this.signals.visible = this.showSignals && zoom >= SIGNAL_MIN_ZOOM;
    if (!this.count && !this.signals?.visible) return;
    // Dots fade out as the 3D car models fade in (same zoom as the buses).
    this.material.uniforms.opacity.value = 1 - modelOpacity(zoom);
    if (this.points) this.points.visible = this.count > 0 && this.material.uniforms.opacity.value > 0;
    this.material.uniforms.size.value = Math.min(9, Math.max(3, 3 + (zoom - 10) * .8)) * devicePixelRatio;
    this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(this.originMatrix);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.renderer.resetState();
  }

  onRemove() {
    this.points?.geometry.dispose();
    this.signals?.geometry.dispose();
    this.material?.dispose();
    this.signalMaterial?.dispose();
    this.renderer?.dispose();
  }
}

// Draws the server-owned simulation. Nothing here creates, moves or removes simulated cars.
export function createSimulatedCars(map, toggle, signalToggle) {
  const $ = id => document.getElementById(id);
  const info = $('car-info'), connection = $('sim-connection'), progressLine = $('sim-progress');
  const slider = $('sim-population'), sliderValue = $('sim-population-value'), pauseButton = $('sim-pause'), reinitButton = $('sim-reinit');
  const layer = new CarLayer();
  let models = null; // 3D cars, loaded like the bus models
  import('/bus-layer.js').then(({ BusLayer, makeCar }) => { models = new BusLayer(map, () => { models = null; }, { id: 'simulated-car-models', makeParts: makeCar }); addLayer(); }).catch(() => {});
  let enabled = false, socket, retry = 1000, retryTimer, status = null, runId = null, snapshots = [], connected = false;
  let signalsLoading = false, signalFrames = 0;
  let renderTime = null, lastFrame = 0, lastDom = 0, lastSnapshotAt = 0, frames = 0, fpsSince = performance.now(), fps = 0, visible = 0, xy = new Float32Array(0), received = 0;

  function addLayer() {
    if (!map.getLayer(layer.id)) map.addLayer(layer, map.getLayer('live-bus-dots') ? 'live-bus-dots' : undefined);
    if (models && !map.getLayer(models.id)) map.addLayer(models);
  }

  function sendViewport() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const b = map.getBounds(), w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    const dx = (e - w) * MARGIN, dy = (n - s) * MARGIN;
    // Culling only trims what this client receives; the simulation and its IDs are unaffected.
    const signals = enabled && signalToggle.checked && map.getZoom() >= SIGNAL_MIN_ZOOM;
    layer.showSignals = signals;
    if (!signals) layer.setSignalStates([], []);
    socket.send(JSON.stringify({ type: 'viewport', snapshots: enabled, signals, bbox: [w - dx, s - dy, e + dx, n + dy] }));
  }

  // Stop-line positions are static for the road network; fetched once the simulation is running.
  async function loadSignals() {
    if (layer.signalLonLat || signalsLoading) return;
    signalsLoading = true;
    try {
      const response = await fetch('/api/simulation/signals');
      const { positions } = response.ok ? await response.json() : {};
      if (positions?.length) { layer.setSignalPositions(Float64Array.from(positions)); map.triggerRepaint(); }
    } catch { /* retried on the next status */ }
    signalsLoading = false;
  }

  function acceptStatus(next) {
    status = next;
    if (next.runId) void loadSignals();
    if (next.runId !== runId) { runId = next.runId; snapshots = []; renderTime = null; }
  }

  function connect() {
    clearTimeout(retryTimer);
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/simulation/stream`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { connected = true; retry = 1000; sendViewport(); };
    socket.onmessage = event => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'status' || message.type === 'run') acceptStatus(message.status);
        if (message.type === 'progress' && status) status = { ...status, job: { ...status.job, stage: message.progress.stage, fraction: message.progress.fraction } };
        return;
      }
      if (new DataView(event.data).getUint32(0, true) === SIGNAL_MAGIC) {
        const view = new DataView(event.data), n = view.getUint32(8, true);
        layer.setSignalStates(new Uint32Array(event.data, 16, n), new Uint8Array(event.data, 16 + 4 * n, n));
        signalFrames++;
        map.triggerRepaint();
        return;
      }
      const snapshot = decodeSnapshot(event.data);
      // Status (sent first on connect, and on every switch) names the run; other runs' snapshots are stale.
      if (snapshot.runId !== runId) return;
      if (snapshots.length && snapshot.time <= snapshots.at(-1).time) return;
      snapshots.push(layer.project(snapshot));
      if (snapshots.length > 8) snapshots.shift();
      lastSnapshotAt = performance.now();
      received++;
    };
    socket.onclose = () => {
      connected = false;
      retryTimer = setTimeout(connect, retry);
      retry = Math.min(10_000, retry * 2);
    };
  }

  function frame(now) {
    requestAnimationFrame(frame);
    frames++;
    if (now - fpsSince >= 1000) { fps = frames * 1000 / (now - fpsSince); frames = 0; fpsSince = now; }
    const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    if (enabled && snapshots.length) {
      const newest = snapshots.at(-1), oldest = snapshots[0];
      if (renderTime === null) renderTime = newest.time - BUFFER_SECONDS;
      if (!status?.pausedForEveryone) renderTime += dt;
      // Never run ahead of the last confirmed state; never fall far behind it either.
      renderTime = Math.min(newest.time, Math.max(oldest.time, renderTime, newest.time - 2 * BUFFER_SECONDS));
      let k = snapshots.length - 1;
      while (k > 0 && snapshots[k - 1].time > renderTime) k--;
      const next = snapshots[k], previous = snapshots[Math.max(0, k - 1)];
      if (xy.length < next.count * 2) xy = new Float32Array(next.count * 2);
      const count = interpolate(previous, next, renderTime, xy);
      layer.setPositions(xy, count);
      const b = map.getBounds(), [west, south] = layer.toLayer(b.getWest(), b.getSouth()), [east, north] = layer.toLayer(b.getEast(), b.getNorth());
      visible = 0;
      for (let i = 0; i < count; i++) if (xy[2 * i] >= west && xy[2 * i] <= east && xy[2 * i + 1] >= south && xy[2 * i + 1] <= north) visible++;
      models?.updateCars(xy, next.angle, count, [west, south, east, north]);
      map.triggerRepaint();
    } else if (layer.count) { layer.setPositions(xy, 0); models?.updateCars(xy, [], 0, [0, 0, 0, 0]); map.triggerRepaint(); }
    if (now - lastDom >= 500) { updatePanel(now); lastDom = now; }
  }

  function updatePanel(now) {
    if (!enabled) return;
    const stale = connected && lastSnapshotAt && now - lastSnapshotAt > STALE_AFTER_MS && status?.lifecycle === 'running';
    const state = !connected ? 'unavailable' : stale ? 'stale' : ({ running: 'live', paused: 'stale' })[status?.lifecycle] ?? (status?.lifecycle === 'initializing' ? 'loading' : 'unavailable');
    connection.dataset.status = state;
    connection.textContent = !connected ? 'Reconnecting to simulation… showing last confirmed state'
      : stale ? 'No new snapshots · holding last confirmed state'
      : ({ running: 'Simulation running', paused: 'Simulation paused for everyone', initializing: 'Preparing simulation…', failed: `Simulation failed: ${status?.reason}`, crashed: 'Simulation restarting…', unavailable: status?.reason ?? 'Simulation unavailable' })[status?.lifecycle] ?? 'Connecting…';
    const population = status?.population, observation = status?.observation, perf = status?.performance, health = status?.health;
    $('sim-global').textContent = population ? `${population.actual.toLocaleString()} (target ${population.target.toLocaleString()})` : '—';
    $('sim-visible').textContent = layer.count ? visible.toLocaleString() : '0';
    $('sim-speed').textContent = status?.averageSpeedMps == null ? '—' : `${(status.averageSpeedMps * 3.6).toFixed(1)} km/h`;
    $('sim-time').textContent = status?.simTime == null ? '—' : `${clock(status.simTime)} · run ${status.runId}`;
    if (observation) {
      const age = observation.observedAt ? Math.round((Date.now() - Date.parse(observation.observedAt)) / 60000) : null;
      const label = ({ live: 'Live TomTom', stale: 'Stale TomTom', fallback: 'Fallback (no live data)' })[observation.status];
      $('sim-data').textContent = `${label}${age == null ? '' : ` · observed ${age} min before start`} · ${(observation.matchedShare * 100).toFixed(0)}% roads matched, rest inferred`;
    } else $('sim-data').textContent = '—';
    $('sim-health').textContent = perf ? `${perf.realtimeFactor}× real time · step ${perf.stepMs} ms · ${health.gridlocked} gridlocked · ${fps.toFixed(0)} FPS${perf.realtimeFactor < 1 ? ' · degraded' : ''}` : `${fps.toFixed(0)} FPS`;
    const job = status?.job;
    progressLine.textContent = job?.state === 'preparing' ? `Re-initializing (${job.population.toLocaleString()} cars): ${job.stage} ${Math.round((job.fraction ?? 0) * 100)}%`
      : job?.state === 'failed' ? `Re-initialization failed: ${job.reason}.`
      : job?.state === 'succeeded' ? `Re-initialized from live traffic at ${new Date(job.finishedAt).toLocaleTimeString()}.`
      : job?.state === 'initializing' ? `${job.stage} ${Math.round((job.fraction ?? 0) * 100)}%` : '';
    reinitButton.disabled = job?.state === 'preparing' || !['running', 'paused'].includes(status?.lifecycle);
    pauseButton.disabled = !['running', 'paused'].includes(status?.lifecycle);
    pauseButton.textContent = status?.pausedForEveryone ? 'Play' : 'Pause';
  }

  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  }

  pauseButton.addEventListener('click', async () => {
    try { acceptStatus(await post('/api/simulation/pause', { paused: !status?.pausedForEveryone })); } catch (error) { progressLine.textContent = error.message; }
  });
  reinitButton.addEventListener('click', async () => {
    reinitButton.disabled = true;
    try { const { job } = await post('/api/simulation/reinitialize', { population: Number(slider.value) }); status = { ...status, job }; }
    catch (error) { progressLine.textContent = `Re-initialization refused: ${error.message}`; reinitButton.disabled = false; }
  });
  slider.addEventListener('input', () => { sliderValue.textContent = Number(slider.value).toLocaleString(); });

  function update() {
    enabled = toggle.checked;
    info.hidden = !enabled;
    sendViewport();
    if (!enabled) { snapshots = []; renderTime = null; }
  }
  toggle.addEventListener('change', update);
  signalToggle.addEventListener('change', () => { sendViewport(); map.triggerRepaint(); });
  map.on('moveend', sendViewport);
  map.on('style.load', addLayer);
  addLayer();
  connect();
  update();
  requestAnimationFrame(frame);
  return {
    get enabled() { return enabled; }, get runId() { return runId; }, get status() { return status; },
    get visibleCount() { return visible; }, get renderedCount() { return layer.count; }, get fps() { return fps; },
    get snapshotsReceived() { return received; }, get signalFrames() { return signalFrames; }, get connected() { return connected; },
    positions: () => Array.from(xy.subarray(0, layer.count * 2)), latest: () => snapshots.at(-1),
  };
}
