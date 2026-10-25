// Lightweight agent-based car simulation on a directed road graph (roads.json from build_roads.py).
// Cars follow edge polylines, use charged-particle-inspired following within their lane, and pick weighted random
// turns at junctions. Everything lives in typed arrays indexed by car ID, so IDs never change.
// Signalised junctions (OpenStreetMap locations) run simulated fixed-time cycles; live TfL timings
// are not available.
// shortcut: no turn bans or conflicts at unsignalised junctions, which behave like free merges.

import { LAPSE_CHANCE, PARAMS, PERSONALITIES, hash, personalityOf } from './personality.mjs';

export const CAR_LENGTH = 4.5;
const MIN_GAP = 2.0, HEADWAY = 1.2; // seeding spacing; driving uses per-car personality values (lib/personality.mjs)
const SLOT = CAR_LENGTH + MIN_GAP + 1; // safe initial spacing per car (m)
const LANE_WIDTH = 3.2;
const BIG_GAP = 1e4;
export const PARTICLE_GAP = 1.5 * CAR_LENGTH; // bumper-to-bumper, not centre-to-centre
const EMERGENCY_DECEL = 9;

// A bounded attraction and inverse-square short-range repulsion, damped by relative speed.
// Only the car ahead on the directed lane/path interacts: there are no forces across streets.
// This is a traffic heuristic, not electrostatics. Cruise speed and braking safety override the force.
export function particleAcceleration(speed, desired, gap, leaderSpeed, target, accel, decel, minGap, dt, response = .9) {
  const cruise = accel * Math.tanh((desired - speed) / 2);
  if (gap >= BIG_GAP) return cruise;
  const ratio = target / Math.max(.1, gap);
  const damping = response * Math.min(1, 4 * ratio * ratio);
  const force = accel * (1 - ratio * ratio) + damping * (leaderSpeed - speed);
  const safeSpeed = Math.sqrt(Math.max(0, leaderSpeed * leaderSpeed + 2 * decel * Math.max(0, gap - minGap)));
  return Math.max(-EMERGENCY_DECEL, Math.min(cruise, force, (safeSpeed - speed) / dt));
}
// Per-car typed arrays (grown together when extra cars are added).
const CAR_ARRAYS = ['edge', 'lane', 'pos', 'v', 'factor', 'next', 'nextLane', 'wait', 'seg', 'acc', 'order', 'sortKey', 'cooldown',
  'routeStep', 'back', 'goal', 'active', 'group', 'leaving', 'outside', 'kind', 'headway', 'pAccel', 'decel', 'minGap', 'laneGain'];
