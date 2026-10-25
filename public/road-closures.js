const empty = () => ({ type: 'FeatureCollection', features: [] });

export function createRoadClosures(map) {
  const drawButton = document.getElementById('closure-draw');
  const finishButton = document.getElementById('closure-finish');
  const cancelButton = document.getElementById('closure-cancel');
  const note = document.getElementById('closure-draw-status');
  const list = document.getElementById('closure-list');
  const count = document.getElementById('closure-count');
  const analysis = document.getElementById('closure-analysis');
  const mapKey = document.getElementById('closure-map-key');
  const impactKey = document.getElementById('closure-impact-key');
  const impactEmpty = document.getElementById('closure-impact-empty');
  const impactContext = document.getElementById('closure-impact-context');
  const overlay = document.getElementById('closure-map-overlay');
  let drawing = false, points = [], previousDoubleClickZoom = true, signature = '', loading = false;
  const sketch = empty(), analysisData = empty();
  let closureData = empty();
  const sketchSource = 'closure-sketch', impactSource = 'closure-impact';
  const setSource = (id, data) => map.getSource(id)?.setData(data);
  const svg = (tag, attrs = {}) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    return element;
  };

  function renderClosureOverlay() {
    if (!overlay) return;
    overlay.setAttribute('viewBox', `0 0 ${map.getContainer().clientWidth} ${map.getContainer().clientHeight}`);
    overlay.replaceChildren();
    const records = closureData.features.filter(feature => feature.properties.kind !== 'barrier' && ['applied', 'applying'].includes(feature.properties.status));
    for (const feature of records) {
      const groups = feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [feature.geometry.coordinates];
      let labelRoute = null;
      for (const coordinates of groups) {
        if (coordinates.length < 2) continue;
        const points = coordinates.map(coordinate => map.project(coordinate));
        const d = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
        const pending = feature.properties.status === 'applying';
        overlay.append(svg('path', { d, class: `closure-casing${pending ? ' is-pending' : ''}` }));
        overlay.append(svg('path', { d, class: `closure-red-stripe${pending ? ' is-pending' : ''}` }));
        overlay.append(svg('path', { d, class: `closure-white-dash${pending ? ' is-pending' : ''}` }));
        let routeLength = 0;
        for (let index = 1; index < points.length; index++) routeLength += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
        if (!labelRoute || routeLength > labelRoute.length) {
          let remaining = routeLength / 2, midpoint = points[0], tangent = { x: 1, y: 0 };
          for (let index = 1; index < points.length; index++) {
            const dx = points[index].x - points[index - 1].x, dy = points[index].y - points[index - 1].y, segment = Math.hypot(dx, dy);
            if (remaining <= segment) { const fraction = segment ? remaining / segment : 0; midpoint = { x: points[index - 1].x + dx * fraction, y: points[index - 1].y + dy * fraction }; tangent = { x: dx / (segment || 1), y: dy / (segment || 1) }; break; }
            remaining -= segment;
          }
          labelRoute = { length: routeLength, point: midpoint, tangent };
        }
      }
      if (labelRoute?.length > 20) {
        const width = map.getContainer().clientWidth, height = map.getContainer().clientHeight;
        const side = labelRoute.point.x < width * .68 ? 1 : -1;
        const labelX = Math.max(54, Math.min(width - 54, labelRoute.point.x + side * 58));
        const labelY = Math.max(20, Math.min(height - 20, labelRoute.point.y - labelRoute.tangent.x * side * 30));
        const badge = svg('g', { transform: `translate(${labelX.toFixed(1)} ${labelY.toFixed(1)})`, class: `closure-road-badge${feature.properties.status === 'applying' ? ' is-pending' : ''}` });
        badge.append(svg('rect', { x: -48, y: -11, width: 96, height: 22, rx: 7 }));
        const text = svg('text', { x: 0, y: 4, 'text-anchor': 'middle' }); text.textContent = 'ROAD CLOSED'; badge.append(text);
        overlay.append(badge);
      }
    }
    for (const feature of closureData.features.filter(item => item.properties.kind === 'barrier' && ['applied', 'applying'].includes(item.properties.status))) {
      const point = map.project(feature.geometry.coordinates), marker = svg('g', { transform: `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`, class: `closure-endpoint${feature.properties.status === 'applying' ? ' is-pending' : ''}` });
      marker.append(svg('circle', { r: 7 }));
      const cross = svg('path', { d: 'M-2.5,-2.5 L2.5,2.5 M2.5,-2.5 L-2.5,2.5' }); marker.append(cross); overlay.append(marker);
    }
  }

  function addLayers() {
    if (!map.getSource(sketchSource)) map.addSource(sketchSource, { type: 'geojson', data: sketch });
    if (!map.getSource(impactSource)) map.addSource(impactSource, { type: 'geojson', data: analysisData });
    const before = map.getLayer('live-bus-dots') ? 'live-bus-dots' : undefined;
    const addImpact = (id, kind, colours, pointColour) => {
      if (!map.getLayer(id)) map.addLayer({ id, type: 'heatmap', source: impactSource, filter: ['==', ['get', 'kind'], kind], paint: {
        'heatmap-weight': ['get', 'intensity'], 'heatmap-intensity': 2.4, 'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 28, 14, 74, 18, 112], 'heatmap-opacity': 1,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, colours[0], .025, colours[1], .12, colours[2], 1, colours[3]],
      } }, before);
      const pointId = `${id}-points`;
      if (!map.getLayer(pointId)) map.addLayer({ id: pointId, type: 'circle', source: impactSource, filter: ['==', ['get', 'kind'], kind], paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'intensity'], 0, 5, 1, 13], 'circle-color': pointColour,
        'circle-opacity': .78, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5, 'circle-blur': .35,
      } }, before);
    };
    addImpact('closure-impact-increase', 'new', ['rgba(255,54,48,0)', 'rgba(255,54,48,.4)', 'rgba(238,35,30,.8)', 'rgba(194,12,20,.98)'], '#ed332d');
    addImpact('closure-impact-worsened', 'worsened', ['rgba(255,123,37,0)', 'rgba(255,123,37,.45)', 'rgba(240,94,28,.82)', 'rgba(190,54,16,.98)'], '#ed7c26');
    addImpact('closure-impact-relief', 'relieved', ['rgba(40,195,150,0)', 'rgba(40,195,150,.38)', 'rgba(26,167,126,.78)', 'rgba(8,126,92,.96)'], '#1caa7d');
    if (!map.getLayer('closure-sketch-glow')) map.addLayer({ id: 'closure-sketch-glow', type: 'line', source: sketchSource, paint: { 'line-color': '#ffc453', 'line-width': 14, 'line-blur': 5, 'line-opacity': .55 } }, before);
    if (!map.getLayer('closure-sketch-line')) map.addLayer({ id: 'closure-sketch-line', type: 'line', source: sketchSource, paint: { 'line-color': '#fff1ad', 'line-width': 4, 'line-dasharray': [1, .8] } }, before);
  }

  function setDraftData() {
    sketch.features = points.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: points }, properties: {} }] : [];
    if (points.length) sketch.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: points.at(-1) }, properties: {} });
    setSource(sketchSource, sketch);
  }

  function finish() {
    if (!drawing || points.length < 2) return;
    drawing = false;
    map.off('click', onClick);
    map.off('mousemove', onMove);
    map.off('dblclick', onDoubleClick);
    map.getCanvas().style.cursor = ''; document.body.classList.remove('is-drawing-closure');
    if (previousDoubleClickZoom) map.doubleClickZoom.enable();
    finishButton.hidden = true; cancelButton.hidden = true; drawButton.disabled = true;
    note.textContent = 'Matching your line to drivable roads…';
    void (async () => {
      try {
        const response = await fetch('/api/simulation/closures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Closure refused');
        note.textContent = 'Applying to the shared simulation… existing cars on the marked road will clear it.';
      } catch (error) { note.textContent = error.message; }
      finally { points = []; setDraftData(); drawButton.disabled = false; }
    })();
  }

  function onClick(event) {
    const point = [event.lngLat.lng, event.lngLat.lat];
    if (points.length && Math.hypot((point[0] - points.at(-1)[0]) * 69_400, (point[1] - points.at(-1)[1]) * 111_320) < 3) return;
    if (points.length >= 64) { note.textContent = 'Maximum 64 draw points. Apply this section or cancel it.'; return; }
    points.push(point); setDraftData(); finishButton.disabled = points.length < 2;
    note.textContent = points.length < 2 ? 'Add a second point to mark the road section.' : `${points.length} points · double-click or press Apply to close this section.`;
  }
  function onMove(event) {
    if (!points.length) return;
    const cursor = [event.lngLat.lng, event.lngLat.lat];
    const old = points.at(-1); points[points.length - 1] = cursor; setDraftData(); points[points.length - 1] = old;
  }
  function onDoubleClick(event) { event.preventDefault(); finish(); }
  function cancel() {
    if (drawing) { map.off('click', onClick); map.off('mousemove', onMove); map.off('dblclick', onDoubleClick); }
    drawing = false; points = []; setDraftData(); map.getCanvas().style.cursor = ''; document.body.classList.remove('is-drawing-closure');
    if (previousDoubleClickZoom) map.doubleClickZoom.enable();
    finishButton.hidden = true; cancelButton.hidden = true; drawButton.disabled = false;
    note.textContent = 'Zoom to street level, then draw along the road centre.';
  }
  function activate() {
    if (drawing) return;
    if (map.getZoom() < 15) { note.textContent = 'Zoom in to street level (zoom 15+) to draw a precise road closure.'; return; }
    drawing = true; points = []; previousDoubleClickZoom = map.doubleClickZoom.isEnabled();
    map.doubleClickZoom.disable(); map.getCanvas().style.cursor = 'crosshair'; document.body.classList.add('is-drawing-closure');
    finishButton.hidden = false; finishButton.disabled = true; cancelButton.hidden = false; drawButton.disabled = true;
    note.textContent = 'Click along the road centre to mark the section. Apply when done.';
    map.on('click', onClick); map.on('mousemove', onMove); map.on('dblclick', onDoubleClick);
  }
  drawButton.addEventListener('click', activate);
  finishButton.addEventListener('click', finish);
  cancelButton.addEventListener('click', cancel);
  window.addEventListener('keydown', event => { if (drawing && event.key === 'Escape') cancel(); else if (drawing && event.key === 'Enter') finish(); });

  async function syncFeatures() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch('/api/simulation/closures', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json(); closureData = data; renderClosureOverlay();
      const records = data.features.filter(feature => feature.properties.kind !== 'barrier');
      mapKey.hidden = !records.some(feature => ['applied', 'applying'].includes(feature.properties.status));
      count.textContent = String(records.length);
      list.replaceChildren();
      for (const feature of records) {
        const props = feature.properties, row = document.createElement('div'); row.className = 'closure-row';
        const info = document.createElement('span'); info.className = 'closure-row-info';
        const title = document.createElement('strong'); title.textContent = props.status === 'applied' ? `${props.matchedEdges.toLocaleString()} road segments closed` : `Closure ${props.status}`;
        const sub = document.createElement('small'); sub.textContent = props.reason ?? (props.status === 'applied' ? 'Cars rerouting · road occupants clearing' : 'Matching road geometry');
        info.append(title, sub);
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove road closure');
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try { const result = await fetch(`/api/simulation/closures/${encodeURIComponent(props.id)}`, { method: 'DELETE' }); if (!result.ok) throw new Error((await result.json()).error); }
          catch (error) { remove.disabled = false; note.textContent = error.message; }
        });
        row.append(info, remove); list.append(row);
      }
    } catch { note.textContent = 'Could not refresh road closure status. Reconnecting…'; }
    finally { loading = false; }
  }
  function updateStatus(status) {
    const next = JSON.stringify(status?.closures ?? []);
    if (next !== signature) { signature = next; void syncFeatures(); }
    drawButton.disabled = drawing || !['running', 'paused'].includes(status?.lifecycle) || (status?.closures?.length ?? 0) >= 12;
    if (!drawing && status?.closures?.length) {
      const rejected = status.closures.find(closure => closure.status === 'rejected');
      const pending = status.closures.some(closure => ['applying', 'removing'].includes(closure.status));
      const applied = status.closures.filter(closure => closure.status === 'applied');
      note.textContent = rejected?.reason ?? (pending ? 'Applying the road change…' : `${applied.length} active closure${applied.length === 1 ? '' : 's'} · live simulation continues.`);
    } else if (!drawing) note.textContent = 'Zoom to street level, then draw along the road centre.';
    if (status?.closureAnalysis) setAnalysis(status.closureAnalysis);
  }
  function setAnalysis(result) {
    analysisData.features = (result.zones ?? []).map(zone => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [zone.lon, zone.lat] }, properties: { change: zone.change, intensity: Math.max(.12, Math.min(1, zone.change / 8)), kind: zone.kind } }));
    setSource(impactSource, analysisData);
    impactKey.hidden = analysisData.features.length === 0;
    impactEmpty.hidden = analysisData.features.length > 0 || result.state === 'idle';
    impactEmpty.textContent = result.state === 'ready' ? 'No queue change measured across London in this comparison' : 'Observing traffic across London for queue changes…';
    impactContext.textContent = `${result.action === 'reinitialized' ? 'Since run start' : result.action === 'opened' ? 'After reopening' : 'Since closure'} · London-wide`;
    if (result.state === 'idle') { analysis.textContent = 'Baseline ready · changes are measured against the live simulation.'; return; }
    const action = result.action === 'opened' ? 'Road reopened' : result.action === 'reinitialized' ? 'New run baseline · closure active from start' : 'Since closure';
    const remaining = Math.max(0, 30 - (result.elapsedSimSeconds ?? 0));
    if (result.state !== 'ready') analysis.textContent = `${action} · observing live traffic (${remaining.toFixed(0)} simulation seconds).`;
    else if (result.action === 'opened') analysis.textContent = `${result.relievedZones} queue zones eased · ${Math.max(0, -result.extraSlowCars)} fewer slow cars in affected cells.`;
    else if (!result.newZones && !result.worsenedZones && !result.relievedZones) analysis.textContent = 'No measurable queue shift yet. Red and orange show new or worsened queues; green shows easing.';
    else analysis.textContent = `${result.newZones} new and ${result.worsenedZones} worsened queue zones · ${result.extraSlowCars >= 0 ? '+' : ''}${result.extraSlowCars} slow cars in affected cells.`;
  }
  map.on('load', addLayers);
  map.on('style.load', addLayers);
  map.on('move', renderClosureOverlay);
  map.on('resize', renderClosureOverlay);
  if (map.isStyleLoaded()) addLayers();
  return { updateStatus, cancel, get drawing() { return drawing; } };
}
