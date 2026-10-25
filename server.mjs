import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { BusFeed, POLL_MS } from './lib/feed.mjs';
import { StopCatalog } from './lib/stops.mjs';
import { SimulationSupervisor, cullSnapshot } from './lib/simulation.mjs';

const root = new URL('./', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/config.js', ['public/config.js', 'text/javascript; charset=utf-8']],
  ['/traffic.js', ['public/traffic.js', 'text/javascript; charset=utf-8']],
  ['/sim-cars.js', ['public/sim-cars.js', 'text/javascript; charset=utf-8']],
  ['/cameras.js', ['public/cameras.js', 'text/javascript; charset=utf-8']],
  ['/cameras.css', ['public/cameras.css', 'text/css; charset=utf-8']],
  ['/bus-layer.js', ['public/bus-layer.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/lib/motion.mjs', ['lib/motion.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/three.module.js', ['node_modules/three/build/three.module.js', 'text/javascript; charset=utf-8']],
  ['/vendor/BufferGeometryUtils.js', ['node_modules/three/examples/jsm/utils/BufferGeometryUtils.js', 'text/javascript; charset=utf-8']],
  ['/vendor/maplibre-gl.mjs', ['node_modules/maplibre-gl/dist/maplibre-gl.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/maplibre-gl-worker.mjs', ['node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/maplibre-gl-shared.mjs', ['node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/maplibre-gl.css', ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'text/css; charset=utf-8']],
]);
const POST_ROUTES = new Set(['/api/simulation/reinitialize', '/api/simulation/pause']);
// A slow client skips snapshots rather than queueing them without bound.
const MAX_BUFFERED_BYTES = 4 * 2 ** 20;

// State-changing requests must come from this page, not another site the browser has open.
const sameOrigin = req => !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;

async function readJson(req, limit = 1024) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
  }
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function createApp({ feed = new BusFeed({ apiKey: process.env.BODS_API_KEY?.trim() }), stops = null, simulation = null } = {}) {
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
    if (req.method === 'POST' && POST_ROUTES.has(pathname)) {
      if (!simulation) return json(503, { error: 'Simulation not configured' });
      if (!sameOrigin(req)) return json(403, { error: 'Cross-origin request refused' });
      try {
        const body = await readJson(req);
        if (pathname === '/api/simulation/pause') {
          if (typeof body.paused !== 'boolean') return json(400, { error: 'paused must be true or false' });
          if (!simulation.setPaused(body.paused)) return json(409, { error: 'No running simulation to pause' });
          return json(200, simulation.getStatus());
        }
        return json(202, { job: simulation.reinitialize({ population: body.population ?? simulation.population }) });
      } catch (error) {
        return json(error.status ?? 500, { error: error.message });
      }
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: POST_ROUTES.has(pathname) ? 'POST' : 'GET, HEAD' }).end();
      return;
    }
    try {
      let body;
      if (pathname === '/api/buses') {
        const snapshot = await feed.getSnapshot();
        if (stops) {
          snapshot.buses = snapshot.buses.map(bus => ({ ...bus, routeStop: stops.match(bus) }));
          snapshot.stopDataStatus = stops.status;
          snapshot.stopDataUpdatedAt = stops.updatedAt;
        }
        res.statusCode = ['unconfigured', 'unavailable'].includes(snapshot.status) ? 503 : 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        body = Buffer.from(JSON.stringify(snapshot));
      } else if (pathname === '/api/simulation/signals') {
        // Static stop-line positions of every signal approach, [lon, lat, ...]; states arrive as 'SIG1' frames.
        if (!simulation) return json(503, { error: 'Simulation not configured' });
        body = Buffer.from(JSON.stringify({ simulated: true, positions: Array.from(simulation.signalPositions ?? [], x => Math.round(x * 1e6) / 1e6) }));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
      } else if (pathname === '/api/simulation/status') {
        if (!simulation) return json(503, { lifecycle: 'unavailable', reason: 'Simulation not configured' });
        return json(200, simulation.getStatus());
      } else {
        const file = files.get(pathname);
        if (!file) { res.writeHead(404).end('Not found'); return; }
        body = await readFile(new URL(file[0], root));
        res.setHeader('Content-Type', file[1]);
        res.setHeader('Cache-Control', pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache');
      }
      if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && body.length > 1024) {
        body = gzipSync(body);
        res.setHeader('Content-Encoding', 'gzip');
      }
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', body.length);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'unavailable', buses: [] }));
    }
  });
  if (simulation) attachSimulationStream(server, simulation);
  return server;
}