const ERROR_PRONE = PERSONALITIES.indexOf('error-prone');
const DETOUR_LIMIT = 20000; // junctions a detour search may expand before giving up
const REVERSE_SPEED = 4; // m/s while turned round and driving back from a road blocked by a closure
// Lane changing: a clear gain in room ahead, safe gaps in the target lane, and a pause between changes.
const CHANGE_COOLDOWN = 3, SAFE_BEHIND_HEADWAY = .6;
// Soft preference for the next road; any legal successor can be taken.
const POPULARITY = { motorway: 4, trunk: 3, primary: 3, secondary: 2, tertiary: 1.5, unclassified: 1, residential: 1, living_street: .5, service: .3 };
const HEADER = 24, MAGIC = 0x31504E53;
// Fixed-time signals: two phases per junction, each 40 s green + 3 s amber + 2 s all-red = 90 s cycle.
export const GREEN = 0, AMBER = 1, RED = 2;
export const CYCLE = 90;
const PHASE = CYCLE / 2, GREEN_SECONDS = 40, AMBER_SECONDS = 3;
// On amber a car stops if it can do so at this deceleration; otherwise it is committed and goes.
const AMBER_STOP_DECEL = 3;
const STOP_LINE_SETBACK = 6; // stop line (and drawn signal), metres before the junction node
export const SIGNAL_MAGIC = 0x31474953; // 'SIG1'

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CarSim {
  constructor(roads, { population, seed = 1, runId = 1 }) {
    this.runId = runId;
    this.seedValue = seed; // also fixes each car's personality (lib/personality.mjs)
    this.rng = mulberry32(seed);
    this.time = 0;
    const edges = roads.edges, E = edges.length;
    this.E = E;
    this.from = new Int32Array(E); this.to = new Int32Array(E);
    this.length = new Float32Array(E); this.speed = new Float32Array(E); this.lanes = new Uint8Array(E);
    this.twoWay = new Uint8Array(E); this.popularity = new Float32Array(E); this.cls = new Uint8Array(E);
    this.ptStart = new Int32Array(E + 1);
    let points = 0;
    for (let e = 0; e < E; e++) { this.ptStart[e] = points; points += edges[e][8].length / 2; }
    this.ptStart[E] = points;
    this.lon = new Float64Array(points); this.lat = new Float64Array(points); this.dist = new Float32Array(points);
    const mPerLat = 111_320, mPerLon = 111_320 * Math.cos(51.5 * Math.PI / 180);
    this.mPerLat = mPerLat; this.mPerLon = mPerLon;
    for (let e = 0; e < E; e++) {
      const [from, to, cls, lanes, speed, , twoWay, , coords] = edges[e];
      this.from[e] = from; this.to[e] = to; this.cls[e] = cls; this.lanes[e] = Math.max(1, lanes); this.speed[e] = speed; this.twoWay[e] = twoWay;
      this.popularity[e] = (POPULARITY[roads.classes[cls]] ?? 1) * this.lanes[e];
      let d = 0, p = this.ptStart[e];
      for (let k = 0; k < coords.length; k += 2, p++) {
        this.lon[p] = coords[k]; this.lat[p] = coords[k + 1];
        if (k) d += Math.hypot((coords[k] - coords[k - 2]) * mPerLon, (coords[k + 1] - coords[k - 1]) * mPerLat);
        this.dist[p] = d;
      }
      this.length[e] = Math.max(d, 1);
    }
    // Outgoing edges per node (CSR).
    this.outStart = new Int32Array(roads.nodes + 1);
    for (let e = 0; e < E; e++) this.outStart[this.from[e] + 1]++;
    for (let n = 0; n < roads.nodes; n++) this.outStart[n + 1] += this.outStart[n];
    this.out = new Int32Array(E);
    const fill = this.outStart.slice(0, roads.nodes);
    for (let e = 0; e < E; e++) this.out[fill[this.from[e]]++] = e;
    this.setupSignals(roads.signals ?? [], seed);
    // Road closures: OSM way id and name per edge (both directions of a road share the way id).
    this.wayId = Float64Array.from(edges, e => e[9] ?? -1); this.nameOf = Int32Array.from(edges, e => e[10] ?? -1);
    this.names = roads.names ?? [];
    this.closed = new Uint8Array(E); this.rerouted = 0;
    this.dead = new Uint8Array(E); // closed, or every way on from it ends at a closed road
    // Incoming edges per node (CSR), to back up along when a car has to turn round.
    this.inStart = new Int32Array(roads.nodes + 1);
    for (let e = 0; e < E; e++) this.inStart[this.to[e] + 1]++;
    for (let n = 0; n < roads.nodes; n++) this.inStart[n + 1] += this.inStart[n];
    this.inEdges = new Int32Array(E);
    const fillIn = this.inStart.slice(0, roads.nodes);
    for (let e = 0; e < E; e++) this.inEdges[fillIn[this.to[e]]++] = e;
    // Detour search (A*): node positions, per-search scratch arrays and a cache of found routes.
    this.nodes = roads.nodes;
    this.nodeLon = new Float64Array(roads.nodes); this.nodeLat = new Float64Array(roads.nodes);
    for (let e = 0; e < E; e++) {
      const p = this.ptStart[e], q = this.ptStart[e + 1] - 1;
      this.nodeLon[this.from[e]] = this.lon[p]; this.nodeLat[this.from[e]] = this.lat[p];
      this.nodeLon[this.to[e]] = this.lon[q]; this.nodeLat[this.to[e]] = this.lat[q];
    }
    this.maxSpeed = this.speed.reduce((a, b) => Math.max(a, b), 1);
    this.cost = new Float64Array(roads.nodes); this.via = new Int32Array(roads.nodes); this.stamp = new Uint32Array(roads.nodes); this.search = 0;
    this.heapKey = new Float64Array(E + 1); this.heapNode = new Int32Array(E + 1);
    this.detours = new Map();
    this.allocate(population);
  }

  // Per incoming edge: its signal (or -1) and phase (0/1, by approach axis). Offsets are seeded
  // separately so adding signals does not change where cars are placed.
  setupSignals(nodes, seed) {
    const E = this.E, rng = mulberry32(seed ^ 0x5161A1);
    this.signalOf = new Int32Array(E).fill(-1); this.edgePhase = new Uint8Array(E);
    this.signalOffset = Float32Array.from(nodes, () => rng() * CYCLE);
    const signalAt = new Map(nodes.map((node, s) => [node, s]));
    const axis = new Float32Array(E), approaches = nodes.map(() => []);
    for (let e = 0; e < E; e++) {
      const s = signalAt.get(this.to[e]);
      if (s === undefined) continue;
      const p = this.ptStart[e + 1] - 2;
      axis[e] = ((Math.atan2((this.lon[p + 1] - this.lon[p]) * this.mPerLon, (this.lat[p + 1] - this.lat[p]) * this.mPerLat) * 180 / Math.PI) + 360) % 180;
      this.signalOf[e] = s;
      approaches[s].push(e);
    }
    for (const list of approaches) {
      // Roughly north–south vs east–west; if that leaves one group empty, split by angle to the first approach.
      for (const e of list) this.edgePhase[e] = axis[e] >= 45 && axis[e] < 135 ? 1 : 0;
      if (list.length > 1 && list.every(e => this.edgePhase[e] === this.edgePhase[list[0]])) {
        for (const e of list) this.edgePhase[e] = Math.abs(((axis[e] - axis[list[0]]) % 180 + 270) % 180 - 90) > 45 ? 1 : 0;
      }
    }
    this.signalCount = nodes.length;
    this.approaches = Int32Array.from(approaches.flat());
    this.redHolds = 0;
  }

  // State of the signal at the end of edge e, from the simulation clock alone.
  signalState(e, t = this.time) {
    const s = this.signalOf[e];
    if (s < 0) return GREEN;
    const c = (t + this.signalOffset[s]) % CYCLE, phase = c < PHASE ? 0 : 1;
    if (this.edgePhase[e] !== phase) return RED;
    const local = c - phase * PHASE;
    return local < GREEN_SECONDS ? GREEN : local < GREEN_SECONDS + AMBER_SECONDS ? AMBER : RED;
  }

  // Static drawing positions for each approach's stop line: [lon, lat, lon, lat, ...] in approach order.
  approachPositions() {
    const out = new Float64Array(this.approaches.length * 2);
    this.approaches.forEach((e, k) => {
      const d = Math.max(0, this.length[e] - STOP_LINE_SETBACK);
      let p = this.ptStart[e];
      while (p < this.ptStart[e + 1] - 2 && this.dist[p + 1] < d) p++;
      const t = Math.min(1, (d - this.dist[p]) / (this.dist[p + 1] - this.dist[p] || 1));
      const dx = (this.lon[p + 1] - this.lon[p]) * this.mPerLon, dy = (this.lat[p + 1] - this.lat[p]) * this.mPerLat, norm = Math.hypot(dx, dy) || 1;
      const offset = this.twoWay[e] ? this.lanes[e] * LANE_WIDTH / 2 : 0; // middle of this direction's lanes
      out[2 * k] = this.lon[p] + (this.lon[p + 1] - this.lon[p]) * t - dy / norm * offset / this.mPerLon;
      out[2 * k + 1] = this.lat[p] + (this.lat[p + 1] - this.lat[p]) * t + dx / norm * offset / this.mPerLat;
    });
    return out;
  }

  // 'SIG1' frame of approach indices and states for approaches inside any [w, s, e, n] box.
  signalFrame(boxes, positions) {
    const indices = [];
    for (let k = 0; k < this.approaches.length; k++) {
      const lon = positions[2 * k], lat = positions[2 * k + 1];
      if (boxes.some(b => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3])) indices.push(k);
    }
    const n = indices.length, buffer = new ArrayBuffer(16 + n * 5), view = new DataView(buffer);
    view.setUint32(0, SIGNAL_MAGIC, true); view.setUint32(4, this.runId, true); view.setUint32(8, n, true);
    new Uint32Array(buffer, 16, n).set(indices);
    const states = new Uint8Array(buffer, 16 + 4 * n, n);
    for (let k = 0; k < n; k++) states[k] = this.signalState(this.approaches[indices[k]]);
    return buffer;
  }

  allocate(n) {
    this.n = n; this.baseN = n;
    // Extra cars (phase 2) get ids >= baseN; a switched-off slot (active 0) is skipped everywhere and reused.
    this.active = new Uint8Array(n).fill(1); this.group = new Int32Array(n).fill(-1); this.leaving = new Uint8Array(n);
    this.outside = new Uint8Array(n); this.groupActive = new Map();
    // Personality (index into PERSONALITIES) and its driving parameters, per car.
    this.kind = new Uint8Array(n); this.headway = new Float32Array(n); this.pAccel = new Float32Array(n);
    this.decel = new Float32Array(n); this.minGap = new Float32Array(n); this.laneGain = new Float32Array(n);
    this.edge = new Int32Array(n); this.lane = new Uint8Array(n); this.pos = new Float32Array(n);
    this.v = new Float32Array(n); this.factor = new Float32Array(n); this.next = new Int32Array(n); this.nextLane = new Uint8Array(n);
    this.wait = new Float32Array(n); this.seg = new Int32Array(n); this.acc = new Float32Array(n);
    this.order = new Uint32Array(n); this.sortKey = new Float64Array(n);
    this.rear = new Int32Array(this.E * 4).fill(-1); this.cooldown = new Float32Array(n);
    this.laneFirst = new Int32Array(this.E * 4); this.laneCount = new Int32Array(this.E * 4); this.claimed = new Uint8Array(this.E * 4);
    this.route = new Array(n).fill(null); this.routeStep = new Int32Array(n); // detour around a closure, if any
    this.back = new Uint8Array(n); this.goal = new Int32Array(n); // turned round, heading for node `goal` past a closure
    for (let i = 0; i < n; i++) { this.factor[i] = Math.min(1.2, Math.max(.8, 1 + .1 * this.gaussian())); this.assignPersonality(i); }
  }

  // Makes room for `total` cars, keeping every existing car (and id) as it is.
  grow(total) {
    if (total <= this.n) return;
    for (const name of CAR_ARRAYS) {
      const old = this[name], next = new old.constructor(total);
      next.set(old);
      this[name] = next;
    }
    this.active.fill(0, this.n); this.group.fill(-1, this.n);
    this.route.length = total; this.route.fill(null, this.n);
    this.n = total;
  }

  // Adds up to `count` cars for demand group `groupId` on roads drawn from `edges` (cumulative weights
  // `cumulative`), each only where its lane has room at the start of the road. Total cars stay <= maxTotal.
  // Returns how many were added.
  spawn(count, groupId, edges, cumulative, maxTotal) {
    let added = 0, active = 0;
    for (let i = 0; i < this.n; i++) active += this.active[i];
    let slot = this.baseN;
    for (let attempt = 0; added < count && attempt < count * 4 && active < maxTotal; attempt++) {
      const r = this.rng() * cumulative[cumulative.length - 1];
      let lo = 0, hi = edges.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < r) lo = mid + 1; else hi = mid; }
      const e = edges[lo], ln = Math.floor(this.rng() * this.lanes[e]), key = e * 4 + ln, rearCar = this.rear[key];
      if (this.dead[e] || (rearCar >= 0 && this.pos[rearCar] < SLOT)) continue; // no room to join here
      while (slot < this.n && this.active[slot]) slot++;
      if (slot >= this.n) this.grow(Math.max(this.n + 64, Math.ceil(this.n * 1.1)));
      const i = slot;
      this.edge[i] = e; this.lane[i] = ln; this.pos[i] = 0; this.v[i] = 0; this.wait[i] = 0; this.cooldown[i] = 0;
      this.factor[i] = Math.min(1.2, Math.max(.8, 1 + .1 * this.gaussian()));
      this.assignPersonality(i);
      this.seg[i] = this.ptStart[e]; this.back[i] = 0; this.route[i] = null; this.leaving[i] = 0;
      this.active[i] = 1; this.group[i] = groupId;
      this.rear[key] = i;
      this.pickNext(i, e);
      this.groupActive.set(groupId, (this.groupActive.get(groupId) ?? 0) + 1);
      added++; active++;
    }
    return added;
  }

  // Extra cars of `groupId` leave: each is switched off when it next reaches a junction.
  release(groupId) {
    for (let i = this.baseN; i < this.n; i++) if (this.active[i] && this.group[i] === groupId) this.leaving[i] = 1;
  }

  switchOff(i) {
    this.active[i] = 0; this.leaving[i] = 0; this.back[i] = 0; this.route[i] = null;
    const g = this.group[i];
    if (this.groupActive.has(g)) this.groupActive.set(g, this.groupActive.get(g) - 1);
    this.group[i] = -1;
  }

  // Sets car i's personality from the seed and its id (never from the simulation's random stream).
  assignPersonality(i) {
    const k = personalityOf(this.seedValue, i), p = PARAMS[PERSONALITIES[k]];
    this.kind[i] = k; this.headway[i] = p.headway; this.pAccel[i] = p.accel; this.decel[i] = p.decel; this.minGap[i] = p.minGap; this.laneGain[i] = p.laneGain;
    if (p.speed) this.factor[i] = p.speed[0] + (p.speed[1] - p.speed[0]) * hash(this.seedValue, i, 2);
  }

  // An error-prone car's lapse this simulated second: -1 none, 0 weaker relative-speed response, 1 speed wobble,
  // 2 hesitation at a junction. Seeded by (seed, id, second), so runs repeat exactly.
  lapse(i) {
    if (this.kind[i] !== ERROR_PRONE) return -1;
    const second = Math.floor(this.time);
    return hash(this.seedValue, i, 1000 + second) < LAPSE_CHANCE ? Math.floor(hash(this.seedValue, i, 5000 + second) * 3) : -1;
  }

  personalityCounts() {
    const counts = Object.fromEntries(PERSONALITIES.map(p => [p, 0]));
    for (let i = 0; i < this.n; i++) if (this.active[i]) counts[PERSONALITIES[this.kind[i]]]++;
    return counts;
  }

  gaussian() { return Math.sqrt(-2 * Math.log(1 - this.rng())) * Math.cos(2 * Math.PI * this.rng()); }

  laneCapacity(e) { return Math.floor(this.length[e] / SLOT); }

  capacity(weights) {
    let total = 0;
    for (let e = 0; e < this.E; e++) if (!weights || weights[e] > 0) total += this.laneCapacity(e) * this.lanes[e];
    return total;
  }

  // Moves every car to a new seeded position (IDs 0..population-1 are kept). Validates before
  // changing anything, so a refused re-seed leaves the current state untouched.
  reseed({ population = this.n, weights, speeds, runId = this.runId } = {}) {
    const capacity = this.capacity(weights);
    if (population > capacity) throw new Error(`requested ${population} cars but safe network capacity is ${capacity}`);
    if (population !== this.n || this.n !== this.baseN) this.allocate(population); // also drops extra cars
    this.runId = runId;
    this.seed(weights, speeds);
  }

  // Places every car (same IDs) by edge weight, at safe spacing, keeping `n` exact.
  // weights: optional per-edge weights (default lane-km × road popularity); speeds: optional observed m/s.
  seed(weights, speeds) {
    const E = this.E, n = this.n;
    const w = new Float64Array(E);
    for (let e = 0; e < E; e++) w[e] = this.laneCapacity(e) && !this.dead[e] ? (weights ? weights[e] : this.popularity[e] * this.length[e] * this.lanes[e]) : 0;
    const capacity = this.capacity(weights);
    if (n > capacity) throw new Error(`requested ${n} cars but safe network capacity is ${capacity}`);
    const counts = new Int32Array(E * 4);
    const cumulative = new Float64Array(E);
    let total = 0;
    for (let e = 0; e < E; e++) { total += w[e]; cumulative[e] = total; }
    for (let placed = 0, guard = 0; placed < n; guard++) {
      if (guard > n * 50) throw new Error('could not place cars: network too full');
      const r = this.rng() * total;
      let lo = 0, hi = E - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < r) lo = mid + 1; else hi = mid; }
      const lane = Math.floor(this.rng() * this.lanes[lo]);
      if (counts[lo * 4 + lane] >= this.laneCapacity(lo)) continue;
      counts[lo * 4 + lane]++;
      this.edge[placed] = lo; this.lane[placed] = lane; placed++;
    }
    // Even spacing on each lane, then a speed that is safe behind the car ahead.
    const seen = new Int32Array(E * 4);
    this.route.fill(null); this.back.fill(0);
    for (let i = 0; i < n; i++) {
      const e = this.edge[i], key = e * 4 + this.lane[i], count = counts[key];
      const spacing = this.length[e] / count;
      this.pos[i] = (seen[key]++ + .5) * spacing;
      const observed = speeds && Number.isFinite(speeds[e]) ? speeds[e] : this.speed[e] * .8;
      this.v[i] = Math.max(0, Math.min(observed, this.speed[e], this.speed[e] * this.factor[i], (spacing - CAR_LENGTH - MIN_GAP) / HEADWAY));
      this.cooldown[i] = 0;
      this.pickNext(i, e);
      this.wait[i] = 0;
      this.seg[i] = this.ptStart[e];
    }
    this.time = 0;
  }

  // Chooses the road after `e`, and the lane the car will enter it on.
  pickNext(i, e) {
    let next = -1;
    const route = this.route[i];
    if (route) { // following a detour; dropped if it no longer fits (car moved off it, or a road on it closed)
      const k = this.routeStep[i]++, c = route[k];
      if (k < route.length && this.from[c] === this.to[e] && !this.closed[c]) next = c;
      if (next < 0 || k + 1 >= route.length) this.route[i] = null;
    }
    if (next < 0) next = this.chooseNext(i, e);
    this.next[i] = next;
    this.nextLane[i] = Math.floor(this.rng() * this.lanes[next]);
  }

  chooseNext(i, e) {
    const node = this.to[e], start = this.outStart[node], end = this.outStart[node + 1];
    let total = 0;
    for (let k = start; k < end; k++) total += this.turnWeight(e, this.out[k]);
    let r = this.rng() * total, pick = this.out[end - 1];
    for (let k = start; k < end; k++) { r -= this.turnWeight(e, this.out[k]); if (r <= 0) { pick = this.out[k]; break; } }
    if (!this.dead[pick]) return pick; // with no closures, choices (and random draws) are exactly as before
    // The car wanted a closed road (or one that only leads into one): it detours to the far end of that
    // closed road by the quickest open route.
    let c = pick;
    for (let hops = 0; !this.closed[c] && hops < 1000; hops++) c = this.out[this.outStart[this.to[c]]]; // every way on is dead
    const route = this.findDetour(node, this.to[c]);
    if (route) {
      this.rerouted++;
      this.route[i] = route.length > 1 ? route : null; this.routeStep[i] = 1;
      return route[0];
    }
    // No way round within the search limit: re-pick from the open exits with the same weighting. With
    // none open, the car waits at the junction until one reopens.
    total = 0;
    for (let k = start; k < end; k++) if (!this.dead[this.out[k]]) total += this.turnWeight(e, this.out[k]);
    if (!total) return pick;
    this.rerouted++;
    r = this.rng() * total;
    for (let k = start; k < end; k++) {
      const c = this.out[k];
      if (this.dead[c]) continue;
      r -= this.turnWeight(e, c);
      if (r <= 0) return c;
    }
    for (let k = end - 1; k >= start; k--) if (!this.dead[this.out[k]]) return this.out[k];
    return pick;
  }

  // Closes or reopens edges in place. Cars already on a closed edge finish it; cars about to turn
  // into one re-pick now.
  setClosed(edges, closed) {
    for (const e of edges) this.closed[e] = closed ? 1 : 0;
    this.detours.clear(); // cached routes may cross a newly closed road, or miss a reopened shortcut
    // Dead roads: closed ones, then (backwards) any road whose every exit is dead.
    const { dead } = this, stack = [];
    dead.set(this.closed);
    for (let e = 0; e < this.E; e++) if (this.closed[e]) stack.push(e);
    while (stack.length) {
      const node = this.from[stack.pop()];
      let open = false;
      for (let m = this.outStart[node]; m < this.outStart[node + 1] && !open; m++) open = !dead[this.out[m]];
      if (open) continue;
      for (let k = this.inStart[node]; k < this.inStart[node + 1]; k++) {
        const x = this.inEdges[k];
        if (!dead[x]) { dead[x] = 1; stack.push(x); }
      }
    }
    // Re-pick for cars heading into a closed edge (on reopen, this frees cars that had no open exit).
    for (let i = 0; i < this.n; i++) if (this.active[i] && !this.back[i] && this.dead[this.next[i]]) this.pickNext(i, this.edge[i]);
  }

  // The road segment nearest (lon, lat) within `metres`, in both directions: [edge, reverse edge?], or null.
  nearestSegment(lon, lat, metres = 30) {
    let best = -1, bestD = metres;
    for (let e = 0; e < this.E; e++) {
      for (let p = this.ptStart[e]; p < this.ptStart[e + 1] - 1; p++) {
        const ax = (lon - this.lon[p]) * this.mPerLon, ay = (lat - this.lat[p]) * this.mPerLat;
        const dx = (this.lon[p + 1] - this.lon[p]) * this.mPerLon, dy = (this.lat[p + 1] - this.lat[p]) * this.mPerLat;
        const t = Math.max(0, Math.min(1, (ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(ax - t * dx, ay - t * dy);
        if (d < bestD) { bestD = d; best = e; }
      }
    }
    if (best < 0) return null;
    const pair = [best];
    for (let k = this.outStart[this.to[best]]; k < this.outStart[this.to[best] + 1]; k++) {
      const c = this.out[k];
      if (this.to[c] === this.from[best] && this.wayId[c] === this.wayId[best]) { pair.push(c); break; }
    }
    return pair;
  }

  // Quickest route (free-flow travel time) from node `start` to node `goal` on open roads, as edge ids,
  // or null. A* with a straight-line heuristic; cached until closures change.
  // shortcut: ignores live congestion and gives up after DETOUR_LIMIT nodes; upgrade if detours look odd.
  findDetour(start, goal) {
    const key = start * this.nodes + goal;
    if (this.detours.has(key)) return this.detours.get(key);
    const { cost, via, stamp, heapKey, heapNode } = this, mark = ++this.search;
    const h = node => Math.hypot((this.nodeLon[node] - this.nodeLon[goal]) * this.mPerLon, (this.nodeLat[node] - this.nodeLat[goal]) * this.mPerLat) / this.maxSpeed;
    let size = 0, expanded = 0, found = false;
    const push = (f, node) => {
      let k = size++;
      while (k > 0) { const p = (k - 1) >> 1; if (heapKey[p] <= f) break; heapKey[k] = heapKey[p]; heapNode[k] = heapNode[p]; k = p; }
      heapKey[k] = f; heapNode[k] = node;
    };
    const pop = () => {
      const top = heapNode[0], f = heapKey[--size], node = heapNode[size];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= size) break;
        if (c + 1 < size && heapKey[c + 1] < heapKey[c]) c++;
        if (heapKey[c] >= f) break;
        heapKey[k] = heapKey[c]; heapNode[k] = heapNode[c]; k = c;
      }
      heapKey[k] = f; heapNode[k] = node;
      return top;
    };
    stamp[start] = mark; cost[start] = 0; via[start] = -1; push(h(start), start);
    while (size && expanded++ < DETOUR_LIMIT) {
      const node = pop();
      if (node === goal) { found = true; break; }
      for (let k = this.outStart[node]; k < this.outStart[node + 1]; k++) {
        const e = this.out[k];
        if (this.dead[e] || size >= this.E) continue;
        const to = this.to[e], c = cost[node] + this.length[e] / this.speed[e];
        if (stamp[to] === mark && cost[to] <= c) continue;
        stamp[to] = mark; cost[to] = c; via[to] = e; push(c + h(to), to);
      }
    }
    let route = null;
    if (found && goal !== start) {
      const edges = [];
      for (let node = goal; node !== start; node = this.from[via[node]]) edges.push(via[node]);
      route = Int32Array.from(edges.reverse());
    }
    this.detours.set(key, route);
    return route;
  }

  roadName(e) { return this.names[this.nameOf[e]] || 'Unnamed road'; }

  edgeCoordinates(e) {
    const out = [];
    for (let p = this.ptStart[e]; p < this.ptStart[e + 1]; p++) out.push([+this.lon[p].toFixed(6), +this.lat[p].toFixed(6)]);
    return out;
  }

  turnWeight(e, candidate) {
    return this.popularity[candidate] * (this.to[candidate] === this.from[e] ? .02 : 1); // U-turns are a last resort
  }

  // Orders cars by lane then position, and indexes where each lane's run starts in that order.
  sortCars() {
    const n = this.n, { edge, lane, pos, order, sortKey, rear, laneFirst, laneCount } = this;
    const { back, active, outside } = this;
    // Turned-round cars drive back on the other side of the road, and switched-off cars are not on the
    // road at all: both sort last and are outside every lane.
    for (let i = 0; i < n; i++) { order[i] = i; outside[i] = back[i] || !active[i] ? 1 : 0; sortKey[i] = outside[i] ? 1e300 : (edge[i] * 4 + lane[i]) * 1e6 + pos[i]; }
    order.sort((a, b) => sortKey[a] - sortKey[b]);
    rear.fill(-1); laneCount.fill(0);
    for (let k = n - 1; k >= 0; k--) { if (outside[order[k]]) continue; const i = order[k], key = edge[i] * 4 + lane[i]; rear[key] = i; laneFirst[key] = k; laneCount[key]++; }
  }

  // Leader and follower around position `p` in lane `key`: [leader car or -1, follower car or -1].
  neighbours(key, p) {
    const { order, pos } = this, first = this.laneFirst[key], count = this.laneCount[key];
    let lo = 0, hi = count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pos[order[first + mid]] <= p) lo = mid + 1; else hi = mid; }
    return [lo < count ? order[first + lo] : -1, lo > 0 ? order[first + lo - 1] : -1];
  }

  changeLanes(dt) {
    const n = this.n, { edge, lane, pos, v, order, cooldown, claimed } = this;
    claimed.fill(0);
    let changes = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k], e = edge[i], lanes = this.lanes[e];
      cooldown[i] = Math.max(0, cooldown[i] - dt);
      if (lanes < 2 || cooldown[i] > 0 || this.outside[i]) continue;
      const j = k + 1 < n ? order[k + 1] : -1;
      const room = j >= 0 && !this.outside[j] && edge[j] === e && lane[j] === lane[i] ? pos[j] - pos[i] - CAR_LENGTH : this.length[e] - pos[i];
      if (room > 60 || this.length[e] - pos[i] < 30) continue; // no need, or too close to the junction
      for (const target of [lane[i] - 1, lane[i] + 1]) {
        if (target < 0 || target >= lanes) continue;
        const key = e * 4 + target;
        if (claimed[key]) continue; // one car into a lane per step, so two cars never take the same gap
        const [leader, follower] = this.neighbours(key, pos[i]);
        const ahead = leader >= 0 ? pos[leader] - pos[i] - CAR_LENGTH : this.length[e] - pos[i];
        const behind = follower >= 0 ? pos[i] - pos[follower] - CAR_LENGTH : BIG_GAP;
        if (ahead < room + this.laneGain[i] || ahead < this.minGap[i] + v[i] * this.headway[i] / 2) continue;
        if (behind < MIN_GAP + v[follower] * SAFE_BEHIND_HEADWAY) continue;
        lane[i] = target; cooldown[i] = CHANGE_COOLDOWN; claimed[key] = 1; changes++;
        break;
      }
    }
    this.laneChanges = (this.laneChanges ?? 0) + changes;
    return changes;
  }

  step(dt) {
    const n = this.n, { edge, lane, pos, v, factor, next, nextLane, acc, order, rear, back, outside, active } = this;
    this.sortCars();
    if (this.changeLanes(dt)) this.sortCars();
    for (let k = 0; k < n; k++) {
      const i = order[k], e = edge[i], key = e * 4 + lane[i];
      if (outside[i]) continue;
      let gap = BIG_GAP, leaderSpeed = v[i], obstacle = false;
      const j = k + 1 < n ? order[k + 1] : -1;
      if (j >= 0 && !outside[j] && edge[j] * 4 + lane[j] === key) {
        gap = pos[j] - pos[i] - CAR_LENGTH; leaderSpeed = v[j];
      } else {
        const toLine = this.length[e] - pos[i], light = this.signalOf[e] < 0 ? GREEN : this.signalState(e);
        // The stop line sits STOP_LINE_SETBACK before the junction node; a car already past it carries on
        // to the node and is held there by the red check below.
        const toStop = toLine - STOP_LINE_SETBACK;
        if (toStop > 0 && (light === RED || (light === AMBER && v[i] * v[i] <= 2 * AMBER_STOP_DECEL * toStop))) {
          gap = toStop; leaderSpeed = 0; obstacle = true; // stop line acts as a stationary leader
        } else {
          // Front of its lane: the rearmost car where it will enter the next road.
          const entry = rear[next[i] * 4 + nextLane[i]];
          if (this.closed[next[i]]) { // closed ahead: stop at the end, then take another exit or turn round
            gap = toLine; leaderSpeed = 0; obstacle = true;
            if (toLine < 3 && v[i] < .5) this.blockedAhead(i);
          }
          else if (entry >= 0) { gap = toLine + pos[entry] - CAR_LENGTH; leaderSpeed = v[entry]; }
        }
      }
      // Personalities retain acceleration/braking and a preferred gap between one and two lengths.
      // Signals/closures are barriers, not attractive cars, and retain a small stand-off distance.
      const lapse = this.lapse(i), accel = this.pAccel[i];
      const desired = Math.max(.1, Math.min(this.speed[e], this.speed[e] * factor[i] * (lapse === 1 ? 1 + .08 * Math.sin(this.time * 3 + i) : 1)));
      const target = obstacle ? this.minGap[i] : Math.max(CAR_LENGTH, Math.min(2 * CAR_LENGTH, PARTICLE_GAP * this.headway[i] / HEADWAY));
      acc[i] = particleAcceleration(v[i], desired, gap, leaderSpeed, target, accel, this.decel[i], this.minGap[i], dt, lapse === 0 ? .45 : .9);
    }
    for (let k = n - 1; k >= 0; k--) { // front cars first, so followers can be capped behind updated leaders
      const i = order[k];
      if (!active[i]) continue;
      if (back[i]) { this.driveBack(i, dt); continue; }
      const vNew = Math.min(this.speed[edge[i]], Math.max(0, v[i] + acc[i] * dt));
      let advance = (v[i] + vNew) / 2 * dt;
      const intendedAdvance = advance;
      const j = k + 1 < n ? order[k + 1] : -1;
      if (j >= 0 && !outside[j] && edge[j] === edge[i] && lane[j] === lane[i]) advance = Math.min(advance, Math.max(0, pos[j] - CAR_LENGTH - .5 - pos[i]));
      v[i] = advance < intendedAdvance ? Math.min(vNew, advance / dt) : vNew;
      pos[i] += advance;
      this.wait[i] = v[i] < .1 ? this.wait[i] + dt : 0;
      while (pos[i] > this.length[edge[i]]) {
        if (this.leaving[i]) { this.switchOff(i); break; } // an extra car leaves at its next junction
        if (this.lapse(i) === 2) { pos[i] = this.length[edge[i]]; v[i] = 0; break; } // error-prone: hesitates at the junction
        // Never enter a junction on red (a committed amber car that is still short of the line stops there).
        if (this.signalOf[edge[i]] >= 0 && this.signalState(edge[i]) === RED) { pos[i] = this.length[edge[i]]; v[i] = 0; this.redHolds++; break; }
        // Enter the next road only where there is room behind its rearmost car in the chosen lane
        // (another car may have just merged in); otherwise wait at the end of this road.
        const ne = next[i], key = ne * 4 + nextLane[i], r = rear[key];
        if (this.closed[ne]) { pos[i] = this.length[edge[i]]; v[i] = 0; this.blockedAhead(i); break; }
        const over = pos[i] - this.length[edge[i]], room = r >= 0 ? pos[r] - CAR_LENGTH - .5 : Infinity;
        if (room < 0) { pos[i] = this.length[edge[i]]; v[i] = 0; break; }
        if (over > room) v[i] = Math.min(v[i], v[r]);
        pos[i] = Math.min(over, room);
        edge[i] = ne; lane[i] = nextLane[i];
        v[i] = Math.min(v[i], this.speed[ne]);
        if (r < 0 || pos[i] < pos[r]) rear[key] = i;
        this.pickNext(i, ne);
        this.seg[i] = this.ptStart[ne];
      }
    }
    this.time += dt;
  }

  // Car i has stopped with a closed road ahead: take another open exit if there is one, else turn round.
  blockedAhead(i) {
    this.pickNext(i, this.edge[i]);
    if (this.closed[this.next[i]]) { this.back[i] = 1; this.goal[i] = this.to[this.next[i]]; this.route[i] = null; }
  }

  // A turned-round car drives back along its road. At the first junction with an open way on it takes
  // the quickest open route to `goal` (past the closure); at a junction whose exits all lead into the
  // closure it keeps backing up along a road into that junction.
  driveBack(i, dt) {
    const { edge, pos, v } = this;
    v[i] = Math.min(REVERSE_SPEED, this.speed[edge[i]]); pos[i] -= v[i] * dt; this.wait[i] = 0;
    if (pos[i] > 0) return;
    const node = this.from[edge[i]];
    let open = false;
    for (let k = this.outStart[node]; k < this.outStart[node + 1] && !open; k++) open = !this.dead[this.out[k]];
    if (open) {
      const route = this.findDetour(node, this.goal[i]);
      let first = route ? route[0] : -1;
      if (first < 0) for (let k = this.outStart[node]; k < this.outStart[node + 1] && first < 0; k++) if (!this.dead[this.out[k]]) first = this.out[k];
      const ln = Math.floor(this.rng() * this.lanes[first]), key = first * 4 + ln, r = this.rear[key];
      if (r >= 0 && this.pos[r] < CAR_LENGTH + .5) { pos[i] = 0; v[i] = 0; return; } // wait for room to pull in
      edge[i] = first; this.lane[i] = ln; pos[i] = 0; v[i] = 0; this.back[i] = 0; this.seg[i] = this.ptStart[first];
      this.rear[key] = i;
      this.route[i] = route && route.length > 1 ? route : null; this.routeStep[i] = 1;
      this.rerouted++;
      this.pickNext(i, first);
      return;
    }
    for (let k = this.inStart[node]; k < this.inStart[node + 1]; k++) {
      const x = this.inEdges[k];
      if (this.closed[x]) continue;
      edge[i] = x; pos[i] = this.length[x]; this.seg[i] = this.ptStart[x];
      return;
    }
    pos[i] = 0; v[i] = 0; // nowhere to back into: wait until a road reopens
  }

  stats(gridlockSeconds = 120) {
    let speed = 0, gridlocked = 0, cars = 0, extra = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.active[i]) continue;
      cars++; if (this.group[i] >= 0) extra++; // stop-tool demand groups; time-of-day cars use group -2
      speed += this.v[i]; if (this.wait[i] > gridlockSeconds) gridlocked++;
    }
    return { averageSpeedMps: cars ? speed / cars : 0, gridlocked, extraCars: extra, fleet: cars - extra };
  }

  // Position on the polyline, offset to the left of travel (UK) by lane; heading in degrees from north.
  locate(i, out) {
    const e = this.edge[i], end = this.ptStart[e + 1] - 1;
    let p = this.seg[i];
    while (p < end - 1 && this.dist[p + 1] < this.pos[i]) p++;
    while (p > this.ptStart[e] && this.dist[p] > this.pos[i]) p--;
    this.seg[i] = p;
    const span = this.dist[p + 1] - this.dist[p] || 1, t = Math.min(1, Math.max(0, (this.pos[i] - this.dist[p]) / span));
    const dx = (this.lon[p + 1] - this.lon[p]) * this.mPerLon, dy = (this.lat[p + 1] - this.lat[p]) * this.mPerLat;
    const norm = Math.hypot(dx, dy) || 1, lanes = this.lanes[e];
    const offset = this.back[i] ? -(this.twoWay[e] ? .5 : (lanes - 1) / 2 + 1) * LANE_WIDTH
      : this.twoWay[e] ? (this.lane[i] + .5) * LANE_WIDTH : (this.lane[i] - (lanes - 1) / 2) * LANE_WIDTH;
    out[0] = this.lon[p] + (this.lon[p + 1] - this.lon[p]) * t - dy / norm * offset / this.mPerLon;
    out[1] = this.lat[p] + (this.lat[p + 1] - this.lat[p]) * t + dx / norm * offset / this.mPerLat;
    out[2] = (Math.atan2(dx, dy) * 180 / Math.PI + (this.back[i] ? 540 : 360)) % 360;
    return out;
  }

  // Same columnar format the browser decodes (see lib/simulation.mjs).
  snapshot() {
    let n = 0;
    for (let i = 0; i < this.n; i++) n += this.active[i]; // switched-off extra slots are left out; ids say who is who
    const buffer = new ArrayBuffer(HEADER + n * 24), view = new DataView(buffer);
    view.setUint32(0, MAGIC, true); view.setUint32(4, this.runId, true); view.setFloat64(8, this.time, true);
    view.setUint32(16, n, true); view.setUint32(20, 0, true);
    const ids = new Uint32Array(buffer, HEADER, n), lon = new Int32Array(buffer, HEADER + 4 * n, n), lat = new Int32Array(buffer, HEADER + 8 * n, n);
    const lane = new Uint32Array(buffer, HEADER + 12 * n, n), lanePos = new Float32Array(buffer, HEADER + 16 * n, n);
    const angle = new Uint16Array(buffer, HEADER + 20 * n, n), speed = new Uint16Array(buffer, HEADER + 22 * n, n);
    const out = [0, 0, 0];
    for (let i = 0, k = 0; i < this.n; i++) {
      if (!this.active[i]) continue;
      this.locate(i, out);
      ids[k] = i; lon[k] = Math.round(out[0] * 1e7); lat[k] = Math.round(out[1] * 1e7);
      lane[k] = this.edge[i] * 4 + this.lane[i]; lanePos[k] = this.pos[i];
      angle[k] = Math.round(out[2] * 100) % 36000; speed[k] = Math.min(65535, Math.round(this.v[i] * 100));
      k++;
    }
    return buffer;
  }
}
