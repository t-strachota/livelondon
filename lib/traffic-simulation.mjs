import { MAX_CARS, metres } from './traffic.mjs';

const VEHICLE_TYPES = [
  { type: 'car', share: .72, minWeightKg: 900, maxWeightKg: 2200 },
  { type: 'van', share: .16, minWeightKg: 1800, maxWeightKg: 3500 },
  { type: 'truck', share: .08, minWeightKg: 7500, maxWeightKg: 44000 },
  { type: 'motorcycle', share: .04, minWeightKg: 120, maxWeightKg: 400 },
];

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

// Mulberry32 is small, repeatable across Node and browsers, and sufficient for
// visual sampling. It is deliberately not used for security-sensitive values.
function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function prepareRoad(road) {
  if (!road?.id || !Array.isArray(road.line) || road.line.length < 2) return null;
  const cumulative = new Float64Array(road.line.length);
  for (let i = 1; i < road.line.length; i++) {
    cumulative[i] = cumulative[i - 1] + metres(road.line[i - 1], road.line[i]);
  }
  const length = cumulative.at(-1);
  if (!(length >= 5)) return null;
  return {
    id: String(road.id),
    line: road.line,
    cumulative,
    length,
    lanes: Math.max(1, Math.floor(road.lanes) || 1),
    oneway: String(road.oneway),
    speed: Number.isFinite(road.kmh) && road.kmh >= 0 ? road.kmh / 3.6 : 32 / 3.6,
    vehicles: Number.isFinite(road.vehicles) && road.vehicles > 0 ? road.vehicles : 0,
  };
}

function vehiclePoint(vehicle, road) {
  let low = 1, high = road.cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (road.cumulative[middle] < vehicle.position) low = middle + 1;
    else high = middle;
  }
  const i = low, a = road.line[i - 1], b = road.line[i];
  const segment = road.cumulative[i] - road.cumulative[i - 1] || 1;
  const progress = (vehicle.position - road.cumulative[i - 1]) / segment;
  const x = (b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180) / segment * vehicle.direction;
  const y = (b[1] - a[1]) * 110540 / segment * vehicle.direction;
  const latitude = a[1] + (b[1] - a[1]) * progress + x * vehicle.laneOffset / 110540;
  const longitude = a[0] + (b[0] - a[0]) * progress - y * vehicle.laneOffset / (111320 * Math.cos(latitude * Math.PI / 180));
  return {
    longitude,
    latitude,
    bearing: positiveModulo(Math.atan2(x, y) * 180 / Math.PI, 360),
  };
}

export class TrafficSimulation {
  constructor({ roads = [], seed = 1, timestepSeconds = .1, maxVehicles = MAX_CARS } = {}) {
    if (!(timestepSeconds > 0) || !Number.isFinite(timestepSeconds)) throw new RangeError('timestepSeconds must be positive');
    if (!Number.isInteger(maxVehicles) || maxVehicles < 0) throw new RangeError('maxVehicles must be a nonnegative integer');
    this.timestepSeconds = timestepSeconds;
    this.maxVehicles = maxVehicles;
    this.tick = 0;
    this.nextVehicleId = 0;
    this.random = seededRandom(seed);
    this.roads = new Map();
    this.vehicles = [];
    this.updateRoads(roads);
  }

  updateRoads(roads) {
    const prepared = roads.map(prepareRoad).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
    const nextRoads = new Map(prepared.map(road => [road.id, road]));

    // Preserve progress when refreshed geometry describes the same stable road.
    this.vehicles = this.vehicles.filter(vehicle => {
      const oldRoad = this.roads.get(vehicle.roadId), nextRoad = nextRoads.get(vehicle.roadId);
      if (!nextRoad) return false;
      if (oldRoad) vehicle.position = vehicle.position / oldRoad.length * nextRoad.length;
      vehicle.speed = nextRoad.speed;
      return true;
    });
    this.roads = nextRoads;

    const total = prepared.reduce((sum, road) => sum + road.vehicles, 0);
    const factor = total > 0 ? Math.min(1, this.maxVehicles / total) : 0;
    const desired = new Map();
    for (const road of prepared) {
      const exact = road.vehicles * factor;
      desired.set(road.id, Math.floor(exact) + (this.random() < exact % 1 ? 1 : 0));
    }

    // Removing newest IDs first makes the survivor set deterministic and keeps
    // long-lived IDs stable while live density estimates fluctuate.
    const byRoad = new Map();
    for (const vehicle of this.vehicles) {
      const list = byRoad.get(vehicle.roadId) ?? [];
      list.push(vehicle);
      byRoad.set(vehicle.roadId, list);
    }
    const survivors = [];
    for (const road of prepared) {
      const existing = byRoad.get(road.id) ?? [];
      const keep = Math.min(existing.length, desired.get(road.id));
      survivors.push(...existing.slice(0, keep));
      for (let i = keep; i < desired.get(road.id) && survivors.length < this.maxVehicles; i++) {
        survivors.push(this.#createVehicle(road));
      }
    }
    this.vehicles = survivors;
  }

  #createVehicle(road) {
    const choice = this.random();
    let cumulativeShare = 0, definition = VEHICLE_TYPES.at(-1);
    for (const candidate of VEHICLE_TYPES) {
      cumulativeShare += candidate.share;
      if (choice < cumulativeShare) { definition = candidate; break; }
    }
    const direction = road.oneway === '1' ? 1 : road.oneway === '-1' ? -1 : this.random() < .5 ? 1 : -1;
    return {
      id: this.nextVehicleId++,
      roadId: road.id,
      position: this.random() * road.length,
      speed: road.speed,
      direction,
      type: definition.type,
      weightKg: Math.round(definition.minWeightKg + this.random() * (definition.maxWeightKg - definition.minWeightKg)),
      laneOffset: 1.75 + 3.5 * Math.floor(this.random() * road.lanes),
    };
  }

  step(count = 1) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('step count must be a nonnegative integer');
    for (let n = 0; n < count; n++) {
      for (const vehicle of this.vehicles) {
        const road = this.roads.get(vehicle.roadId);
        vehicle.position = positiveModulo(vehicle.position + vehicle.direction * vehicle.speed * this.timestepSeconds, road.length);
      }
      this.tick++;
    }
    return this;
  }

  snapshot() {
    return {
      tick: this.tick,
      simulationTimeSeconds: this.tick * this.timestepSeconds,
      vehicles: this.vehicles.map(vehicle => {
        const road = this.roads.get(vehicle.roadId);
        return {
          id: vehicle.id,
          roadId: vehicle.roadId,
          positionMetres: vehicle.position,
          speedMps: vehicle.speed,
          direction: vehicle.direction,
          type: vehicle.type,
          weightKg: vehicle.weightKg,
          ...vehiclePoint(vehicle, road),
        };
      }),
    };
  }
}

// GeoJSON belongs at the rendering boundary rather than in simulation state.
export function snapshotToGeoJSON(snapshot) {
  return {
    type: 'FeatureCollection',
    features: snapshot.vehicles.map(vehicle => ({
      type: 'Feature',
      id: vehicle.id,
      geometry: { type: 'Point', coordinates: [vehicle.longitude, vehicle.latitude] },
      properties: {
        estimated: true,
        kind: 'estimated-car',
        vehicleType: vehicle.type,
        weightKg: vehicle.weightKg,
        speedMps: vehicle.speedMps,
        direction: vehicle.direction,
      },
    })),
  };
}
