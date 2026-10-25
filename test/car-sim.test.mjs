import test from 'node:test';
import assert from 'node:assert/strict';
import { CarSim, CAR_LENGTH, CYCLE, GREEN, RED, particleAcceleration, PARTICLE_GAP } from '../lib/car-sim.mjs';
import { squareRoads } from './fixtures.mjs';

function sameLaneGaps(sim) {
  const lanes = new Map();
  for (let i = 0; i < sim.n; i++) {
    const key = sim.edge[i] * 4 + sim.lane[i];
    lanes.set(key, [...(lanes.get(key) ?? []), sim.pos[i]]);
  }
  return [...lanes.values()].flatMap(list => list.sort((a, b) => a - b).slice(1).map((p, k) => p - list[k]));
}

test('seeding places exactly the requested cars at safe spacing and refuses over-capacity', () => {
  const sim = new CarSim(squareRoads(), { population: 150, seed: 4 });
  sim.seed();
  assert.equal(sim.n, 150);
  assert.ok(Math.min(...sameLaneGaps(sim)) >= CAR_LENGTH + 2);
  const full = new CarSim(squareRoads(), { population: 1000, seed: 4 });
  assert.throws(() => full.seed(), /safe network capacity/);
});

test('cars keep their IDs, never overlap in a lane and keep moving for 10 simulated minutes', () => {
  const sim = new CarSim(squareRoads(), { population: 120, seed: 9 });
  sim.seed();
  const travelled = new Float64Array(sim.n);
  for (let k = 0; k < 3000; k++) {
    sim.step(.2);
    for (let i = 0; i < sim.n; i++) travelled[i] += sim.v[i] * .2;
    if (k % 100 === 0) assert.ok(Math.min(...sameLaneGaps(sim)) >= CAR_LENGTH - 1e-3, `overlap at step ${k}`);
  }
  assert.equal(sim.n, 120);
  assert.ok(travelled.every(d => d > 500), 'every car keeps driving');
  assert.equal(sim.stats().gridlocked, 0);
});

// Two cars on one lane: the leader held at 300 m, the follower starting at 0 m doing 13 m/s.
function stoppedLeader(edge) {
  const sim = new CarSim(squareRoads(), { population: 2, seed: 1 });
  sim.seed();
  sim.edge.set([edge, edge]); sim.lane.set([0, 0]); sim.pos.set([300, 0]); sim.v.set([0, 13]); sim.seg.set([sim.ptStart[edge], sim.ptStart[edge]]);
  return sim;
}

test('a follower brakes to a stop behind a stopped car on a single-lane road', () => {
  const sim = stoppedLeader(2);
  for (let k = 0; k < 300; k++) { sim.step(.2); sim.v[0] = 0; sim.pos[0] = 300; }
  assert.equal(sim.lane[1], 0);
  assert.ok(sim.v[1] < .1);
  assert.ok(300 - sim.pos[1] >= CAR_LENGTH, `gap ${300 - sim.pos[1]}`);
  assert.ok(300 - sim.pos[1] <= CAR_LENGTH * 3 + .2, "settles within two car lengths bumper-to-bumper");
});

test('on a two-lane road the follower changes lane and passes instead', () => {
  const sim = stoppedLeader(0);
  let passed = false;
  for (let k = 0; k < 300 && !passed; k++) {
    sim.step(.2); sim.v[0] = 0; sim.pos[0] = 300;
    if (sim.edge[1] === 0 && sim.lane[1] === 0) assert.ok(sim.pos[1] <= 300 - CAR_LENGTH + 1e-3, 'never drives through the stopped car');
    passed = sim.edge[1] !== 0 || sim.pos[1] > 300;
  }
  assert.ok(passed);
  assert.equal(sim.laneChanges, 1);
});

test('snapshots follow the road polyline, offset to the left in lanes', () => {
  const sim = new CarSim(squareRoads(), { population: 40, seed: 2 });
  sim.seed();
  for (let k = 0; k < 20; k++) sim.step(.2);
  const view = new DataView(sim.snapshot());
  assert.equal(view.getUint32(16, true), 40);
  for (let i = 0; i < 40; i++) {
    const lon = view.getInt32(24 + 160 + 4 * i, true) / 1e7, lat = view.getInt32(24 + 320 + 4 * i, true) / 1e7;
    // Every road here is a straight side of the square: distance from it is just the lane offset.
    const e = sim.edge[i], horizontal = e < 2 || (e >= 4 && e < 6);
    const off = horizontal ? Math.abs(lat - sim.lat[sim.ptStart[e]]) * 111_320 : Math.abs(lon - sim.lon[sim.ptStart[e]]) * sim.mPerLon;
    assert.ok(off > 1 && off < 7, `car ${i} is ${off.toFixed(1)} m from its road`);
    // Driving on the left: eastbound (edge 0) cars sit north of the centre line.
    if (e === 0) assert.ok(lat > sim.lat[sim.ptStart[0]]);
  }
});

// Signal at node 1: edge 0 arrives eastbound, edge 3 southbound, so they get opposite phases.
const signalRoads = () => ({ ...squareRoads(), signals: [1] });

