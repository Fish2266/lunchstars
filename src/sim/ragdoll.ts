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

export interface PartDef {
  name: PartName;
  shape: ShapeDesc;
  /** Center offset from the pelvis center in the rest pose. */
  offset: [number, number, number];
  density: number;
}

// Rest pose: standing straight, arms hanging, facing +Z. Pelvis center sits at `standHeight`.
export const ARM_X = 0.27;
export const HIP_X = 0.1;
/** Rest-pose layout of every body part (also used by the renderer to build the one-piece body mesh). */
export const PARTS: PartDef[] = [
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

/** Bottom of the shin capsule, in the shin's local frame. */
const FOOT_LOCAL = { x: 0, y: -0.26, z: 0 };
/** Hand position in the forearm's local frame (bottom of the capsule). */
const HAND_LOCAL = { x: 0, y: -0.16, z: 0 };

interface Part {
  def: PartDef;
  body: Body;
  /** Principal inertia (body-local axes) used to turn desired angular acceleration into torque. */
  inertia: { x: number; y: number; z: number };
  /** Per-part gain multiplier (balance parts vs limbs). */
  balance: boolean;
}

type V3 = { x: number; y: number; z: number };

/**
 * idle  — loose, swinging with the walk
 * reach — held out along the aim, grabbing whatever the hand touches
 * aim   — holding an item, pointed down the aim line
 * punch — snapped straight out along the aim
 */
export type ArmMode = 'idle' | 'reach' | 'aim' | 'punch';

interface Leg {
  /** +1 = left (local +X), -1 = right. */
  side: 1 | -1;
  thigh: Part;
  shin: Part;
  collider: RAPIER_NS.Collider;
  planted: boolean;
  swinging: boolean;
  onGround: boolean;
  /** Swing progress 0..1. */
  t: number;
  /** Seconds since this foot planted. */
  plantAge: number;
  sole: V3;
  plant: V3;
  from: V3;
  /** Where this foot wants to be: under the hip, led by velocity. */
  home: V3;
  /** Where the foot is being driven this tick (for the leg pose). */
  target: V3;
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
const DOWN = new Vector3(0, -1, 0);

export class Ragdoll {
  readonly parts = new Map<PartName, Part>();
  readonly colliderHandles = new Set<number>();
  readonly bodyHandles = new Set<number>();
  readonly hands: Hand[];
  totalMass = 0;
  /** Chest + head + arms: what the spine holds up. */
  upperMass = 0;

  grounded = false;
  stunTimer = 0;
  staggerTimer = 0;
  /** Set by the sim: fully limp, no control at all. */
  knockedOut = false;
  stiffness = 1;
  private walkAmount = 0;
  private jumpCooldown = 0;
  yaw = 0;
  /** Set by the sim each tick: what each arm is doing. Index 0 = left hand (Q), 1 = right hand (E). */
  armMode: [ArmMode, ArmMode] = ['idle', 'idle'];
  private dt = 1 / 60;
  readonly legs: Leg[];
  private lastStep: Leg | null = null;
  private smoothVel = { x: 0, z: 0 };

  constructor(
    private readonly R: R,
    private readonly world: RAPIER_NS.World,
    readonly playerId: number,
    readonly color: number,
    spawn: { x: number; y: number; z: number },
    collisionGroups: number,
  ) {
    const footColliders = new Map<string, RAPIER_NS.Collider>();
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
          .setFriction(def.name.startsWith('shin') ? 1.6 : 0.45)
          .setCollisionGroups(collisionGroups),
        body,
      );
      const pi = body.principalInertia();
      const part: Part = {
        def,
        body,
        inertia: { x: pi.x, y: pi.y, z: pi.z },
        balance: def.name === 'pelvis' || def.name === 'chest' || def.name === 'head',
      };
      this.parts.set(def.name, part);
      this.colliderHandles.add(collider.handle);
      this.bodyHandles.add(body.handle);
      if (def.name === 'shinL' || def.name === 'shinR') footColliders.set(def.name, collider);
      this.totalMass += body.mass();
      if (def.name === 'chest' || def.name === 'head' || def.name.includes('Arm') || def.name.startsWith('forearm')) this.upperMass += body.mass();
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

    const makeLeg = (side: 1 | -1, thigh: PartName, shin: PartName): Leg => ({
      side, thigh: this.parts.get(thigh)!, shin: this.parts.get(shin)!, collider: footColliders.get(shin)!,
      planted: false, swinging: false, onGround: false, t: 0, plantAge: 0,
      sole: { x: 0, y: 0, z: 0 }, plant: { x: 0, y: 0, z: 0 }, from: { x: 0, y: 0, z: 0 },
      home: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 },
    });
    this.legs = [makeLeg(1, 'thighL', 'shinL'), makeLeg(-1, 'thighR', 'shinR')];

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
    this.addStun(strength * tuning.stunPerImpulse);
  }

  addStun(seconds: number) {
    this.stunTimer = Math.min(4, this.stunTimer + seconds);
    // Any hit knocks you off your footing for a moment, so knockback slides you instead of being absorbed.
    this.staggerTimer = Math.max(this.staggerTimer, tuning.staggerTime);
  }

  /** Set by the sim: velocity of a moving surface (like the conveyor) under a point, or null. */
  surfaceVelocity: (p: { x: number; y: number; z: number }) => { x: number; z: number } | null = () => null;

  /** False while eliminated: the body is parked out of the world and doesn't simulate. */
  active = true;

  setActive(on: boolean) {
    this.active = on;
    this.releaseAll();
    for (const p of this.parts.values()) {
      if (!on) {
        p.body.setTranslation({ x: p.def.offset[0], y: -1000 + p.def.offset[1], z: p.def.offset[2] }, false);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        p.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      }
      p.body.setEnabled(on);
    }
  }

  teleport(pos: { x: number; y: number; z: number }, yaw = 0) {
    if (!this.active) this.setActive(true);
    this.releaseAll();
    for (const p of this.parts.values()) {
      p.body.setTranslation({ x: pos.x + p.def.offset[0], y: pos.y + p.def.offset[1], z: pos.z + p.def.offset[2] }, true);
      p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.stunTimer = 0;
    this.staggerTimer = 0;
    this.yaw = yaw;
    for (const leg of this.legs) { leg.planted = false; leg.swinging = false; }
    this.smoothVel.x = 0; this.smoothVel.z = 0;
  }

  /** Start a punch: for its duration the fist is steered to arm's length along `dir` (see `servoFist`). */
  punch(i: 0 | 1, dir: { x: number; y: number; z: number }) {
    this.punchDir[i] = { ...dir };
  }

  /** Seconds left pulling an arm back down after a punch. */
  private retract: [number, number] = [0, 0];

  /** Match the arm's motion to the chest's, removing any swing of its own. */
  private settleArm(i: 0 | 1) {
    const cv = this.chest.linvel(), ca = this.chest.angvel();
    for (const n of i === 0 ? ['upperArmL', 'forearmL'] as const : ['upperArmR', 'forearmR'] as const) {
      const b = this.parts.get(n)!.body;
      b.setLinvel(cv, true);
      b.setAngvel(ca, true);
    }
  }

  /** Bleed off an arm's swing (relative to the chest) by `f` per tick, so a dropped arm settles instead of pendulum-swinging. */
  private dampArm(i: 0 | 1, f: number) {
    const ca = this.chest.angvel(), cv = this.chest.linvel();
    for (const n of i === 0 ? ['upperArmL', 'forearmL'] as const : ['upperArmR', 'forearmR'] as const) {
      const b = this.parts.get(n)!.body;
      const a = b.angvel(), v = b.linvel();
      b.setAngvel({ x: a.x + (ca.x - a.x) * f, y: a.y + (ca.y - a.y) * f, z: a.z + (ca.z - a.z) * f }, true);
      b.setLinvel({ x: v.x + (cv.x - v.x) * f, y: v.y + (cv.y - v.y) * f, z: v.z + (cv.z - v.z) * f }, true);
    }
  }

  private punchDir: [{ x: number; y: number; z: number } | null, { x: number; y: number; z: number } | null] = [null, null];

  /**
   * Drive the fist straight at a point an arm's length in front of the shoulder, fast, then hold it there.
   * Steering by velocity (not a one-off shove) gets it out in a few frames without flinging it over the head.
   */
  private servoFist(i: 0 | 1, k: number) {
    const dir = this.punchDir[i]!;
    const side = i === 0 ? 1 : -1;
    const shoulder = localToWorld(this.chest, { x: 0.27 * side, y: 0.12, z: 0 });
    const tx = shoulder.x + dir.x * 0.6, ty = shoulder.y + dir.y * 0.6, tz = shoulder.z + dir.z * 0.6;
    const fore = this.hands[i].forearm.body;
    const hand = localToWorld(fore, HAND_LOCAL);
    let vx = (tx - hand.x) / 0.05, vy = (ty - hand.y) / 0.05, vz = (tz - hand.z) / 0.05;
    const vm = Math.hypot(vx, vy, vz);
    const sp = tuning.punchSpeed;
    if (vm > sp) { vx *= sp / vm; vy *= sp / vm; vz *= sp / vm; }
    const cv = this.chest.linvel();
    const v = fore.linvel();
    const m = fore.mass() * k;
    fore.applyImpulseAtPoint({ x: (cv.x + vx - v.x) * m, y: (cv.y + vy - v.y) * m, z: (cv.z + vz - v.z) * m }, hand, true);
  }

  /** Which body part a rigid body is. */
  partName(handle: number): PartName | null {
    for (const [n, p] of this.parts) if (p.body.handle === handle) return n;
    return null;
  }

  /** World positions of both hands. */
  handPositions() {
    return this.hands.map((h) => localToWorld(h.forearm.body, HAND_LOCAL));
  }

  /** World position of one hand (0 = left, 1 = right). */
  handPosition(i: 0 | 1) {
    return localToWorld(this.hands[i].forearm.body, HAND_LOCAL);
  }

  /** World position of the right hand. */
  rightHand() {
    return localToWorld(this.parts.get('forearmR')!.body, HAND_LOCAL);
  }

  /** Point the camera and the sim agree shots come from: above the chest. */
  aimOrigin() {
    const c = this.chest.translation();
    return { x: c.x, y: c.y + 0.35, z: c.z };
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
    this.stiffness = this.knockedOut ? 0 : clamp(1 - this.stunTimer / t.stunTime, t.stunFloor, 1);
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
    this.yaw = approachAngle(this.yaw, input.aimYaw, t.turnRate * dt);
    _qYaw.setFromAxisAngle(Y_AXIS, this.yaw);

    // --- Feet ---
    const pv = pelvis.linvel();
    const speed = Math.hypot(pv.x, pv.z);
    let mx = input.moveX, mz = input.moveZ;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const leftX = Math.cos(this.yaw), leftZ = -Math.sin(this.yaw); // the character's local +X
    for (const leg of this.legs) this.senseFoot(leg);
    const [legL, legR] = this.legs;

    // "Too tall" means the surface under the pelvis is well above our feet (a crate we walked into), so it
    // can't hold us up. Lying on the floor, the floor is level with our feet, so we still get back up.
    const surfaceY = hit ? pp.y - groundDist : -Infinity;
    const tooTall = hit ? surfaceY - Math.min(legL.sole.y, legR.sole.y) > t.maxStepUp : false;
    this.staggerTimer = Math.max(0, this.staggerTimer - dt);
    const canStep = this.grounded && !tooTall && k > 0.35 && this.staggerTimer === 0;

    const walkSpeed = this.grounded ? Math.max(speed, ml * t.moveSpeed * 0.6) : 0;
    this.walkAmount += (clamp(walkSpeed / t.moveSpeed, 0, 1) - this.walkAmount) * Math.min(1, 8 * dt);
    const w = this.walkAmount;

    // --- Stepping ---
    // Each foot is either planted (stays exactly where it landed) or swinging to a spot ahead of the hips.
    // One foot at a time. The body moves over planted feet, so nothing skates.
    // Aim steps with a smoothed velocity, so a jolt to the hips doesn't make the feet dance.
    const sv = this.smoothVel;
    const blend = Math.min(1, t.stepVelSmoothing * dt);
    sv.x += (pv.x - sv.x) * blend;
    sv.z += (pv.z - sv.z) * blend;
    const lead = t.stepLead + t.stepTime * 0.5;
    for (const leg of this.legs) {
      leg.home.x = pp.x + leftX * leg.side * t.stanceWidth + sv.x * lead;
      leg.home.z = pp.z + leftZ * leg.side * t.stanceWidth + sv.z * lead;
      leg.home.y = surfaceY;
    }
    if (!canStep) {
      for (const leg of this.legs) { leg.planted = false; leg.swinging = false; }
    } else {
      for (const leg of this.legs) {
        if (leg.planted || leg.swinging) continue;
        if (leg.onGround) this.plantFoot(leg);
        else if (!this.legs.some((l) => l.swinging)) this.startStep(leg);
      }
      for (const leg of this.legs) {
        if (!leg.swinging) continue;
        leg.t += dt / t.stepTime;
        if (leg.t >= 1) this.plantFoot(leg);
      }
      if (!this.legs.some((l) => l.swinging)) {
        // Step with whichever foot has fallen furthest behind where it should be; alternate on ties.
        const dist = (l: Leg) => Math.hypot(l.plant.x - l.home.x, l.plant.z - l.home.z);
        const dL = dist(legL), dR = dist(legR);
        const need = t.stepDist;
        if (dL > need || dR > need) {
          let pick = dL > dR ? legL : legR;
          const other = pick === legL ? legR : legL;
          if (pick === this.lastStep && dist(other) > need * 0.7) pick = other;
          this.startStep(pick);
        }
      }
    }

    // Drive the feet: swinging feet follow an arc to their landing spot, planted feet hold still.
    for (const leg of this.legs) {
      const shin = leg.shin.body;
      const m = shin.mass();
      const fv = this.soleVelocity(leg);
      if (leg.swinging) {
        const s = leg.t * leg.t * (3 - 2 * leg.t);
        const tx = leg.from.x + (leg.home.x - leg.from.x) * s;
        const tz = leg.from.z + (leg.home.z - leg.from.z) * s;
        const ty = leg.from.y + (leg.home.y - leg.from.y) * s + t.stepHeight * Math.sin(Math.PI * leg.t);
        leg.target.x = tx; leg.target.y = ty; leg.target.z = tz;
        let vx = (tx - leg.sole.x) / 0.06, vy = (ty - leg.sole.y) / 0.06, vz = (tz - leg.sole.z) / 0.06;
        const vm = Math.hypot(vx, vy, vz);
        if (vm > 9) { vx *= 9 / vm; vy *= 9 / vm; vz *= 9 / vm; }
        // Hip muscles swing the leg: the pull on the foot pushes back on the pelvis.
        // Ease in at lift-off and out before landing so the hips don't get a jolt every step.
        const ease = Math.min(1, leg.t * 5, (1 - leg.t) * 4);
        const g = t.footDrive * m * k * ease * ease;
        const ix = (vx - fv.x) * g, iy = (vy - fv.y) * g, iz = (vz - fv.z) * g;
        shin.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, leg.sole, true);
        const r = t.swingReaction;
        pelvis.applyImpulse({ x: -ix * r, y: -iy * r, z: -iz * r }, true);
        this.holdUp(leg.shin.def.name, k, pelvis);
        this.holdUp(leg.thigh.def.name, k, pelvis);
        leg.collider.setFriction(t.footGlide);
      } else if (leg.planted) {
        // Pin it horizontally (what a real sole's grip does), easing in so landing doesn't jolt the hips.
        leg.plantAge += dt;
        // A planted foot on a moving surface (the conveyor) rides along with it.
        const sv = this.surfaceVelocity(leg.plant);
        if (sv) { leg.plant.x += sv.x * dt; leg.plant.z += sv.z * dt; }
        const g = t.footDrive * m * k * Math.min(1, leg.plantAge * 10);
        const ax = (leg.plant.x - leg.sole.x) * 12 - fv.x, az = (leg.plant.z - leg.sole.z) * 12 - fv.z;
        shin.applyImpulseAtPoint({ x: ax * g, y: 0, z: az * g }, leg.sole, true);
        leg.target.x = leg.plant.x; leg.target.y = leg.plant.y; leg.target.z = leg.plant.z;
        leg.collider.setFriction(t.footGrip);
      } else {
        leg.collider.setFriction(t.footGlide);
      }
    }

    // Weight goes through planted feet (or grounded ones, while we're scrambling up).
    let wL = legL.planted ? 1 : !canStep && legL.onGround ? 1 : 0;
    let wR = legR.planted ? 1 : !canStep && legR.onGround ? 1 : 0;
    const wSum = wL + wR;
    if (wSum > 0) { wL /= wSum; wR /= wSum; }
    /** Push the pelvis by `imp`; the stance feet push back on the ground (internal force pair). */
    const pushOffFeet = (ix: number, iy: number, iz: number) => {
      pelvis.applyImpulse({ x: ix, y: iy, z: iz }, true);
      if (wSum > 0 && t.legSupport > 0) {
        const s = t.legSupport, h = t.footPush;
        if (wL > 0) legL.shin.body.applyImpulse({ x: -ix * wL * h, y: -iy * wL * s, z: -iz * wL * h }, true);
        if (wR > 0) legR.shin.body.applyImpulse({ x: -ix * wR * h, y: -iy * wR * s, z: -iz * wR * h }, true);
      }
    };

    // --- Locomotion ---
    // Walk relative to what we're standing on, so the conveyor moves you but you can still walk off it.
    const gv = this.grounded ? this.surfaceVelocity({ x: pp.x, y: Math.min(legL.sole.y, legR.sole.y) + 0.1, z: pp.z }) : null;
    const dvx = mx * t.moveSpeed + (gv ? gv.x : 0) - pv.x;
    const dvz = mz * t.moveSpeed + (gv ? gv.z : 0) - pv.z;
    if (this.grounded) {
      // While staggered we can't brake, so knockback carries us.
      const control = this.staggerTimer > 0 ? 0.1 : 1;
      let ax = dvx * t.moveAccel * k * control, az = dvz * t.moveAccel * k * control;
      const am = Math.hypot(ax, az);
      if (am > t.maxMoveAccel) { ax *= t.maxMoveAccel / am; az *= t.maxMoveAccel / am; }
      pushOffFeet(ax * this.totalMass * dt, 0, az * this.totalMass * dt);
    } else {
      const a = t.moveAccel * t.airControl * k * this.totalMass * dt;
      pelvis.applyImpulse({ x: dvx * a, y: 0, z: dvz * a }, true);
    }

    // --- Weight shift ---
    // Move the hips sideways over the foot that's holding us up (between both feet when standing).
    // This is the big side-to-side waddle; the force goes through the feet like everything else.
    if (canStep && wSum > 0) {
      let fx = 0, fz = 0;
      if (legL.planted && legR.planted) { fx = (legL.sole.x + legR.sole.x) / 2; fz = (legL.sole.z + legR.sole.z) / 2; }
      else { const st = legL.planted ? legL : legR; fx = st.sole.x; fz = st.sole.z; }
      // Don't fight a strafe: fade the shift out when moving sideways and damp relative to the wanted speed.
      const desLat = (mx * leftX + mz * leftZ) * t.moveSpeed;
      const fade = 1 - Math.min(1, Math.abs(desLat) / t.moveSpeed);
      const lat = ((fx - pp.x) * leftX + (fz - pp.z) * leftZ) * t.sway * fade;
      const vlat = pv.x * leftX + pv.z * leftZ;
      const a = (t.swayKp * lat - t.swayKd * (vlat - desLat * (1 - fade))) * k * this.totalMass * dt;
      pushOffFeet(leftX * a, 0, leftZ * a);
    }

    // --- Leg support ---
    // A spring holds the pelvis at standing height; its reaction goes into the stance feet, so the legs
    // carry the weight instead of an invisible string.
    const spread = Math.hypot(legL.sole.x - legR.sole.x, legL.sole.z - legR.sole.z);
    if (hit && groundDist < t.standHeight + 0.35 && !tooTall) {
      // Hips dip when the feet are spread mid-stride.
      const height = t.standHeight - t.bob * clamp((spread - 0.2) / 0.5, 0, 1);
      // Clamp so getting up from the floor is a scramble, not a launch.
      const err = Math.min(height - groundDist, 0.25);
      const g = -t.gravity;
      const up = Math.max(0, (t.hoverKp * err - t.hoverKd * pv.y + g) * k) * this.totalMass * dt;
      pushOffFeet(0, up, 0);
    }

    // --- Spine ---
    // Back muscles: carry the upper body's weight on the pelvis (internal force pair), so the torso
    // controller only has to orient it. Nothing external — the legs still hold everything up.
    if (t.spineSupport > 0) {
      const lift = -t.gravity * this.upperMass * t.spineSupport * k * dt;
      this.chest.applyImpulse({ x: 0, y: lift, z: 0 }, true);
      pelvis.applyImpulse({ x: 0, y: -lift, z: 0 }, true);
    }

    // --- Jump ---
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    if (input.jump && this.grounded && this.jumpCooldown === 0 && k > 0.6) {
      const j = t.jumpImpulse * this.totalMass;
      pelvis.applyImpulse({ x: 0, y: j * 0.75, z: 0 }, true);
      this.chest.applyImpulse({ x: 0, y: j * 0.25, z: 0 }, true);
      this.jumpCooldown = 0.35;
    }

    // --- Pose targets ---
    const velFwd = speed > 0.3 ? (pv.x * fwdX + pv.z * fwdZ) / speed : 1;
    // +1 when the left foot is ahead, -1 when the right is. Drives hip twist and arm swing.
    const stride = clamp(((legL.sole.x - legR.sole.x) * fwdX + (legL.sole.z - legR.sole.z) * fwdZ) / 0.5, -1, 1);
    // Lean with speed, and extra into acceleration: tip forward when setting off, back when stopping.
    const accelFwd = dvx * fwdX + dvz * fwdZ;
    const lean = t.turnLean * w * velFwd + clamp(accelFwd * t.accelLean * (this.grounded ? 1 : 0), -0.3, 0.35);
    // Waddle: rock over the stance foot while the other one is in the air.
    let roll = 0;
    for (const leg of this.legs) if (leg.swinging) roll = t.waddle * leg.side * Math.sin(Math.PI * leg.t);
    const twist = t.hipTwist * stride;
    this.drive('pelvis', mul(_qYaw, mul(rot(Y_AXIS, twist), mul(rot(X_AXIS, lean * 0.5), rot(Z_AXIS, roll * 0.6)))), k);
    // Bend at the waist when reaching down, so low things are grabbable.
    const reaching = this.armMode[0] === 'reach' || this.armMode[1] === 'reach';
    const bend = reaching ? clamp(-input.aimPitch, 0, 1.1) * 0.8 : 0;
    this.drive('chest', mul(_qYaw, mul(rot(Y_AXIS, -twist * 0.5), mul(rot(X_AXIS, lean + bend), rot(Z_AXIS, roll)))), k * t.torsoGain);
    // Neck: hold the head's weight on the chest so it doesn't loll, then point it.
    this.holdUp('head', k, this.chest);
    this.drive('head', mul(_qYaw, rot(X_AXIS, lean * -0.4)), k * t.headGain);

    for (const leg of this.legs) this.driveLeg(leg, canStep, k);

    const aimQ = mul(_qYaw, rot(X_AXIS, -(Math.PI / 2 + clamp(input.aimPitch, -1.2, 1.4))));
    // Each arm on its own: left = side +1 (local +X), right = side -1.
    const arms = [['upperArmL', 'forearmL', 1], ['upperArmR', 'forearmR', -1]] as const;
    for (let i = 0; i < 2; i++) {
      const [upper, fore, side] = arms[i];
      const mode = this.armMode[i];
      if (mode === 'idle') {
        // Loose: swing opposite the legs, mostly flopping around with the body.
        // Just after a punch it's held a bit firmer so it comes back down instead of drifting.
        const arm = t.armSwing * stride * side;
        const ka = k * (this.retract[i] > 0 ? 1 : t.idleArmGain);
        this.drive(upper, mul(_qYaw, mul(rot(X_AXIS, arm), rot(Z_AXIS, 0.2 * side))), ka);
        this.drive(fore, mul(_qYaw, rot(X_AXIS, arm - 0.45)), ka);
        continue;
      }
      // Out along the aim. Angle the arm in a little so the hand ends up in front of the chest.
      const ka = k * t.aimGain * (mode === 'punch' ? 2 : mode === 'reach' ? 1.5 : 1);
      const inward = mode === 'aim' ? 0.12 : 0.06;
      // Active arms may accelerate much harder than the body, so hands come up fast.
      this.drive(upper, mul(aimQ, rot(Z_AXIS, -inward * side)), ka, t.armSnap);
      this.drive(fore, aimQ, ka, t.armSnap);
      this.holdUp(upper, k, this.chest);
      this.holdUp(fore, k, this.chest);
      if (mode === 'punch' && this.punchDir[i]) this.servoFist(i as 0 | 1, k);
    }
    for (let i = 0; i < 2; i++) {
      if (this.armMode[i] !== 'punch' && this.punchDir[i]) {
        // Punch over: kill the arm's leftover swing so it doesn't fling up past the head, then let it drop.
        this.punchDir[i] = null;
        this.settleArm(i as 0 | 1);
        this.retract[i] = 0.35;
      }
      if (this.retract[i] > 0) this.dampArm(i as 0 | 1, 0.15);
      this.retract[i] = Math.max(0, this.retract[i] - dt);
    }

    this.updateGrab([this.armMode[0] === 'reach' && k > 0.3, this.armMode[1] === 'reach' && k > 0.3]);
  }

  private driveLeg(leg: Leg, stepping: boolean, k: number) {
    const t = tuning;
    if (!stepping) {
      // In the air or knocked silly: tuck a little and let physics do the rest.
      const tuck = this.grounded ? 0.05 : 0.5;
      const thighQ = mul(_qYaw, rot(X_AXIS, -tuck));
      this.drive(leg.thigh.def.name, thighQ, k * t.legPoseGain);
      this.drive(leg.shin.def.name, mul(thighQ, rot(X_AXIS, tuck * 1.6)), k * t.legPoseGain);
      return;
    }
    // Point the leg from the hip at where the foot should be, bending the knee mid-swing.
    const hip = localToWorld(this.pelvis, { x: leg.side * HIP_X, y: -0.08, z: 0 });
    _qTmp.copy(_qYaw).invert();
    _v.set(leg.target.x - hip.x, leg.target.y - hip.y, leg.target.z - hip.z).applyQuaternion(_qTmp);
    if (_v.lengthSq() < 1e-6) _v.set(0, -1, 0);
    _v.normalize();
    const knee = leg.swinging ? t.kneeBend * Math.sin(Math.PI * leg.t) : 0.05;
    const aimLocal = tmpQ().setFromUnitVectors(DOWN, _v);
    const thighQ = mul(_qYaw, mul(aimLocal, rot(X_AXIS, -knee * 0.5)));
    this.drive(leg.thigh.def.name, thighQ, k * t.legPoseGain);
    this.drive(leg.shin.def.name, mul(thighQ, rot(X_AXIS, knee)), k * t.legPoseGain);
  }

  private startStep(leg: Leg) {
    leg.swinging = true;
    leg.planted = false;
    leg.t = 0;
    leg.from.x = leg.sole.x; leg.from.y = leg.sole.y; leg.from.z = leg.sole.z;
    this.lastStep = leg;
  }

  private plantFoot(leg: Leg) {
    leg.swinging = false;
    leg.planted = true;
    leg.plantAge = 0;
    leg.plant.x = leg.sole.x; leg.plant.y = leg.sole.y; leg.plant.z = leg.sole.z;
  }

  /** World velocity of the sole point. */
  private soleVelocity(leg: Leg) {
    const b = leg.shin.body;
    const v = b.linvel(), a = b.angvel(), c = b.translation();
    const rx = leg.sole.x - c.x, ry = leg.sole.y - c.y, rz = leg.sole.z - c.z;
    return { x: v.x + a.y * rz - a.z * ry, y: v.y + a.z * rx - a.x * rz, z: v.z + a.x * ry - a.y * rx };
  }

  /** Where this leg's sole is, and whether it's touching (or within a few cm of) something to stand on. */
  private senseFoot(leg: Leg) {
    const f = localToWorld(leg.shin.body, FOOT_LOCAL);
    leg.sole.x = f.x; leg.sole.y = f.y; leg.sole.z = f.z;
    const ray = new this.R.Ray({ x: f.x, y: f.y + 0.2, z: f.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, 0.3, true, undefined, undefined, undefined, undefined,
      (c) => !this.ownsCollider(c) && !this.isHolding(c));
    leg.onGround = !!hit;
  }

  /**
   * Cancel gravity on a part so its pose controller only has to orient it (arms held out, a swinging leg,
   * the head on its neck). The same force pushes down on `onto`, so it's a muscle, not a string.
   */
  private holdUp(name: PartName, k: number, onto: Body) {
    const b = this.parts.get(name)!.body;
    const lift = -tuning.gravity * b.mass() * this.dt * k;
    b.applyImpulse({ x: 0, y: lift, z: 0 }, true);
    onto.applyImpulse({ x: 0, y: -lift, z: 0 }, true);
  }

  /** PD controller: apply a torque impulse that rotates the part toward a world-space orientation. */
  private drive(name: PartName, target: Quaternion, k: number, accelScale = 1) {
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
    const maxA = t.maxAngAccel * accelScale;
    if (mag > maxA) {
      const f = maxA / mag;
      ax *= f; ay *= f; az *= f;
    }
    // torque = I * alpha, done per axis in the body frame. A thin limb has almost no inertia about its
    // long axis; using one averaged number there over-drives twist and makes arms wander.
    // (_qCur holds the inverse rotation here; principal axes match body axes for our primitive shapes.)
    _v.set(ax, ay, az).applyQuaternion(_qCur);
    _v.set(_v.x * p.inertia.x, _v.y * p.inertia.y, _v.z * p.inertia.z).applyQuaternion(_qCur.invert());
    const dt = this.dt;
    p.body.applyTorqueImpulse({ x: _v.x * dt, y: _v.y * dt, z: _v.z * dt }, true);
  }

  private updateGrab(holding: [boolean, boolean]) {
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i];
      if (!holding[i]) {
        if (h.joint) { this.world.removeImpulseJoint(h.joint, true); h.joint = null; }
        continue;
      }
      if (h.joint) continue;
      const fb = h.forearm.body;
      const handWorld = localToWorld(fb, HAND_LOCAL);
      let target: RAPIER_NS.Collider | null = null;
      this.world.intersectionsWithShape(
        handWorld, { x: 0, y: 0, z: 0, w: 1 }, new this.R.Ball(tuning.grabRadius),
        (c) => { target = c; return false; },
        undefined, undefined, undefined, undefined,
        (c) => !this.ownsCollider(c) && !c.isSensor() && c.parent() !== null && !this.ignoreGrab(c),
      );
      if (!target) continue;
      const other = (target as RAPIER_NS.Collider).parent()!;
      const anchor2 = worldToLocal(other, handWorld);
      h.joint = this.world.createImpulseJoint(
        this.R.JointData.spherical(HAND_LOCAL, anchor2), fb, other, true,
      );
    }
  }

  /** Set by the sim: colliders a reaching hand should not latch onto (loose guns are picked up instead). */
  ignoreGrab: (c: RAPIER_NS.Collider) => boolean = () => false;

}

function shapeToCollider(R: R, s: ShapeDesc): RAPIER_NS.ColliderDesc {
  switch (s.kind) {
    case 'box': return R.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
    case 'ball': return R.ColliderDesc.ball(s.r);
    case 'capsule': return R.ColliderDesc.capsule(s.hh, s.r);
    case 'cylinder': return R.ColliderDesc.cylinder(s.hh, s.r);
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

export function localToWorld(body: Body, p: { x: number; y: number; z: number }) {
  const r = body.rotation();
  const t = body.translation();
  _qTmp.set(r.x, r.y, r.z, r.w);
  _v.set(p.x, p.y, p.z).applyQuaternion(_qTmp);
  return { x: _v.x + t.x, y: _v.y + t.y, z: _v.z + t.z };
}

export function worldToLocal(body: Body, p: { x: number; y: number; z: number }) {
  const r = body.rotation();
  const t = body.translation();
  _qTmp.set(r.x, r.y, r.z, r.w).invert();
  _v.set(p.x - t.x, p.y - t.y, p.z - t.z).applyQuaternion(_qTmp);
  return { x: _v.x, y: _v.y, z: _v.z };
}
