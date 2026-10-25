import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSUMPTIONS, ECONOMICS } from './assumptions.mjs';

// Closure sessions: a session starts when the first road, train line or bus is closed and ends when
// everything is open again. Each records what was closed, its peak effects and the estimated money
// lost (estimated, assumption-based):
//   road delay: extra vehicle-hours measured near the closures × people per car × value of time;
//   services:   displaced passengers × trips per hour × extra journey time × value of time, while stopped.
// Finished sessions are kept in data/history.json (newest first, at most MAX_SESSIONS).
const MAX_SESSIONS = 50, TICK_MS = 5000;
const DEFAULT_PATH = fileURLToPath(new URL('../data/history.json', import.meta.url));

export class History {
  constructor({ stopControl, simulation, path = DEFAULT_PATH, now = Date.now } = {}) {
    Object.assign(this, { stopControl, simulation, path, now });
    try { this.sessions = JSON.parse(readFileSync(path, 'utf8')); } catch { this.sessions = []; }
    if (!Array.isArray(this.sessions)) this.sessions = [];
    this.current = null;
  }

  start() { this.timer = setInterval(() => this.tick(), TICK_MS); this.timer.unref?.(); return this; }

  stop() {
    clearInterval(this.timer);
    if (this.current) this.#finish('Server stopped');
  }

  tick() {
    const status = this.simulation?.getStatus?.() ?? {}, summary = this.stopControl?.summary({ economics: false }) ?? { items: [] };
    const roads = (status.closures ?? []).map(c => ({ key: `road:${c.id}`, kind: 'road', label: c.name || 'Unnamed road' }));
    const active = [...roads, ...summary.items];
    const now = this.now();
    if (!active.length) { if (this.current) this.#finish(); return; }
    const s = this.current ??= { id: now, startedAt: new Date(now).toISOString(), endedAt: null, closed: {}, peakPeople: 0, peakExtraCars: 0,
      servicesCost: 0, roadCost: 0, delayVehicleHours: 0, mostAffected: [], lastTick: now };
    const hours = (now - s.lastTick) / 3.6e6;
    s.lastTick = now;
    for (const item of active) s.closed[item.key] ??= { kind: item.kind, label: item.label, at: new Date(now).toISOString() };
    s.servicesCost += summary.items.reduce((a, i) => a + i.people, 0) * ECONOMICS.displacedTripsPerHour * hours * ECONOMICS.displacedDelayHours * ECONOMICS.valueOfTimePerHour;
    s.delayVehicleHours = Math.max(s.delayVehicleHours, status.delay?.vehicleHours ?? 0);
    s.roadCost = s.delayVehicleHours * ASSUMPTIONS.peoplePerCar * ECONOMICS.valueOfTimePerHour;
    s.peakPeople = Math.max(s.peakPeople, summary.people ?? 0);
    s.peakExtraCars = Math.max(s.peakExtraCars, summary.extraCars ?? 0);
    if (status.mostAffected?.length) s.mostAffected = status.mostAffected;
    s.ratePerHour = (status.delay?.ratePerHour ?? 0) * ASSUMPTIONS.peoplePerCar * ECONOMICS.valueOfTimePerHour
      + summary.items.reduce((a, i) => a + i.people, 0) * ECONOMICS.displacedTripsPerHour * ECONOMICS.displacedDelayHours * ECONOMICS.valueOfTimePerHour;
  }

  // The running session's estimate, for the panel.
  economics() {
    const s = this.current;
    if (!s) return { active: false, total: 0, roadCost: 0, servicesCost: 0, perHour: 0, assumptions: ECONOMICS };
    return { active: true, startedAt: s.startedAt, total: Math.round(s.roadCost + s.servicesCost), roadCost: Math.round(s.roadCost), servicesCost: Math.round(s.servicesCost),
      perHour: Math.round(s.ratePerHour ?? 0), delayVehicleHours: +s.delayVehicleHours.toFixed(1), assumptions: ECONOMICS };
  }

  list() { return { sessions: this.sessions.map(view), current: this.current ? view(this.current) : null }; }

  #finish(note) {
    const s = this.current;
    this.current = null;
    s.endedAt = new Date(this.now()).toISOString();
    if (note) s.note = note;
    delete s.lastTick;
    this.sessions = [s, ...this.sessions].slice(0, MAX_SESSIONS);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.sessions));
      renameSync(`${this.path}.tmp`, this.path);
    } catch { /* History is a convenience; a failed save keeps it in memory. */ }
  }
}

function view(s) {
  return { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, note: s.note ?? null, closed: Object.values(s.closed),
    peakPeople: s.peakPeople, peakExtraCars: s.peakExtraCars, delayVehicleHours: +s.delayVehicleHours.toFixed(1),
    roadCost: Math.round(s.roadCost), servicesCost: Math.round(s.servicesCost), total: Math.round(s.roadCost + s.servicesCost), mostAffected: s.mostAffected };
}
