export function createCameras(map, toggle, panel) {
const status = document.querySelector("#camera-status");
// Live London cameras (TfL JamCams), shown the way OSIRIS does it ----
// All ~900 cameras are GPU circles. From zoom 13 the 8 cameras nearest the screen centre also get a live
// JPEG preview tile pinned above their marker. Which cameras get tiles is decided only when the map
// settles; during a pan tiles are just moved with a CSS transform, so nothing is rebuilt per frame.
const CCTV_COLOUR = "#00e676";
const TILE = { w: 176, imgH: 99, labelH: 20, gap: 26 }, TILE_H = TILE.imgH + TILE.labelH;
const MIN_ZOOM = 13, MAX_TILES = 8, TILE_REFRESH = 15000, VIEWER_REFRESH = 5000;
const EDGE = 10, EDGE_TOP = 10, EDGE_BOTTOM = 40; // keep tiles clear of the toggles and zoom buttons
let cctvData = { type: "FeatureCollection", features: [] }, cctvOn = false, hoveredCam = "", camerasRequested = false;
const tiles = new Map(); // camera id -> { cam, el, timers }
const tilesEl = document.getElementById("cctv-tiles");
const freshen = url => `${url}${url.includes("?") ? "&" : "?"}_t=${Date.now()}`; // snapshot URL returns a new frame each time

// One request for every camera, made only when the layer is first switched on (as OSIRIS does).
// TfL allows browser calls without a key and the response is HTTP-cached for 12 h.
let cameraController, listPromise;
function loadCameras() {
  if (camerasRequested) return Promise.resolve();
  if (listPromise) return listPromise;
  const controller = new AbortController();
  cameraController = controller;
  listPromise = fetch("https://api.tfl.gov.uk/Place/Type/JamCam", { signal: controller.signal })
    .then(response => { if (!response.ok) throw new Error("Camera list unavailable"); return response.json(); })
    .then(list => {
      if (!Array.isArray(list)) throw new Error("Invalid camera list");
      cctvData.features = list.filter(cam => typeof cam.id === 'string' && Number.isFinite(cam.lat) && Number.isFinite(cam.lon)).map(cam => {
        const fallback = `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${cam.id.replace("JamCams_", "")}.jpg`;
        let image = cam.additionalProperties?.find(property => property.key === "imageUrl")?.value || fallback;
        try { const url = new URL(image); if (!["https:", "http:"].includes(url.protocol)) image = fallback; else { url.protocol = "https:"; image = url.href; } } catch { image = fallback; }
        return { type: "Feature", geometry: { type: "Point", coordinates: [cam.lon, cam.lat] }, properties: { id: cam.id, name: cam.commonName || "London JamCam", feed_url: image } };
      });
      camerasRequested = true;
      map.getSource("cctv")?.setData(cctvData);
      status.textContent = `${cctvData.features.length} traffic cameras · snapshots`;
    })
    .catch(() => { camerasRequested = false; if (!controller.signal.aborted) status.textContent = "Camera list unavailable · toggle to retry"; })
    .finally(() => { listPromise = null; if (controller.signal.aborted && cctvOn && !document.hidden) void loadCameras(); });
  return listPromise;
}

function addCameraLayers() {
  map.addSource("cctv", { type: "geojson", data: cctvData });
  const vis = { visibility: cctvOn ? "visible" : "none" };
  map.addLayer({ id: "cctv-glow", type: "circle", source: "cctv", layout: vis, paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 4, 5, 6, 10, 10, 14, 14],
    "circle-color": "#000", "circle-opacity": 0.35, "circle-blur": 1 } });
  map.addLayer({ id: "cctv-dots", type: "circle", source: "cctv", layout: vis, paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2, 5, 3.5, 10, 5.5, 14, 8],
    "circle-color": CCTV_COLOUR, "circle-opacity": 0.9, "circle-stroke-width": 2, "circle-stroke-color": "#000", "circle-stroke-opacity": 0.9 } });
  // Name label only for the camera under the cursor (filter is updated on hover)
  if (map.getStyle().glyphs) map.addLayer({ id: "cctv-label", type: "symbol", source: "cctv", filter: ["==", ["get", "id"], hoveredCam], layout: { ...vis,
    "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.5], "text-max-width": 12, "text-allow-overlap": true,
    "text-font": map.getLayer("Road labels") ? map.getLayoutProperty("Road labels", "text-font") : ["Open Sans Regular"] }, // a font this style's glyph server has
    paint: { "text-color": CCTV_COLOUR, "text-halo-color": "#000", "text-halo-width": 1.5, "text-opacity": 0.8 } });
}
addCameraLayers();
map.on("style.load", addCameraLayers);

