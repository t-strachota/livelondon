import * as maplibregl from '/vendor/maplibre-gl.mjs';

// The three stop tools (top right): "Stop road" (road closures), "Stop train line" and "Stop bus".
// One at a time. While one is active the map fades everything except what the tool works on (focus
// mode: paint opacity only, restored exactly when the tool is turned off).
const BANNERS = {
  road: 'Click a road to stop (close) it. Click a red dashed road to reopen it.',
  train: 'Click a train or a train line to stop the whole line. Click a stopped (red) line to reopen it.',
  bus: 'Click a bus to stop it. Its popup can stop the whole route.',
};
// Layers that stay at full opacity in each mode (by id, or roads by their basemap source layer).
const KEEP = {
  train: layer => /^(train-|tube-models)/.test(layer.id),
  bus: layer => /^(live-bus|bus-)/.test(layer.id),
  road: layer => layer['source-layer'] === 'transportation' || layer['source-layer'] === 'transportation_name'
    || /^(simulated-cars|simulated-car-models|closure-impact|closed-roads|congestion-glow)/.test(layer.id),
};
const OPACITY = {
  fill: ['fill-opacity'], line: ['line-opacity'], symbol: ['text-opacity', 'icon-opacity'], raster: ['raster-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'], 'fill-extrusion': ['fill-extrusion-opacity'], heatmap: ['heatmap-opacity'], background: ['background-opacity'],
};
// Custom (Three.js) layers: which modes keep them at full opacity.
const CUSTOM = { 'simulated-car-models': ['road'], 'live-bus-models': ['bus'], 'train-models': ['train'], 'tube-models': ['train'], 'simulated-signal-models': [] };

// Scales an opacity value; zoom curves keep their shape (each output is scaled).
function scale(value, f) {
  if (value === undefined || value === null) return f;
  if (typeof value === 'number') return value * f;
  if (Array.isArray(value) && (value[0] === 'interpolate' || value[0] === 'step')) {
    const out = value.slice();
    for (let k = value[0] === 'interpolate' ? 4 : 2; k < out.length; k += 2) out[k] = scale(out[k], f);
    return out;
  }
  if (value?.stops) return { ...value, stops: value.stops.map(([z, v]) => [z, typeof v === 'number' ? v * f : v]) };
  return ['*', value, f];
}

