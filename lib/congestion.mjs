// A viewport-derived visual summary, never an input to the shared simulation.
export function congestionCells(snapshot, cellMetres = 250) {
  const cells = new Map();
  for (let i = 0; i < snapshot.count; i++) {
    const x = snapshot.x[i], y = snapshot.y[i];
    const key = `${Math.floor(x / cellMetres)},${Math.floor(y / cellMetres)}`;
    let cell = cells.get(key);
    if (!cell) { cell = { total: 0, slow: 0, lon: 0, lat: 0 }; cells.set(key, cell); }
    cell.total++;
    // Wire speeds are centimetres per second; 300 cm/s is 10.8 km/h.
    if (snapshot.speed[i] < 300) { cell.slow++; cell.lon += snapshot.lon[i] / 1e7; cell.lat += snapshot.lat[i] / 1e7; }
  }
  return { type: 'FeatureCollection', features: [...cells.values()]
    .filter(cell => cell.slow >= 8 && cell.slow / cell.total >= .5)
    .map(cell => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [cell.lon / cell.slow, cell.lat / cell.slow] },
      properties: { slowCars: cell.slow, intensity: Math.min(1, cell.slow / 35) } })) };
}