// Same-origin WebSocket: JSON text frames for status/progress, binary frames for snapshots.
// Each client may send {type: 'viewport', bbox: [w, s, e, n] | null, snapshots: boolean, signals: boolean}.
// Signal states ('SIG1' binary frames, 2 Hz) cover the union of the boxes of clients that asked for them.
export function attachSimulationStream(server, simulation) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/api/simulation/stream' || !sameOrigin(req)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const send = (ws, frame) => { if (ws.readyState === ws.OPEN) ws.send(frame); };
  const sendSnapshot = (ws, payload) => {
    if (!ws.wantsSnapshots || ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.dropped = (ws.dropped ?? 0) + 1; return; }
    send(ws, ws.bbox ? cullSnapshot(payload, ws.bbox) : payload);
  };
  wss.on('connection', ws => {
    ws.wantsSnapshots = true;
    ws.on('message', (data, binary) => {
      if (binary) return;
      try {
        const message = JSON.parse(data);
        if (message.type !== 'viewport') return;
        ws.wantsSnapshots = message.snapshots !== false;
        ws.bbox = Array.isArray(message.bbox) && message.bbox.length === 4 && message.bbox.every(Number.isFinite) ? message.bbox : null;
        ws.wantsSignals = message.signals === true && ws.bbox !== null;
        updateSignalViews();
      } catch { /* ignore malformed client messages */ }
    });
    ws.on('close', updateSignalViews);
    send(ws, JSON.stringify({ type: 'status', status: simulation.getStatus() }));
    if (simulation.snapshot) sendSnapshot(ws, simulation.snapshot);
  });
  function updateSignalViews() {
    simulation.setSignalViews?.([...wss.clients].filter(ws => ws.wantsSignals).map(ws => ws.bbox).slice(0, 64));
  }
  simulation.on('signals', frame => {
    for (const ws of wss.clients) if (ws.wantsSignals && ws.bufferedAmount <= MAX_BUFFERED_BYTES) send(ws, frame);
  });
  const broadcast = frame => { for (const ws of wss.clients) send(ws, frame); };
  simulation.on('snapshot', payload => { for (const ws of wss.clients) sendSnapshot(ws, payload); });
  simulation.on('status', status => broadcast(JSON.stringify({ type: 'status', status })));
  simulation.on('run', status => broadcast(JSON.stringify({ type: 'run', status })));
  simulation.on('progress', progress => broadcast(JSON.stringify({ type: 'progress', progress })));
  server.on('close', () => wss.close());
  return wss;
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 3000);
  const stops = new StopCatalog();
  const feed = new BusFeed({ apiKey: process.env.BODS_API_KEY?.trim() });
  const simulation = new SimulationSupervisor({ population: Number(process.env.SIM_POPULATION) || undefined, roads: process.env.SIM_ROADS || undefined }).start();
  const server = createApp({ feed, stops, simulation });
  void stops.start();
  // Bus observations continue server-side whether or not any browser shows the overlay.
  void feed.getSnapshot();
  const busTimer = setInterval(() => void feed.getSnapshot(), POLL_MS);
  server.listen(port, '127.0.0.1', () => {
    console.log(`London map: http://localhost:${port}`);
    if (!process.env.BODS_API_KEY?.trim()) console.log('Live feed not configured. Set BODS_API_KEY in .env (see README.md).');
    if (simulation.lifecycle === 'unavailable') console.log(`Car simulation unavailable: ${simulation.reason}`);
  });
  // The simulation worker would otherwise keep a server that never started alive.
  server.on('error', async error => { console.error(`Server could not start: ${error.code}`); clearInterval(busTimer); await simulation.close(); process.exit(1); });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(busTimer);
    server.close();
    await simulation.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
