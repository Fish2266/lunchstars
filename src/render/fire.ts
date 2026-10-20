// The fire in the pit: a bed of churning coals/lava plus a cluster of animated flame sheets.
// Flames are camera-facing (around the vertical axis) quads with a noise-driven flame shader, drawn additively,
// so they look soft and alive for a handful of draw calls. They swell during the flare's warning and
// shoot up during the burst.
import * as THREE from 'three';
import type { V3 } from '../sim/sim';

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}`;

const flameMaterial = () => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uSeed: { value: Math.random() * 10 }, uPower: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime, uSeed, uPower;
    varying vec2 vUv;
    ${NOISE}
    void main() {
      vec2 uv = vUv;                        // x across, y from base (0) to tip (1)
      float t = uTime * 1.5 + uSeed * 7.0;
      float n = fbm(vec2(uv.x * 3.0 + uSeed, uv.y * 2.2 - t * 1.4));
      float n2 = fbm(vec2(uv.x * 7.0 - uSeed, uv.y * 5.0 - t * 2.4));
      // Teardrop that narrows and wobbles toward the tip.
      float x = (uv.x - 0.5) * 2.0 + (n - 0.5) * 0.9 * uv.y;
      float width = mix(0.95, 0.04, pow(uv.y, 0.85));
      float shape = 1.0 - smoothstep(width * 0.35, width, abs(x));
      float heat = shape * ((1.0 - uv.y) * 1.5 + (n2 - 0.45) * 0.9) * uPower;
      heat *= smoothstep(0.0, 0.12, uv.y) * (1.0 - smoothstep(0.85, 1.0, uv.y));
      heat = clamp(heat, 0.0, 1.4);
      vec3 col = mix(vec3(0.55, 0.04, 0.0), vec3(1.0, 0.42, 0.04), smoothstep(0.12, 0.55, heat));
      col = mix(col, vec3(1.0, 0.88, 0.55), smoothstep(0.75, 1.15, heat));
      float a = smoothstep(0.06, 0.4, heat);
      gl_FragColor = vec4(col * a * 1.1, a);
    }`,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
});

const lavaMaterial = () => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uPower: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform float uTime, uPower;
    varying vec2 vUv;
    ${NOISE}
    void main() {
      vec2 p = vUv * 5.0;
      // Domain-warped noise: slowly churning hot cracks between darker crusted coals.
      vec2 w = vec2(fbm(p + uTime * 0.15), fbm(p + 4.3 - uTime * 0.12));
      float h = fbm(p * 1.3 + w * 2.2 + uTime * 0.05);
      float cracks = smoothstep(0.45, 0.75, h);
      vec3 crust = vec3(0.18, 0.03, 0.01);
      vec3 hot = mix(vec3(0.95, 0.25, 0.02), vec3(1.0, 0.75, 0.3), smoothstep(0.7, 0.95, h));
      vec3 col = mix(crust, hot, cracks) * (0.8 + 0.4 * uPower);
      gl_FragColor = vec4(col, 1.0);
    }`,
});

interface Flame { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; base: number; phase: number }

export class PitFire {
  private flames: Flame[] = [];
  private lava: THREE.ShaderMaterial;
  private grow = 1;

  constructor(scene: THREE.Scene, center: V3, half: number, floorY: number) {
    // Coal/lava bed just above the pit's floor.
    this.lava = lavaMaterial();
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2).rotateX(-Math.PI / 2), this.lava);
    bed.position.set(center.x, floorY + 0.03, center.z);
    scene.add(bed);

    // Flames scattered over the bed, tallest in the middle.
    const rand = mulberry(42);
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * half * 0.85;
      const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
      const h = 1.5 + rand() * 1.1 + (1 - r / half) * 0.6;
      const w = 0.8 + rand() * 0.7;
      const geo = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0);
      const mat = flameMaterial();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, floorY, z);
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.flames.push({ mesh, mat, base: 1, phase: rand() * 10 });
    }
  }

  /** `state` is the pit flare's state: flames swell while it warns and shoot up while it bursts. */
  update(time: number, dt: number, camera: THREE.Camera, state: string) {
    const target = state === 'burst' ? 2.6 : state === 'warn' ? 1.3 : 1;
    this.grow += (target - this.grow) * Math.min(1, dt * (state === 'burst' ? 12 : 3));
    const power = state === 'burst' ? 1.5 : state === 'warn' ? 1.25 + 0.15 * Math.sin(time * 25) : 1;
    this.lava.uniforms.uTime.value = time;
    this.lava.uniforms.uPower.value = power;
    for (const f of this.flames) {
      f.mat.uniforms.uTime.value = time;
      f.mat.uniforms.uPower.value = power;
      // Each flame breathes a little on its own.
      const breathe = 1 + 0.12 * Math.sin(time * 3 + f.phase) + 0.06 * Math.sin(time * 7.3 + f.phase * 2);
      f.mesh.scale.set(1, this.grow * breathe, 1);
      // Face the camera around the vertical axis.
      f.mesh.rotation.y = Math.atan2(camera.position.x - f.mesh.position.x, camera.position.z - f.mesh.position.z);
    }
  }
}

function mulberry(seed: number) {
  return () => {
    let t = (seed = (seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
