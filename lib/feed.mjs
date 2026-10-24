import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const LONDON_BOUNDS = [-0.65, 51.24, 0.42, 51.74];
export const POLL_MS = 15_000;
export const STALE_MS = 60_000;
export const EXPIRE_MS = 180_000;
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: true });
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'object' ? String(value?.['#text'] ?? '') : String(value ?? '');
const number = value => value == null || text(value).trim() === '' ? NaN : Number(text(value));

export function parseFeed(xml, now = Date.now()) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Invalid bus feed XML');
  const delivery = parser.parse(xml)?.Siri?.ServiceDelivery;
  if (!delivery) throw new Error('Missing SIRI ServiceDelivery');
  if (text(delivery.Status) === 'false') throw new Error('Bus feed reported a failure');
  const vehicles = new Map();
  const deliveries = array(delivery.VehicleMonitoringDelivery);
  if (!deliveries.length) throw new Error('Missing vehicle monitoring delivery');
  for (const monitoring of deliveries) {
    if (text(monitoring.Status) === 'false' || monitoring.ErrorCondition) throw new Error('Vehicle monitoring unavailable');
    for (const activity of array(monitoring.VehicleActivity)) {
      const journey = activity.MonitoredVehicleJourney;
      if (!journey || text(journey.OperatorRef) !== 'TFLO') continue;
      const vehicle = text(journey.VehicleRef).trim();
      const longitude = number(journey.VehicleLocation?.Longitude);
      const latitude = number(journey.VehicleLocation?.Latitude);
      const timestamp = Date.parse(text(activity.RecordedAtTime));
      const validUntil = Date.parse(text(activity.ValidUntilTime));
      if (!vehicle || !Number.isFinite(timestamp) || timestamp > now + 60_000 || now - timestamp >= EXPIRE_MS) continue;
      if (Number.isFinite(validUntil) && validUntil < now) continue;
      const [west, south, east, north] = LONDON_BOUNDS;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < west || longitude > east || latitude < south || latitude > north) continue;
      const id = `TFLO:${vehicle}`;
      if (vehicles.has(id) && Date.parse(vehicles.get(id).recordedAt) >= timestamp) continue;
      const heading = number(journey.Bearing);
      vehicles.set(id, {
        id, vehicle, longitude, latitude,
        bearing: Number.isFinite(heading) && heading >= 0 && heading <= 360 ? heading % 360 : null,
        route: text(journey.PublishedLineName || journey.LineRef),
        direction: text(journey.DirectionRef),
        stopRef: text(journey.MonitoredCall?.StopPointRef),
        atStop: ['true', '1'].includes(text(journey.MonitoredCall?.VehicleAtStop)) ? true
          : ['false', '0'].includes(text(journey.MonitoredCall?.VehicleAtStop)) ? false : null,
        destination: text(journey.DestinationName),
        recordedAt: new Date(timestamp).toISOString(),
      });
    }
  }
  const upstreamTimestamp = Date.parse(text(delivery.ResponseTimestamp));
  if (Number.isFinite(upstreamTimestamp) && now - upstreamTimestamp >= EXPIRE_MS) throw new Error('Bus feed snapshot is out of date');
  return { buses: [...vehicles.values()], upstreamAt: Number.isFinite(upstreamTimestamp) ? new Date(upstreamTimestamp).toISOString() : null };
}

export class BusFeed {
  constructor({ apiKey = '', fetchImpl = fetch, now = Date.now } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.buses = new Map();
    this.fetchedAt = null;
    this.upstreamAt = null;
    this.attemptedAt = -Infinity;
    this.failed = false;
    this.inflight = null;
  }

  async getSnapshot() {
    if (!this.apiKey) return { configured: false, status: 'unconfigured', fetchedAt: null, upstreamAt: null, buses: [] };
    if (this.inflight) await this.inflight;
    else if (this.now() - this.attemptedAt >= POLL_MS) {
      this.attemptedAt = this.now();
      this.inflight = this.refresh();
      try { await this.inflight; } finally { this.inflight = null; }
    }
    const now = this.now();
    for (const [id, bus] of this.buses) if (now - Date.parse(bus.recordedAt) >= EXPIRE_MS) this.buses.delete(id);
    const buses = [...this.buses.values()];
    const newest = buses.reduce((latest, bus) => Math.max(latest, Date.parse(bus.recordedAt)), -Infinity);
    const stale = this.failed || (this.fetchedAt && now - Date.parse(this.fetchedAt) >= STALE_MS) || (buses.length > 0 && now - newest >= STALE_MS);
    return { configured: true, status: !this.fetchedAt ? 'unavailable' : stale ? 'stale' : 'live', fetchedAt: this.fetchedAt, upstreamAt: this.upstreamAt, buses };
  }

  async refresh() {
    try {
      const url = new URL('https://data.bus-data.dft.gov.uk/api/v1/datafeed/');
      url.searchParams.set('api_key', this.apiKey);
      url.searchParams.set('operatorRef', 'TFLO');
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: '*/*', 'User-Agent': 'LondonLiveBuses/1.0' } });
      if (!response.ok) throw new Error(`Bus feed HTTP ${response.status}`);
      const snapshot = parseFeed(await response.text(), this.now());
      for (const bus of snapshot.buses) {
        const previous = this.buses.get(bus.id);
        if (!previous || Date.parse(bus.recordedAt) > Date.parse(previous.recordedAt)) this.buses.set(bus.id, bus);
      }
      this.fetchedAt = new Date(this.now()).toISOString();
      this.upstreamAt = snapshot.upstreamAt;
      this.failed = false;
    } catch {
      // Do not log upstream URLs or errors: they may contain the API key.
      this.failed = true;
    }
  }
}
