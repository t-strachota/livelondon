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

export class BusLayer {
  constructor(map, onFailure = () => {}) {
    this.id = 'live-bus-models';
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
    this.parts = makeBus();
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
      this.color.setRGB(bus.stale ? .35 : 1, bus.stale ? .35 : 1, bus.stale ? .35 : 1);
      for (const mesh of this.meshes) { mesh.setMatrixAt(i, this.transform.matrix); mesh.setColorAt(i, this.color); }
    }
    for (const mesh of this.meshes) {
      mesh.count = visible.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.material.opacity = this.opacity;
      mesh.material.depthWrite = this.opacity >= 1;
    }
    this.map.triggerRepaint();
  }

  render(gl, args) {
    if (this.failed || !this.opacity || !this.meshes.some(mesh => mesh.count)) return;
    try {
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
