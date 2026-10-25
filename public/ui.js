const read = (key, fallback) => { try { return localStorage.getItem(`london-map:${key}`) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(`london-map:${key}`, value); } catch { /* Optional persistence. */ } };

export function createInterface() {
  const root = document.documentElement, panel = document.querySelector('.panel');
  const minimize = document.getElementById('panel-minimize'), theme = document.getElementById('theme-toggle');
  let map, originals = new Map(), panelAnimation, styleIdentity;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const content = document.getElementById('panel-content');
  const tabBar = document.querySelector('.panel-tabs');
  const tabs = [...tabBar.querySelectorAll('[role=tab]')];
  const indicator = document.createElement('span');
  indicator.className = 'tab-indicator'; indicator.setAttribute('aria-hidden', 'true'); tabBar.append(indicator);
  let indicatorPositioned = false;
  function moveIndicator(animate = false) {
    const active = tabs.find(button => button.getAttribute('aria-selected') === 'true');
    if (!active?.offsetWidth) return;
    indicator.classList.toggle('is-animating', animate && indicatorPositioned && !reducedMotion.matches);
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translate3d(${active.offsetLeft}px, 0, 0)`;
    indicator.classList.add('is-positioned'); indicatorPositioned = true;
  }
  function selectTab(tab, animate = true) {
    for (const button of tabs) {
      const selected = button === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      const section = document.getElementById(button.getAttribute('aria-controls'));
      section.hidden = !selected;
      if (selected && animate && !reducedMotion.matches) section.animate([{ opacity: 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    document.querySelector('.tab-body').scrollTop = 0;
    moveIndicator(animate);
    save('controls-tab', tab.id);
    save('tab', tab.id === 'tab-btn-performance' ? 'performance' : 'controls');
  }
  tabs.forEach(tab => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const ordered = [...tab.parentElement.querySelectorAll('[role=tab]')], index = ordered.indexOf(tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % ordered.length : event.key === 'ArrowLeft' ? (index + ordered.length - 1) % ordered.length : event.key === 'Home' ? 0 : event.key === 'End' ? ordered.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); selectTab(ordered[next]); ordered[next].focus();
    });
  });
  function showTab(name) {
    const aliases = { controls: 'tab-simulation', simulation: 'tab-simulation', explore: 'tab-explore', statistics: 'tab-statistics', performance: 'tab-btn-performance' };
    const tab = tabs.find(tab => tab.id === (aliases[name] ?? name));
    if (tab) selectTab(tab);
  }
  const legacy = read('tab', 'controls') === 'performance' ? 'tab-btn-performance' : 'tab-explore';
  selectTab(tabs.find(tab => tab.id === read('controls-tab', legacy)) ?? tabs[0], false);
  new ResizeObserver(() => moveIndicator(false)).observe(tabBar);
  document.fonts?.ready.then(() => moveIndicator(false));
  reducedMotion.addEventListener('change', () => moveIndicator(false));
  function setCollapsed(collapsed, animate = true) {
    panelAnimation?.cancel();
    const from = panel.getBoundingClientRect().height;
    panel.classList.toggle('is-minimized', collapsed);
    document.body.classList.toggle('controls-minimized', collapsed);
    content.hidden = collapsed;
    if (!collapsed) requestAnimationFrame(() => moveIndicator(false));
    minimize.setAttribute('aria-expanded', String(!collapsed));
    minimize.setAttribute('aria-label', collapsed ? 'Expand controls' : 'Minimize controls');
    minimize.title = collapsed ? 'Expand controls' : 'Minimize controls';
    minimize.textContent = collapsed ? '+' : '−';
    if (animate && !reducedMotion.matches) panelAnimation = panel.animate([{ height: `${from}px` }, { height: `${panel.getBoundingClientRect().height}px` }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' });
    save('minimized', collapsed ? 'on' : 'off');
  }
  function paintMap() {
    if (!map?.getStyle()?.layers) return;
    const dark = root.dataset.theme === 'dark';
    for (const layer of map.getStyle().layers) {
      if (!['background', 'fill', 'line', 'symbol'].includes(layer.type) || /traffic|bus|simulated|congestion|camera|closure|closed-road|impact|train|tube|stopped/i.test(layer.id)) continue;
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
  setCollapsed(read('minimized', 'off') === 'on', false);
  minimize.addEventListener('click', () => setCollapsed(minimize.getAttribute('aria-expanded') === 'true'));
  theme.addEventListener('click', () => setTheme(root.dataset.theme !== 'dark'));
  const closureCard = document.querySelector('.closure-card');
  const closureDetails = document.getElementById('closure-details-toggle');
  const results = document.getElementById('closure-body');
  let detailsOpen = false, hadResults = false;
  function updateClosureDetails() {
    const activeTool = Boolean(document.querySelector('.stop-tools [aria-pressed=true]'));
    const hasResults = [...results.querySelectorAll(':scope > section')].some(section => !section.hidden);
    if (hasResults && !hadResults) detailsOpen = true;
    hadResults = hasResults;
    const expanded = detailsOpen || activeTool;
    closureCard.classList.toggle('is-folded', !expanded);
    closureDetails.setAttribute('aria-expanded', String(expanded));
    closureDetails.setAttribute('aria-label', expanded ? 'Hide closure impact and history' : 'Show closure impact and history');
    closureDetails.textContent = expanded ? 'Hide results ↑' : 'Impact & history ↓';
  }
  closureDetails.addEventListener('click', () => { detailsOpen = !detailsOpen; updateClosureDetails(); });
  new MutationObserver(updateClosureDetails).observe(results, { attributes: true, attributeFilter: ['hidden'], subtree: true });
  new MutationObserver(updateClosureDetails).observe(document.querySelector('.stop-tools'), { attributes: true, attributeFilter: ['aria-pressed'], subtree: true });
  updateClosureDetails();
  const screen = document.getElementById('loading-screen');
  const workspaceElements = [...document.querySelectorAll('#map, .panel, .closure-card, #cctv-tiles, #cctv-viewer')];
  let dismissed = false, dismissTimer, cleanupIntro;
  const setWorkspaceInert = inert => { for (const element of workspaceElements) element.inert = inert; };
  function enterWorkspace() {
    if (dismissed) return;
    dismissed = true;
    screen.inert = true; screen.classList.add('is-ready'); setWorkspaceInert(false);
    const focusTarget = content.hidden ? minimize : tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
    focusTarget?.focus({ preventScroll: true });
    dismissTimer = setTimeout(() => { screen.hidden = true; }, reducedMotion.matches ? 0 : 400);
  }
  function openIntroduction() {
    cleanupIntro?.(); clearTimeout(dismissTimer);
    dismissed = false; screen.hidden = false; screen.inert = false; screen.classList.remove('is-ready'); screen.scrollTop = 0;
    setWorkspaceInert(true);
    cleanupIntro = createProjectIntro(reducedMotion, enterWorkspace);
    requestAnimationFrame(() => document.getElementById('intro-line').focus({ preventScroll: true }));
  }
  document.getElementById('intro-replay').addEventListener('click', openIntroduction);
  openIntroduction();
  return { showTab, attach(next) {
    map = next;
    document.getElementById('map-home').addEventListener('click', () => map.easeTo({ center: [-.128, 51.507], zoom: 14, pitch: 0, bearing: 0, duration: reducedMotion.matches ? 0 : 1000 }));
    map.on('load', () => requestAnimationFrame(paintMap));
    map.on('style.load', () => {
      const style = map.getStyle(), identity = JSON.stringify([style.name, style.sprite, style.glyphs]);
      if (identity !== styleIdentity) { originals = new Map(); styleIdentity = identity; }
      paintMap();
    });
  } };
}

function createProjectIntro(reducedMotion, onFinish) {
  const intro = document.getElementById('project-intro'), copy = intro.querySelector('.intro-copy'), line = document.getElementById('intro-line');
  const next = document.getElementById('intro-next'), enter = document.getElementById('intro-enter'), skip = document.getElementById('intro-skip');
  const progress = document.getElementById('intro-progress'), dots = [...intro.querySelectorAll('.intro-progress i')];
  const scenes = [
    ['The cost of standing still', 'When public transport and traffic are poorly managed, we lose <strong>time</strong>, <strong>money</strong> and <em>ease of movement.</em>'],
    ['A clearer way forward', 'Data-driven<br><strong><em>decision-making</em></strong><br>prevents this.'],
  ];
  let index = 0, disposed = false, busy = false, timer;
  function show() {
    intro.dataset.scene = String(index); line.innerHTML = scenes[index][1]; intro.querySelector('.intro-overline').textContent = scenes[index][0];
    progress.textContent = `${String(index + 1).padStart(2, '0')} / ${String(scenes.length).padStart(2, '0')}`; dots.forEach((dot, at) => dot.classList.toggle('is-current', at === index));
    const final = index === scenes.length - 1; next.hidden = final; enter.hidden = !final;
    if (final) enter.focus({ preventScroll: true });
  }
  function cleanup() {
    if (disposed) return; disposed = true; clearTimeout(timer); copy.getAnimations().forEach(animation => animation.cancel());
    document.removeEventListener('keydown', onKey); next.removeEventListener('click', advance); enter.removeEventListener('click', finish); skip.removeEventListener('click', finish); intro.querySelector('.intro-stage').removeEventListener('click', advance);
  }
  function finish() { if (!disposed) { cleanup(); onFinish(); } }
  function advance() {
    if (disposed || busy || index === scenes.length - 1) return;
    index++; show();
    if (!reducedMotion.matches) { busy = true; copy.animate([{ opacity: .25, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 280, easing: 'ease-out' }); timer = setTimeout(() => { busy = false; }, 220); }
  }
  function onKey(event) {
    if (disposed || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); finish(); return; }
    if (['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    if (event.target.closest?.('button, a') && ['Enter', ' '].includes(event.key)) return;
    if (index === scenes.length - 1) { if (event.key === 'Enter') { event.preventDefault(); finish(); } return; }
    event.preventDefault(); advance();
  }
  show(); document.addEventListener('keydown', onKey); next.addEventListener('click', advance); enter.addEventListener('click', finish); skip.addEventListener('click', finish); intro.querySelector('.intro-stage').addEventListener('click', advance);
  return cleanup;
}
