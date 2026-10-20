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
  | { kind: 'capsule'; hh: number; r: number };

interface PartShape {
  name: PartName;
  /** Rest transform of this part in mesh space (pelvis at the origin). */
  pos: THREE.Vector3;
  rot: THREE.Quaternion;
  inv: THREE.Matrix4;
  prims: Prim[];
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Soft shapes for each part, in the part's local frame. Sized a bit chunkier than the physics shapes. */
function primsFor(name: PartName): Prim[] {
  switch (name) {
    case 'pelvis': return [{ kind: 'ellipsoid', c: v3(0, 0, 0), r: v3(0.2, 0.18, 0.17) }];
    case 'chest': return [{ kind: 'ellipsoid', c: v3(0, -0.02, 0), r: v3(0.235, 0.26, 0.19) }];
    case 'head': return [{ kind: 'ellipsoid', c: v3(0, 0.01, 0), r: v3(0.16, 0.165, 0.16) }];
    case 'upperArmL': case 'upperArmR': return [{ kind: 'capsule', hh: 0.1, r: 0.075 }];
    case 'forearmL': case 'forearmR': return [
      { kind: 'capsule', hh: 0.1, r: 0.068 },
      { kind: 'ellipsoid', c: v3(0, -0.15, 0.005), r: v3(0.09, 0.1, 0.085) },
    ];
    case 'thighL': case 'thighR': return [{ kind: 'capsule', hh: 0.13, r: 0.095 }];
    case 'shinL': case 'shinR': return [
      { kind: 'capsule', hh: 0.19, r: 0.088 },
      { kind: 'ellipsoid', c: v3(0, -0.215, 0.05), r: v3(0.095, 0.07, 0.135) },
    ];
  }
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
  if (p.kind === 'capsule') {
    const y = Math.max(-p.hh, Math.min(p.hh, q.y));
    return Math.hypot(q.x, q.y - y, q.z) - p.r;
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
  const RES = 96;
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
          const k = s.name === 'chest' || s.name === 'pelvis' || s.name === 'head' ? 0.07 : 0.04;
          d = d === Infinity ? ds : smin(d, ds, k);
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
    for (let s = 0; s < shapes.length; s++) ds[s] = Math.exp(-Math.max(0, partSdf(shapes[s], p)) / 0.025);
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
