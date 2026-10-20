// Low-poly display models built from primitives. Pure visuals: collision still uses the simple
// shapes in sim/weapons.ts. Every gun model points down +Z with its center where the sim's box center is.
import * as THREE from 'three';
import type { EntityDesc, ModelKind } from '../sim/sim';

const mat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, ...opts });

const GUNMETAL = mat(0x2a2d34, { metalness: 0.6, roughness: 0.35 });
const DARK = mat(0x15161a, { metalness: 0.4, roughness: 0.5 });
const WOOD = mat(0x8a4b25, { roughness: 0.7, metalness: 0 });
const BRASS = mat(0xd9a441, { metalness: 0.8, roughness: 0.3 });
const OLIVE = mat(0x4d6b32, { roughness: 0.6, metalness: 0.1 });
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

// ------------------------------------------------------------------ gummy characters

const gummyCache = new Map<number, THREE.Material>();
/** Glossy, candy-like material: clearcoat for the wet shine, sheen for the soft rim. */
export function gummy(color: number) {
  let m = gummyCache.get(color);
  if (!m) {
    const c = new THREE.Color(color);
    m = new THREE.MeshPhysicalMaterial({
      color: c, roughness: 0.32, metalness: 0,
      clearcoat: 1, clearcoatRoughness: 0.12,
      sheen: 1, sheenRoughness: 0.4, sheenColor: c.clone().lerp(new THREE.Color(0xffffff), 0.5),
    });
    gummyCache.set(color, m);
  }
  return m;
}

function blob(rx: number, ry: number, rz: number, m: THREE.Material, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), m);
  mesh.scale.set(rx, ry, rz);
  mesh.position.set(0, y, z);
  return mesh;
}

/** Head with a big-eyed cartoon face on the +Z side (characters face +Z at yaw 0). */
function head(radius: number, color: number) {
  const r = radius * 1.12;
  const g = new THREE.Group();
  g.add(blob(r, r * 1.04, r, gummy(color)));
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r * 0.17, 12, 10), EYE);
    eye.position.set(side * r * 0.34, r * 0.16, r * 0.88);
    eye.scale.set(0.85, 1.2, 0.6);
    g.add(eye);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(r * 0.05, 8, 6), EYE_SHINE);
    shine.position.set(side * r * 0.34 + r * 0.04, r * 0.24, r * 0.98);
    g.add(shine);
  }
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(r * 0.18, r * 0.03, 6, 12, Math.PI), EYE);
  mouth.position.set(0, -r * 0.26, r * 0.92);
  mouth.rotation.z = Math.PI;
  g.add(mouth);
  return g;
}

const STAR = new THREE.MeshBasicMaterial({ color: 0xffe14a });

export interface Face {
  group: THREE.Group;
  /** Swap to knocked-out eyes and show the circling stars. */
  setKnockedOut(on: boolean): void;
  animate(time: number): void;
}

/** Eyes, shine and smile for the one-piece body's head bone (face points down +Z), plus knockout eyes and stars. */
export function buildFace(r: number): Face {
  const group = new THREE.Group();
  const awake = new THREE.Group();
  const out = new THREE.Group();
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r * 0.17, 12, 10), EYE);
    eye.position.set(side * r * 0.34, r * 0.18, r * 0.9);
    eye.scale.set(0.85, 1.2, 0.55);
    awake.add(eye);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(r * 0.05, 8, 6), EYE_SHINE);
    shine.position.set(side * r * 0.34 + r * 0.04, r * 0.26, r * 0.99);
    awake.add(shine);
    // Knocked out: X eyes.
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(r * 0.36, r * 0.07, r * 0.06), EYE);
      bar.position.set(side * r * 0.34, r * 0.18, r * 0.95);
      bar.rotation.z = a;
      out.add(bar);
    }
  }
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(r * 0.18, r * 0.03, 6, 12, Math.PI), EYE);
  mouth.position.set(0, -r * 0.24, r * 0.94);
  mouth.rotation.z = Math.PI;
  awake.add(mouth);
  // Knocked out: a little "o" mouth.
  const o = new THREE.Mesh(new THREE.TorusGeometry(r * 0.09, r * 0.03, 6, 12), EYE);
  o.position.set(0, -r * 0.26, r * 0.95);
  out.add(o);

  // Stars circling above the head. They stay level even when the head is on its side.
  const stars = new THREE.Group();
  const starGeo = new THREE.OctahedronGeometry(r * 0.16, 0);
  for (let i = 0; i < 4; i++) {
    const st = new THREE.Mesh(starGeo, STAR);
    const a = (i / 4) * Math.PI * 2;
    st.position.set(Math.cos(a) * r * 1.3, 0, Math.sin(a) * r * 1.3);
    stars.add(st);
  }
  out.add(stars);
  out.visible = false;
  group.add(awake, out);
  const up = new THREE.Vector3();
  const q = new THREE.Quaternion();
  return {
    group,
    setKnockedOut(on) { awake.visible = !on; out.visible = on; },
    animate(time) {
      if (!out.visible) return;
      // Place the ring above the head in world-up, whatever way the head is facing.
      group.getWorldQuaternion(q).invert();
      up.set(0, r * 1.5, 0).applyQuaternion(q);
      stars.position.copy(up);
      stars.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), time * 4));
      for (const st of stars.children) st.rotation.y = time * 6;
    },
  };
}

