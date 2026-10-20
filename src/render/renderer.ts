// Draws the simulation. Reads only entity descriptions + a flat transform array,
// so it works the same whether transforms come from a local sim or a network snapshot.
import * as THREE from 'three';
import type { EntityDesc, ShapeDesc } from '../sim/sim';
import { buildBody } from './body';
import { buildFace, buildModel, gummy, type Face } from './models';
import { surfaceMaterial, worldBox } from './surfaces';

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.05, 300);
  readonly gl: THREE.WebGLRenderer;
  /** One mesh per sim entity, same order as `sim.entities`. */
  meshes: THREE.Object3D[] = [];
  /** Objects not tied to one entity (skinned bodies). */
  private extra: THREE.Object3D[] = [];
  private faces = new Map<number, Face>();
  private furnaceLight: THREE.PointLight;
  private furnaceState: 'idle' | 'warn' | 'burst' = 'idle';

  setFurnace(state: 'idle' | 'warn' | 'burst') {
    this.furnaceState = state;
  }
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

    // Industrial dusk: smoky sky, warm bounce from the furnace, a hazy drop below.
    this.scene.background = new THREE.Color(0x2b2f38);
    this.scene.fog = new THREE.Fog(0x2b2f38, 22, 60);

    this.scene.add(new THREE.HemisphereLight(0xc9d6ff, 0x5a3a2a, 1.25));
    this.sun = new THREE.DirectionalLight(0xffe2c4, 2.0);
    this.sun.position.set(8, 16, 6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 50;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);

    // Hanging factory lamps: warm pools of light over the floor (no shadows, to keep it cheap).
    const shade = new THREE.MeshStandardMaterial({ color: 0x2f4a3a, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide });
    const bulb = new THREE.MeshBasicMaterial({ color: 0xfff1c8 });
    const cable = new THREE.MeshBasicMaterial({ color: 0x111111 });
    for (const [x, z] of [[-4.6, 3.6], [4.6, 3.6], [-4.6, -4.2], [4.6, -4.2]]) {
      const y = 6.2;
      const lamp = new THREE.Group();
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 6, 4), cable);
      c.position.y = 3.2;
      const sh = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.32, 18, 1, true), shade);
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), bulb);
      b.position.y = -0.12;
      lamp.add(c, sh, b);
      lamp.position.set(x, y, z);
      this.scene.add(lamp);
      const spot = new THREE.SpotLight(0xffd9a0, 55, 15, 0.75, 0.6, 1.4);
      spot.position.set(x, y - 0.15, z);
      spot.target.position.set(x, 0, z);
      this.scene.add(spot, spot.target);
    }

    // Furnace glow: a warm light in the mouth that flickers, and flares before and during a burst.
    this.furnaceLight = new THREE.PointLight(0xff7a2a, 30, 16, 1.5);
    this.furnaceLight.position.set(0, 0.3, 0); // just above the fire pit
    this.scene.add(this.furnaceLight);

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
    for (const m of this.extra) this.scene.remove(m);
    this.extra = [];
    // Player body parts become bones of one skinned body per player (see body.ts).
    const bonesByPlayer = new Map<number, { bones: THREE.Bone[]; color: number }>();
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    this.meshes = entities.map((e) => {
      if (e.role === 'player' && e.playerId !== undefined && e.model !== undefined && !isGunModel(e.model)) {
        const bone = new THREE.Bone();
        // Invisible copy of the collision shape, so the crosshair raycast can hit players.
        bone.add(new THREE.Mesh(geometryFor(e.shape), pickMat));
        if (e.model === 'head') {
          // Matches the head of the body bean (see body.ts), not the smaller physics ball.
          const face = buildFace(0.195);
          bone.add(face.group);
          this.faces.set(e.playerId, face);
        }
        let entry = bonesByPlayer.get(e.playerId);
        if (!entry) { entry = { bones: [], color: e.color }; bonesByPlayer.set(e.playerId, entry); }
        entry.bones.push(bone);
        this.scene.add(bone);
        return bone;
      }
      if (e.model) {
        const model = buildModel(e);
        this.scene.add(model);
        return model;
      }
      // Textured level pieces get world-scale UVs; everything else the plain shape.
      const mesh = e.surface && e.shape.kind === 'box'
        ? new THREE.Mesh(worldBox(e.shape.hx, e.shape.hy, e.shape.hz, e.surface), surfaceMaterial(e.surface, e.color, e.emissive ?? 0))
        : new THREE.Mesh(geometryFor(e.shape), materialFor(e));
      mesh.castShadow = e.role !== 'static' || e.shape.kind !== 'box' || (e.shape as { hy: number }).hy > 0.05;
      mesh.receiveShadow = true;
      if (e.role === 'static') mesh.matrixAutoUpdate = true;
      this.scene.add(mesh);
      return mesh;
    });
    for (const { bones, color } of bonesByPlayer.values()) {
      const body = buildBody(bones, gummy(color));
      this.scene.add(body);
      this.extra.push(body);
    }
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

  setKnockedOut(playerId: number, on: boolean) {
    this.faces.get(playerId)?.setKnockedOut(on);
  }

  render() {
    const t = performance.now() / 1000;
    const flicker = 0.85 + 0.15 * Math.sin(t * 13) * Math.sin(t * 7.3);
    const base = this.furnaceState === 'burst' ? 120 : this.furnaceState === 'warn' ? 45 + 25 * Math.sin(t * 30) : 30;
    this.furnaceLight.intensity = base * flicker;
    for (const f of this.faces.values()) f.animate(t);
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
  const key = `${e.role}:${e.color}:${e.emissive ?? 0}`;
  let m = matCache.get(key);
  if (!m) {
    const glow = e.emissive ?? (e.role === 'fx' ? 0.25 : 0);
    m = new THREE.MeshStandardMaterial({
      color: e.color,
      roughness: e.role === 'player' ? 0.55 : e.role === 'fx' ? 0.35 : 0.85,
      metalness: e.role === 'fx' ? 0.3 : 0,
      emissive: glow > 0 ? e.color : 0x000000,
      emissiveIntensity: glow,
    });
    matCache.set(key, m);
  }
  return m;
}

function isGunModel(m: string) {
  return m === 'pistol' || m === 'shotgun' || m === 'grenade' || m === 'grenadeLive';
}
