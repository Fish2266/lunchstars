// The game simulation. Pure: no rendering, no DOM, no networking.
// It takes inputs, advances physics at a fixed timestep, and exposes state as plain data.
// The same code can run in single-player, on the multiplayer host, or on a Node server.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { emptyInput, type PlayerInput } from './input';
import { Ragdoll } from './ragdoll';
import { tuning } from './tuning';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export type ShapeDesc =
  | { kind: 'box'; hx: number; hy: number; hz: number }
  | { kind: 'ball'; r: number }
  | { kind: 'capsule'; hh: number; r: number };

/** Static description of something the renderer should draw. Transforms come separately. */
export interface EntityDesc {
  id: number;
  shape: ShapeDesc;
  color: number;
  /** 'player' parts get the character look; 'static' never moves. */
  role: 'static' | 'prop' | 'player';
  playerId?: number;
}

type V3 = { x: number; y: number; z: number };

// Collision groups: bit 0 = world, bits 1..15 = one per player (so a ragdoll never hits itself).
const WORLD_GROUP = 0x0001;
function groups(membership: number, filter: number) {
  return (membership << 16) | filter;
}
function playerGroups(slot: number) {
  const bit = 1 << (slot + 1);
  return groups(bit, 0xffff ^ bit);
}

export const PLAYER_COLORS = [0xff5a5f, 0x3fa7ff, 0xffc93c, 0x5fd068, 0xb57bff, 0xff8fd1];

interface Prop {
  body: RAPIER_NS.RigidBody;
  spawn: V3;
}

export class Sim {
  readonly world: RAPIER_NS.World;
  readonly players = new Map<number, Ragdoll>();
  readonly entities: EntityDesc[] = [];
  /** Body for each entity, same order as `entities`. */
  private entityBodies: RAPIER_NS.RigidBody[] = [];
  private props: Prop[] = [];
  private spawns: V3[] = [];
  /** Bumped whenever `entities` changes so the renderer knows to rebuild meshes. */
  entityVersion = 0;
  tick = 0;

  constructor(private readonly R: typeof RAPIER_NS) {
    this.world = new R.World({ x: 0, y: tuning.gravity, z: 0 });
    this.world.timestep = DT;
    this.world.numSolverIterations = 8;
    this.buildArena();
  }

  addPlayer(id: number): Ragdoll {
    const slot = this.players.size;
    const spawn = this.spawns[slot % this.spawns.length];
    const color = PLAYER_COLORS[slot % PLAYER_COLORS.length];
    const r = new Ragdoll(this.R, this.world, id, color, { x: spawn.x, y: spawn.y + tuning.standHeight, z: spawn.z }, playerGroups(slot));
    this.players.set(id, r);
    for (const part of r.parts.values()) {
      const s = part.def.shape;
      this.addEntity(part.body, s, part.def.name === 'head' ? 0xffe0bd : color, 'player', id);
    }
    return r;
  }

  respawn(id: number) {
    const r = this.players.get(id);
    if (!r) return;
    const slot = [...this.players.keys()].indexOf(id);
    const s = this.spawns[slot % this.spawns.length];
    for (const other of this.players.values()) for (const b of r.bodyHandles) other.releaseIfAttachedTo(b);
    r.teleport({ x: s.x, y: s.y + tuning.standHeight + 0.3, z: s.z });
  }

