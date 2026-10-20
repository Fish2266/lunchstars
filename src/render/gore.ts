// Over-the-top cartoon blood, and shell casings. Purely visual and client-side.
//
// Why it's cheap:
// - Every droplet is one instance of a single InstancedMesh (one draw call for thousands of drops).
// - Droplets are simple ballistic points (no physics engine), stretched along their velocity so they read as streaks.
// - Wounds are "emitters" pinned to a body part's local frame, so fountains move with the ragdoll.
//   They pulse like a heartbeat and die out after a couple of seconds.
// - When a droplet reaches the ground height (one raycast per wound every 0.25 s, not per droplet)
//   it becomes a flat splat decal from a second pooled InstancedMesh. Oldest splats are recycled.
import * as THREE from 'three';
import type { SimEvent, V3 } from '../sim/sim';

export type GoreMode = 'blood' | 'ketchup & mustard' | 'off';
export const goreSettings = { mode: 'blood' as GoreMode, amount: 1 };

const MAX_DROPS = 2500;
const MAX_SPLATS = 700;
const MAX_WOUNDS = 24;
const MAX_CASINGS = 120;
const GRAVITY = -18;
const SPLAT_LIFE = 30;
/** Puddles fade out over this many seconds at the end of their life. */
const SPLAT_FADE = 4;

interface Wound {
  entity: number;
  local: THREE.Vector3;
  localDir: THREE.Vector3;
  age: number;
  life: number;
  power: number;
  carry: number;
  groundY: number;
  groundCheck: number;
}

