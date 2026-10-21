// Cosmetics: hats, faces, tops and bottoms. A player's `Look` is four indices into the lists below, so it's
// tiny to save and to send over the network.
//
// - Tops and bottoms are painted onto the one-piece body as vertex colours: each vertex knows (from its skin
//   weights) which parts it belongs to and where along each part it sits, so a sleeve or a pair of shorts
//   can end at the right place on a limb. Edges are blended over a few centimetres so they don't look jagged.
// - Hats are little models stuck to the head bone; faces swap the eyes and mouth.
import * as THREE from 'three';
import { bodyGeometry } from './body';

export interface Look { head: number; face: number; torso: number; pants: number }
export const DEFAULT_LOOK: Look = { head: 0, face: 0, torso: 0, pants: 0 };

// ---------------------------------------------------------------- tops and bottoms

type Paint = (p: THREE.Vector3) => number; // a colour for this rest-pose point (for patterns)

interface Top { name: string; color: number; sleeves: 'none' | 'short' | 'long'; pattern?: Paint }
interface Bottom { name: string; color: number; length: 'shorts' | 'long'; shoes: number | null; pattern?: Paint }

const stripes = (a: number, b: number, w = 0.055): Paint => (p) => (Math.floor(p.y / w) % 2 === 0 ? a : b);
const check = (a: number, b: number, w = 0.06): Paint => (p) => ((Math.floor(p.x / w) + Math.floor(p.y / w)) % 2 === 0 ? a : b);
const camo = (cols: number[]): Paint => (p) => {
  const n = Math.sin(p.x * 23 + Math.sin(p.y * 17)) + Math.sin(p.y * 19 + Math.sin(p.z * 21)) + Math.sin(p.z * 27 + p.x * 9);
  return cols[Math.min(cols.length - 1, Math.floor(((n + 3) / 6) * cols.length))];
};
const sideStripe = (a: number, b: number): Paint => (p) => (Math.abs(Math.abs(p.x) - 0.17) < 0.02 && p.y < -0.05 ? b : a);

export const TORSOS: Top[] = [
  { name: 'None', color: 0, sleeves: 'none' },
  { name: 'White tee', color: 0xf2f2ee, sleeves: 'short' },
  { name: 'Red tee', color: 0xd93a3a, sleeves: 'short' },
  { name: 'Sailor stripes', color: 0xffffff, sleeves: 'short', pattern: stripes(0xf4f4f4, 0x23365e) },
  { name: 'Tank top', color: 0x2f7bd6, sleeves: 'none' },
  { name: 'Grey hoodie', color: 0x8a8f99, sleeves: 'long' },
  { name: 'Flannel', color: 0xb02a2a, sleeves: 'long', pattern: check(0xb02a2a, 0x2b1a1a) },
  { name: 'Green sweater', color: 0x3f8f4f, sleeves: 'long' },
  { name: 'Black long sleeve', color: 0x25262b, sleeves: 'long' },
];

export const PANTS: Bottom[] = [
  { name: 'None', color: 0, length: 'shorts', shoes: null },
  { name: 'Jeans', color: 0x34548c, length: 'long', shoes: 0xf2f2f2 },
  { name: 'Khaki shorts', color: 0xc8b082, length: 'shorts', shoes: 0x3a3a3a },
  { name: 'Black pants', color: 0x232428, length: 'long', shoes: 0x111111 },
  { name: 'Camo pants', color: 0x55623a, length: 'long', shoes: 0x3b2c1e, pattern: camo([0x3e4a2a, 0x55623a, 0x7a7350, 0x2b2a1f]) },
  { name: 'Plaid shorts', color: 0x2f6f8f, length: 'shorts', shoes: 0xf2f2f2, pattern: check(0x2f6f8f, 0xe0c060, 0.05) },
  { name: 'Track pants', color: 0xc22f2f, length: 'long', shoes: 0xf2f2f2, pattern: sideStripe(0xc22f2f, 0xffffff) },
  { name: 'Pink shorts', color: 0xff8fc8, length: 'shorts', shoes: 0xffffff },
];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * How much of a part (given a point's position along it, in the part's own frame) a top or bottom covers.
 * Limb frames run from +y at the joint nearer the body to -y at the far end.
 */
