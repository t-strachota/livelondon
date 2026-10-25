// Browser-only display settings (Performance tab). They change how much this browser draws, never the
// shared simulation. The defaults are the original behaviour, so "High" changes nothing.
const KEY = 'london-map:performance';

export const OPTIONS = {
  renderRate: [0, 30, 20], // vehicle position updates per second; 0 = every display frame
  pixelRatio: [0, 1.5, 1], // map resolution cap; 0 = the device's own pixel ratio
};
export const DEFAULTS = Object.freeze({ renderRate: 0, models3d: true, pixelRatio: 0 });
export const PRESETS = Object.freeze({
  high: DEFAULTS,
  balanced: Object.freeze({ renderRate: 30, models3d: true, pixelRatio: 1.5 }),
  low: Object.freeze({ renderRate: 20, models3d: false, pixelRatio: 1 }),
});

// Keeps only known keys with allowed values; anything else falls back to the default.
export function normalize(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    renderRate: OPTIONS.renderRate.includes(Number(v.renderRate)) ? Number(v.renderRate) : DEFAULTS.renderRate,
    models3d: typeof v.models3d === 'boolean' ? v.models3d : DEFAULTS.models3d,
    pixelRatio: OPTIONS.pixelRatio.includes(Number(v.pixelRatio)) ? Number(v.pixelRatio) : DEFAULTS.pixelRatio,
  };
}

export function presetOf(settings) {
  for (const [name, preset] of Object.entries(PRESETS)) if (Object.keys(preset).every(k => preset[k] === settings[k])) return name;
  return 'custom';
}

export const frameInterval = settings => settings.renderRate ? 1000 / settings.renderRate : 0;
export const pixelRatioFor = (settings, device) => settings.pixelRatio ? Math.min(device, settings.pixelRatio) : device;

// Settings kept in `storage` (localStorage-like; reads and writes may throw, e.g. in private windows).
export function createSettingsStore(storage) {
  let current;
  try { current = normalize(JSON.parse(storage?.getItem(KEY) ?? 'null')); } catch { current = normalize(null); }
  const listeners = new Set();
  const commit = next => {
    current = normalize(next);
    try { storage?.setItem(KEY, JSON.stringify(current)); } catch { /* Kept for this page only. */ }
    for (const fn of listeners) fn(current);
    return current;
  };
  return {
    get: () => current,
    preset: () => presetOf(current),
    set: patch => commit({ ...current, ...patch }),
    applyPreset: name => { if (!PRESETS[name]) throw new RangeError(`unknown preset ${name}`); return commit(PRESETS[name]); },
    reset: () => commit(DEFAULTS),
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// The page's shared store, created on first use.
let shared;
export function settings() {
  if (!shared) { let storage = null; try { storage = globalThis.localStorage ?? null; } catch { /* Blocked. */ } shared = createSettingsStore(storage); }
  return shared;
}

// 3D model fade-in for `zoom`: the usual crossfade, or 0 (2D dots at every zoom) with 3D vehicles off.
export const modelFadeFor = (fade, zoom) => settings().get().models3d ? fade(zoom) : 0;
