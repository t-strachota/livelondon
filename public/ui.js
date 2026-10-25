const read = (key, fallback) => { try { return localStorage.getItem(`london-map:${key}`) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(`london-map:${key}`, value); } catch { /* Optional persistence. */ } };

export function createInterface() {
  const root = document.documentElement, panel = document.querySelector('.panel');
  const minimize = document.getElementById('panel-minimize'), theme = document.getElementById('theme-toggle');
  let map, originals = new Map();
  function setCollapsed(collapsed) {
    panel.classList.toggle('is-minimized', collapsed);
    document.getElementById('panel-content').hidden = collapsed;
    minimize.setAttribute('aria-expanded', String(!collapsed));
    minimize.setAttribute('aria-label', collapsed ? 'Expand controls' : 'Minimize controls');
    minimize.title = collapsed ? 'Expand controls' : 'Minimize controls';
    minimize.textContent = collapsed ? '+' : '−';
    save('minimized', collapsed ? 'on' : 'off');
  }
  function paintMap() {
    if (!map?.getStyle()?.layers) return;
    const dark = root.dataset.theme === 'dark';
    for (const layer of map.getStyle().layers) {
      if (!['background', 'fill', 'line', 'symbol'].includes(layer.type) || /traffic|bus|simulated|congestion|camera/.test(layer.id)) continue;
      const property = { background: 'background-color', fill: 'fill-color', line: 'line-color', symbol: 'text-color' }[layer.type];
      const key = `${layer.id}:${property}`;
      if (!originals.has(key)) originals.set(key, map.getPaintProperty(layer.id, property));
      const original = originals.get(key);
      if (original === undefined) continue;
      const id = layer.id.toLowerCase();
      const colour = layer.type === 'symbol' ? '#a6b5c5' : /water|ocean|river/.test(id) ? '#122b3d'
        : /building/.test(id) ? '#2c3846' : /park|wood|grass|forest/.test(id) ? '#20382f'
        : layer.type === 'line' ? (/road|street|motorway|highway|trunk/.test(id) ? '#465466' : '#2e3b48') : '#1b2632';
      map.setPaintProperty(layer.id, property, dark ? colour : original);
      if (layer.type === 'symbol') {
        const haloKey = `${layer.id}:text-halo-color`;
        if (!originals.has(haloKey)) originals.set(haloKey, map.getPaintProperty(layer.id, 'text-halo-color'));
        if (originals.get(haloKey) !== undefined) map.setPaintProperty(layer.id, 'text-halo-color', dark ? '#1b2632' : originals.get(haloKey));
      }
    }
  }
  function setTheme(dark) {
    root.dataset.theme = dark ? 'dark' : 'light';
    theme.textContent = dark ? '☀' : '☾';
    theme.setAttribute('aria-pressed', String(dark));
    theme.setAttribute('aria-label', dark ? 'Enable light mode' : 'Enable dark mode');
    save('theme', root.dataset.theme);
    paintMap();
  }
  setTheme(read('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') === 'dark');
  setCollapsed(read('minimized', 'off') === 'on');
  minimize.addEventListener('click', () => setCollapsed(minimize.getAttribute('aria-expanded') === 'true'));
  theme.addEventListener('click', () => setTheme(root.dataset.theme !== 'dark'));
  const screen = document.getElementById('loading-screen'), message = document.getElementById('loading-message');
  const dismiss = () => { screen.classList.add('is-ready'); setTimeout(() => { screen.hidden = true; }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450); };
  document.getElementById('loading-continue').addEventListener('click', dismiss);
  const timeout = setTimeout(() => { message.textContent = 'The map is taking a little longer. You can explore while it connects.'; }, 12000);
  return { attach(next) {
    map = next;
    map.on('load', () => { clearTimeout(timeout); requestAnimationFrame(paintMap); message.textContent = 'Map ready. Live feeds connect in the background.'; setTimeout(dismiss, 600); });
    map.on('style.load', () => { originals = new Map(); paintMap(); });
    map.on('error', event => { if (!screen.hidden && !map.loaded()) message.textContent = 'Still connecting to the map. You can continue while we retry.'; });
  } };
}