function topCover(part: string, y: number, top: Top): number {
  if (top.name === 'None') return 0;
  if (part === 'chest') return 1;
  if (part === 'pelvis') return smooth(0.02, 0.07, y); // tucked hem around the waist
  if (part.startsWith('upperArm')) return top.sleeves === 'long' ? 1 : top.sleeves === 'short' ? smooth(-0.04, 0.0, y) : 0;
  if (part.startsWith('forearm')) return top.sleeves === 'long' ? smooth(-0.1, -0.07, y) : 0; // stops at the wrist
  return 0;
}

function bottomCover(part: string, y: number, b: Bottom): number {
  if (b.name === 'None') return 0;
  if (part === 'pelvis') return 1;
  if (part.startsWith('thigh')) return b.length === 'long' ? 1 : smooth(-0.1, -0.06, y);
  if (part.startsWith('shin')) return b.length === 'long' ? smooth(-0.19, -0.16, y) : 0; // down to the ankle
  return 0;
}

function shoeCover(part: string, y: number, b: Bottom): number {
  return b.shoes !== null && part.startsWith('shin') ? smooth(-0.15, -0.18, y) : 0;
}

/** Vertex colours for a body wearing `look`, with `skin` (the player's colour) wherever it's bare. */
export function bodyColors(skin: number, look: Look): Float32Array {
  const { geometry, shapes } = bodyGeometry();
  const pos = geometry.getAttribute('position');
  const idx = geometry.getAttribute('skinIndex');
  const wt = geometry.getAttribute('skinWeight');
  const top = TORSOS[look.torso] ?? TORSOS[0];
  const bottom = PANTS[look.pants] ?? PANTS[0];
  const out = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3(), local = new THREE.Vector3();
  const cSkin = new THREE.Color(skin), cTmp = new THREE.Color(), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    let tc = 0, bc = 0, sc = 0;
    for (let j = 0; j < 4; j++) {
      const w = wt.getComponent(i, j);
      if (w < 0.01) continue;
      const s = shapes[idx.getComponent(i, j)];
      local.copy(p).applyMatrix4(s.inv);
      tc += w * topCover(s.name, local.y, top);
      bc += w * bottomCover(s.name, local.y, bottom);
      sc += w * shoeCover(s.name, local.y, bottom);
    }
    // Sharpen the blended coverage into a crisp (but not jagged) edge.
    tc = smooth(0.3, 0.7, tc); bc = smooth(0.3, 0.7, bc); sc = smooth(0.3, 0.7, sc);
    c.copy(cSkin);
    if (bc > 0) c.lerp(cTmp.set(bottom.pattern ? bottom.pattern(p) : bottom.color), bc);
    if (sc > 0 && bottom.shoes !== null) c.lerp(cTmp.set(bottom.shoes), sc);
    if (tc > 0) c.lerp(cTmp.set(top.pattern ? top.pattern(p) : top.color), tc);
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  return out;
}

/**
 * A body geometry of its own for one player: shares the (big) shape and skinning data with every other
 * player, with its own colour attribute.
 */
export function playerGeometry(): THREE.BufferGeometry {
  const { geometry } = bodyGeometry();
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) g.setAttribute(name, geometry.getAttribute(name));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3), 3));
  return g;
}

export function paintBody(g: THREE.BufferGeometry, skin: number, look: Look) {
  const attr = g.getAttribute('color') as THREE.BufferAttribute;
  (attr.array as Float32Array).set(bodyColors(skin, look));
  attr.needsUpdate = true;
}

let bodyMat: THREE.MeshPhysicalMaterial | null = null;
/** The gummy material, coloured per vertex (skin + clothes). */
export function gummyBodyMaterial() {
  bodyMat ??= new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.12, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color(0xb8b8b8),
  });
  return bodyMat;
}

// ---------------------------------------------------------------- hats

