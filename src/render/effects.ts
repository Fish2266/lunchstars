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
      case 'pickup':
        this.puff({ x: e.pos.x, y: e.pos.y + 0.55, z: e.pos.z }, 0.5, 0xfff7a8, 0.25);
        break;
    }
  }

  update(dt: number) {
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
