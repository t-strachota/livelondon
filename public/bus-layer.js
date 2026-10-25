import * as THREE from 'three';
import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { mergeGeometries } from '/vendor/BufferGeometryUtils.js';
import { modelOpacity } from '/lib/motion.mjs';

const box = (size, position) => new THREE.BoxGeometry(...size).translate(...position);

function makeBus() {
  const red = [box([2.55, 11, 4.05], [0, -5.5, 2.35]), box([2.48, 10.8, .2], [0, -5.5, 4.43])];
  const glass = [], wheels = [], trim = [];
  for (const z of [1.85, 3.45]) {
    for (const x of [-1.285, 1.285]) {
      for (let i = 0; i < 6; i++) glass.push(box([.035, 1.25, .86], [x, -1.1 - i * 1.7, z]));
    }
    glass.push(box([2.1, .04, .9], [0, .025, z]));
    glass.push(box([2.1, .04, .9], [0, -11.025, z]));
  }
  for (const x of [-1.22, 1.22]) for (const y of [-2.1, -8.7]) {
    wheels.push(new THREE.CylinderGeometry(.52, .52, .3, 12).rotateZ(Math.PI / 2).translate(x, y, .55));
  }
  for (const x of [-.85, .85]) trim.push(box([.36, .06, .2], [x, .05, .9]));
  return [
    [red, 0xdf252f], [glass, 0x153641], [wheels, 0x262925], [trim, 0xffedbe],
  ].map(([parts, color]) => {
    const geometry = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    // The front is the origin: BODS positions refer to the front of the bus.
    return { geometry, material: new THREE.MeshLambertMaterial({ color, transparent: true }) };
  });
}

// A 4.2 m car (shorter than the simulation's 4.5 m car length, so stopped queues never touch),
// with windscreen, rear window and two side windows. Front at the origin, like the bus.
export function makeCar() {
  const body = [box([1.8, 4.2, .75], [0, -2.1, .55]), box([1.6, 2.2, .6], [0, -2.3, 1.22])];
  const glass = [box([1.45, .04, .45], [0, -1.19, 1.22]), box([1.45, .04, .45], [0, -3.41, 1.22]),
    box([.035, 1.9, .42], [-.81, -2.3, 1.24]), box([.035, 1.9, .42], [.81, -2.3, 1.24])];
  const wheels = [];
  for (const x of [-.85, .85]) for (const y of [-.8, -3.4]) wheels.push(new THREE.CylinderGeometry(.33, .33, .22, 10).rotateZ(Math.PI / 2).translate(x, y, .33));
  return [[body, 0x1e1f22], [glass, 0x9cc4d8], [wheels, 0x101010]].map(([parts, color]) => {
    const geometry = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    return { geometry, material: new THREE.MeshLambertMaterial({ color, transparent: true }) };
  });
}

// One 16 m train carriage, front at the origin. The body is white so the per-instance line colour shows;
// windows and roof are darker parts tinted by the same colour.
export const TRAIN_CAR_LENGTH = 17; // carriage plus gap
export function makeTrainCar() {
  const body = [box([2.8, 16, 2.6], [0, -8, 1.6])];
  const glass = [box([.04, 14.4, .75], [-1.42, -8, 2.1]), box([.04, 14.4, .75], [1.42, -8, 2.1]), box([2.3, .04, .8], [0, .02, 2.1])];
  const roof = [box([2.5, 15.6, .25], [0, -8, 3.02])];
  return [[body, 0xffffff], [glass, 0x2a3036], [roof, 0x9a9a9a]].map(([parts, color]) => {
    const geometry = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    return { geometry, material: new THREE.MeshLambertMaterial({ color, transparent: true }) };
  });
}

// A traffic light: grey pole and black head; the lit lamp (part 0) is drawn per instance at the
// red (top), amber or green (bottom) position in that colour. Exaggerated in size to read at zoom 16+.
const LAMP_HEIGHT = [4.0, 4.5, 5.0]; // GREEN, AMBER, RED
const LAMP_COLOUR = [[.18, .85, .3], [1, .7, 0], [1, .12, .1]];
export function makeTrafficLight() {
  const parts = [
    [new THREE.BoxGeometry(.72, .72, .42), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true })],
    [new THREE.CylinderGeometry(.08, .08, 3.6, 8).rotateX(Math.PI / 2).translate(0, 0, 1.8), new THREE.MeshLambertMaterial({ color: 0x8a8d88, transparent: true })],
    [box([.62, .62, 1.7], [0, 0, 4.5]), new THREE.MeshLambertMaterial({ color: 0x1a1b1c, transparent: true })],
  ];
  return parts.map(([geometry, material]) => ({ geometry, material }));
}

export class BusLayer {
  constructor(map, onFailure = () => {}, { id = 'live-bus-models', makeParts = makeBus, alpha = 1 } = {}) {
    this.id = id;
    this.makeParts = makeParts;
    this.alpha = alpha; // extra transparency, e.g. for trains that are underground
    this.focus = 1; // focus mode fade (stop-tools.js)
    this.type = 'custom';
    this.renderingMode = '3d';
    this.map = map;
    this.onFailure = onFailure;
    this.capacity = 0;
    this.meshes = [];
    this.opacity = 0;
    this.failed = false;
  }

