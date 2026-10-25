import { pixelRatioFor, settings } from '/performance-settings.js';

// Performance tab: live indicators, browser-only display settings, and a pointer to the shared
// population control (which lives in the Controls tab and affects everyone).
export function createPerformance(map, layers, { showTab } = {}) {
  const $ = id => document.getElementById(id);
  const store = settings();
  const presets = [...document.querySelectorAll('input[name="perf-preset"]')];
  const rate = $('perf-render-rate'), models = $('perf-models'), resolution = $('perf-resolution');

  function render(s) {
    const preset = store.preset();
    for (const input of presets) input.checked = input.value === preset;
    $('perf-preset-custom').hidden = preset !== 'custom';
    rate.value = String(s.renderRate);
    models.checked = s.models3d;
    resolution.value = String(s.pixelRatio);
  }
  function apply(s) {
    const ratio = pixelRatioFor(s, devicePixelRatio);
    if (map.getPixelRatio?.() !== ratio) map.setPixelRatio?.(ratio); // default: untouched
    map.triggerRepaint();
    render(s);
  }
  for (const input of presets) input.addEventListener('change', () => { if (input.checked && input.value !== 'custom') store.applyPreset(input.value); });
  rate.addEventListener('change', () => store.set({ renderRate: Number(rate.value) }));
  models.addEventListener('change', () => store.set({ models3d: models.checked }));
  resolution.addEventListener('change', () => store.set({ pixelRatio: Number(resolution.value) }));
  $('perf-reset').addEventListener('click', () => store.reset());
  store.onChange(apply);
  apply(store.get());

  $('perf-population-link').addEventListener('click', () => {
    showTab?.('controls');
    const slider = $('sim-population');
    slider.scrollIntoView({ block: 'center' });
    slider.focus();
  });

  // Live indicators: refreshed once a second, only while the tab is open and the page is visible.
  const panel = $('tab-performance');
  const text = (id, value) => { $(id).textContent = value; };
  function update() {
    const cars = layers.cars, status = cars?.status, perf = status?.performance;
    text('perf-fps', cars ? `${cars.fps.toFixed(0)} FPS` : '—');
    text('perf-step', perf ? `${perf.stepMs} ms per step (+${perf.encodeMs} ms encode)` : '—');
    text('perf-realtime', perf ? `${perf.realtimeFactor}× real time${perf.realtimeFactor < 1 ? ' · server can’t keep up' : ''}` : '—');
    text('perf-cars', cars?.enabled ? `${cars.renderedCount.toLocaleString()} drawn · ${cars.visibleCount.toLocaleString()} on screen` : 'Simulated cars off');
    text('perf-buses', window.londonBuses?.enabled ? `${window.londonBuses.buses.length.toLocaleString()}` : 'Buses off');
    text('perf-trains', layers.trains?.enabled ? `${layers.trains.trains.length.toLocaleString()}` : 'Trains off');
    const population = status?.population, clock = status?.clock;
    text('perf-population', population ? `${population.actual.toLocaleString()} now · target ${population.target.toLocaleString()}` : '—');
    text('perf-count-source', !clock ? '—' : clock.mode === 'manual' ? 'Manual population (set at last re-initialize)' : clock.mode === 'custom' ? 'Custom clock' : 'London time');
    const slow = cars?.fps && cars.fps < 30 && store.preset() !== 'low';
    text('perf-advice', slow ? 'Below 30 FPS: try Balanced or Low, or turn off 3D vehicles.' : '');
  }
  setInterval(() => { if (!panel.hidden && !document.hidden) update(); }, 1000);
  return { update, store };
}