test('signals: two approaches get opposite phases and the same seed gives the same states', () => {
  const a = new CarSim(signalRoads(), { population: 10, seed: 7 }), b = new CarSim(signalRoads(), { population: 10, seed: 7 });
  assert.deepEqual([...a.approaches].sort(), [0, 3]);
  assert.notEqual(a.edgePhase[0], a.edgePhase[3]);
  for (let t = 0; t < CYCLE; t += .5) {
    assert.equal(a.signalState(0, t), b.signalState(0, t));
    assert.ok(a.signalState(0, t) === RED || a.signalState(3, t) === RED, 'never both moving');
  }
  assert.equal(a.signalState(1), GREEN, 'unsignalised edge');
});

test('signals: no car runs a red; ids, counts and spacing hold for 10,000 steps', () => {
  const sim = new CarSim(signalRoads(), { population: 120, seed: 9 });
  sim.seed();
  const ids = [...new Uint32Array(sim.snapshot(), 24, sim.n)], before = new Int32Array(sim.n);
  for (let k = 0; k < 10000; k++) {
    before.set(sim.edge);
    const t = sim.time;
    sim.step(.2);
    for (let i = 0; i < sim.n; i++) {
      if (sim.edge[i] !== before[i] && sim.signalOf[before[i]] >= 0) assert.notEqual(sim.signalState(before[i], t), RED, `car ${i} ran a red at ${t}`);
    }
    if (k % 500 === 0) assert.ok(Math.min(...sameLaneGaps(sim)) >= CAR_LENGTH - 1e-3, `overlap at step ${k}`);
  }
  assert.equal(sim.n, 120);
  assert.deepEqual([...new Uint32Array(sim.snapshot(), 24, sim.n)], ids);
});

test('signals: a queue forms at red and discharges on green', () => {
  const sim = new CarSim(signalRoads(), { population: 4, seed: 3 });
  sim.seed();
  let t = 0; // first moment edge 0 turns red
  while (!(sim.signalState(0, t) === RED && sim.signalState(0, t - .2) !== RED)) t += .2;
  sim.time = t;
  for (let i = 0; i < 4; i++) { sim.edge[i] = 0; sim.lane[i] = i % 2; sim.pos[i] = 250 - 30 * Math.floor(i / 2); sim.v[i] = 10; sim.seg[i] = sim.ptStart[0]; }
  let k = 0;
  for (; sim.signalState(0) === RED; k++) sim.step(.2);
  assert.ok(k > 100, 'red lasts a while');
  assert.ok([...sim.edge].every(e => e === 0), 'nobody crossed on red');
  assert.ok([...sim.v].every(v => v < .1), 'whole queue stopped');
  assert.ok(Math.max(...sim.pos) <= 400 && Math.max(...sim.pos) > 385, 'front cars wait at the stop line');
  for (let j = 0; j < 150; j++) sim.step(.2);
  assert.ok([...sim.edge].every(e => e !== 0), `queue discharged on green: ${[...sim.edge]} ${[...sim.pos].map(Math.round)} ${[...sim.v].map(Math.round)} ${[...sim.next]} state ${sim.signalState(0)}`);
});


test('particle force attracts at long gaps, balances at the preferred gap and repels close cars', () => {
  const force = gap => particleAcceleration(8, 13.4, gap, 8, PARTICLE_GAP, 1.5, 2, 2, .2);
  assert.ok(force(40) > 0);
  assert.equal(force(PARTICLE_GAP), 0);
  assert.ok(force(3) < 0);
  assert.ok(force(.01) >= -9, 'emergency deceleration is bounded');
  assert.ok(particleAcceleration(13.4, 13.4, 100, 13.4, PARTICLE_GAP, 1.5, 2, 2, .2) <= 0, 'attraction never accelerates above cruise');
});

for (const initialGap of [60, 2]) test(`particle following settles from a ${initialGap} m gap without overlap`, () => {
  const roads = squareRoads();
  for (const e of roads.edges) e[8] = e[8].map((v, k) => k % 2 ? 51.5 + (v - 51.5) * 10 : -.13 + (v + .13) * 10);
  const sim = new CarSim(roads, { population: 2, seed: 1 }); sim.seed();
  sim.edge.fill(2); sim.lane.fill(0); sim.pos.set([300, 300 - CAR_LENGTH - initialGap]); sim.v.fill(8.04);
  sim.factor.set([.6, 1]); sim.headway.fill(1.2); sim.pAccel.fill(1.5); sim.decel.fill(2); sim.minGap.fill(2);
  sim.lapse = () => -1;
  for (let k = 0; k < 600; k++) {
    sim.step(.2);
    assert.ok(sim.pos[0] - sim.pos[1] >= CAR_LENGTH + .49, 'hard separation');
    assert.ok([...sim.v].every(v => v >= 0 && v <= sim.speed[2]), 'bounded speeds');
  }
  const gap = sim.pos[0] - sim.pos[1] - CAR_LENGTH;
  assert.ok(Math.abs(gap - PARTICLE_GAP) < .3, `settled gap ${gap}`);
  assert.ok(Math.abs(sim.v[0] - sim.v[1]) < .05, 'relative-speed damping settles');
});

test('road limits cap even aggressive drivers and transitions to slower roads', () => {
  const sim = new CarSim(squareRoads(), { population: 40, seed: 9 }); sim.seed(); sim.factor.fill(1.2);
  sim.speed[2] = 5;
  for (let k = 0; k < 1200; k++) {
    sim.step(.2);
    for (let i = 0; i < sim.n; i++) assert.ok(sim.v[i] <= sim.speed[sim.edge[i]] + 1e-5);
  }
});
