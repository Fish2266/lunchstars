// Low-poly display models built from primitives. Pure visuals: collision still uses the simple
// shapes in sim/weapons.ts. Every gun model points down +Z with its center where the sim's box center is.
import * as THREE from 'three';
import type { ModelKind } from '../sim/sim';

const mat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, ...opts });

const GUNMETAL = mat(0x2a2d34, { metalness: 0.6, roughness: 0.35 });
const DARK = mat(0x15161a, { metalness: 0.4, roughness: 0.5 });
const WOOD = mat(0x8a4b25, { roughness: 0.7, metalness: 0 });
const BRASS = mat(0xd9a441, { metalness: 0.8, roughness: 0.3 });
const OLIVE = mat(0x4d6b32, { roughness: 0.6, metalness: 0.1 });
const SKIN = mat(0xffe0bd, { roughness: 0.55, metalness: 0 });
const EYE = mat(0x15151a, { roughness: 0.2, metalness: 0 });
const EYE_SHINE = new THREE.MeshBasicMaterial({ color: 0xffffff });
/** Shared, so all live grenades blink together (see `animateModels`). */
export const LIVE_GRENADE = mat(0x4d6b32, { roughness: 0.6, emissive: 0xff2020, emissiveIntensity: 0 });

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rx;
  return mesh;
}

function cyl(r: number, len: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  // Cylinder along +Z.
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12).rotateX(Math.PI / 2), m);
  mesh.position.set(x, y, z);
  return mesh;
}

function pistol() {
  // Sim box: 0.08 x 0.14 x 0.28, centered.
  const g = new THREE.Group();
  g.add(box(0.06, 0.06, 0.26, GUNMETAL, 0, 0.035, 0.01)); // slide
  g.add(cyl(0.012, 0.03, DARK, 0, 0.035, 0.15)); // muzzle
  g.add(box(0.05, 0.13, 0.065, DARK, 0, -0.04, -0.075, 0.28)); // grip
  g.add(box(0.012, 0.035, 0.05, DARK, 0, -0.012, -0.015)); // trigger guard
  g.add(box(0.012, 0.02, 0.02, GUNMETAL, 0, 0.072, -0.1)); // rear sight
  return g;
}

function shotgun() {
  // Sim box: 0.09 x 0.12 x 0.72, centered.
  const g = new THREE.Group();
  g.add(cyl(0.022, 0.5, GUNMETAL, 0, 0.025, 0.11)); // barrel
  g.add(cyl(0.018, 0.42, DARK, 0, -0.012, 0.08)); // magazine tube
  g.add(box(0.06, 0.07, 0.18, GUNMETAL, 0, 0.01, -0.13)); // receiver
  g.add(box(0.058, 0.05, 0.14, WOOD, 0, -0.01, 0.12)); // pump
  g.add(box(0.05, 0.09, 0.2, WOOD, 0, -0.04, -0.3, -0.12)); // stock
  g.add(box(0.045, 0.08, 0.05, WOOD, 0, -0.05, -0.18, 0.4)); // grip
  return g;
}

function grenade(live: boolean) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), live ? LIVE_GRENADE : OLIVE);
  body.scale.set(1, 1.15, 1);
  g.add(body);
  // Pineapple bands.
  for (const y of [-0.04, 0.03]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.098, 0.008, 6, 16).rotateX(Math.PI / 2), DARK);
    band.position.y = y;
    g.add(band);
  }
  g.add(box(0.04, 0.04, 0.04, GUNMETAL, 0, 0.115, 0)); // fuse
  g.add(box(0.015, 0.012, 0.11, GUNMETAL, 0.025, 0.11, -0.03, 0.4)); // lever
  if (!live) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.005, 6, 12), BRASS);
    ring.position.set(-0.04, 0.13, 0);
    ring.rotation.y = Math.PI / 2;
    g.add(ring);
  }
  return g;
}

/** Head with a big-eyed cartoon face on the +Z side (characters face +Z at yaw 0). */
function head(radius: number) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 22, 16), SKIN));
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.2, 12, 10), EYE);
    eye.position.set(side * radius * 0.36, radius * 0.18, radius * 0.86);
    eye.scale.set(0.85, 1.15, 0.6);
    g.add(eye);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.06, 8, 6), EYE_SHINE);
    shine.position.set(side * radius * 0.36 + radius * 0.05, radius * 0.26, radius * 0.97);
    g.add(shine);
  }
  // Little smile.
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.22, radius * 0.035, 6, 12, Math.PI), EYE);
  mouth.position.set(0, -radius * 0.28, radius * 0.9);
  mouth.rotation.z = Math.PI;
  g.add(mouth);
  return g;
}

export function buildModel(kind: ModelKind, size: number): THREE.Object3D {
  let g: THREE.Object3D;
  switch (kind) {
    case 'pistol': g = pistol(); break;
    case 'shotgun': g = shotgun(); break;
    case 'grenade': g = grenade(false); break;
    case 'grenadeLive': g = grenade(true); break;
    case 'head': g = head(size); break;
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return g;
}

/** Per-frame model animation (blinking live grenades). */
export function animateModels(time: number) {
  LIVE_GRENADE.emissiveIntensity = Math.sin(time * 18) > 0 ? 1.4 : 0;
}
