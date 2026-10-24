import { TOMTOM_KEY } from '/config.js';

export function createTraffic(map, toggle) {
  let enabled = false, timer;
  function remove() {
    if (map.getLayer('traffic')) map.removeLayer('traffic');
    if (map.getSource('traffic')) map.removeSource('traffic');
  }
  function refresh() {
    if (!enabled || document.hidden) return;
    remove();
    map.addSource('traffic', { type: 'raster', tileSize: 256,
      tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.png?key=${TOMTOM_KEY}&t=${Date.now()}`] });
    map.addLayer({ id: 'traffic', type: 'raster', source: 'traffic', paint: { 'raster-opacity': .8 } }, map.getStyle().layers.find(layer => layer.type === 'symbol')?.id);
  }
  function update() {
    enabled = toggle.checked;
    clearInterval(timer);
    if (enabled) { refresh(); timer = setInterval(refresh, 120_000); }
    else remove();
  }
  toggle.addEventListener('change', update);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && enabled) refresh(); });
  map.on('style.load', () => { if (enabled) refresh(); });
  update();
  return { get enabled() { return enabled; } };
}