// Tile above its marker, or below when there's no room; clamped inside the view (then it has no connector)
function layoutTile(pt) {
  const { clientWidth: W, clientHeight: H } = map.getCanvas();
  const above = pt.y - TILE_H - TILE.gap, flipped = above < EDGE_TOP;
  const wantX = pt.x - TILE.w / 2, wantY = flipped ? pt.y + TILE.gap : above;
  let x = Math.min(Math.max(wantX, EDGE), Math.max(EDGE, W - TILE.w - EDGE));
  let y = Math.min(Math.max(wantY, EDGE_TOP), Math.max(EDGE_TOP, H - TILE_H - EDGE_BOTTOM));
  const controls = panel.getBoundingClientRect();
  if (x < controls.right + 8 && x + TILE.w > controls.left - 8 && y < controls.bottom + 8 && y + TILE_H > controls.top - 8) {
    if (controls.right + TILE.w + 16 < W) x = controls.right + 12;
    else y = Math.min(controls.bottom + 12, H - TILE_H - EDGE_BOTTOM);
  }
  return { x, y, flipped, anchored: Math.abs(x - wantX) < 1 && Math.abs(y - wantY) < 1 };
}
const tilesOverlap = (a, b) => Math.abs(a.x - b.x) < TILE.w + 8 && Math.abs(a.y - b.y) < TILE_H + TILE.gap;

function makeTile(cam) {
  const el = document.createElement("div");
  el.className = "cctv-wrap";
  el.dataset.flip = "above";
  el.innerHTML = `<button class="cctv-tile"><div class="cctv-frame"><img width="176" height="99" draggable="false" alt="">
    <div class="cctv-fx"></div><span class="cctv-corner tl"></span><span class="cctv-corner tr"></span><span class="cctv-corner bl"></span>
    <span class="cctv-corner br"></span><div class="cctv-badge live"><i></i>LIVE</div><div class="cctv-badge open">⤢ OPEN</div>
    <div class="cctv-linking">LINKING</div></div><div class="cctv-label"><i></i><span></span></div></button>
    <span class="cctv-stem down"></span><span class="cctv-stem up"></span>`;
  const img = el.querySelector("img"), frame = el.querySelector(".cctv-frame");
  el.querySelector(".cctv-label span").textContent = img.alt = el.querySelector("button").title = cam.name;
  img.onload = () => { frame.classList.add("loaded"); el.style.display = ""; };
  img.onerror = () => { el.style.display = "none"; }; // a dead feed is worse than no tile
  img.src = freshen(cam.feed_url);
  el.querySelector("button").onclick = () => openViewer(cam);
  // Staggered refresh so the tiles don't all hit TfL on the same tick
  const t = { interval: null };
  t.first = setTimeout(() => {
    if (cctvOn && !document.hidden) img.src = freshen(cam.feed_url);
    t.interval = setInterval(() => { if (cctvOn && !document.hidden) img.src = freshen(cam.feed_url); }, TILE_REFRESH);
  }, TILE_REFRESH + Math.random() * 2000);
  return { cam, el, timers: t };
}
function dropTile(id) {
  const t = tiles.get(id);
  clearTimeout(t.timers.first); clearInterval(t.timers.interval);
  t.el.remove();
  tiles.delete(id);
}

// Pick which cameras get a tile. Runs only when the map settles.
function recomputeTiles() {
  let picked = [];
  if (cctvOn && !document.hidden && map.getZoom() >= MIN_ZOOM && map.getLayer("cctv-dots")) {
    const { clientWidth: W, clientHeight: H } = map.getCanvas(), seen = new Set(), candidates = [];
    for (const f of map.queryRenderedFeatures({ layers: ["cctv-dots"] })) {
      const p = f.properties;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const coords = f.geometry.coordinates, pt = map.project(coords);
      candidates.push({ cam: { ...p, lng: coords[0], lat: coords[1] }, box: layoutTile(pt), d: (pt.x - W / 2) ** 2 + (pt.y - H / 2) ** 2 });
    }
    // Nearest the centre first; skip any tile that would land on one already taken
    candidates.sort((a, b) => a.d - b.d);
    for (const c of candidates) {
      if (picked.length >= MAX_TILES) break;
      if (!picked.some(p => tilesOverlap(p.box, c.box))) picked.push(c);
    }
  }
  const keep = new Set(picked.map(p => p.cam.id));
  for (const id of [...tiles.keys()]) if (!keep.has(id)) dropTile(id);
  for (const { cam } of picked) if (!tiles.has(cam.id)) { const t = makeTile(cam); tiles.set(cam.id, t); tilesEl.append(t.el); }
  placeTiles();
}

