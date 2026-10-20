// Over-the-shoulder third-person camera: smoothed follow, shake, and no clipping through the level.
import * as THREE from 'three';
import type { V3 } from '../sim/sim';

const DIST = 3.6;
const SHOULDER = 0.55;
const RISE = 0.25;

export class CameraRig {
  /** Smoothed point the camera orbits (just above the followed character's chest). */
  readonly pivot = new THREE.Vector3(0, 1.6, 3);
  /** Level geometry the camera won't pass through. */
  blockers: THREE.Object3D[] = [];
  private dist = DIST;
  private offset = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private ray = new THREE.Raycaster();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** How far the camera currently sits from the pivot (small = squeezed against a wall). */
  get distance() { return this.dist; }

  /**
   * @param follow  point to orbit (aim origin of the followed character)
   * @param yaw/pitch  look direction from the controls
   * @param shake  0..1ish, from effects
   */
  update(follow: V3, yaw: number, pitch: number, shake: number, dt: number, realDt: number) {
    this.pivot.lerp(this.goal.set(follow.x, follow.y, follow.z), 1 - Math.exp(-dt * 12));
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fx = Math.sin(yaw) * cp, fy = sp, fz = Math.cos(yaw) * cp;
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    // Where the camera wants to be, relative to the pivot.
    this.offset.set(-fx * DIST + rx * SHOULDER, -fy * DIST + RISE, -fz * DIST + rz * SHOULDER);
    const want = this.offset.length();
    this.offset.multiplyScalar(1 / want);
    // Don't clip through the level: pull in front of anything between the pivot and the camera.
    this.ray.set(this.pivot, this.offset);
    this.ray.far = want + 0.3;
    const block = this.ray.intersectObjects(this.blockers, true)[0];
    const allowed = block ? Math.max(0.35, block.distance - 0.3) : want;
    // Snap in fast when something gets in the way; ease back out when it clears.
    this.dist += (allowed - this.dist) * (1 - Math.exp(-realDt * (allowed < this.dist ? 30 : 4)));
    this.dist = Math.min(this.dist, allowed);
    const sh = shake * shake * 0.25;
    const cx = this.pivot.x + this.offset.x * this.dist;
    const cy = this.pivot.y + this.offset.y * this.dist;
    const cz = this.pivot.z + this.offset.z * this.dist;
    this.camera.position.set(cx + (Math.random() - 0.5) * sh, cy + (Math.random() - 0.5) * sh, cz + (Math.random() - 0.5) * sh);
    this.camera.lookAt(cx + fx * 10, cy + fy * 10, cz + fz * 10);
  }
}
