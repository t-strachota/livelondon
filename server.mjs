import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BusFeed } from './lib/feed.mjs';
import { StopCatalog } from './lib/stops.mjs';

const root = new URL('./', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/config.js', ['public/config.js', 'text/javascript; charset=utf-8']],
  ['/traffic.js', ['public/traffic.js', 'text/javascript; charset=utf-8']],
  ['/estimated-cars.js', ['public/estimated-cars.js', 'text/javascript; charset=utf-8']],
  ['/cameras.js', ['public/cameras.js', 'text/javascript; charset=utf-8']],
  ['/cameras.css', ['public/cameras.css', 'text/css; charset=utf-8']],
  ['/flow_table.json', ['flow_table.json', 'application/json']],
  ['/lib/traffic.mjs', ['lib/traffic.mjs', 'text/javascript; charset=utf-8']],
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

export function createApp({ feed = new BusFeed({ apiKey: process.env.BODS_API_KEY?.trim() }), stops = null } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], 'file:'))) {
  const port = Number(process.env.PORT || 3000);
  const stops = new StopCatalog();
  const server = createApp({ stops });
  void stops.start();
  server.listen(port, '127.0.0.1', () => {
    console.log(`London buses: http://localhost:${port}`);
    if (!process.env.BODS_API_KEY?.trim()) console.log('Live feed not configured. Set BODS_API_KEY in .env (see README.md).');
  });
  server.on('error', error => { console.error(`Server could not start: ${error.code}`); process.exitCode = 1; });
}