  onAdd(map, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(-50, 30, 100);
    this.scene.add(light);
    this.parts = this.makeParts();
    this.origin = maplibregl.MercatorCoordinate.fromLngLat([-0.128, 51.507]);
    this.unit = this.origin.meterInMercatorCoordinateUnits();
    this.originMatrix = new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, 0)
      .scale(new THREE.Vector3(this.unit, -this.unit, this.unit));
    this.transform = new THREE.Object3D();
    this.color = new THREE.Color();
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  ensureCapacity(count) {
    if (count <= this.capacity) return;
    for (const mesh of this.meshes) { this.scene.remove(mesh); mesh.dispose(); }
    this.capacity = 2 ** Math.ceil(Math.log2(Math.max(64, count)));
    this.meshes = this.parts.map(({ geometry, material }) => {
      const mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return mesh;
    });
  }

  update(buses) {
    if (this.failed || !this.renderer) return;
    this.opacity = modelOpacity(this.map.getZoom());
    const bounds = this.map.getBounds();
    const visible = this.opacity > 0 ? buses.filter(bus => bounds.contains([bus.longitude, bus.latitude])) : [];
    this.ensureCapacity(visible.length);
    for (let i = 0; i < visible.length; i++) {
      const bus = visible[i];
      const coordinate = maplibregl.MercatorCoordinate.fromLngLat([bus.longitude, bus.latitude]);
      this.transform.position.set((coordinate.x - this.origin.x) / this.unit, -(coordinate.y - this.origin.y) / this.unit, .12);
      this.transform.rotation.set(0, 0, -bus.bearing * Math.PI / 180);
      this.transform.scale.setScalar(coordinate.meterInMercatorCoordinateUnits() / this.unit);
      this.transform.updateMatrix();
      if (bus.color) this.color.set(bus.color);
      else this.color.setRGB(bus.stale ? .35 : 1, bus.stale ? .35 : 1, bus.stale ? .35 : 1);
      for (const mesh of this.meshes) { mesh.setMatrixAt(i, this.transform.matrix); mesh.setColorAt(i, this.color); }
    }
    for (const mesh of this.meshes) {
      mesh.count = visible.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.material.opacity = this.opacity * this.alpha;
      mesh.material.depthWrite = this.opacity * this.alpha >= 1;
    }
    this.map.triggerRepaint();
  }

  // Simulated cars: xy in metres east/north of the same origin, heading in 0.01° units, culled to [w, s, e, n].
  updateCars(xy, angle, count, [west, south, east, north]) {
    if (this.failed || !this.renderer) return;
    this.opacity = modelOpacity(this.map.getZoom());
    let n = 0;
    if (this.opacity > 0) {
      this.ensureCapacity(count);
      for (let i = 0; i < count; i++) {
        const x = xy[2 * i], y = xy[2 * i + 1];
        if (x < west || x > east || y < south || y > north) continue;
        this.transform.position.set(x, y, .12);
        this.transform.rotation.set(0, 0, -angle[i] / 100 * Math.PI / 180);
        this.transform.updateMatrix();
        for (const mesh of this.meshes) mesh.setMatrixAt(n, this.transform.matrix);
        n++;
      }
    }
    for (const mesh of this.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.material.opacity = this.opacity;
      mesh.material.depthWrite = this.opacity >= 1;
    }
  }

  // Simulated signals: positions [x, y, z per approach] in layer metres, states 0-2 (255 = unknown).
  updateSignals(positions, states, count, [west, south, east, north]) {
    if (this.failed || !this.renderer) return;
    this.opacity = count ? modelOpacity(this.map.getZoom()) : 0;
    let n = 0;
    if (this.opacity > 0) {
      this.ensureCapacity(count);
      for (let k = 0; k < count; k++) {
        const state = states[k], x = positions[3 * k], y = positions[3 * k + 1];
        if (state > 2 || x < west || x > east || y < south || y > north) continue;
        this.transform.position.set(x, y, 0);
        this.transform.rotation.set(0, 0, 0);
        this.transform.updateMatrix();
        for (let m = 1; m < this.meshes.length; m++) this.meshes[m].setMatrixAt(n, this.transform.matrix);
        this.transform.position.z = LAMP_HEIGHT[state];
        this.transform.updateMatrix();
        this.meshes[0].setMatrixAt(n, this.transform.matrix);
        this.meshes[0].setColorAt(n, this.color.setRGB(...LAMP_COLOUR[state]));
        n++;
      }
    }
    for (const mesh of this.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.material.opacity = this.opacity;
      mesh.material.depthWrite = this.opacity >= 1;
    }
  }

  render(gl, args) {
    if (this.failed || !this.opacity || !this.meshes.some(mesh => mesh.count)) return;
    try {
      const opacity = this.opacity * this.alpha * this.focus;
      for (const mesh of this.meshes) { mesh.material.opacity = opacity; mesh.material.depthWrite = opacity >= 1; }
      this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(this.originMatrix);
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
      this.renderer.resetState();
    } catch {
      this.failed = true;
      this.onFailure();
    }
  }

  onRemove() {
    for (const mesh of this.meshes) mesh.dispose();
    for (const part of this.parts ?? []) { part.geometry.dispose(); part.material.dispose(); }
    this.renderer?.dispose();
  }
}
