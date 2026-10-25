import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, createSettingsStore, frameInterval, normalize, pixelRatioFor, presetOf } from '../public/performance-settings.js';

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), data };
};

test('the default settings are the High preset and keep the original rendering behaviour', () => {
  assert.deepEqual(DEFAULTS, PRESETS.high);
  assert.equal(presetOf(DEFAULTS), 'high');
  assert.equal(frameInterval(DEFAULTS), 0, 'every display frame');
  assert.equal(pixelRatioFor(DEFAULTS, 2.5), 2.5, 'device pixel ratio');
  assert.equal(DEFAULTS.models3d, true);
  assert.deepEqual(createSettingsStore(memory()).get(), DEFAULTS);
});

test('presets apply their settings and a single change becomes Custom', () => {
  const store = createSettingsStore(memory());
  assert.deepEqual(store.applyPreset('low'), PRESETS.low);
  assert.equal(store.preset(), 'low');
  assert.equal(frameInterval(store.get()), 50);
  assert.equal(pixelRatioFor(store.get(), 2), 1);
  store.applyPreset('balanced');
  assert.equal(pixelRatioFor(store.get(), 2), 1.5);
  assert.equal(pixelRatioFor(store.get(), 1), 1, 'never raises the resolution');
  store.set({ models3d: false });
  assert.equal(store.preset(), 'custom');
  store.set({ models3d: true });
  assert.equal(store.preset(), 'balanced', 'matching a preset again names it');
  assert.throws(() => store.applyPreset('ultra'), RangeError);
  assert.deepEqual(store.reset(), DEFAULTS);
});

test('settings persist locally and invalid or unreadable storage falls back to the defaults', () => {
  const storage = memory();
  const changes = [];
  const store = createSettingsStore(storage);
  store.onChange(s => changes.push(s));
  store.set({ renderRate: 30 });
  assert.equal(changes.length, 1);
  assert.deepEqual(createSettingsStore(storage).get(), { ...DEFAULTS, renderRate: 30 });

  assert.deepEqual(createSettingsStore(memory({ 'london-map:performance': '{not json' })).get(), DEFAULTS);
  assert.deepEqual(normalize({ renderRate: 144, models3d: 'yes', pixelRatio: -1, population: 5 }), DEFAULTS, 'unknown values and keys are dropped');
  assert.deepEqual(normalize({ renderRate: '20', pixelRatio: '1' }), { ...DEFAULTS, renderRate: 20, pixelRatio: 1 });

  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const fallback = createSettingsStore(blocked);
  assert.deepEqual(fallback.get(), DEFAULTS);
  assert.equal(fallback.set({ models3d: false }).models3d, false, 'still works for this page');
});

test('local display settings never reach the shared simulation', async t => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no network expected'); };
  t.after(() => { globalThis.fetch = original; });
  const store = createSettingsStore(memory());
  for (const name of Object.keys(PRESETS)) store.applyPreset(name);
  store.set({ renderRate: 20, models3d: false, pixelRatio: 1 });
  store.reset();
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(store.get()).sort(), ['models3d', 'pixelRatio', 'renderRate'], 'no population or timing settings are local');
});