const mats = new Map<number, THREE.MeshStandardMaterial>();
function mat(color: number, rough = 0.5, metal = 0) {
  const key = color * 10 + Math.round(rough * 5) + metal * 7;
  let m = mats.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }); mats.set(key, m); }
  return m;
}
function mesh(geo: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, rough = 0.5, metal = 0) {
  const m = new THREE.Mesh(geo, mat(color, rough, metal));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
const dome = (r: number, cut = 0.5) => new THREE.SphereGeometry(r, 20, 12, 0, Math.PI * 2, 0, Math.PI * cut);

/** Hats sit on top of a head of radius r (head centre at the origin, +z is the face; the eyes reach ~0.4r). */
const SEAT = 0.46; // where brims and rims sit, as a fraction of r: just above the eyes

/** A dome that hugs the top of the head: its rim at the seat, flattened to the head's curve. */
function cap(r: number, color: number, radius = 1.02, squash = 0.74, rough = 0.5, metal = 0) {
  const m = mesh(dome(r * radius, 0.5), color, 0, r * SEAT, 0, rough, metal);
  m.scale.y = squash;
  return m;
}
const top = (r: number, radius = 1.02, squash = 0.74) => r * SEAT + r * radius * squash; // height of a cap's crown

export const HATS: { name: string; build: ((r: number) => THREE.Object3D) | null }[] = [
  { name: 'None', build: null },
  { name: 'Baseball cap', build: (r) => {
    const g = new THREE.Group();
    g.add(cap(r, 0x2a62c9));
    const brim = mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, r * 0.06, 20, 1, false, -Math.PI / 2, Math.PI), 0x2a62c9, 0, r * (SEAT + 0.02), r * 0.7);
    brim.scale.set(1, 1, 1.1);
    brim.rotation.x = 0.12;
    g.add(brim, mesh(new THREE.SphereGeometry(r * 0.09, 8, 6), 0xffffff, 0, top(r) + r * 0.02, 0));
    return g;
  } },
  { name: 'Beanie', build: (r) => {
    const g = new THREE.Group();
    g.add(cap(r, 0xe0632f, 1.04, 0.86, 0.9));
    const rim = mesh(new THREE.TorusGeometry(r * 0.94, r * 0.12, 8, 24), 0xc04d22, 0, r * (SEAT + 0.04), 0, 0.9);
    rim.rotation.x = Math.PI / 2;
    g.add(rim, mesh(new THREE.SphereGeometry(r * 0.22, 10, 8), 0xffffff, 0, top(r, 1.04, 0.86) + r * 0.14, 0, 0.95));
    return g;
  } },
  { name: 'Top hat', build: (r) => {
    const g = new THREE.Group();
    const y0 = r * 0.86;
    g.add(mesh(new THREE.CylinderGeometry(r * 0.78, r * 0.78, r * 0.05, 24), 0x1a1a1f, 0, y0, 0, 0.4));
    g.add(mesh(new THREE.CylinderGeometry(r * 0.52, r * 0.55, r * 1.05, 24), 0x1a1a1f, 0, y0 + r * 0.53, 0, 0.4));
    g.add(mesh(new THREE.CylinderGeometry(r * 0.56, r * 0.56, r * 0.16, 24), 0xb3202a, 0, y0 + r * 0.12, 0, 0.6));
    return g;
  } },
  { name: 'Hard hat', build: (r) => {
    const g = new THREE.Group();
    g.add(cap(r, 0xffc61a, 1.08, 0.8, 0.35));
    g.add(mesh(new THREE.CylinderGeometry(r * 1.24, r * 1.24, r * 0.06, 24), 0xffc61a, 0, r * (SEAT + 0.02), r * 0.06, 0.35));
    const ridge = mesh(new THREE.BoxGeometry(r * 0.18, r * 0.14, r * 1.5), 0xf0b000, 0, top(r, 1.08, 0.8) - r * 0.02, 0, 0.35);
    g.add(ridge);
    return g;
  } },
  { name: 'Crown', build: (r) => {
    const g = new THREE.Group();
    const y = r * 0.84;
    g.add(mesh(new THREE.CylinderGeometry(r * 0.64, r * 0.6, r * 0.32, 20, 1, true), 0xffcc33, 0, y, 0, 0.25, 1));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.add(mesh(new THREE.ConeGeometry(r * 0.13, r * 0.34, 8), 0xffcc33, Math.sin(a) * r * 0.62, y + r * 0.32, Math.cos(a) * r * 0.62, 0.25, 1));
      g.add(mesh(new THREE.SphereGeometry(r * 0.07, 8, 6), i % 2 ? 0xe02040 : 0x2a6fe0, Math.sin(a) * r * 0.65, y + r * 0.02, Math.cos(a) * r * 0.65, 0.2));
    }
    return g;
  } },
  { name: 'Chef hat', build: (r) => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.CylinderGeometry(r * 0.68, r * 0.74, r * 0.55, 20), 0xffffff, 0, r * 0.88, 0, 0.9));
    for (const [x, z] of [[0, 0], [0.35, 0.2], [-0.35, 0.2], [0.25, -0.3], [-0.25, -0.3], [0, 0.4]]) {
      g.add(mesh(new THREE.SphereGeometry(r * 0.42, 12, 10), 0xffffff, x * r, r * 1.32, z * r, 0.9));
    }
    return g;
  } },
  { name: 'Propeller cap', build: (r) => {
    const g = new THREE.Group();
    const colors = [0xe23b3b, 0xffd23b, 0x3b8be2, 0x3bc25a];
    for (let i = 0; i < 4; i++) {
      const seg = mesh(new THREE.SphereGeometry(r * 1.02, 10, 10, (i / 4) * Math.PI * 2, Math.PI / 2, 0, Math.PI / 2), colors[i], 0, r * SEAT, 0);
      seg.scale.y = 0.74;
      g.add(seg);
    }
    const crown = top(r);
    g.add(mesh(new THREE.CylinderGeometry(r * 0.03, r * 0.03, r * 0.3, 6), 0x555555, 0, crown + r * 0.13, 0));
    const prop = new THREE.Group();
    prop.name = 'spin';
    prop.position.set(0, crown + r * 0.28, 0);
    for (const s of [-1, 1]) {
      const blade = mesh(new THREE.BoxGeometry(r * 0.75, r * 0.03, r * 0.16), 0xe23b3b, s * r * 0.38, 0, 0);
      blade.rotation.x = 0.25 * s;
      prop.add(blade);
    }
    g.add(prop);
    return g;
  } },
  { name: 'Traffic cone', build: (r) => {
    const g = new THREE.Group();
    const y = r * 0.9;
    g.add(mesh(new THREE.BoxGeometry(r * 1.4, r * 0.08, r * 1.4), 0xff6a1a, 0, y, 0, 0.6));
    g.add(mesh(new THREE.ConeGeometry(r * 0.6, r * 1.5, 20), 0xff6a1a, 0, y + r * 0.75, 0, 0.6));
    g.add(mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.42, r * 0.2, 20), 0xf4f4f4, 0, y + r * 0.72, 0, 0.5));
    return g;
  } },
  { name: 'Party hat', build: (r) => {
    const g = new THREE.Group();
    const cone = mesh(new THREE.ConeGeometry(r * 0.48, r * 1.2, 20), 0x9b3bdb, 0, r * 1.38, 0, 0.5);
    cone.rotation.z = -0.15;
    g.add(cone, mesh(new THREE.SphereGeometry(r * 0.16, 10, 8), 0xffe14d, r * 0.13, r * 2.0, 0, 0.8));
    return g;
  } },
  { name: 'Viking helmet', build: (r) => {
    const g = new THREE.Group();
    g.add(cap(r, 0xb4bac2, 1.06, 0.82, 0.38, 0.35));
    const band = mesh(new THREE.TorusGeometry(r * 0.98, r * 0.08, 8, 24), 0x7a5a2a, 0, r * (SEAT + 0.04), 0, 0.6);
    band.rotation.x = Math.PI / 2;
    g.add(band);
    for (const s of [-1, 1]) {
      const horn = mesh(new THREE.ConeGeometry(r * 0.17, r * 0.85, 10), 0xf0e6c8, s * r * 1.02, r * 1.0, 0, 0.6);
      horn.rotation.z = -s * 0.7;
      g.add(horn);
    }
    return g;
  } },
  { name: 'Headphones', build: (r) => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.TorusGeometry(r * 1.06, r * 0.07, 8, 24, Math.PI), 0x222428, 0, r * 0.12, 0, 0.4));
    for (const s of [-1, 1]) {
      const cup = mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, r * 0.2, 16), 0xe23b3b, s * r * 1.02, r * 0.1, 0, 0.4);
      cup.rotation.z = Math.PI / 2;
      g.add(cup);
    }
    return g;
  } },
];

