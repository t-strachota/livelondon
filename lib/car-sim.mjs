// Lightweight agent-based car simulation on a directed road graph (roads.json from build_roads.py).
// Cars follow edge polylines, use IDM car-following within their lane, and pick weighted random
// turns at junctions. Everything lives in typed arrays indexed by car ID, so IDs never change.
// Signalised junctions (OpenStreetMap locations) run simulated fixed-time cycles; live TfL timings
// are not available.
// shortcut: no turn bans or conflicts at unsignalised junctions, which behave like free merges.

export const CAR_LENGTH = 4.5;
const MIN_GAP = 2.0, HEADWAY = 1.2, ACCEL = 1.5, COMFORT_DECEL = 2.0;
const SLOT = CAR_LENGTH + MIN_GAP + 1; // safe initial spacing per car (m)
const LANE_WIDTH = 3.2;
const BIG_GAP = 1e4;
// Lane changing: a clear gain in room ahead, safe gaps in the target lane, and a pause between changes.
const CHANGE_GAIN = 15, CHANGE_COOLDOWN = 3, SAFE_BEHIND_HEADWAY = .6;
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
    this.n = n;
    this.edge = new Int32Array(n); this.lane = new Uint8Array(n); this.pos = new Float32Array(n);
    this.v = new Float32Array(n); this.factor = new Float32Array(n); this.next = new Int32Array(n); this.nextLane = new Uint8Array(n);
    this.wait = new Float32Array(n); this.seg = new Int32Array(n); this.acc = new Float32Array(n);
    this.order = new Uint32Array(n); this.sortKey = new Float64Array(n);
    this.rear = new Int32Array(this.E * 4).fill(-1); this.cooldown = new Float32Array(n);
    this.laneFirst = new Int32Array(this.E * 4); this.laneCount = new Int32Array(this.E * 4); this.claimed = new Uint8Array(this.E * 4);
    for (let i = 0; i < n; i++) this.factor[i] = Math.min(1.2, Math.max(.8, 1 + .1 * this.gaussian()));
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
    if (population !== this.n) this.allocate(population);
    this.runId = runId;
    this.seed(weights, speeds);
  }

  // Places every car (same IDs) by edge weight, at safe spacing, keeping `n` exact.
  // weights: optional per-edge weights (default lane-km × road popularity); speeds: optional observed m/s.
  seed(weights, speeds) {
    const E = this.E, n = this.n;
    const w = new Float64Array(E);
    for (let e = 0; e < E; e++) w[e] = this.laneCapacity(e) ? (weights ? weights[e] : this.popularity[e] * this.length[e] * this.lanes[e]) : 0;
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
    for (let i = 0; i < n; i++) {
      const e = this.edge[i], key = e * 4 + this.lane[i], count = counts[key];
      const spacing = this.length[e] / count;
      this.pos[i] = (seen[key]++ + .5) * spacing;
      const observed = speeds && Number.isFinite(speeds[e]) ? speeds[e] : this.speed[e] * .8;
      this.v[i] = Math.max(0, Math.min(observed, this.speed[e] * this.factor[i], (spacing - CAR_LENGTH - MIN_GAP) / HEADWAY));
      this.cooldown[i] = 0;
      this.pickNext(i, e);
      this.wait[i] = 0;
      this.seg[i] = this.ptStart[e];
    }
    this.time = 0;
  }

  // Chooses the road after `e`, and the lane the car will enter it on.
  pickNext(i, e) {
    const next = this.next[i] = this.chooseNext(e);
    this.nextLane[i] = Math.floor(this.rng() * this.lanes[next]);
  }

  chooseNext(e) {
    const node = this.to[e], start = this.outStart[node], end = this.outStart[node + 1];
    let total = 0;
    for (let k = start; k < end; k++) total += this.turnWeight(e, this.out[k]);
    let r = this.rng() * total;
    for (let k = start; k < end; k++) { r -= this.turnWeight(e, this.out[k]); if (r <= 0) return this.out[k]; }
    return this.out[end - 1];
  }

  turnWeight(e, candidate) {
    return this.popularity[candidate] * (this.to[candidate] === this.from[e] ? .02 : 1); // U-turns are a last resort
  }

  // Orders cars by lane then position, and indexes where each lane's run starts in that order.
  sortCars() {
    const n = this.n, { edge, lane, pos, order, sortKey, rear, laneFirst, laneCount } = this;
    for (let i = 0; i < n; i++) { order[i] = i; sortKey[i] = (edge[i] * 4 + lane[i]) * 1e6 + pos[i]; }
    order.sort((a, b) => sortKey[a] - sortKey[b]);
    rear.fill(-1); laneCount.fill(0);
    for (let k = n - 1; k >= 0; k--) { const i = order[k], key = edge[i] * 4 + lane[i]; rear[key] = i; laneFirst[key] = k; laneCount[key]++; }
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
      if (lanes < 2 || cooldown[i] > 0) continue;
      const j = k + 1 < n ? order[k + 1] : -1;
      const room = j >= 0 && edge[j] === e && lane[j] === lane[i] ? pos[j] - pos[i] - CAR_LENGTH : this.length[e] - pos[i];
      if (room > 60 || this.length[e] - pos[i] < 30) continue; // no need, or too close to the junction
      for (const target of [lane[i] - 1, lane[i] + 1]) {
        if (target < 0 || target >= lanes) continue;
        const key = e * 4 + target;
        if (claimed[key]) continue; // one car into a lane per step, so two cars never take the same gap
        const [leader, follower] = this.neighbours(key, pos[i]);
        const ahead = leader >= 0 ? pos[leader] - pos[i] - CAR_LENGTH : this.length[e] - pos[i];
        const behind = follower >= 0 ? pos[i] - pos[follower] - CAR_LENGTH : BIG_GAP;
        if (ahead < room + CHANGE_GAIN || ahead < MIN_GAP + v[i] * HEADWAY / 2) continue;
        if (behind < MIN_GAP + v[follower] * SAFE_BEHIND_HEADWAY) continue;
        lane[i] = target; cooldown[i] = CHANGE_COOLDOWN; claimed[key] = 1; changes++;
        break;
      }
    }
    this.laneChanges = (this.laneChanges ?? 0) + changes;
    return changes;
  }

  step(dt) {
    const n = this.n, { edge, lane, pos, v, factor, next, nextLane, acc, order, rear } = this;
    this.sortCars();
    if (this.changeLanes(dt)) this.sortCars();
    for (let k = 0; k < n; k++) {
      const i = order[k], e = edge[i], key = e * 4 + lane[i];
      let gap = BIG_GAP, leaderSpeed = v[i];
      const j = k + 1 < n ? order[k + 1] : -1;
      if (j >= 0 && edge[j] * 4 + lane[j] === key) {
        gap = pos[j] - pos[i] - CAR_LENGTH; leaderSpeed = v[j];
      } else {
        const toLine = this.length[e] - pos[i], light = this.signalOf[e] < 0 ? GREEN : this.signalState(e);
        // The stop line sits STOP_LINE_SETBACK before the junction node; a car already past it carries on
        // to the node and is held there by the red check below.
        const toStop = toLine - STOP_LINE_SETBACK;
        if (toStop > 0 && (light === RED || (light === AMBER && v[i] * v[i] <= 2 * AMBER_STOP_DECEL * toStop))) {
          gap = toStop; leaderSpeed = 0; // stop line acts as a stationary leader
        } else {
          // Front of its lane: the rearmost car where it will enter the next road.
          const entry = rear[next[i] * 4 + nextLane[i]];
          if (entry >= 0) { gap = toLine + pos[entry] - CAR_LENGTH; leaderSpeed = v[entry]; }
        }
      }
      const desired = this.speed[e] * factor[i];
      const s = Math.max(.1, gap);
      const sStar = MIN_GAP + Math.max(0, v[i] * HEADWAY + v[i] * (v[i] - leaderSpeed) / (2 * Math.sqrt(ACCEL * COMFORT_DECEL)));
      acc[i] = ACCEL * (1 - (v[i] / desired) ** 4 - (sStar / s) ** 2);
    }
    for (let k = n - 1; k >= 0; k--) { // front cars first, so followers can be capped behind updated leaders
      const i = order[k];
      const vNew = Math.max(0, v[i] + acc[i] * dt);
      let advance = (v[i] + vNew) / 2 * dt;
      const j = k + 1 < n ? order[k + 1] : -1;
      if (j >= 0 && edge[j] === edge[i] && lane[j] === lane[i]) advance = Math.min(advance, Math.max(0, pos[j] - CAR_LENGTH - .5 - pos[i]));
      v[i] = advance === 0 ? 0 : vNew;
      pos[i] += advance;
      this.wait[i] = v[i] < .1 ? this.wait[i] + dt : 0;
      while (pos[i] > this.length[edge[i]]) {
        // Never enter a junction on red (a committed amber car that is still short of the line stops there).
        if (this.signalOf[edge[i]] >= 0 && this.signalState(edge[i]) === RED) { pos[i] = this.length[edge[i]]; v[i] = 0; this.redHolds++; break; }
        // Enter the next road only where there is room behind its rearmost car in the chosen lane
        // (another car may have just merged in); otherwise wait at the end of this road.
        const ne = next[i], key = ne * 4 + nextLane[i], r = rear[key];
        const over = pos[i] - this.length[edge[i]], room = r >= 0 ? pos[r] - CAR_LENGTH - .5 : Infinity;
        if (room < 0) { pos[i] = this.length[edge[i]]; v[i] = 0; break; }
        if (over > room) v[i] = Math.min(v[i], v[r]);
        pos[i] = Math.min(over, room);
        edge[i] = ne; lane[i] = nextLane[i];
        if (r < 0 || pos[i] < pos[r]) rear[key] = i;
        this.pickNext(i, ne);
        this.seg[i] = this.ptStart[ne];
      }
    }
    this.time += dt;
  }

  stats(gridlockSeconds = 120) {
    let speed = 0, gridlocked = 0;
    for (let i = 0; i < this.n; i++) { speed += this.v[i]; if (this.wait[i] > gridlockSeconds) gridlocked++; }
    return { averageSpeedMps: this.n ? speed / this.n : 0, gridlocked };
  }

  // Position on the polyline, offset to the left of travel (UK) by lane; heading in degrees from north.
  locate(i, out) {
    const e = this.edge[i], end = this.ptStart[e + 1] - 1;
    let p = this.seg[i];
    while (p < end - 1 && this.dist[p + 1] < this.pos[i]) p++;
    this.seg[i] = p;
    const span = this.dist[p + 1] - this.dist[p] || 1, t = Math.min(1, Math.max(0, (this.pos[i] - this.dist[p]) / span));
    const dx = (this.lon[p + 1] - this.lon[p]) * this.mPerLon, dy = (this.lat[p + 1] - this.lat[p]) * this.mPerLat;
    const norm = Math.hypot(dx, dy) || 1, lanes = this.lanes[e];
    const offset = this.twoWay[e] ? (this.lane[i] + .5) * LANE_WIDTH : (this.lane[i] - (lanes - 1) / 2) * LANE_WIDTH;
    out[0] = this.lon[p] + (this.lon[p + 1] - this.lon[p]) * t - dy / norm * offset / this.mPerLon;
    out[1] = this.lat[p] + (this.lat[p + 1] - this.lat[p]) * t + dx / norm * offset / this.mPerLat;
    out[2] = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    return out;
  }

  // Same columnar format the browser decodes (see lib/simulation.mjs).
  snapshot() {
    const n = this.n, buffer = new ArrayBuffer(HEADER + n * 24), view = new DataView(buffer);
    view.setUint32(0, MAGIC, true); view.setUint32(4, this.runId, true); view.setFloat64(8, this.time, true);
    view.setUint32(16, n, true); view.setUint32(20, 0, true);
    const ids = new Uint32Array(buffer, HEADER, n), lon = new Int32Array(buffer, HEADER + 4 * n, n), lat = new Int32Array(buffer, HEADER + 8 * n, n);
    const lane = new Uint32Array(buffer, HEADER + 12 * n, n), lanePos = new Float32Array(buffer, HEADER + 16 * n, n);
    const angle = new Uint16Array(buffer, HEADER + 20 * n, n), speed = new Uint16Array(buffer, HEADER + 22 * n, n);
    const out = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      this.locate(i, out);
      ids[i] = i; lon[i] = Math.round(out[0] * 1e7); lat[i] = Math.round(out[1] * 1e7);
      lane[i] = this.edge[i] * 4 + this.lane[i]; lanePos[i] = this.pos[i];
      angle[i] = Math.round(out[2] * 100) % 36000; speed[i] = Math.min(65535, Math.round(this.v[i] * 100));
    }
    return buffer;
  }
}
