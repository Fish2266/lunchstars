// Draws the simulation. Reads only entity descriptions + a flat transform array,
// so it works the same whether transforms come from a local sim or a network snapshot.
import * as THREE from 'three';
import type { EntityDesc, ShapeDesc } from '../sim/sim';
import { buildModel } from './models';

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.05, 300);
  readonly gl: THREE.WebGLRenderer;
  /** One mesh per sim entity, same order as `sim.entities`. */
  meshes: THREE.Object3D[] = [];
  private builtVersion = -1;
  private sun: THREE.DirectionalLight;

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true });
    this.gl.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.gl.domElement);

    this.scene.background = new THREE.Color(0x8ec5ff);
    this.scene.fog = new THREE.Fog(0x8ec5ff, 30, 90);

    this.scene.add(new THREE.HemisphereLight(0xdff1ff, 0x6b5b4b, 1.4));
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    this.sun.position.set(8, 16, 6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 50;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);

    // Distant "void" clouds so the pit reads as deep.
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 40; i++) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(2 + Math.random() * 3, 10, 8), cloudMat);
      const a = Math.random() * Math.PI * 2;
      const d = 18 + Math.random() * 40;
      c.position.set(Math.cos(a) * d, -14 - Math.random() * 10, Math.sin(a) * d);
      c.scale.y = 0.5;
      this.scene.add(c);
    }

    const resize = () => {
      this.gl.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    };
    addEventListener('resize', resize);
    resize();
  }

  /** (Re)build meshes if the entity list changed. */
  /** Returns true if it rebuilt. */
  sync(entities: readonly EntityDesc[], version: number): boolean {
    if (version === this.builtVersion) return false;
    for (const m of this.meshes) this.scene.remove(m);
    this.meshes = entities.map((e) => {
      if (e.model) {
        const model = buildModel(e);
        this.scene.add(model);
        return model;
      }
      const mesh = new THREE.Mesh(geometryFor(e.shape), materialFor(e));
      mesh.castShadow = e.role !== 'static' || e.shape.kind !== 'box' || (e.shape as { hy: number }).hy > 0.05;
      mesh.receiveShadow = true;
      if (e.role === 'static') mesh.matrixAutoUpdate = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.builtVersion = version;
    return true;
  }

  /** Apply a flat [px,py,pz,qx,qy,qz,qw]* array. */
  applyTransforms(t: Float32Array) {
    for (let i = 0; i < this.meshes.length; i++) {
      const o = i * 7;
      const m = this.meshes[i];
      m.visible = t[o + 1] > -500; // sim parks hidden things far below the map
      m.position.set(t[o], t[o + 1], t[o + 2]);
      m.quaternion.set(t[o + 3], t[o + 4], t[o + 5], t[o + 6]);
    }
  }

  /** Keep the shadow camera centered on the action. */
  focusShadow(target: THREE.Vector3) {
    this.sun.position.set(target.x + 8, target.y + 16, target.z + 6);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  render() {
    this.gl.render(this.scene, this.camera);
  }
}

function geometryFor(s: ShapeDesc): THREE.BufferGeometry {
  switch (s.kind) {
    case 'box': {
      // Slightly rounded look on small boxes comes later (Phase 6); plain boxes read fine for now.
      return new THREE.BoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2);
    }
    case 'ball':
      return new THREE.SphereGeometry(s.r, 20, 14);
    case 'capsule':
      return new THREE.CapsuleGeometry(s.r, s.hh * 2, 6, 14);
  }
}

const matCache = new Map<string, THREE.Material>();
function materialFor(e: EntityDesc): THREE.Material {
  const key = `${e.role}:${e.color}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: e.color,
      roughness: e.role === 'player' ? 0.55 : e.role === 'fx' ? 0.35 : 0.85,
      metalness: e.role === 'fx' ? 0.3 : 0,
      emissive: e.role === 'fx' ? e.color : 0x000000,
      emissiveIntensity: e.role === 'fx' ? 0.25 : 0,
    });
    matCache.set(key, m);
  }
  return m;
}
