// One-piece gummy character mesh.
//
// The physics character is 11 separate rigid bodies. To draw it as a single smooth blob:
// 1. Once, at load: describe every part as a soft shape (ellipsoids, capsules, mitten hands, feet) in a
//    relaxed A-pose, blend them with a smooth union into one signed-distance field, and mesh it with
//    marching cubes. That gives one seamless surface.
// 2. Skin that surface to 11 bones, one per physics part, with weights that fade smoothly across each
//    joint. Every frame the bones just copy the physics transforms; the GPU bends the mesh.
// So: one draw call per character, no seams, and the physics is untouched.
import * as THREE from 'three';
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';
import { ARM_X, HIP_X, PARTS, type PartName } from '../sim/ragdoll';

const SHOULDER_Y = 0.4;
const HIP_Y = -0.08;
const ARM_SPREAD = 0.6; // radians the arms are lifted out in the mesh's rest pose
const LEG_SPREAD = 0.1;

type Prim =
  | { kind: 'ellipsoid'; c: THREE.Vector3; r: THREE.Vector3 }
  /** Tapered capsule along local Y, from (y0, r0) to (y1, r1). */
  | { kind: 'cone'; y0: number; r0: number; y1: number; r1: number };

interface PartShape {
  name: PartName;
  /** Rest transform of this part in mesh space (pelvis at the origin). */
  pos: THREE.Vector3;
  rot: THREE.Quaternion;
  inv: THREE.Matrix4;
  prims: Prim[];
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Soft shapes for each part, in the part's local frame. The torso, hips and head form one bean (the head is
 * nearly as wide as the body, no neck). Limbs taper and start inside the body so they grow out of it.
 */
function primsFor(name: PartName): Prim[] {
  switch (name) {
    case 'pelvis': return [
      { kind: 'ellipsoid', c: v3(0, -0.01, -0.005), r: v3(0.215, 0.19, 0.18) },
      // A soft, rounded rear: one smooth bulge, not two cheeks.
      { kind: 'ellipsoid', c: v3(0, -0.06, -0.06), r: v3(0.2, 0.14, 0.16) },
    ];
    case 'chest': return [{ kind: 'ellipsoid', c: v3(0, 0, 0), r: v3(0.225, 0.27, 0.185) }];
    case 'head': return [{ kind: 'ellipsoid', c: v3(0, 0.0, 0.0), r: v3(0.2, 0.2, 0.19) }];
    case 'upperArmL': case 'upperArmR': return [{ kind: 'cone', y0: 0.15, r0: 0.088, y1: -0.1, r1: 0.07 }];
    case 'forearmL': case 'forearmR': return [
      { kind: 'cone', y0: 0.1, r0: 0.07, y1: -0.1, r1: 0.062 },
      { kind: 'ellipsoid', c: v3(0, -0.155, 0.005), r: v3(0.088, 0.098, 0.083) },
    ];
    case 'thighL': case 'thighR': return [{ kind: 'cone', y0: 0.18, r0: 0.115, y1: -0.13, r1: 0.088 }];
    case 'shinL': case 'shinR': return [
      { kind: 'cone', y0: 0.19, r0: 0.087, y1: -0.19, r1: 0.076 },
      { kind: 'ellipsoid', c: v3(0, -0.215, 0.05), r: v3(0.092, 0.068, 0.132) },
    ];
  }
}

/** How softly each part melts into what it attaches to (smooth-union size, metres). */
function blendFor(name: PartName): number {
  if (name === 'chest') return 0.16;
  if (name === 'head') return 0.13;
  if (name.startsWith('thigh') || name.startsWith('upperArm')) return 0.09;
  return 0.06; // shins and forearms join at the knee / elbow
}

/** Mesh rest pose: physics rest pose with arms lifted out and legs slightly apart, so limbs don't fuse. */
function restShapes(): PartShape[] {
  return PARTS.map((def) => {
    const pos = v3(def.offset[0], def.offset[1], def.offset[2]);
    const rot = new THREE.Quaternion();
    const n = def.name;
    const side = n.endsWith('L') ? 1 : -1;
    let pivot: THREE.Vector3 | null = null;
    let angle = 0;
    if (n.startsWith('upperArm') || n.startsWith('forearm')) { pivot = v3(ARM_X * side, SHOULDER_Y, 0); angle = ARM_SPREAD * side; }
    if (n.startsWith('thigh') || n.startsWith('shin')) { pivot = v3(HIP_X * side, HIP_Y, 0); angle = LEG_SPREAD * side; }
    if (pivot) {
      rot.setFromAxisAngle(v3(0, 0, 1), angle);
      pos.sub(pivot).applyQuaternion(rot).add(pivot);
    }
    const inv = new THREE.Matrix4().compose(pos, rot, v3(1, 1, 1)).invert();
    return { name: n, pos, rot, inv, prims: primsFor(n) };
  });
}