export function buildHat(index: number, r: number): THREE.Object3D | null {
  return HATS[index]?.build?.(r) ?? null;
}

/** Spin any propellers. */
export function animateHat(hat: THREE.Object3D | null, time: number) {
  const p = hat?.getObjectByName('spin');
  if (p) p.rotation.y = time * 14;
}

// ---------------------------------------------------------------- faces

const DARK = 0x16161c;
const WHITE = 0xffffff;
const PINK = 0xff6f9a;

function eye(r: number, side: number, sx = 1, sy = 1, dy = 0) {
  const g = new THREE.Group();
  const e = mesh(new THREE.SphereGeometry(r * 0.17, 12, 10), DARK, side * r * 0.34, r * (0.18 + dy), r * 0.9, 0.3);
  e.scale.set(0.85 * sx, 1.2 * sy, 0.55);
  e.castShadow = false;
  const shine = mesh(new THREE.SphereGeometry(r * 0.05, 8, 6), WHITE, side * r * 0.34 + r * 0.04 * sx, r * (0.26 + dy) , r * 0.99, 0.2);
  shine.castShadow = false;
  g.add(e, shine);
  return g;
}
function arc(r: number, radius: number, thick: number, y: number, flip: boolean, span = Math.PI, x = 0, rotZ = 0) {
  const m = mesh(new THREE.TorusGeometry(r * radius, r * thick, 6, 14, span), DARK, x, y, r * 0.94, 0.3);
  m.rotation.z = (flip ? Math.PI : 0) + rotZ;
  m.castShadow = false;
  return m;
}
function bar(r: number, w: number, h: number, x: number, y: number, rotZ: number, color = DARK, z = 0.95) {
  const m = mesh(new THREE.BoxGeometry(r * w, r * h, r * 0.06), color, x, y, r * z, 0.3);
  m.rotation.z = rotZ;
  m.castShadow = false;
  return m;
}
function blob(r: number, size: number, x: number, y: number, color: number, sx = 1, sy = 1, sz = 0.4, z = 0.93) {
  const m = mesh(new THREE.SphereGeometry(r * size, 12, 10), color, x, y, r * z, 0.4);
  m.scale.set(sx, sy, sz);
  m.castShadow = false;
  return m;
}

