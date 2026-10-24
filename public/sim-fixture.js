import { metres } from '/lib/traffic.mjs';

// Stand-in for Person A's simulation core: same contract (dt, step(), snapshot(), optional setTraffic()), no MapLibre or DOM.
// shortcut: five fixed vehicles near Trafalgar Square; swap in Person A's sim in app.js once it is merged.
export const FIXTURE_VEHICLES = [
  { id: 'car-1', type: 'car', weight: 1, speed: 8, path: [[-.1300, 51.5070], [-.1260, 51.5070]] },
  { id: 'car-2', type: 'car', weight: 3, speed: 12, path: [[-.1280, 51.5055], [-.1280, 51.5085]] },
  { id: 'van-1', type: 'van', weight: 2, speed: 6, path: [[-.1295, 51.5060], [-.1265, 51.5080]] },
  { id: 'hgv-1', type: 'hgv', weight: 5, speed: 4, path: [[-.1265, 51.5060], [-.1295, 51.5080]] },
  { id: 'car-4', type: 'car', weight: 1, speed: 10, path: [[-.1310, 51.5078], [-.1250, 51.5062]] },
];

export function createFixtureSim(vehicles = FIXTURE_VEHICLES, dt = .1) {
  const routes = vehicles.map(vehicle => ({ ...vehicle, length: metres(...vehicle.path) }));
  let time = 0, traffic = null;
  return {
    dt,
    step() { time += dt; },
    // Person A's sim retargets density from refreshed estimates; the fixture only records them.
    setTraffic(estimate) { traffic = estimate; },
    get traffic() { return traffic; },
    snapshot() {
      return routes.map(({ id, type, weight, speed, path: [a, b], length }) => {
        const travelled = speed * time % (2 * length), forward = travelled <= length; // ping-pong, so nobody jumps back to the start
        const t = (forward ? travelled : 2 * length - travelled) / length;
        const bearing = Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
        return { id, type, weight, speed, heading: (bearing + (forward ? 360 : 180)) % 360, position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
      });
    },
  };
}
