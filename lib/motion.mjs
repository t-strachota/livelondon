export const STALE_MS = 60_000;
export const EXPIRE_MS = 180_000;
export const INTERPOLATION_MS = 15_000;
export const STOP_DEPARTURE_METRES = 12;
export const normalizeRoute = route => String(route ?? '').trim().toLowerCase().replace(/\s+/g, '');
export const modelOpacity = zoom => Math.max(0, Math.min(1, zoom - 16));
export const pitchForZoom = zoom => 40 * modelOpacity(zoom);
const radians = degrees => degrees * Math.PI / 180;

export function distance(a, b) {
  const lat = radians((a.latitude + b.latitude) / 2);
  return 6_371_000 * Math.hypot(radians(b.longitude - a.longitude) * Math.cos(lat), radians(b.latitude - a.latitude));
}

export function bearingBetween(a, b) {
  const lat1 = radians(a.latitude), lat2 = radians(b.latitude), delta = radians(b.longitude - a.longitude);
  return (Math.atan2(Math.sin(delta) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta)) * 180 / Math.PI + 360) % 360;
}

export function tween(state, now) {
  const t = state.duration === 0 ? 1 : Math.max(0, Math.min(1, (now - state.startedAt) / state.duration));
  const eased = state.easing === 'arrive' ? t * (2 - t)
    : state.easing === 'leave' ? t * t
    : state.easing === 'stop-to-stop' ? t * t * (3 - 2 * t) : t;
  const angle = ((state.to.bearing - state.from.bearing + 540) % 360) - 180;
  return {
    ...state.to,
    longitude: state.from.longitude + (state.to.longitude - state.from.longitude) * eased,
    latitude: state.from.latitude + (state.to.latitude - state.from.latitude) * eased,
    bearing: (state.from.bearing + angle * eased + 360) % 360,
    stale: now - Date.parse(state.to.recordedAt) >= STALE_MS,
    holdingAtStop: Boolean(state.holdStop && t >= 1),
    heldStop: state.holdStop ? { id: state.holdStop.id, name: state.holdStop.name } : null,
    moving: t < 1 && distance(state.from, state.to) > 0,
  };
}

export class BusMotionStore {
  constructor() { this.states = new Map(); this.movingUntil = 0; }

  ingest(buses, now = Date.now(), { animate = true } = {}) {
    for (const input of buses) {
      if (!input.id || !Number.isFinite(input.longitude) || !Number.isFinite(input.latitude) || !Number.isFinite(Date.parse(input.recordedAt))) continue;
      if (now - Date.parse(input.recordedAt) >= EXPIRE_MS) continue;
      const previous = this.states.get(input.id);
      if (previous && Date.parse(previous.to.recordedAt) >= Date.parse(input.recordedAt)) continue;
      const sameService = previous && normalizeRoute(previous.to.route) === normalizeRoute(input.route)
        && String(previous.to.direction ?? '') === String(input.direction ?? '');
      // Stops come from the server's TfL route index; nearby OSM dots never control motion.
      const candidate = input.routeStop?.id && normalizeRoute(input.routeStop.route) === normalizeRoute(input.route)
        ? input.routeStop : null;
      let departedStopId = sameService ? previous.departedStopId : null;
      if (departedStopId && candidate?.id !== departedStopId) departedStopId = null;
      const previousHold = sameService ? previous.holdStop : null;
      if (previousHold) {
        const stillAtStop = (input.atStop === true && candidate?.id === previousHold.id)
          || (input.atStop !== false && distance(previousHold.anchor, input) <= STOP_DEPARTURE_METRES);
        if (stillAtStop) {
          // Keep the original approach/arrival time and anchor despite GPS jitter.
          this.states.set(input.id, { ...previous, to: { ...input, ...previousHold.anchor }, confirmedFix: input, receivedAt: now });
          continue;
        }
        departedStopId = previousHold.id;
      }
      if (sameService && !previousHold && !candidate && distance(previous.confirmedFix, input) <= 3) {
        this.states.set(input.id, { ...previous, to: { ...previous.to, ...input, longitude: previous.to.longitude, latitude: previous.to.latitude, bearing: previous.to.bearing }, confirmedFix: input, receivedAt: now, departedStopId });
        continue;
      }
      const from = previous ? tween(previous, now) : null;
      const bearing = Number.isFinite(input.bearing) ? input.bearing : from && distance(from, input) > 3 ? bearingBetween(from, input) : from?.bearing ?? 0;
      const to = { ...input, bearing };
      const holdStop = candidate && candidate.id !== departedStopId
        ? { ...candidate, anchor: { longitude: to.longitude, latitude: to.latitude, bearing: to.bearing } } : null;
      // Interpolate only to the newest CONFIRMED fix, never beyond it.
      const duration = from && animate && distance(from, to) < 500 && now - Date.parse(previous.to.recordedAt) < STALE_MS ? INTERPOLATION_MS : 0;
      const easing = holdStop && previousHold ? 'stop-to-stop' : holdStop ? 'arrive' : previousHold ? 'leave' : 'linear';
      this.states.set(input.id, { from: from ?? to, to, startedAt: now, duration, holdStop, departedStopId, easing, confirmedFix: input, receivedAt: now });
      this.movingUntil = Math.max(this.movingUntil, now + duration);
    }
  }

  sample(now = Date.now()) {
    const buses = [];
    for (const [id, state] of this.states) {
      if (now - Date.parse(state.to.recordedAt) >= EXPIRE_MS) this.states.delete(id);
      else buses.push(tween(state, now));
    }
    return buses;
  }
}

export function toGeoJSON(buses) {
  return { type: 'FeatureCollection', features: buses.map(bus => ({
    type: 'Feature', id: bus.id,
    geometry: { type: 'Point', coordinates: [bus.longitude, bus.latitude] },
    properties: { id: bus.id, stale: bus.stale, stopped: Boolean(bus.stopped) },
  })) };
}