function capsule(r: number, len: number, m: THREE.Material) {
  return new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 8, 16), m);
}

/** Display model for one entity: guns from the weapon kind, gummy body parts from the collision shape. */
export function buildModel(e: EntityDesc): THREE.Object3D {
  const s = e.shape;
  let g: THREE.Object3D;
  switch (e.model!) {
    case 'pistol': g = pistol(); break;
    case 'shotgun': g = shotgun(); break;
    case 'grenade': g = grenade(false); break;
    case 'grenadeLive': g = grenade(true); break;
    case 'belt': g = belt(s.kind === 'box' ? s : { hx: 1, hy: 0.2, hz: 3 }); break;
    case 'head': g = head(s.kind === 'ball' ? s.r : 0.14, e.color); break;
    case 'torso': {
      // A round bean instead of a box, overlapping the hips so the body reads as one blob.
      const b = s.kind === 'box' ? s : { hx: 0.2, hy: 0.17, hz: 0.12 };
      g = blob(b.hx * 1.18, b.hy * 1.5, b.hz * 1.55, gummy(e.color), -0.02);
      break;
    }
    case 'hips': {
      const b = s.kind === 'box' ? s : { hx: 0.17, hy: 0.1, hz: 0.11 };
      g = blob(b.hx * 1.2, b.hy * 1.8, b.hz * 1.55, gummy(e.color));
      break;
    }
    case 'limb': {
      const c = s.kind === 'capsule' ? s : { hh: 0.1, r: 0.06 };
      g = capsule(c.r * 1.3, c.hh * 2, gummy(e.color));
      break;
    }
    case 'forearm': {
      // Forearm with a mitten hand on the end.
      const c = s.kind === 'capsule' ? s : { hh: 0.1, r: 0.055 };
      const grp = new THREE.Group();
      grp.add(capsule(c.r * 1.25, c.hh * 2, gummy(e.color)));
      grp.add(blob(c.r * 1.7, c.r * 1.9, c.r * 1.6, gummy(e.color), -(c.hh + c.r * 0.9)));
      g = grp;
      break;
    }
    case 'shin': {
      // Shin with a little rounded foot pointing forward.
      const c = s.kind === 'capsule' ? s : { hh: 0.19, r: 0.07 };
      const grp = new THREE.Group();
      grp.add(capsule(c.r * 1.3, c.hh * 2, gummy(e.color)));
      grp.add(blob(c.r * 1.35, c.r * 0.95, c.r * 1.9, gummy(e.color), -(c.hh + c.r * 0.35), c.r * 0.7));
      g = grp;
      break;
    }
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return g;
}

// ------------------------------------------------------------------ conveyor belt

/** Rubber belt with yellow chevrons, drawn once to a canvas; its offset scrolls to show the belt moving. */
const BELT_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = '#26272b'; x.fillRect(0, 0, 64, 64);
  x.strokeStyle = '#3a3b40'; x.lineWidth = 2;
  for (let i = 0; i < 64; i += 8) { x.beginPath(); x.moveTo(0, i); x.lineTo(64, i); x.stroke(); }
  x.strokeStyle = '#e3b21b'; x.lineWidth = 7;
  x.beginPath(); x.moveTo(6, 44); x.lineTo(32, 18); x.lineTo(58, 44); x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
let beltSpeed = 1.5;
export function setBeltSpeed(v: number) { beltSpeed = v; }

function belt(b: { hx: number; hy: number; hz: number }) {
  const tex = BELT_TEX.clone();
  tex.repeat.set(1, (b.hz * 2) / (b.hx * 2));
  tex.needsUpdate = true;
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  const side = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.7, metalness: 0.4 });
  // Box faces: +x, -x, +y (top), -y, +z, -z.
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2), [side, side, top, side, side, side]);
  beltTextures.push({ tex, length: b.hz * 2 });
  return mesh;
}
const beltTextures: { tex: THREE.Texture; length: number }[] = [];

/** Per-frame model animation (blinking live grenades, moving belts). */
export function animateModels(time: number) {
  LIVE_GRENADE.emissiveIntensity = Math.sin(time * 18) > 0 ? 1.4 : 0;
  // The belt moves toward -z: on the box's top face, v runs along +z... so scroll v forward.
  for (const b of beltTextures) b.tex.offset.y = ((time * beltSpeed) / b.length) * b.tex.repeat.y;
}
