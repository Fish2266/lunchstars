import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import type { PlayerInput } from './input';
import { tuning } from './tuning';
import type { ShapeDesc } from './sim';

type R = typeof RAPIER_NS;
type Body = RAPIER_NS.RigidBody;

export type PartName =
  | 'pelvis' | 'chest' | 'head'
  | 'thighL' | 'shinL' | 'thighR' | 'shinR'
  | 'upperArmL' | 'forearmL' | 'upperArmR' | 'forearmR';

interface PartDef {
  name: PartName;
  shape: ShapeDesc;
  /** Center offset from the pelvis center in the rest pose. */
  offset: [number, number, number];
  density: number;
}

// Rest pose: standing straight, arms hanging, facing +Z. Pelvis center sits at `standHeight`.
const ARM_X = 0.27;
const HIP_X = 0.1;
const PARTS: PartDef[] = [
  { name: 'pelvis', shape: { kind: 'box', hx: 0.17, hy: 0.1, hz: 0.11 }, offset: [0, 0, 0], density: 1000 },
  { name: 'chest', shape: { kind: 'box', hx: 0.2, hy: 0.17, hz: 0.12 }, offset: [0, 0.28, 0], density: 700 },
  { name: 'head', shape: { kind: 'ball', r: 0.14 }, offset: [0, 0.63, 0], density: 600 },
  { name: 'thighL', shape: { kind: 'capsule', hh: 0.13, r: 0.075 }, offset: [HIP_X, -0.28, 0], density: 1000 },
  { name: 'shinL', shape: { kind: 'capsule', hh: 0.19, r: 0.07 }, offset: [HIP_X, -0.74, 0], density: 1000 },
  { name: 'thighR', shape: { kind: 'capsule', hh: 0.13, r: 0.075 }, offset: [-HIP_X, -0.28, 0], density: 1000 },
  { name: 'shinR', shape: { kind: 'capsule', hh: 0.19, r: 0.07 }, offset: [-HIP_X, -0.74, 0], density: 1000 },
  { name: 'upperArmL', shape: { kind: 'capsule', hh: 0.1, r: 0.06 }, offset: [ARM_X, 0.24, 0], density: 800 },
  { name: 'forearmL', shape: { kind: 'capsule', hh: 0.1, r: 0.055 }, offset: [ARM_X, -0.075, 0], density: 800 },
  { name: 'upperArmR', shape: { kind: 'capsule', hh: 0.1, r: 0.06 }, offset: [-ARM_X, 0.24, 0], density: 800 },
  { name: 'forearmR', shape: { kind: 'capsule', hh: 0.1, r: 0.055 }, offset: [-ARM_X, -0.075, 0], density: 800 },
];

// Joints, as [parent, child, world-space pivot offset from pelvis center, type].
type JointKind = 'ball' | 'knee' | 'elbow';
const JOINTS: [PartName, PartName, [number, number, number], JointKind][] = [
  ['pelvis', 'chest', [0, 0.1, 0], 'ball'],
  ['chest', 'head', [0, 0.47, 0], 'ball'],
  ['pelvis', 'thighL', [HIP_X, -0.08, 0], 'ball'],
  ['thighL', 'shinL', [HIP_X, -0.49, 0], 'knee'],
  ['pelvis', 'thighR', [-HIP_X, -0.08, 0], 'ball'],
  ['thighR', 'shinR', [-HIP_X, -0.49, 0], 'knee'],
  ['chest', 'upperArmL', [ARM_X, 0.4, 0], 'ball'],
  ['upperArmL', 'forearmL', [ARM_X, 0.08, 0], 'elbow'],
  ['chest', 'upperArmR', [-ARM_X, 0.4, 0], 'ball'],
  ['upperArmR', 'forearmR', [-ARM_X, 0.08, 0], 'elbow'],
];

/** Hand position in the forearm's local frame (bottom of the capsule). */
const HAND_LOCAL = { x: 0, y: -0.16, z: 0 };