function primSdf(p: Prim, q: THREE.Vector3): number {
  if (p.kind === 'cone') {
    // Distance to the axis segment, with the radius interpolated along it (good enough for gentle tapers).
    const t = Math.max(0, Math.min(1, (q.y - p.y0) / (p.y1 - p.y0)));
    const y = p.y0 + (p.y1 - p.y0) * t;
    return Math.hypot(q.x, q.y - y, q.z) - (p.r0 + (p.r1 - p.r0) * t);
  }
  // Ellipsoid (good-enough approximation).
  const x = (q.x - p.c.x) / p.r.x, y = (q.y - p.c.y) / p.r.y, z = (q.z - p.c.z) / p.r.z;
  const k = Math.sqrt(x * x + y * y + z * z);
  return (k - 1) * Math.min(p.r.x, p.r.y, p.r.z);
}

const _q = new THREE.Vector3();
function partSdf(s: PartShape, p: THREE.Vector3): number {
  _q.copy(p).applyMatrix4(s.inv);
  let d = Infinity;
  for (const prim of s.prims) d = Math.min(d, primSdf(prim, _q));
  return d;
}

/** Polynomial smooth minimum: blends shapes together with a soft fillet of size k. */
function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

let cached: { geometry: THREE.BufferGeometry; shapes: PartShape[] } | null = null;

/** Build (once) the seamless body geometry with skin indices/weights for the 11 part bones. */
export function bodyGeometry() {
  if (cached) return cached;
  const t0 = performance.now();
  const shapes = restShapes();

  // Marching cubes over a cube that contains the A-posed character.
  const RES = 112;
  const SIDE = 2.1;
  const CENTER = v3(0, -0.15, 0.02);
  const mc = new MarchingCubes(RES, new THREE.MeshBasicMaterial(), false, false, 120000);
  mc.isolation = 0;
  const half = mc.halfsize;
  const p = new THREE.Vector3();
  for (let z = 0; z < RES; z++) {
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        p.set((x - half) / half, (y - half) / half, (z - half) / half).multiplyScalar(SIDE / 2).add(CENTER);
        // Most of the cube is empty air beside a thin character; skip it.
        if (Math.abs(p.x) > 0.85 || p.z < -0.32 || p.z > 0.4) { mc.field[x + y * RES + z * RES * RES] = -1; continue; }
        let d = Infinity;
        for (const s of shapes) {
          const ds = partSdf(s, p);
          // Torso, hips, and head melt together more than limbs do.
          d = d === Infinity ? ds : smin(d, ds, blendFor(s.name));
        }
        mc.field[x + y * RES + z * RES * RES] = -d; // inside is positive
      }
    }
  }
  mc.update();
  console.info(`body mesh: ${mc.count} verts in ${(performance.now() - t0).toFixed(0)} ms`);

  const count = mc.count;
  const srcPos = mc.geometry.getAttribute('position').array as Float32Array;
  const srcNor = mc.geometry.getAttribute('normal').array as Float32Array;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const ds = new Float32Array(shapes.length);
  const order = shapes.map((_, i) => i);
  const n = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    p.set(srcPos[i * 3], srcPos[i * 3 + 1], srcPos[i * 3 + 2]).multiplyScalar(SIDE / 2).add(CENTER);
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    n.set(srcNor[i * 3], srcNor[i * 3 + 1], srcNor[i * 3 + 2]).normalize();
    nor[i * 3] = n.x; nor[i * 3 + 1] = n.y; nor[i * 3 + 2] = n.z;

    // Skin weights: each part's influence fades with distance from its own surface.
    // A wide falloff spreads each joint's bend over more of the surface, so bends stay smooth.
    for (let s = 0; s < shapes.length; s++) ds[s] = Math.exp(-Math.max(0, partSdf(shapes[s], p)) / 0.045);
    order.sort((a, b) => ds[b] - ds[a]);
    let sum = 0;
    for (let j = 0; j < 4; j++) sum += ds[order[j]];
    for (let j = 0; j < 4; j++) {
      skinIndex[i * 4 + j] = order[j];
      skinWeight[i * 4 + j] = sum > 0 ? ds[order[j]] / sum : j === 0 ? 1 : 0;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  mc.geometry.dispose();
  cached = { geometry, shapes };
  return cached;
}

/**
 * Make one character: a skinned mesh driven by the given bones (one per physics part, in PARTS order).
 * The bones are the objects the renderer moves to the physics transforms each frame.
 */
export function buildBody(bones: THREE.Bone[], material: THREE.Material): THREE.SkinnedMesh {
  const { geometry, shapes } = bodyGeometry();
  const inverses = shapes.map((s) => s.inv.clone());
  const skeleton = new THREE.Skeleton(bones, inverses);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