  resetAll() {
    for (const id of this.players.keys()) this.respawn(id);
    for (const p of this.props) {
      for (const r of this.players.values()) r.releaseIfAttachedTo(p.body.handle);
      p.body.setTranslation(p.spawn, true);
      p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  step(inputs: ReadonlyMap<number, PlayerInput>) {
    this.world.gravity = { x: 0, y: tuning.gravity, z: 0 };
    for (const [id, r] of this.players) r.step(inputs.get(id) ?? emptyInput(), DT);
    this.world.step();
    this.tick++;

    // Falling out of the world. (Phase 4 turns this into elimination.)
    for (const [id, r] of this.players) if (r.pelvis.translation().y < tuning.killY) this.respawn(id);
    for (const p of this.props) {
      if (p.body.translation().y < tuning.killY) {
        for (const r of this.players.values()) r.releaseIfAttachedTo(p.body.handle);
        p.body.setTranslation(p.spawn, true);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
  }

  /**
   * Cast a ray and knock back whatever it hits. This is the core of every gun:
   * Phase 3 weapons are this plus ammo, spread, and cooldowns.
   */
  shoveRay(origin: V3, dir: V3, impulse: number, maxDist = 60, ignorePlayer?: number): V3 | null {
    const ignore = ignorePlayer !== undefined ? this.players.get(ignorePlayer) : undefined;
    const ray = new this.R.Ray(origin, dir);
    const hit = this.world.castRay(ray, maxDist, true, undefined, undefined, undefined, undefined,
      (c) => !(ignore && ignore.ownsCollider(c)));
    if (!hit) return null;
    const point = ray.pointAt(hit.timeOfImpact);
    const body = hit.collider.parent();
    if (!body || !body.isDynamic()) return point;
    const imp = { x: dir.x * impulse, y: dir.y * impulse + impulse * 0.25, z: dir.z * impulse };
    const owner = [...this.players.values()].find((r) => r.ownsCollider(hit.collider));
    if (owner) {
      // Scale to the whole character's mass so the same number feels the same on every body part.
      const s = owner.totalMass / 10;
      owner.hit(body, { x: imp.x * s, y: imp.y * s, z: imp.z * s }, point, impulse);
    } else {
      const s = body.mass() / 10;
      body.applyImpulseAtPoint({ x: imp.x * s, y: imp.y * s, z: imp.z * s }, point, true);
    }
    return point;
  }

  /** Writes position (3) + rotation quaternion (4) per entity. This is also the network snapshot layout. */
  writeTransforms(out: Float32Array) {
    for (let i = 0; i < this.entityBodies.length; i++) {
      const b = this.entityBodies[i];
      const t = b.translation();
      const r = b.rotation();
      const o = i * 7;
      out[o] = t.x; out[o + 1] = t.y; out[o + 2] = t.z;
      out[o + 3] = r.x; out[o + 4] = r.y; out[o + 5] = r.z; out[o + 6] = r.w;
    }
  }

  private addEntity(body: RAPIER_NS.RigidBody, shape: ShapeDesc, color: number, role: EntityDesc['role'], playerId?: number) {
    this.entities.push({ id: body.handle, shape, color, role, playerId });
    this.entityBodies.push(body);
    this.entityVersion++;
  }

  private addStatic(pos: V3, half: V3, color: number, rotY = 0, rotX = 0) {
    const q = eulerYX(rotY, rotX);
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z).setRotation(q));
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.9).setCollisionGroups(groups(WORLD_GROUP, 0xffff)),
      body,
    );
    this.addEntity(body, { kind: 'box', hx: half.x, hy: half.y, hz: half.z }, color, 'static');
  }

  private addCrate(pos: V3, size: number, color: number) {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z));
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(size, size, size).setDensity(60).setFriction(0.8).setCollisionGroups(groups(WORLD_GROUP, 0xffff)),
      body,
    );
    this.props.push({ body, spawn: { ...pos } });
    this.addEntity(body, { kind: 'box', hx: size, hy: size, hz: size }, color, 'prop');
  }

  /** "Cafeteria": a floating floor over a bottomless pit, with lunch tables to climb and crates to throw. */
  private buildArena() {
    // Floor (top surface at y = 0).
    this.addStatic({ x: 0, y: -0.5, z: 0 }, { x: 9, y: 0.5, z: 9 }, 0xe8e2d4);
    // Checker accent strips so motion reads well.
    this.addStatic({ x: 0, y: 0.01, z: 0 }, { x: 9, y: 0.02, z: 0.6 }, 0xd46a4c);
    // Lunch tables.
    this.addStatic({ x: -4.5, y: 0.75, z: -3 }, { x: 2, y: 0.08, z: 0.7 }, 0x8a5a3b);
    this.addStatic({ x: -4.5, y: 0.35, z: -3 }, { x: 0.15, y: 0.35, z: 0.5 }, 0x5b3a26);
    this.addStatic({ x: 4.5, y: 0.75, z: 3 }, { x: 2, y: 0.08, z: 0.7 }, 0x8a5a3b);
    this.addStatic({ x: 4.5, y: 0.35, z: 3 }, { x: 0.15, y: 0.35, z: 0.5 }, 0x5b3a26);
    // Raised stage with a ramp.
    this.addStatic({ x: 0, y: 0.5, z: -7 }, { x: 4, y: 0.5, z: 2 }, 0x6c8ebf);
    this.addStatic({ x: 0, y: 0.45, z: -3.9 }, { x: 2, y: 0.08, z: 1.3 }, 0x8fb0de, 0, 0.42);
    // Crates.
    this.addCrate({ x: 2, y: 0.5, z: -1 }, 0.35, 0xc9a26b);
    this.addCrate({ x: -2, y: 0.5, z: 2 }, 0.35, 0xc9a26b);
    this.addCrate({ x: 1, y: 1.6, z: -7 }, 0.45, 0xb98d55);
    this.addCrate({ x: -6, y: 0.3, z: 5 }, 0.25, 0xd8b47c);

    this.spawns = [
      { x: 0, y: 0, z: 3 },
      { x: 0, y: 0, z: 0.5 },
      { x: -3, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
    ];
  }
}

function eulerYX(y: number, x: number) {
  // q = qy * qx
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
  return { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx };
}