interface Part {
  def: PartDef;
  body: Body;
  /** Scalar inertia used to turn desired angular acceleration into torque. */
  inertia: number;
  /** Per-part gain multiplier (balance parts vs limbs). */
  balance: boolean;
}

interface Hand {
  forearm: Part;
  joint: RAPIER_NS.ImpulseJoint | null;
}

// Scratch objects, reused every step to avoid garbage.
const _qCur = new Quaternion();
const _qErr = new Quaternion();
const _qYaw = new Quaternion();
const _qTmp = new Quaternion();
const _v = new Vector3();
const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

export class Ragdoll {
  readonly parts = new Map<PartName, Part>();
  readonly colliderHandles = new Set<number>();
  readonly bodyHandles = new Set<number>();
  readonly hands: Hand[];
  totalMass = 0;

  grounded = false;
  stunTimer = 0;
  stiffness = 1;
  private walkPhase = 0;
  private walkAmount = 0;
  private jumpCooldown = 0;
  private yaw = 0;
  private dt = 1 / 60;

  constructor(
    private readonly R: R,
    private readonly world: RAPIER_NS.World,
    readonly playerId: number,
    readonly color: number,
    spawn: { x: number; y: number; z: number },
    collisionGroups: number,
  ) {
    for (const def of PARTS) {
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(spawn.x + def.offset[0], spawn.y + def.offset[1], spawn.z + def.offset[2])
          .setLinearDamping(0.05)
          .setAngularDamping(0.6)
          .setCanSleep(false),
      );
      const collider = world.createCollider(
        shapeToCollider(R, def.shape)
          .setDensity(def.density)
          .setFriction(def.name.startsWith('shin') ? 1.2 : 0.6)
          .setCollisionGroups(collisionGroups),
        body,
      );
      const pi = body.principalInertia();
      const part: Part = {
        def,
        body,
        inertia: (pi.x + pi.y + pi.z) / 3,
        balance: def.name === 'pelvis' || def.name === 'chest' || def.name === 'head',
      };
      this.parts.set(def.name, part);
      this.colliderHandles.add(collider.handle);
      this.bodyHandles.add(body.handle);
      this.totalMass += body.mass();
    }

    for (const [a, b, pivot, kind] of JOINTS) {
      const pa = this.parts.get(a)!;
      const pb = this.parts.get(b)!;
      const anchorA = sub(pivot, pa.def.offset);
      const anchorB = sub(pivot, pb.def.offset);
      if (kind === 'ball') {
        world.createImpulseJoint(R.JointData.spherical(anchorA, anchorB), pa.body, pb.body, true);
      } else {
        const j = world.createImpulseJoint(
          R.JointData.revolute(anchorA, anchorB, { x: 1, y: 0, z: 0 }),
          pa.body, pb.body, true,
        ) as RAPIER_NS.RevoluteImpulseJoint;
        // Knees bend backward (+X rotation), elbows bend forward (-X rotation).
        if (kind === 'knee') j.setLimits(0, 2.4);
        else j.setLimits(-2.5, 0);
      }
    }