interface Casing {
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  spin: THREE.Vector3;
  groundY: number;
  age: number;
  bounces: number;
  shell: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class Gore {
  // Droplet state, struct-of-arrays. Live drops are packed at [0, count).
  private count = 0;
  private pos = new Float32Array(MAX_DROPS * 3);
  private vel = new Float32Array(MAX_DROPS * 3);
  private size = new Float32Array(MAX_DROPS);
  private ground = new Float32Array(MAX_DROPS);
  private color = new Float32Array(MAX_DROPS * 3);
  private drops: THREE.InstancedMesh;

  private splats: THREE.InstancedMesh;
  private splatBorn = new Float32Array(MAX_SPLATS);
  /** When each puddle is fully gone (it fades over the SPLAT_FADE seconds before). */
  private splatEnd = new Float32Array(MAX_SPLATS);
  private splatAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS), 1);
  private splatSize = new Float32Array(MAX_SPLATS);
  private splatPos = new Float32Array(MAX_SPLATS * 3);
  private splatRot = new Float32Array(MAX_SPLATS);
  private splatNext = 0;
  private splatUsed = 0;

  private wounds: Wound[] = [];
  private casings: Casing[] = [];
  private casingMesh: THREE.InstancedMesh;
  private time = 0;

  constructor(
    scene: THREE.Scene,
    /** Height of the ground below a point (or -Infinity over the pit). */
    private readonly groundAt: (p: V3) => number,
  ) {
    const dropMat = new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0 });
    this.drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), dropMat, MAX_DROPS);
    this.drops.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 3), 3);
    this.drops.count = 0;
    this.drops.frustumCulled = false;
    scene.add(this.drops);

    const splatGeo = new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2);
    // Per-puddle opacity (an instanced attribute patched into the standard material) so puddles fade out.
    splatGeo.setAttribute('instanceAlpha', this.splatAlpha);
    const splatMat = new THREE.MeshStandardMaterial({
      roughness: 0.15, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      transparent: true, depthWrite: false,
    });
    splatMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vInstanceAlpha;')
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity * vInstanceAlpha );');
    };
    this.splats = new THREE.InstancedMesh(splatGeo, splatMat, MAX_SPLATS);
    this.splats.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 3), 3);
    this.splats.count = 0;
    this.splats.frustumCulled = false;
    this.splats.receiveShadow = true;
    scene.add(this.splats);

    const casingGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
    this.casingMesh = new THREE.InstancedMesh(casingGeo, new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.7 }), MAX_CASINGS);
    this.casingMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CASINGS * 3), 3);
    this.casingMesh.count = 0;
    this.casingMesh.frustumCulled = false;
    this.casingMesh.castShadow = true;
    scene.add(this.casingMesh);
  }

  /** A hit on a player: an immediate spray plus a pulsing fountain pinned to the wound. */
  wound(e: Extract<SimEvent, { type: 'hit' }>, transforms: Float32Array) {
    // Only guns and explosions bleed; punches and bonks don't.
    if (goreSettings.mode === 'off' || e.entity < 0) return;
    if (e.cause !== 'shot' && e.cause !== 'pellet' && e.cause !== 'blast') return;
    const o = e.entity * 7;
    _q.set(transforms[o + 3], transforms[o + 4], transforms[o + 5], transforms[o + 6]);
    const power = THREE.MathUtils.clamp(e.strength / 14, 0.5, 3) * goreSettings.amount;

    // Fountain points out of the wound: away from the body part's center, biased along the shot.
    const local = new THREE.Vector3(e.local.x, e.local.y, e.local.z);
    const outward = local.lengthSq() > 1e-6 ? local.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const shotLocal = new THREE.Vector3(e.dir.x, e.dir.y, e.dir.z).applyQuaternion(_q2.copy(_q).invert());
    const localDir = outward.multiplyScalar(0.6).addScaledVector(shotLocal, -0.4).normalize();

    if (this.wounds.length >= MAX_WOUNDS) this.wounds.shift();
    this.wounds.push({
      entity: e.entity, local, localDir, age: 0, life: 1.2 + power * 0.8, power, carry: 0,
      groundY: this.groundAt(e.pos), groundCheck: 0.25,
    });

    // Impact burst: back toward the shooter and out the far side.
    const g = this.groundAt(e.pos);
    const n = Math.round(14 * power);
    for (let i = 0; i < n; i++) {
      const back = i % 3 === 0;
      const sgn = back ? -1 : 1;
      const sp = (back ? 1.2 : 3.5) * (0.6 + Math.random() * 0.8) * Math.sqrt(power);
      this.spawn(e.pos,
        e.dir.x * sgn * sp + rnd(1.2), e.dir.y * sgn * sp + 1 + rnd(1.2), e.dir.z * sgn * sp + rnd(1.2),
        0.035 + Math.random() * 0.045, g);
    }
  }

  /** Eject a shell casing from the gun, off to the shooter's right. */
  casing(from: V3, dir: V3, shell: boolean) {
    if (this.casings.length >= MAX_CASINGS) this.casings.shift();
    const right = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    // Our characters' right is -X local; pick the side away from the body.
    right.negate();
    this.casings.push({
      p: new THREE.Vector3(from.x - dir.x * 0.15, from.y + 0.04, from.z - dir.z * 0.15),
      v: right.multiplyScalar(1.6 + Math.random()).add(new THREE.Vector3(rnd(0.4), 2.4 + Math.random(), rnd(0.4))),
      q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
      spin: new THREE.Vector3(rnd(25), rnd(25), rnd(25)),
      groundY: this.groundAt(from),
      age: 0, bounces: 0, shell,
    });
  }

  update(dt: number, transforms: Float32Array) {
    this.time += dt;
    this.updateWounds(dt, transforms);
    this.updateDrops(dt);
    this.updateSplats();
    this.updateCasings(dt);
  }

  /** Wipe everything at once (debug). */
  clear() {
    this.count = 0;
    this.wounds.length = 0;
    this.casings.length = 0;
    this.splatUsed = 0;
    this.splats.count = 0;
  }

  /** Fade every puddle away over `seconds` (between rounds) instead of popping it. */
  fadeAll(seconds = 1.2) {
    this.wounds.length = 0;
    for (let i = 0; i < this.splatUsed; i++) {
      // End so that the fade (which spans SPLAT_FADE) is already most of the way through.
      this.splatEnd[i] = Math.min(this.splatEnd[i], this.time + seconds);
    }
    this.fastFade = seconds;
  }
  private fastFade = 0;

  // ------------------------------------------------------------------ internals

  private updateWounds(dt: number, transforms: Float32Array) {
    for (let i = this.wounds.length - 1; i >= 0; i--) {
      const w = this.wounds[i];
      w.age += dt;
      if (w.age >= w.life || goreSettings.mode === 'off') { this.wounds.splice(i, 1); continue; }
      const o = w.entity * 7;
      if (transforms[o + 1] < -500) { this.wounds.splice(i, 1); continue; }
      _q.set(transforms[o + 3], transforms[o + 4], transforms[o + 5], transforms[o + 6]);
      const px = transforms[o], py = transforms[o + 1], pz = transforms[o + 2];
      _v.copy(w.local).applyQuaternion(_q);
      const wx = px + _v.x, wy = py + _v.y, wz = pz + _v.z;
      _s.copy(w.localDir).applyQuaternion(_q).addScaledVector(UP, 0.7).normalize();

      w.groundCheck -= dt;
      if (w.groundCheck <= 0) { w.groundY = this.groundAt({ x: wx, y: wy, z: wz }); w.groundCheck = 0.25; }

      // Heartbeat pulses that fade out over the wound's life.
      const fade = 1 - w.age / w.life;
      const beat = Math.pow(Math.max(0, Math.sin(w.age * 11)), 2);
      const pulse = 0.25 + 0.75 * beat;
      w.carry += 110 * w.power * pulse * fade * dt;
      const speed = (2.5 + 3.5 * pulse) * Math.sqrt(w.power) * (0.4 + 0.6 * fade);
      while (w.carry >= 1) {
        w.carry -= 1;
        this.spawn({ x: wx, y: wy, z: wz },
          _s.x * speed + rnd(0.5), _s.y * speed + rnd(0.5), _s.z * speed + rnd(0.5),
          0.03 + Math.random() * 0.04 * Math.sqrt(w.power), w.groundY);
      }
    }
  }

  private spawn(p: V3, vx: number, vy: number, vz: number, size: number, groundY: number) {
    if (this.count >= MAX_DROPS) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.size[i] = size;
    this.ground[i] = groundY;
    pickColor(_c);
    this.color[i3] = _c.r; this.color[i3 + 1] = _c.g; this.color[i3 + 2] = _c.b;
  }

  private kill(i: number) {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[i3 + k] = this.pos[l3 + k];
      this.vel[i3 + k] = this.vel[l3 + k];
      this.color[i3 + k] = this.color[l3 + k];
    }
    this.size[i] = this.size[last];
    this.ground[i] = this.ground[last];
  }

  private groundCursor = 0;

  private updateDrops(dt: number) {
    const colors = this.drops.instanceColor!.array as Float32Array;
    // Re-find the ground under a slice of the droplets each frame (round robin, capped), so drops that fly
    // past a ledge fall into the pit and drops over a table land on the table, instead of splatting in mid-air.
    const checks = Math.min(this.count, 120);
    for (let n = 0; n < checks; n++) {
      const i = (this.groundCursor + n) % this.count;
      const i3 = i * 3;
      this.ground[i] = this.groundAt({ x: this.pos[i3], y: this.pos[i3 + 1], z: this.pos[i3 + 2] });
    }
    if (this.count > 0) this.groundCursor = (this.groundCursor + checks) % this.count;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this.vel[i3 + 1] += GRAVITY * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const y = this.pos[i3 + 1];
      if (y <= this.ground[i] || y < -30) {
        if (y > -30 && this.ground[i] > -1e6) {
          // Confirm there really is ground right here before leaving a puddle.
          const g = this.groundAt({ x: this.pos[i3], y: this.ground[i] + 0.25, z: this.pos[i3 + 2] });
          if (Math.abs(g - this.ground[i]) > 0.2) { this.ground[i] = g; continue; }
          this.splat(this.pos[i3], this.ground[i], this.pos[i3 + 2], this.size[i], this.color, i3);
        }
        this.kill(i);
        i--;
        continue;
      }
    }
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      // Stretch along velocity: a cheap motion-blur streak.
      _v.set(this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]);
      const sp = _v.length();
      if (sp > 1e-3) _q.setFromUnitVectors(UP, _v.multiplyScalar(1 / sp)); else _q.identity();
      const r = this.size[i];
      _s.set(r, r * (1 + sp * 0.12), r);
      _m.compose(_v.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]), _q, _s);
      this.drops.setMatrixAt(i, _m);
      colors[i3] = this.color[i3]; colors[i3 + 1] = this.color[i3 + 1]; colors[i3 + 2] = this.color[i3 + 2];
    }
    this.drops.count = this.count;
    this.drops.instanceMatrix.needsUpdate = true;
    this.drops.instanceColor!.needsUpdate = true;
  }

  private splat(x: number, y: number, z: number, size: number, color: Float32Array, c3: number) {
    const i = this.splatNext;
    this.splatNext = (this.splatNext + 1) % MAX_SPLATS;
    this.splatUsed = Math.min(MAX_SPLATS, this.splatUsed + 1);
    this.splatBorn[i] = this.time;
    this.splatEnd[i] = this.time + SPLAT_LIFE;
    // Splats are much wider than the drop: cartoon puddles.
    this.splatSize[i] = size * (1.8 + Math.random() * 1.8);
    this.splatPos[i * 3] = x; this.splatPos[i * 3 + 1] = y + 0.004 + Math.random() * 0.002; this.splatPos[i * 3 + 2] = z;
    this.splatRot[i] = Math.random() * Math.PI;
    const sc = this.splats.instanceColor!.array as Float32Array;
    // Slightly darker than the drop, like it soaked in.
    sc[i * 3] = color[c3] * 0.8; sc[i * 3 + 1] = color[c3 + 1] * 0.8; sc[i * 3 + 2] = color[c3 + 2] * 0.8;
    this.splats.instanceColor!.needsUpdate = true;
  }

  private updateSplats() {
    for (let i = 0; i < this.splatUsed; i++) {
      const age = this.time - this.splatBorn[i];
      // Spread quickly as it lands; fade out (not shrink) at the end of its life.
      const grow = Math.min(1, age * 12);
      const left = this.splatEnd[i] - this.time;
      const fade = this.fastFade > 0 ? this.fastFade : SPLAT_FADE;
      this.splatAlpha.setX(i, Math.max(0, Math.min(1, left / fade)));
      const r = this.splatSize[i] * grow * (left > 0 ? 1 : 0);
      _q.setFromAxisAngle(UP, this.splatRot[i]);
      _s.set(r, 1, r * 0.8);
      _m.compose(_v.set(this.splatPos[i * 3], this.splatPos[i * 3 + 1], this.splatPos[i * 3 + 2]), _q, _s);
      this.splats.setMatrixAt(i, _m);
    }
    this.splats.count = this.splatUsed;
    this.splats.instanceMatrix.needsUpdate = true;
    this.splatAlpha.needsUpdate = true;
    // Once a round-reset fade has finished, go back to the normal slow fade for new puddles.
    if (this.fastFade > 0 && this.splatUsed > 0 && [...this.splatEnd.subarray(0, this.splatUsed)].every((e) => e <= this.time)) {
      this.fastFade = 0;
      this.splatUsed = 0;
      this.splatNext = 0;
    }
  }

  private updateCasings(dt: number) {
    const colors = this.casingMesh.instanceColor!.array as Float32Array;
    for (let i = this.casings.length - 1; i >= 0; i--) {
      const c = this.casings[i];
      c.age += dt;
      if (c.age > 8 || c.p.y < -30) { this.casings.splice(i, 1); continue; }
      if (c.bounces < 3) {
        c.v.y += GRAVITY * dt;
        c.p.addScaledVector(c.v, dt);
        _q2.setFromEuler(new THREE.Euler(c.spin.x * dt, c.spin.y * dt, c.spin.z * dt));
        c.q.multiply(_q2);
        if (c.p.y <= c.groundY + 0.01 && c.v.y < 0) {
          c.p.y = c.groundY + 0.01;
          c.v.y *= -0.35; c.v.x *= 0.5; c.v.z *= 0.5; c.spin.multiplyScalar(0.4);
          c.bounces++;
          // Come to rest lying on its side.
          if (c.bounces === 3) c.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2).premultiply(_q2.setFromAxisAngle(UP, Math.random() * 6));
        }
      }
    }
    for (let i = 0; i < this.casings.length; i++) {
      const c = this.casings[i];
      const fade = c.age > 7 ? Math.max(0, 8 - c.age) : 1;
      if (c.shell) _s.set(0.022, 0.07, 0.022).multiplyScalar(fade); else _s.set(0.012, 0.032, 0.012).multiplyScalar(fade);
      _m.compose(c.p, c.q, _s);
      this.casingMesh.setMatrixAt(i, _m);
      _c.setHex(c.shell ? 0xc8261c : 0xd9a441);
      colors[i * 3] = _c.r; colors[i * 3 + 1] = _c.g; colors[i * 3 + 2] = _c.b;
    }
    this.casingMesh.count = this.casings.length;
    this.casingMesh.instanceMatrix.needsUpdate = true;
    this.casingMesh.instanceColor!.needsUpdate = true;
  }
}

function rnd(a: number) {
  return (Math.random() - 0.5) * 2 * a;
}

function pickColor(out: THREE.Color) {
  if (goreSettings.mode === 'ketchup & mustard') {
    if (Math.random() < 0.3) out.setHSL(0.13, 0.95, 0.5 + Math.random() * 0.08);
    else out.setHSL(0.01, 0.9, 0.42 + Math.random() * 0.08);
  } else {
    // Cartoon blood: saturated, a bit pink-red, with some variation.
    out.setHSL(0.99 + Math.random() * 0.02, 0.95, 0.36 + Math.random() * 0.1);
  }
  return out;
}
