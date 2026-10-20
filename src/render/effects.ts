// Short-lived visual effects driven by SimEvents: tracers, muzzle flashes, impact puffs, explosions,
// plus a camera-shake value the camera reads.
import * as THREE from 'three';
import type { SimEvent, V3 } from '../sim/sim';

interface Fx {
  obj: THREE.Object3D;
  age: number;
  life: number;
  update: (t: number) => void; // t = 0..1
}

export class Effects {
  shake = 0;
  private live: Fx[] = [];
  private tracerMat = new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true });
  private puffGeo = new THREE.SphereGeometry(1, 12, 8);

  // Fixed pool of lights: adding/removing lights at runtime forces shader recompiles (hitches).
  private lights: { light: THREE.PointLight; until: number; peak: number; start: number }[] = [];
  private lightIdx = 0;
  private time = 0;

  constructor(private readonly scene: THREE.Scene, private readonly localPlayer: number) {
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffa040, 0, 8, 2);
      scene.add(light);
      this.lights.push({ light, until: 0, peak: 0, start: 0 });
    }
  }

  private pulseLight(p: V3, color: number, peak: number, distance: number, life: number) {
    const l = this.lights[this.lightIdx++ % this.lights.length];
    l.light.position.set(p.x, p.y, p.z);
    l.light.color.setHex(color);
    l.light.distance = distance;
    l.peak = peak;
    l.start = this.time;
    l.until = this.time + life;
  }

  handle(e: SimEvent) {
    switch (e.type) {
      case 'shot':
        this.tracer(e.from, e.to, e.weapon === 'shotgun' ? 0.09 : 0.07);
        if (e.hit) this.puff(e.to, 0.12, 0xfff2c0, 0.15);
        this.flash(e.from, e.weapon === 'shotgun' ? 1.6 : 1);
        if (e.player === this.localPlayer) this.shake = Math.max(this.shake, e.weapon === 'shotgun' ? 0.35 : 0.1);
        break;
      case 'punch':
        if (e.hit) this.puff(e.to, 0.15, 0xffffff, 0.12);
        break;
      case 'hit':
        if (e.player === this.localPlayer) this.shake = Math.max(this.shake, Math.min(0.6, e.strength / 30));
        break;
      case 'explosion':
        this.explosion(e.pos, e.radius);
        this.shake = Math.max(this.shake, 0.7);
        break;
      case 'burn':
        this.fireBall(e.pos, 0.6);
        break;
      case 'eliminated':
        if (e.cause === 'fire') { this.fireBall(e.pos, 1.4); this.shake = Math.max(this.shake, 0.5); }
        break;
      case 'drop':
        // Spent guns lie there smoking until they vanish, so it's obvious they're empty.
        if (e.empty && e.entity >= 0) this.smokers.push({ entity: e.entity, t: 0, acc: 0 });
        break;
      case 'stamp':
        // Dust and a thump when a press hits the belt.
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2;
          this.smokePuff({ x: e.pos.x + Math.cos(ang) * 0.9, y: e.pos.y, z: e.pos.z + Math.sin(ang) * 1.1 }, 0.18, 0.9);
        }
        this.shake = Math.max(this.shake, 0.3);
        break;
      case 'railBreak':
        this.puff(e.pos, 0.35, 0xffe08a, 0.18);
        this.shake = Math.max(this.shake, 0.2);
        break;
      case 'gunSpawn':
        this.puff(e.pos, 0.3, 0xdddddd, 0.3);
        break;
      case 'pickup':
        this.puff({ x: e.pos.x, y: e.pos.y + 1.0, z: e.pos.z }, 0.5, 0xfff7a8, 0.25);
        break;
    }
  }

  private smokers: { entity: number; t: number; acc: number }[] = [];
  private emberAcc = 0;
  private wispAcc = 0;
  private emberGeo = new THREE.SphereGeometry(1, 5, 4);

  /** A tiny glowing spark that floats up, wanders and fades. */
  private ember(center: V3, half: number) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, depthWrite: false });
    const m = new THREE.Mesh(this.emberGeo, mat);
    const start = { x: center.x + (Math.random() - 0.5) * half * 2, y: center.y - 0.8, z: center.z + (Math.random() - 0.5) * half * 2 };
    const vy = 1.2 + Math.random() * 1.6, sway = Math.random() * 6, life = 1.8 + Math.random() * 1.6;
    const size = 0.015 + Math.random() * 0.02;
    this.add(m, life, (t) => {
      const s = t * life;
      m.position.set(start.x + Math.sin(s * 2 + sway) * 0.3, start.y + vy * s, start.z + Math.cos(s * 1.7 + sway) * 0.3);
      m.scale.setScalar(size);
      mat.opacity = (1 - t) * (0.6 + 0.4 * Math.sin(s * 20 + sway));
    });
  }
  private smokeMat = new THREE.MeshLambertMaterial({ color: 0x8a8a8a, transparent: true, depthWrite: false });
  private jetAcc = 0;

  /**
   * Per frame. `transforms` lets smoke follow the spent gun it rises from; `furnace` drives the flame jet.
   */
  update(dt: number, transforms?: Float32Array, furnace?: { state: string; center: V3; half: number }) {
    if (transforms) {
      for (let i = this.smokers.length - 1; i >= 0; i--) {
        const s = this.smokers[i];
        s.t += dt;
        const o = s.entity * 7;
        if (s.t > 6 || transforms[o + 1] < -500) { this.smokers.splice(i, 1); continue; }
        s.acc += dt * 9;
        while (s.acc >= 1) {
          s.acc -= 1;
          this.smokePuff({ x: transforms[o] + (Math.random() - 0.5) * 0.08, y: transforms[o + 1] + 0.05, z: transforms[o + 2] + (Math.random() - 0.5) * 0.08 }, 0.07, 1.4);
        }
      }
    }
    if (furnace) {
      // Ambience: embers drifting up out of the pit, and the odd wisp of smoke rising into the hood.
      this.emberAcc += dt * 16;
      while (this.emberAcc >= 1) { this.emberAcc -= 1; this.ember(furnace.center, furnace.half); }
      this.wispAcc += dt * 1.6;
      while (this.wispAcc >= 1) {
        this.wispAcc -= 1;
        const c = furnace.center;
        this.smokePuff({ x: c.x + (Math.random() - 0.5) * furnace.half, y: c.y + 0.4, z: c.z + (Math.random() - 0.5) * furnace.half }, 0.35, 3.2);
      }
      // Idle: flames licking up out of the pit. Warning: more of them. Burst: a column erupting.
      const burst = furnace.state === 'burst';
      this.jetAcc += dt * (burst ? 90 : furnace.state === 'warn' ? 30 : 12);
      while (this.jetAcc >= 1) {
        this.jetAcc -= 1;
        this.flameBlob(furnace.center, furnace.half, burst);
      }
    }
    this.time += dt;
    for (const l of this.lights) {
      const t = l.until > l.start ? (this.time - l.start) / (l.until - l.start) : 1;
      l.light.intensity = t < 1 ? l.peak * (1 - t) : 0;
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const f = this.live[i];
      f.age += dt;
      const t = Math.min(1, f.age / f.life);
      f.update(t);
      if (t >= 1) {
        this.scene.remove(f.obj);
        this.live.splice(i, 1);
      }
    }
  }

  private add(obj: THREE.Object3D, life: number, update: (t: number) => void) {
    this.scene.add(obj);
    this.live.push({ obj, age: 0, life, update });
    update(0);
  }

  private tracer(from: V3, to: V3, life: number) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z)]);
    const mat = this.tracerMat.clone();
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    this.add(line, life, (t) => { mat.opacity = 1 - t; });
  }

  private puff(p: V3, size: number, color: number, life: number) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false });
    const m = new THREE.Mesh(this.puffGeo, mat);
    m.position.set(p.x, p.y, p.z);
    this.add(m, life, (t) => {
      m.scale.setScalar(size * (0.5 + t));
      mat.opacity = 1 - t;
    });
  }

  private flash(p: V3, intensity: number) {
    this.pulseLight(p, 0xffd27a, 8 * intensity, 4, 0.06);
    this.puff(p, 0.09 * intensity, 0xffe08a, 0.05);
  }

  /** A grey puff that rises, grows and fades. */
  private smokePuff(p: V3, size: number, life: number) {
    const mat = this.smokeMat.clone();
    const m = new THREE.Mesh(this.puffGeo, mat);
    const drift = { x: (Math.random() - 0.5) * 0.15, z: (Math.random() - 0.5) * 0.15 };
    this.add(m, life, (t) => {
      m.position.set(p.x + drift.x * t, p.y + t * 0.8, p.z + drift.z * t);
      m.scale.setScalar(size * (0.6 + t * 2.2));
      mat.opacity = 0.55 * (1 - t) * Math.min(1, t * 8);
    });
  }

  /** One blob of flame rising out of the pit (a big fast column during a burst, embers while it warns). */
  private flameBlob(center: V3, half: number, burst: boolean) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, depthWrite: false });
    const m = new THREE.Mesh(this.puffGeo, mat);
    const start = { x: center.x + (Math.random() - 0.5) * half * 1.8, y: center.y - 1.3, z: center.z + (Math.random() - 0.5) * half * 1.8 };
    const out = burst ? 1.5 : 0.3;
    const vx = (start.x - center.x) * out + (Math.random() - 0.5), vz = (start.z - center.z) * out + (Math.random() - 0.5);
    const vy = burst ? 7 + Math.random() * 4 : 1.4 + Math.random() * 1.2;
    const life = burst ? 0.55 + Math.random() * 0.25 : 0.9;
    this.add(m, life, (t) => {
      const s = t * life;
      m.position.set(start.x + vx * s, start.y + vy * s, start.z + vz * s);
      m.scale.setScalar(0.2 + t * 0.6);
      mat.color.setHSL(0.1 - 0.08 * t, 1, 0.6 - 0.25 * t);
      mat.opacity = 0.9 * (1 - t);
    });
  }

  /** Something hit the fire: a bloom of flame and a smoke plume. */
  private fireBall(p: V3, size: number) {
    this.pulseLight(p, 0xff8030, 30 * size, 6, 0.4);
    for (let i = 0; i < 10 * size; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthWrite: false });
      const m = new THREE.Mesh(this.puffGeo, mat);
      const v = { x: (Math.random() - 0.5) * 2, y: 1.5 + Math.random() * 2.5, z: (Math.random() - 0.5) * 2 + 1 };
      const life = 0.5 + Math.random() * 0.4;
      this.add(m, life, (t) => {
        const s = t * life;
        m.position.set(p.x + v.x * s, p.y + v.y * s, p.z + v.z * s);
        m.scale.setScalar(size * (0.15 + t * 0.35));
        mat.color.setHSL(0.09 - 0.07 * t, 1, 0.6 - 0.3 * t);
        mat.opacity = 0.95 * (1 - t);
      });
    }
    for (let i = 0; i < 4 * size; i++) this.smokePuff({ x: p.x, y: p.y + 0.5, z: p.z + 0.4 }, 0.25 * size, 1.6);
  }

  private explosion(p: V3, radius: number) {
    const fire = new THREE.MeshBasicMaterial({ color: 0xffa640, transparent: true, depthWrite: false });
    const core = new THREE.Mesh(this.puffGeo, fire);
    core.position.set(p.x, p.y, p.z);
    this.add(core, 0.35, (t) => {
      core.scale.setScalar(radius * (0.25 + 0.75 * Math.sqrt(t)));
      fire.opacity = 0.9 * (1 - t);
      fire.color.setHSL(0.09 - 0.07 * t, 1, 0.6 - 0.3 * t);
    });
    const smokeMat = new THREE.MeshLambertMaterial({ color: 0x555555, transparent: true, depthWrite: false });
    const smoke = new THREE.Mesh(this.puffGeo, smokeMat);
    smoke.position.set(p.x, p.y, p.z);
    this.add(smoke, 1.1, (t) => {
      smoke.scale.setScalar(radius * (0.3 + 0.5 * t));
      smoke.position.y = p.y + t * 1.5;
      smokeMat.opacity = 0.6 * (1 - t);
    });
    this.pulseLight({ x: p.x, y: p.y + 0.5, z: p.z }, 0xffa040, 40, radius * 4, 0.3);
  }
}
