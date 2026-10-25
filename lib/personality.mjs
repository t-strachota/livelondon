// Car personalities: each car's is fixed by the run seed and its id, so it never changes and the browser
// can work it out too. They only set existing IDM and lane-change parameters; the engine's hard rules
// (no overlaps, room to enter a road) still override them. Change the mix and parameters here.
export const PERSONALITIES = ['aggressive', 'neutral', 'calm', 'error-prone'];
export const MIX = [.20, .45, .25, .10]; // same order as PERSONALITIES
export const PARAMS = {
  // speed: desired-speed factor range (null keeps the car's usual 0.8-1.2 factor); headway s; accel and
  // decel m/s²; minGap m; laneGain m of extra room needed before changing lanes (lower = overtakes more).
  aggressive: { speed: [1.1, 1.2], headway: .9, accel: 2.0, decel: 2.5, minGap: 1.6, laneGain: 8 },
  neutral: { speed: null, headway: 1.2, accel: 1.5, decel: 2.0, minGap: 2.0, laneGain: 15 },
  calm: { speed: [.85, .95], headway: 1.6, accel: 1.1, decel: 1.5, minGap: 2.5, laneGain: 45 },
  'error-prone': { speed: null, headway: 1.2, accel: 1.5, decel: 2.0, minGap: 2.0, laneGain: 15 },
};
// Error-prone lapses: in a given simulated second a lapse happens with this chance and lasts that second.
export const LAPSE_CHANCE = .05;
export const COLOURS = { aggressive: '#e4572e', neutral: '#1f1f1f', calm: '#2a9d8f', 'error-prone': '#f2b705' };

// Deterministic hash of (seed, id, salt) to [0, 1).
export function hash(seed, id, salt = 0) {
  let h = Math.imul((seed | 0) ^ Math.imul(id + 1, 0x9E3779B1), 0x85EBCA77) ^ Math.imul(salt + 0x51ED27, 0xC2B2AE3D);
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Index into PERSONALITIES for car `id` of a run with `seed`.
export function personalityOf(seed, id) {
  let r = hash(seed, id, 1);
  for (let k = 0; k < MIX.length; k++) { if (r < MIX[k]) return k; r -= MIX[k]; }
  return 1;
}