export function createStopTools(map, layers, { busAt }) {
  const $ = id => document.getElementById(id);
  const buttons = { road: $('closure-mode'), train: $('stop-line-mode'), bus: $('stop-bus-mode') };
  const banner = $('tool-banner'), exit = $('exit-focus');
  let tool = null, saved = new Map(), summary = null, refreshTimer, popup, pulse = 0;

  async function post(body) {
    const response = await fetch('/api/stops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? 'Request failed');
    show(value);
    return value;
  }

  function setTool(next) {
    if (tool === next) next = null;
    if (tool === 'road' || next === 'road') layers.cars?.setClosing(next === 'road');
    tool = next;
    for (const [name, button] of Object.entries(buttons)) button.setAttribute('aria-pressed', String(name === tool));
    exit.hidden = !tool;
    banner.hidden = !tool;
    banner.textContent = tool ? BANNERS[tool] : '';
    map.getCanvas().classList.toggle('stopping', Boolean(tool) && tool !== 'road');
    // The tool's vehicles must be on the map to be clicked.
    for (const [name, toggle] of [['train', 'toggle-trains'], ['train', 'toggle-train-lines'], ['bus', 'toggle-buses']]) {
      if (tool === name && !document.getElementById(toggle).checked) document.getElementById(toggle).click();
    }
    applyFocus();
  }

  // ---- Focus mode -------------------------------------------------------------------------------
  function restore() {
    for (const [key, value] of saved) {
      const [id, prop] = key.split('|');
      if (map.getLayer(id)) try { map.setPaintProperty(id, prop, value); } catch { /* Layer changed. */ }
    }
    saved = new Map();
  }

  function applyFocus() {
    restore();
    const strength = 1, f = 0; // full fade: only the tool's layers stay visible
    for (const [id, keepIn] of Object.entries(CUSTOM)) {
      const layer = map.getLayer(id)?.implementation;
      if (layer) layer.focus = tool && !keepIn.includes(tool) ? f : 1;
    }
    const cars = map.getLayer('simulated-cars')?.implementation;
    if (cars) { cars.focus = tool && tool !== 'road' ? f : 1; cars.signalFocus = tool ? f : 1; }
    if (tool && strength > 0) {
      for (const layer of map.getStyle().layers) {
        if (KEEP[tool](layer)) continue;
        for (const prop of OPACITY[layer.type] ?? []) {
          const original = map.getPaintProperty(layer.id, prop);
          saved.set(`${layer.id}|${prop}`, original);
          try {
            map.setPaintProperty(layer.id, `${prop}-transition`, { duration: 300, delay: 0 });
            map.setPaintProperty(layer.id, prop, scale(original, f));
          } catch { saved.delete(`${layer.id}|${prop}`); }
        }
      }
      if (tool === 'train' && map.getLayer('train-lines')) { // brighten the lines a little
        saved.set('train-lines|line-opacity', map.getPaintProperty('train-lines', 'line-opacity'));
        map.setPaintProperty('train-lines', 'line-opacity', 1);
      }
    }
    map.triggerRepaint();
  }

  // ---- Clicks while a tool is active -----------------------------------------------------------
  async function click(event) {
    if (!tool || tool === 'road') return false;
    if (tool === 'train') {
      const line = layers.trains?.lineAt(event);
      if (!line) { banner.textContent = 'No train or train line there. ' + BANNERS.train; return true; }
      const stopped = summary?.items.find(i => i.kind === 'line' && i.line === line);
      try {
        await post(stopped ? { action: 'reopen', key: stopped.key } : { action: 'stop-line', line });
        banner.textContent = `${stopped ? 'Reopened' : 'Stopped'} the ${layers.trains.lineName(line)} line. ${BANNERS.train}`;
      } catch (error) { banner.textContent = error.message; }
      return true;
    }
    const bus = busAt(event.point);
    if (!bus) { banner.textContent = 'No bus there. ' + BANNERS.bus; return true; }
    popup?.remove();
    const content = document.createElement('div');
    content.className = 'bus-popup';
    const title = document.createElement('strong'), note = document.createElement('small'), actions = document.createElement('div');
    title.textContent = bus.route ? `Bus ${bus.route}` : 'TfL bus';
    actions.className = 'popup-actions';
    const button = (label, body) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await post(body); popup?.remove(); } catch (error) { note.textContent = error.message; b.disabled = false; }
      });
      actions.append(b);
    };
    const own = summary?.items.find(i => i.key === `bus:${bus.id}`), route = summary?.items.find(i => i.kind === 'route' && i.route === String(bus.route ?? '').trim().toLowerCase().replace(/\s+/g, ''));
    if (bus.stopped) {
      note.textContent = 'Stopped (frozen in our display). Estimated, assumption-based.';
      if (own) button('Reopen bus', { action: 'reopen', key: own.key });
      if (route) button('Reopen route', { action: 'reopen', key: route.key });
    } else {
      try { await post({ action: 'stop-bus', id: bus.id }); note.textContent = 'Stopped. Live buses are only frozen in our display.'; }
      catch (error) { note.textContent = error.message; }
      if (bus.route) button('Stop whole route', { action: 'stop-route', route: bus.route });
    }
    content.append(title, actions, note);
    popup = new maplibregl.Popup().setLngLat([bus.longitude, bus.latitude]).setDOMContent(content).addTo(map);
    return true;
  }

  // ---- Economic impact and closure history ------------------------------------------------------
  const money = pounds => `£${Math.round(pounds).toLocaleString('en-GB')}`;
  const clockTime = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function showEconomics(e) {
    $('economics').hidden = !e?.active;
    if (!e?.active) return;
    $('econ-total').textContent = money(e.total);
    $('econ-rate').textContent = `about ${money(e.perHour)} per hour right now`;
    $('econ-split').textContent = `Road delay ${money(e.roadCost)} (${e.delayVehicleHours.toLocaleString()} extra vehicle-hours) · displaced passengers ${money(e.servicesCost)} · since ${clockTime(e.startedAt)}`;
  }

  const history = $('history');
  let historyCount = -1;
  async function loadHistory() {
    let value;
    try { const response = await fetch('/api/history', { cache: 'no-store' }); if (!response.ok) return; value = await response.json(); } catch { return; }
    const sessions = [...(value.current ? [{ ...value.current, running: true }] : []), ...value.sessions];
    $('history-count').textContent = value.sessions.length ? `(${value.sessions.length})` : '';
    const line = text => { const p = document.createElement('p'); p.className = 'detail'; p.textContent = text; return p; };
    $('history-list').replaceChildren(...(sessions.length ? sessions : [null]).map(s => {
      const li = document.createElement('li');
      if (!s) { li.className = 'detail'; li.textContent = 'No closure sessions yet.'; return li; }
      const details = document.createElement('details'), head = document.createElement('summary'), body = document.createElement('div');
      const start = new Date(s.startedAt), minutes = Math.max(1, Math.round(((s.endedAt ? Date.parse(s.endedAt) : Date.now()) - start) / 60000));
      head.textContent = `${start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${clockTime(s.startedAt)}–${s.running ? 'now' : clockTime(s.endedAt)} · ${minutes} min · ${money(s.total)}`;
      const closed = document.createElement('ul');
      closed.replaceChildren(...s.closed.map(c => {
        const item = document.createElement('li');
        item.textContent = `${({ road: 'Road', line: 'Train line', route: 'Bus route', bus: 'Bus' })[c.kind] ?? 'Closed'}: ${c.label}`;
        return item;
      }));
      body.append(closed,
        line(`Road delay ${money(s.roadCost)} (${s.delayVehicleHours} vehicle-hours) · displaced passengers ${money(s.servicesCost)}`),
        line(`Peak ${s.peakPeople.toLocaleString()} people displaced · ${s.peakExtraCars.toLocaleString()} extra cars`));
      if (s.mostAffected?.length) body.append(line(`Most affected: ${s.mostAffected.slice(0, 3).map(t => `${t.name} (${t.slowerPercent}% slower)`).join(', ')}`));
      if (s.running) body.append(line('Still running.'));
      else if (s.note) body.append(line(s.note));
      details.append(head, body);
      li.append(details);
      return li;
    }));
  }
  history.addEventListener('toggle', () => { if (history.open) void loadHistory(); });

  // The right-hand panel keeps the height it was dragged to.
  const body = $('closure-body');
  try { const h = Number(localStorage.getItem('london-map:closure-height')); if (h > 0) body.style.height = `${Math.min(h, innerHeight - 100)}px`; } catch { /* Optional. */ }
  new ResizeObserver(() => {
    if (body.style.height && body.offsetHeight > 0) try { localStorage.setItem('london-map:closure-height', String(Math.round(body.offsetHeight))); } catch { /* Optional. */ }
  }).observe(body);

  // ---- Stopped list, effect panel, pulsing markers ---------------------------------------------
  function show(value) {
    summary = value;
    const items = value.items ?? [];
    showEconomics(value.economics);
    if (value.historyCount !== historyCount || value.economics?.active) { historyCount = value.historyCount; if (history.open) void loadHistory(); }
    layers.trains?.setStoppedLines(value.stoppedLines ?? []);
    $('stopped-panel').hidden = !items.length;
    $('stopped-list').replaceChildren(...items.map(item => {
      const li = document.createElement('li'), name = document.createElement('span'), reopen = document.createElement('button');
      name.textContent = `${item.label} · ${item.vehicles} ${item.kind === 'line' ? 'trains' : item.vehicles === 1 ? 'bus' : 'buses'}`;
      reopen.type = 'button'; reopen.textContent = 'Reopen';
      reopen.addEventListener('click', async () => { reopen.disabled = true; try { await post({ action: 'reopen', key: item.key }); } catch { reopen.disabled = false; } });
      li.append(name, reopen);
      return li;
    }));
    const lines = items.filter(i => i.kind === 'line').length, buses = items.filter(i => i.kind !== 'line').reduce((a, i) => a + i.vehicles, 0);
    $('stopped-summary').textContent = `${lines} train line${lines === 1 ? '' : 's'} and ${buses} bus${buses === 1 ? '' : 'es'} stopped · about ${value.people.toLocaleString()} people displaced · ${value.extraCars.toLocaleString()} of ${value.extraCarsTarget.toLocaleString()} extra cars on the roads (estimated, assumption-based)`;
    const top = value.mostAffected ?? [];
    $('stopped-affected').replaceChildren(...(top.length ? top : [null]).map(t => {
      const li = document.createElement('li');
      li.textContent = t ? `${t.name}: ${t.slowerPercent}% slower${t.extraQueue > 0 ? `, +${t.extraQueue} queued` : ''}` : 'No clear impact yet (needs a minute or two of samples)';
      return li;
    }));
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, items.length || value.closures || value.economics?.active ? 5000 : 10_000);
    if (items.length && !pulse) pulse = requestAnimationFrame(animate);
  }

  async function refresh() {
    try { const response = await fetch('/api/stops', { cache: 'no-store' }); if (response.ok) show(await response.json()); else refreshTimer = setTimeout(refresh, 30_000); }
    catch { refreshTimer = setTimeout(refresh, 30_000); }
  }

  let lastPulse = 0;
  function animate(now) {
    if (!summary?.items.length) { pulse = 0; return; }
    pulse = requestAnimationFrame(animate);
    if (now - lastPulse < 50) return;
    lastPulse = now;
    const wave = (Math.sin(now / 300) + 1) / 2;
    for (const id of ['train-stopped-glow', 'bus-stopped-glow']) {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, 'circle-radius', 10 + 10 * wave);
      map.setPaintProperty(id, 'circle-opacity', .35 + .45 * (1 - wave));
    }
  }

  for (const [name, button] of Object.entries(buttons)) button.addEventListener('click', () => setTool(name));
  exit.addEventListener('click', () => setTool(null));
  // A style change drops our saved values with the old layers; fade the new style if a tool is still on.
  map.on('style.load', () => { saved = new Map(); if (tool) setTimeout(applyFocus, 0); });
  void refresh();
  return { click, get tool() { return tool; }, setTool };
}
