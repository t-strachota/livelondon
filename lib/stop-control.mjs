import { ASSUMPTIONS, carsFor } from './assumptions.mjs';
import { normalizeRoute } from './motion.mjs';
import { TRAIN_LINES } from './trains.mjs';

// Stopped train lines, buses and bus routes, shared by every viewer (like road closures). Stopped
// vehicles freeze where they are until reopened; live BODS buses are only frozen in what we show.
// Each stop displaces passengers, some of whom drive: those extra cars go to the simulation as demand.
export const STOP_NOTICE = 'Estimated, assumption-based';
const SAFE_ID = /^[\w:.\- ]{1,40}$/;

export class StopControl {
  constructor({ trains = null, feed = null, stops = null, simulation = null } = {}) {
    Object.assign(this, { trains, feed, stops, simulation });
    this.items = new Map();
  }

  async act(body) {
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    const now = Date.now();
    if (body.action === 'reopen') {
      const item = this.items.get(body.key);
      if (!item) fail(404, 'Nothing stopped with that key');
      this.items.delete(body.key);
      if (item.kind === 'line') this.trains?.tracker.setStopped(item.line, false, now);
      this.trains?.stoppedLines.delete(item.line);
    } else if (body.action === 'stop-line') {
      const spec = TRAIN_LINES[body.line], line = this.trains?.network?.[body.line];
      if (!spec || !line) fail(400, 'Unknown train line');
      const key = `line:${body.line}`;
      if (this.items.has(key)) fail(409, 'That line is already stopped');
      const vehicles = this.trains.tracker.list(now).filter(t => t.line === body.line).length;
      const people = Math.round(vehicles * ASSUMPTIONS.passengersPerVehicle[spec.mode]);
      const points = [...new Set(line.stations.values())].map(s => [s.lon, s.lat]);
      this.trains.stoppedLines.add(body.line);
      this.trains.tracker.setStopped(body.line, true, now);
      this.items.set(key, { key, kind: 'line', line: body.line, label: `${spec.name}${body.line === 'dlr' ? '' : ' line'}`, vehicles, people, cars: carsFor(people), points, stoppedAt: now });
    } else if (body.action === 'stop-bus' || body.action === 'stop-route') {
      const value = String(body.action === 'stop-bus' ? body.id ?? '' : body.route ?? '');
      if (!SAFE_ID.test(value)) fail(400, body.action === 'stop-bus' ? 'id must be a bus id' : 'route must be a route name');
      const snapshot = await this.feed?.getSnapshot();
      const live = (snapshot?.buses ?? []).filter(bus => !this.frozen().has(bus.id));
      const route = body.action === 'stop-route' ? normalizeRoute(value) : null;
      const buses = route ? live.filter(bus => normalizeRoute(bus.route) === route) : live.filter(bus => bus.id === value);
      if (!buses.length) fail(404, route ? 'No live buses on that route' : 'That bus is not in the live feed');
      const key = route ? `route:${route}` : `bus:${value}`;
      if (this.items.has(key)) fail(409, 'Already stopped');
      const routeName = route ?? normalizeRoute(buses[0].route);
      const stops = this.stops?.index?.byRoute.get(routeName) ?? [];
      const people = Math.round(buses.length * ASSUMPTIONS.passengersPerVehicle.bus);
      this.items.set(key, {
        key, kind: route ? 'route' : 'bus', route: routeName, label: route ? `Bus route ${buses[0].route}` : `Bus ${buses[0].route || ''} (${buses[0].vehicle})`,
        vehicles: buses.length, people, cars: carsFor(people), stoppedAt: now,
        points: stops.length ? stops.map(s => [s.longitude, s.latitude]) : buses.map(b => [b.longitude, b.latitude]),
        frozen: new Map(buses.map(bus => [bus.id, { ...bus }])),
      });
    } else fail(400, "action must be 'stop-line', 'stop-bus', 'stop-route' or 'reopen'");
    this.simulation?.setDemand([...this.items.values()].map(item => ({ id: item.key, cars: item.cars, points: item.points })));
    return this.summary();
  }

  frozen() {
    const all = new Map();
    for (const item of this.items.values()) for (const [id, bus] of item.frozen ?? []) all.set(id, bus);
    return all;
  }

  // The live bus list as shown: frozen buses stay where they were stopped (flagged), and buses that
  // joined a stopped route afterwards are hidden.
  applyToBuses(buses) {
    if (!this.items.size) return buses;
    const frozen = this.frozen(), routes = new Set([...this.items.values()].filter(i => i.kind === 'route').map(i => i.route));
    const recordedAt = new Date().toISOString();
    const shown = buses.filter(bus => !frozen.has(bus.id) && !routes.has(normalizeRoute(bus.route)));
    for (const bus of frozen.values()) shown.push({ ...bus, recordedAt, stopped: true });
    return shown;
  }

  // With economics (the default) it also carries the running money-loss estimate and history size.
  summary({ economics = true } = {}) {
    const items = [...this.items.values()].map(({ key, kind, label, line, route, vehicles, people, cars, stoppedAt }) => ({ key, kind, label, line, route, vehicles, people, cars, stoppedAt }));
    const status = this.simulation?.getStatus?.() ?? {};
    return {
      notice: STOP_NOTICE, items, stoppedLines: items.filter(i => i.kind === 'line').map(i => i.line),
      people: items.reduce((a, i) => a + i.people, 0), extraCarsTarget: items.reduce((a, i) => a + i.cars, 0), extraCars: status.extraCars ?? 0,
      mostAffected: status.mostAffected ?? [], assumptions: ASSUMPTIONS, closures: status.closures?.length ?? 0,
      ...(economics && this.history ? { economics: this.history.economics(), historyCount: this.history.sessions.length } : {}),
    };
  }
}