// Keep tiles glued to their markers on every frame of a pan, without rebuilding anything
function placeTiles() {
  for (const { cam, el } of tiles.values()) {
    const box = layoutTile(map.project([cam.lng, cam.lat]));
    el.dataset.flip = !box.anchored ? "none" : box.flipped ? "below" : "above";
    el.style.transform = `translate3d(${Math.round(box.x)}px, ${Math.round(box.y)}px, 0)`;
  }
}
map.on("move", placeTiles);
// moveend can fire before the view's data is parsed, so idle and the camera source loading also re-check
for (const ev of ["moveend", "zoomend"]) map.on(ev, recomputeTiles);
let settledView = "";
map.on("idle", () => {
  const c = map.getCenter(), canvas = map.getCanvas();
  const key = [c.lng, c.lat, map.getZoom(), map.getPitch(), map.getBearing(), canvas.clientWidth, canvas.clientHeight, cctvOn, cctvData.features.length].join(":");
  if (key !== settledView) { settledView = key; recomputeTiles(); }
});
map.on("sourcedata", e => { if (e.sourceId === "cctv" && e.isSourceLoaded) recomputeTiles(); });

// Full viewer: bigger frame, refreshed every 5 s while open
const viewer = document.getElementById("cctv-viewer"), cvImg = document.getElementById("cv-img");
let viewerTimer, currentCam;
cvImg.onload = () => cvImg.parentElement.classList.add("loaded");
function openViewer(cam) {
  currentCam = cam;
  clearInterval(viewerTimer);
  cvImg.parentElement.classList.remove("loaded");
  document.getElementById("cv-name").textContent = cvImg.alt = cam.name;
  document.getElementById("cv-src").href = cam.feed_url;
  cvImg.src = freshen(cam.feed_url);
  viewerTimer = setInterval(() => { if (cctvOn && !document.hidden) cvImg.src = freshen(cam.feed_url); }, VIEWER_REFRESH);
  viewer.hidden = false;
}
document.getElementById("cv-close").onclick = () => { viewer.hidden = true; currentCam = null; clearInterval(viewerTimer); };
map.on("click", "cctv-dots", e => {
  const f = e.features[0];
  openViewer({ ...f.properties, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
});
const showName = id => {
  if (id === hoveredCam) return;
  hoveredCam = id;
  if (map.getLayer("cctv-label")) map.setFilter("cctv-label", ["==", ["get", "id"], id]);
};
// Hover checks capped at 10/s and skipped while the map moves (OSIRIS keeps this work out of gestures)
let lastHover = 0;
map.on("mousemove", e => {
  if (!cctvOn || map.isMoving() || performance.now() - lastHover < 100) return;
  lastHover = performance.now();
  const f = map.queryRenderedFeatures(e.point, { layers: ["cctv-dots"] })[0];
  if (f) map.getCanvas().style.cursor = "pointer";
  else if (hoveredCam) map.getCanvas().style.cursor = ""; // only clear a cursor we set
  showName(f ? f.properties.id : "");
});

// Viewer: drag by its title bar, resize from the corner grip (pointer events cover mouse and touch)
function onDrag(handle, apply) {
  handle.addEventListener("pointerdown", e => {
    if (e.target.closest("button")) return; // let the close button click
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = viewer.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const move = ev => apply(start, ev.clientX - x0, ev.clientY - y0);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", () => handle.removeEventListener("pointermove", move), { once: true });
  });
}
onDrag(viewer.querySelector(".cv-head"), (r, dx, dy) => {
  viewer.style.right = "auto"; // switch from right- to left-anchored once moved
  viewer.style.left = `${Math.min(Math.max(0, r.left + dx), Math.max(0, innerWidth - r.width))}px`; // keep the title bar reachable
  viewer.style.top = `${Math.min(Math.max(0, r.top + dy), Math.max(0, innerHeight - r.height))}px`;
});
onDrag(viewer.querySelector(".cv-grip"), (r, dx, dy) => {
  viewer.style.right = "auto"; // grow from the top-left corner, towards the cursor
  viewer.style.left = `${r.left}px`;
  viewer.style.width = `${Math.min(innerWidth - r.left, Math.max(280, r.width + dx))}px`;
  viewer.style.height = `${Math.min(innerHeight - r.top, Math.max(200, r.height + dy))}px`;
});

function update() {
  cctvOn = toggle.checked;
  status.hidden = !cctvOn;
  if (cctvOn && !document.hidden) void loadCameras();
  else {
    cameraController?.abort();
    viewer.hidden = true;
    currentCam = null;
    clearInterval(viewerTimer);
  }
  for (const id of ["cctv-glow", "cctv-dots", "cctv-label"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", cctvOn ? "visible" : "none");
  recomputeTiles();
}
toggle.addEventListener("change", update);
cvImg.onerror = () => {
  cvImg.parentElement.classList.remove("loaded");
  viewer.querySelector(".cctv-linking").textContent = "IMAGE UNAVAILABLE";
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { cameraController?.abort(); clearInterval(viewerTimer); }
  else if (cctvOn) { void loadCameras(); if (currentCam && !viewer.hidden) openViewer(currentCam); }
  recomputeTiles();
});
map.on("resize", () => { placeTiles(); recomputeTiles(); });
update();
return { get enabled() { return cctvOn; }, get count() { return cctvData.features.length; }, get previews() { return tiles.size; } };

}