    this.hands = [
      { forearm: this.parts.get('forearmL')!, joint: null },
      { forearm: this.parts.get('forearmR')!, joint: null },
    ];
  }

  get pelvis(): Body { return this.parts.get('pelvis')!.body; }
  get chest(): Body { return this.parts.get('chest')!.body; }

  ownsCollider = (c: RAPIER_NS.Collider): boolean => this.colliderHandles.has(c.handle);

  /** True if one of our hands is holding this collider's body. Used so we can't stand on what we carry. */
  isHolding(c: RAPIER_NS.Collider): boolean {
    const b = c.parent();
    return !!b && this.hands.some((h) => h.joint !== null && h.joint.body2().handle === b.handle);
  }

  /** Knock the character around. Impulse is world-space; `strength` is the weapon's knockback number, which sets the stun. */
  hit(body: Body, impulse: { x: number; y: number; z: number }, point: { x: number; y: number; z: number }, strength: number) {
    body.applyImpulseAtPoint(impulse, point, true);
    this.stunTimer = Math.min(4, this.stunTimer + strength * tuning.stunPerImpulse);
  }

  teleport(pos: { x: number; y: number; z: number }) {
    this.releaseAll();
    for (const p of this.parts.values()) {
      p.body.setTranslation({ x: pos.x + p.def.offset[0], y: pos.y + p.def.offset[1], z: pos.z + p.def.offset[2] }, true);
      p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.stunTimer = 0;
    this.yaw = 0;
  }

  releaseAll() {
    for (const h of this.hands) {
      if (h.joint) {
        this.world.removeImpulseJoint(h.joint, true);
        h.joint = null;
      }
    }
  }

  /** Drop any grab joints attached to bodies that are about to disappear. */
  releaseIfAttachedTo(bodyHandle: number) {
    for (const h of this.hands) {
      if (h.joint && h.joint.body2().handle === bodyHandle) {
        this.world.removeImpulseJoint(h.joint, true);
        h.joint = null;
      }
    }
  }

  step(input: PlayerInput, dt: number) {
    const t = tuning;
    this.dt = dt;

    // --- Stun / stiffness ---
    this.stunTimer = Math.max(0, this.stunTimer - dt);
    this.stiffness = clamp(1 - this.stunTimer / t.stunTime, t.stunFloor, 1);
    const k = this.stiffness;

    // --- Ground probe ---
    const pelvis = this.pelvis;
    const pp = pelvis.translation();
    const ray = new this.R.Ray({ x: pp.x, y: pp.y, z: pp.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, t.standHeight + 0.6, true, undefined, undefined, undefined, undefined, (c) => !this.ownsCollider(c) && !this.isHolding(c));
    const groundDist = hit ? hit.timeOfImpact : Infinity;
    this.grounded = groundDist < t.standHeight + 0.18;

    // --- Facing ---
    // Rotate toward the aim yaw, but not instantly, so the character has a bit of weight.
    this.yaw = approachAngle(this.yaw, input.aimYaw, 10 * dt);
    _qYaw.setFromAxisAngle(Y_AXIS, this.yaw);

    // --- Locomotion ---
    const pv = pelvis.linvel();
    let mx = input.moveX, mz = input.moveZ;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const control = (this.grounded ? 1 : t.airControl) * k;
    const dvx = mx * t.moveSpeed - pv.x;
    const dvz = mz * t.moveSpeed - pv.z;
    const accel = t.moveAccel * control;
    // Split the push between pelvis and chest so the upper body doesn't get left behind.
    const fx = dvx * accel * this.totalMass * dt;
    const fz = dvz * accel * this.totalMass * dt;
    pelvis.applyImpulse({ x: fx * 0.6, y: 0, z: fz * 0.6 }, true);
    this.chest.applyImpulse({ x: fx * 0.4, y: 0, z: fz * 0.4 }, true);

    // --- Hover spring (holds the body up like a puppet string) ---
    // Anything much taller than a step under the pelvis (a crate we walked into) doesn't hold us up,
    // otherwise the spring would hoist us on top of it.
    if (hit && groundDist < t.standHeight + 0.35 && groundDist > t.standHeight - t.maxStepUp) {
      const err = t.standHeight - groundDist;
      const g = -t.gravity;
      const up = Math.max(0, (t.hoverKp * err - t.hoverKd * pv.y + g) * k) * this.totalMass * dt;
      pelvis.applyImpulse({ x: 0, y: up * 0.55, z: 0 }, true);
      this.chest.applyImpulse({ x: 0, y: up * 0.45, z: 0 }, true);
    }

    // --- Jump ---
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    if (input.jump && this.grounded && this.jumpCooldown === 0 && k > 0.6) {
      const j = t.jumpImpulse * this.totalMass;
      pelvis.applyImpulse({ x: 0, y: j * 0.6, z: 0 }, true);
      this.chest.applyImpulse({ x: 0, y: j * 0.4, z: 0 }, true);
      this.jumpCooldown = 0.35;
    }

    // --- Walk cycle ---
    const speed = Math.hypot(pv.x, pv.z);
    const targetWalk = this.grounded ? clamp(speed / t.moveSpeed, 0, 1) : 0;
    this.walkAmount += (targetWalk - this.walkAmount) * Math.min(1, 10 * dt);
    if (speed > 0.2 && this.grounded) this.walkPhase += dt * t.stepRate * Math.PI * 2 * clamp(speed / t.moveSpeed, 0.4, 1.2);
    const w = this.walkAmount;

    // Direction of travel relative to facing, so legs stride the right way when strafing/backpedaling.
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const rightX = -fwdZ, rightZ = fwdX; // character's right (its -X axis rotated by yaw)
    const velFwd = speed > 0.05 ? (pv.x * fwdX + pv.z * fwdZ) / speed : 1;
    const velSide = speed > 0.05 ? (pv.x * rightX + pv.z * rightZ) / speed : 0;

    const swing = Math.sin(this.walkPhase) * t.strideAngle * w;
    const kneeL = 0.08 + t.kneeBend * w * Math.max(0, Math.cos(this.walkPhase));
    const kneeR = 0.08 + t.kneeBend * w * Math.max(0, -Math.cos(this.walkPhase));
    const airTuck = this.grounded ? 0 : 0.5;

    // --- Pose targets ---
    const lean = t.turnLean * w * velFwd;
    this.drive('pelvis', mul(_qYaw, rot(X_AXIS, lean * 0.5)), k);
    // Bend at the waist when reaching down, so low things are grabbable.
    const bend = input.grab ? clamp(-input.aimPitch, 0, 1.1) * 0.8 : 0;
    this.drive('chest', mul(_qYaw, rot(X_AXIS, lean + bend)), k);
    this.drive('head', _qYaw, k);

    this.driveLeg('thighL', 'shinL', swing, kneeL, velFwd, velSide, airTuck, k);
    this.driveLeg('thighR', 'shinR', -swing, kneeR, velFwd, velSide, airTuck, k);

    if (input.grab) {
      // Reach forward along the aim pitch.
      const reach = -(Math.PI / 2 + clamp(input.aimPitch, -1.2, 1.4));
      const armQ = mul(_qYaw, rot(X_AXIS, reach));
      this.drive('upperArmL', mul(armQ, rot(Z_AXIS, -0.08)), k);
      this.drive('upperArmR', mul(armQ, rot(Z_AXIS, 0.08)), k);
      this.drive('forearmL', armQ, k);
      this.drive('forearmR', armQ, k);
    } else {
      const arm = t.armSwing * w * Math.sin(this.walkPhase) * velFwd;
      this.drive('upperArmL', mul(_qYaw, mul(rot(X_AXIS, arm), rot(Z_AXIS, 0.15))), k * 0.6);
      this.drive('upperArmR', mul(_qYaw, mul(rot(X_AXIS, -arm), rot(Z_AXIS, -0.15))), k * 0.6);
      this.drive('forearmL', mul(_qYaw, rot(X_AXIS, arm - 0.35)), k * 0.6);
      this.drive('forearmR', mul(_qYaw, rot(X_AXIS, -arm - 0.35)), k * 0.6);
    }

    this.updateGrab(input.grab && k > 0.3);
  }

  private driveLeg(thigh: PartName, shin: PartName, swing: number, knee: number, fwd: number, side: number, tuck: number, k: number) {
    // Stride along the direction of travel: forward/back component and a sideways component.
    const pitch = -swing * fwd - tuck;
    const roll = swing * side * 0.6;
    const thighQ = mul(_qYaw, mul(rot(X_AXIS, pitch), rot(Z_AXIS, roll)));
    this.drive(thigh, thighQ, k);
    this.drive(shin, mul(thighQ, rot(X_AXIS, knee + tuck * 1.6)), k);
  }

  /** PD controller: apply a torque impulse that rotates the part toward a world-space orientation. */
  private drive(name: PartName, target: Quaternion, k: number) {
    const p = this.parts.get(name)!;
    const t = tuning;
    const kp = (p.balance ? t.balanceKp : t.limbKp) * k;
    const kd = (p.balance ? t.balanceKd : t.limbKd) * Math.sqrt(k);
    const r = p.body.rotation();
    _qCur.set(r.x, r.y, r.z, r.w);
    _qErr.copy(target).multiply(_qCur.invert());
    if (_qErr.w < 0) _qErr.set(-_qErr.x, -_qErr.y, -_qErr.z, -_qErr.w);
    // Rotation vector = axis * angle.
    const s = Math.sqrt(1 - Math.min(1, _qErr.w * _qErr.w));
    const angle = 2 * Math.acos(Math.min(1, _qErr.w));
    if (s > 1e-5) _v.set(_qErr.x / s, _qErr.y / s, _qErr.z / s).multiplyScalar(angle);
    else _v.set(0, 0, 0);
    const av = p.body.angvel();
    let ax = kp * _v.x - kd * av.x;
    let ay = kp * _v.y - kd * av.y;
    let az = kp * _v.z - kd * av.z;
    const mag = Math.hypot(ax, ay, az);
    if (mag > t.maxAngAccel) {
      const f = t.maxAngAccel / mag;
      ax *= f; ay *= f; az *= f;
    }
    const s2 = p.inertia * this.dt;
    p.body.applyTorqueImpulse({ x: ax * s2, y: ay * s2, z: az * s2 }, true);
  }

  private updateGrab(holding: boolean) {
    if (!holding) {
      this.releaseAll();
      return;
    }
    for (const h of this.hands) {
      if (h.joint) continue;
      const fb = h.forearm.body;
      const handWorld = localToWorld(fb, HAND_LOCAL);
      let target: RAPIER_NS.Collider | null = null;
      this.world.intersectionsWithShape(
        handWorld, { x: 0, y: 0, z: 0, w: 1 }, new this.R.Ball(tuning.grabRadius),
        (c) => { target = c; return false; },
        undefined, undefined, undefined, undefined,
        (c) => !this.ownsCollider(c) && !c.isSensor() && c.parent() !== null,
      );
      if (!target) continue;
      const other = (target as RAPIER_NS.Collider).parent()!;
      const anchor2 = worldToLocal(other, handWorld);
      h.joint = this.world.createImpulseJoint(
        this.R.JointData.spherical(HAND_LOCAL, anchor2), fb, other, true,
      );
    }
  }
}

function shapeToCollider(R: R, s: ShapeDesc): RAPIER_NS.ColliderDesc {
  switch (s.kind) {
    case 'box': return R.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
    case 'ball': return R.ColliderDesc.ball(s.r);
    case 'capsule': return R.ColliderDesc.capsule(s.hh, s.r);
  }
}

function sub(a: [number, number, number], b: [number, number, number]) {
  return { x: a[0] - b[0], y: a[1] - b[1], z: a[2] - b[2] };
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function approachAngle(cur: number, target: number, maxStep: number) {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return cur + clamp(d, -maxStep, maxStep);
}

// Small pool of quaternions for building targets without allocating each step.
const pool: Quaternion[] = Array.from({ length: 64 }, () => new Quaternion());
let poolIdx = 0;
function tmpQ() {
  poolIdx = (poolIdx + 1) % pool.length;
  return pool[poolIdx];
}
function rot(axis: Vector3, angle: number) {
  return tmpQ().setFromAxisAngle(axis, angle);
}
function mul(a: Quaternion, b: Quaternion) {
  return tmpQ().multiplyQuaternions(a, b);
}

function localToWorld(body: Body, p: { x: number; y: number; z: number }) {
  const r = body.rotation();
  const t = body.translation();
  _qTmp.set(r.x, r.y, r.z, r.w);
  _v.set(p.x, p.y, p.z).applyQuaternion(_qTmp);
  return { x: _v.x + t.x, y: _v.y + t.y, z: _v.z + t.z };
}

function worldToLocal(body: Body, p: { x: number; y: number; z: number }) {
  const r = body.rotation();
  const t = body.translation();
  _qTmp.set(r.x, r.y, r.z, r.w).invert();
  _v.set(p.x - t.x, p.y - t.y, p.z - t.z).applyQuaternion(_qTmp);
  return { x: _v.x, y: _v.y, z: _v.z };
}
