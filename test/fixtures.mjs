export function activity({ vehicle = '0001', longitude = -.128, latitude = 51.507, bearing = 90, operator = 'TFLO', route = '88', recordedAt = Date.now(), validUntil = null } = {}) {
  return `<VehicleActivity><RecordedAtTime>${new Date(recordedAt).toISOString()}</RecordedAtTime>${validUntil == null ? '' : `<ValidUntilTime>${new Date(validUntil).toISOString()}</ValidUntilTime>`}<MonitoredVehicleJourney><OperatorRef>${operator}</OperatorRef><VehicleRef>${vehicle}</VehicleRef><PublishedLineName>${route}</PublishedLineName><DestinationName>Camden &amp; Town</DestinationName><VehicleLocation><Longitude>${longitude}</Longitude><Latitude>${latitude}</Latitude></VehicleLocation>${bearing == null ? '' : `<Bearing>${bearing}</Bearing>`}</MonitoredVehicleJourney></VehicleActivity>`;
}

export function feedXML(activities = [], now = Date.now()) {
  return `<Siri xmlns="http://www.siri.org.uk/siri"><ServiceDelivery><ResponseTimestamp>${new Date(now).toISOString()}</ResponseTimestamp><VehicleMonitoringDelivery>${activities.join('')}</VehicleMonitoringDelivery></ServiceDelivery></Siri>`;
}

export function makeBuses(count, now = Date.now()) {
  const columns = Math.min(count, count > 1000 ? 100 : 30);
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => ({
    id: `TFLO:test-${index}`, vehicle: `test-${index}`,
    longitude: -.128 + ((index % columns) - Math.floor(columns / 2)) * .00015,
    latitude: 51.507 + (Math.floor(index / columns) - Math.floor(rows / 2)) * .00018,
    bearing: (index % 4) * 90, route: String(10 + index % 90), destination: 'Waterloo',
    recordedAt: new Date(now).toISOString(),
  }));
}

// A 400 m × 400 m square of two-way roads (2 lanes each way on the south side) near Trafalgar Square.
export function squareRoads() {
  const corners = [[-.130, 51.505], [-.1242, 51.505], [-.1242, 51.5086], [-.130, 51.5086]];
  const edges = [];
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], lanes = k === 0 ? 2 : 1;
    edges.push([k, (k + 1) % 4, 0, lanes, 13.4, 0, 1, 400, [...a, ...mid, ...b]]);
    edges.push([(k + 1) % 4, k, 0, lanes, 13.4, 0, 1, 400, [...b, ...mid, ...a]]);
  }
  return { bbox: [-.131, 51.504, -.123, 51.51], classes: ['primary'], nodes: 4, edges };
}