/** Face styles (the awake face; knocked out, everyone gets the same X eyes). */
export const FACES: { name: string; build: (r: number) => THREE.Object3D }[] = [
  { name: 'Smile', build: (r) => { const g = new THREE.Group(); g.add(eye(r, -1), eye(r, 1), arc(r, 0.18, 0.03, -r * 0.24, true)); return g; } },
  { name: 'Big grin', build: (r) => {
    const g = new THREE.Group();
    g.add(eye(r, -1), eye(r, 1));
    const mouth = mesh(new THREE.CircleGeometry(r * 0.3, 20, Math.PI, Math.PI), DARK, 0, -r * 0.1, r * 0.97, 0.3);
    mouth.castShadow = false;
    g.add(mouth, bar(r, 0.5, 0.08, 0, -r * 0.14, 0, WHITE, 0.98), blob(r, 0.11, 0, -r * 0.31, PINK, 1.4, 0.6, 0.3, 0.95));
    return g;
  } },
  { name: 'Grumpy', build: (r) => {
    const g = new THREE.Group();
    g.add(eye(r, -1, 1, 0.8), eye(r, 1, 1, 0.8));
    g.add(bar(r, 0.3, 0.07, -r * 0.34, r * 0.42, -0.45), bar(r, 0.3, 0.07, r * 0.34, r * 0.42, 0.45));
    g.add(arc(r, 0.15, 0.03, -r * 0.34, false));
    return g;
  } },
  { name: 'Surprised', build: (r) => {
    const g = new THREE.Group();
    g.add(eye(r, -1, 1.35, 1.25, 0.03), eye(r, 1, 1.35, 1.25, 0.03));
    const o = mesh(new THREE.TorusGeometry(r * 0.1, r * 0.035, 6, 14), DARK, 0, -r * 0.28, r * 0.95, 0.3);
    o.castShadow = false;
    g.add(o);
    return g;
  } },
  { name: 'Content', build: (r) => {
    const g = new THREE.Group();
    g.add(arc(r, 0.11, 0.028, r * 0.16, false, Math.PI, -r * 0.34), arc(r, 0.11, 0.028, r * 0.16, false, Math.PI, r * 0.34));
    g.add(arc(r, 0.1, 0.028, -r * 0.24, true));
    return g;
  } },
  { name: 'Cool shades', build: (r) => {
    const g = new THREE.Group();
    for (const s of [-1, 1]) g.add(blob(r, 0.19, s * r * 0.34, r * 0.18, 0x111111, 1.1, 0.8, 0.35, 0.94));
    g.add(bar(r, 0.3, 0.05, 0, r * 0.22, 0, 0x111111, 0.97));
    g.add(arc(r, 0.13, 0.03, -r * 0.26, true, Math.PI * 0.8, r * 0.04, 0.3));
    return g;
  } },
  { name: 'Mustache', build: (r) => {
    const g = new THREE.Group();
    g.add(eye(r, -1), eye(r, 1));
    for (const s of [-1, 1]) {
      const m = blob(r, 0.15, s * r * 0.13, -r * 0.13, 0x5a3418, 1.4, 0.55, 0.5, 0.95);
      m.rotation.z = s * -0.25;
      g.add(m);
    }
    g.add(arc(r, 0.1, 0.025, -r * 0.3, true));
    return g;
  } },
  { name: 'Cheeky', build: (r) => {
    const g = new THREE.Group();
    g.add(eye(r, -1), eye(r, 1), arc(r, 0.17, 0.03, -r * 0.22, true));
    g.add(blob(r, 0.13, r * 0.05, -r * 0.4, PINK, 1, 1.25, 0.55, 0.95));
    return g;
  } },
  { name: 'Wink', build: (r) => {
    const g = new THREE.Group();
    g.add(eye(r, -1), arc(r, 0.11, 0.028, r * 0.16, false, Math.PI, r * 0.34), arc(r, 0.18, 0.03, -r * 0.24, true));
    return g;
  } },
  { name: 'Derp', build: (r) => {
    const g = new THREE.Group();
    g.add(eye(r, -1, 1.4, 1.3, 0.04), eye(r, 1, 0.75, 0.75, -0.04));
    g.add(arc(r, 0.14, 0.03, -r * 0.27, true, Math.PI, r * 0.05, 0.35));
    return g;
  } },
  { name: 'Blushing', build: (r) => {
    const g = new THREE.Group();
    g.add(eye(r, -1), eye(r, 1), arc(r, 0.13, 0.03, -r * 0.24, true));
    for (const s of [-1, 1]) g.add(blob(r, 0.11, s * r * 0.52, -r * 0.08, PINK, 1.2, 0.7, 0.3, 0.86));
    return g;
  } },
];

/** Keep a look's indices in range (looks arrive from other players over the network). */
export function sanitizeLook(l: Partial<Look> | undefined | null): Look {
  const pick = (v: unknown, n: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < n ? (v as number) : 0);
  return { head: pick(l?.head, HATS.length), face: pick(l?.face, FACES.length), torso: pick(l?.torso, TORSOS.length), pants: pick(l?.pants, PANTS.length) };
}

export function randomLook(): Look {
  const r = (n: number) => Math.floor(Math.random() * n);
  return { head: r(HATS.length), face: r(FACES.length), torso: r(TORSOS.length), pants: 1 + r(PANTS.length - 1) };
}
