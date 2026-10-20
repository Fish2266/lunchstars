// The game simulation. Pure: no rendering, no DOM, no networking.
// It takes inputs, advances physics at a fixed timestep, and exposes state as plain data.
// The same code can run in single-player, on the multiplayer host, or on a Node server.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { emptyInput, type PlayerInput } from './input';
import { Ragdoll, worldToLocal } from './ragdoll';
import { tuning } from './tuning';
import { explosive, handling, PICKUP_RESPAWN, punch, WEAPON_KINDS, weapons, type WeaponKind } from './weapons';

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
  /** 'player' parts get the character look; 'static' never moves; 'fx' is non-physical (held guns, pickups). */
  role: 'static' | 'prop' | 'player' | 'fx';
  playerId?: number;
  /** Render a detailed model instead of the plain collision shape. */
  model?: ModelKind;
}

export type ModelKind = WeaponKind | 'grenadeLive' | 'head';

export type V3 = { x: number; y: number; z: number };
type Q = { x: number; y: number; z: number; w: number };

/** Things the client turns into effects (and, in multiplayer, reliable events). Drain with `drainEvents()`. */
export type SimEvent =
  | { type: 'shot'; player: number; weapon: WeaponKind; from: V3; to: V3; hit: boolean; first: boolean; dir: V3 }
  | { type: 'punch'; player: number; to: V3; hit: boolean }
  | { type: 'throw'; player: number; pos: V3 }
  | { type: 'explosion'; pos: V3; radius: number }
  /** A player got hit. `entity`/`local` pin the wound to a body part (for blood); `dir` is the shot direction. */
  | { type: 'hit'; player: number; by?: number; pos: V3; strength: number; entity: number; local: V3; dir: V3 }
  | { type: 'drop'; player: number; weapon: WeaponKind; thrown: boolean }
  | { type: 'pickup'; player: number; weapon: WeaponKind; pos: V3 }
  | { type: 'empty'; player: number };

/** Anything with a transform. Rapier bodies already fit; `Virtual` covers non-physical things. */
interface TransformSource {
  translation(): V3;
  rotation(): Q;
}

/** A transform the sim sets by hand (held guns, floating pickups). */
class Virtual implements TransformSource {
  pos = { x: 0, y: HIDDEN_Y, z: 0 };
  rot = { x: 0, y: 0, z: 0, w: 1 };
  translation() { return this.pos; }
  rotation() { return this.rot; }
  hide() { this.pos.y = HIDDEN_Y; }
}

/** Entities parked here are not drawn (renderer hides anything below -500). */
export const HIDDEN_Y = -1000;

// Collision groups: bit 0 = world, bits 1..15 = one per player (so a ragdoll never hits itself).
const WORLD_GROUP = 0x0001;
function groups(membership: number, filter: number) {
  return (membership << 16) | filter;
}
function playerBit(slot: number) {
  return 1 << (slot + 1);
}
function playerGroups(slot: number) {
  const bit = playerBit(slot);
  return groups(bit, 0xffff ^ bit);
}

export const PLAYER_COLORS = [0xff5a5f, 0x3fa7ff, 0xffc93c, 0x5fd068, 0xb57bff, 0xff8fd1];

interface Prop {
  body: RAPIER_NS.RigidBody;
  spawn: V3;
}

export interface Fighter {
  weapon: WeaponKind | null;
  ammo: number;
  cooldown: number;
  prevFire: boolean;
  prevDrop: boolean;
  /** Knockback taken this tick; enough of it knocks the gun loose. */
  hitAccum: number;
  /** Who last hit us this tick (so the dropped gun flies the right way). */
  hitDir: V3;
  punchTimer: number;
  slot: number;
  /** Held-weapon models, one per kind; only the current one is shown. */
  held: Record<WeaponKind, Virtual>;
}

interface PickupSpot {
  kind: WeaponKind;
  pos: V3;
  /** Seconds until it reappears; 0 = available. */
  respawn: number;
  model: Virtual;
}

interface Grenade {
  body: RAPIER_NS.RigidBody;
  collider: RAPIER_NS.Collider;
  active: boolean;
  fuse: number;
  owner: number;
}

const GRENADE_POOL = 12;
const LOOSE_PER_KIND = 4;

/** A gun lying around (or flying through the air) as a real physics object. */
interface LooseGun {
  kind: WeaponKind;
  body: RAPIER_NS.RigidBody;
  collider: RAPIER_NS.Collider;
  active: boolean;
  ammo: number;
  age: number;
  /** Player who threw it, and for how long it can still bonk people. */
  thrownBy: number;
  bonkTimer: number;
}

export class Sim {
  readonly world: RAPIER_NS.World;
  readonly players = new Map<number, Ragdoll>();
  readonly fighters = new Map<number, Fighter>();
  readonly entities: EntityDesc[] = [];
  /** Transform source for each entity, same order as `entities`. */
  private sources: TransformSource[] = [];
  private props: Prop[] = [];
  private spawns: V3[] = [];
  private pickups: PickupSpot[] = [];
  private grenades: Grenade[] = [];
  private loose: LooseGun[] = [];
  /** Entity index for each rigid body handle (for pinning blood to body parts). */
  private entityOfBody = new Map<number, number>();
  private events: SimEvent[] = [];
  private rngState = 0x1234567;
  /** Bumped whenever `entities` changes so the renderer knows to rebuild meshes. */
  entityVersion = 0;
  private nextVirtualId = -1;
  tick = 0;

  constructor(private readonly R: typeof RAPIER_NS) {
    this.world = new R.World({ x: 0, y: tuning.gravity, z: 0 });
    this.world.timestep = DT;
    this.world.numSolverIterations = 8;
    this.buildArena();
    this.buildGrenadePool();
    this.buildLoosePool();
  }

  addPlayer(id: number): Ragdoll {
    const slot = this.players.size;
    const spawn = this.spawns[slot % this.spawns.length];
    const color = PLAYER_COLORS[slot % PLAYER_COLORS.length];
    const r = new Ragdoll(this.R, this.world, id, color, { x: spawn.x, y: spawn.y + tuning.standHeight, z: spawn.z }, playerGroups(slot));
    this.players.set(id, r);
    for (const part of r.parts.values()) {
      const s = part.def.shape;
      this.addEntity(part.body, s, part.def.name === 'head' ? 0xffe0bd : color, 'player', id, part.def.name === 'head' ? 'head' : undefined);
    }
    const held = {} as Record<WeaponKind, Virtual>;
    for (const k of WEAPON_KINDS) {
      held[k] = new Virtual();
      this.addEntity(held[k], weapons[k].shape, weapons[k].color, 'fx', id, k);
    }
    this.fighters.set(id, {
      weapon: null, ammo: 0, cooldown: 0, prevFire: false, prevDrop: false, hitAccum: 0, hitDir: { x: 0, y: 0, z: 0 },
      punchTimer: 0, slot, held,
    });
    return r;
  }

  /** Give a weapon directly (debug / tests). */
  giveWeapon(id: number, kind: WeaponKind | null) {
    const f = this.fighters.get(id);
    if (!f) return;
    f.weapon = kind;
    f.ammo = kind ? weapons[kind].ammo : 0;
    f.cooldown = 0;
  }

  respawn(id: number) {
    const r = this.players.get(id);
    if (!r) return;
    const slot = this.fighters.get(id)!.slot;
    const s = this.spawns[slot % this.spawns.length];
    for (const other of this.players.values()) for (const b of r.bodyHandles) other.releaseIfAttachedTo(b);
    r.teleport({ x: s.x, y: s.y + tuning.standHeight + 0.3, z: s.z });
    this.giveWeapon(id, null);
  }

  resetAll() {
    for (const id of this.players.keys()) this.respawn(id);
    for (const p of this.props) this.resetProp(p);
    for (const p of this.pickups) p.respawn = 0;
    for (const g of this.grenades) this.deactivateGrenade(g);
    for (const g of this.loose) this.deactivateLoose(g);
  }

  step(inputs: ReadonlyMap<number, PlayerInput>) {
    this.world.gravity = { x: 0, y: tuning.gravity, z: 0 };
    for (const [id, r] of this.players) {
      const input = inputs.get(id) ?? emptyInput();
      const f = this.fighters.get(id)!;
      f.punchTimer = Math.max(0, f.punchTimer - DT);
      r.aimHands = f.weapon ? weapons[f.weapon].hands : f.punchTimer > 0 ? 1 : 0;
      r.step(input, DT);
      this.updateFighter(id, r, f, input);
      this.updateHandling(id, r, f, input);
    }
    this.world.step();
    this.tick++;

    this.updateGrenades();
    this.updateLoose();
    this.updatePickups();
    // Big hits knock the gun out of your hands.
    for (const [id, f] of this.fighters) {
      if (f.weapon && f.hitAccum >= handling.dropThreshold) {
        const d = f.hitDir;
        this.dropWeapon(id, { x: d.x * 4, y: 3, z: d.z * 4 }, false);
      }
      f.hitAccum = 0;
    }
    this.updateHeldModels(inputs);

    // Falling out of the world. (Phase 4 turns this into elimination.)
    for (const [id, r] of this.players) if (r.pelvis.translation().y < tuning.killY) this.respawn(id);
    for (const p of this.props) if (p.body.translation().y < tuning.killY) this.resetProp(p);
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---------------------------------------------------------------- weapons

  private updateFighter(id: number, r: Ragdoll, f: Fighter, input: PlayerInput) {
    f.cooldown = Math.max(0, f.cooldown - DT);
    const pressed = input.fire && !f.prevFire;
    f.prevFire = input.fire;
    if (!pressed || f.cooldown > 0 || r.stiffness < 0.35 || input.grab) return;

    const dir = aimDir(input.aimYaw, input.aimPitch);
    const origin = r.aimOrigin();

    if (!f.weapon) {
      // Unarmed: a quick shove.
      f.cooldown = punch.cooldown;
      f.punchTimer = 0.25;
      const res = this.hitscan(id, origin, dir, punch.range + 0.3, punch.knockback, 1, punch.lift);
      this.events.push({ type: 'punch', player: id, to: res.point, hit: res.hit });
      return;
    }

    const w = weapons[f.weapon];
    f.cooldown = w.cooldown;
    f.ammo--;
    if (f.weapon === 'grenade') {
      this.throwGrenade(id, r, f, dir);
    } else {
      const muzzle = this.muzzle(r, f.weapon, dir);
      for (let i = 0; i < w.pellets; i++) {
        const d = this.spreadDir(dir, w.spread);
        const res = this.hitscan(id, origin, d, w.range, w.knockback, w.falloff, w.lift);
        this.events.push({ type: 'shot', player: id, weapon: f.weapon, from: muzzle, to: res.point, hit: res.hit, first: i === 0, dir: d });
      }
      if (w.recoil > 0) {
        const s = (r.totalMass / 10) * w.recoil;
        r.chest.applyImpulse({ x: -dir.x * s, y: -dir.y * s * 0.3, z: -dir.z * s }, true);
      }
      // Kick the gun arm(s) up and back.
      const arms = w.hands === 2 ? ['forearmR', 'forearmL'] as const : ['forearmR'] as const;
      for (const a of arms) {
        const b = r.parts.get(a)!.body;
        const s = b.mass() * w.armKick;
        b.applyImpulse({ x: -dir.x * s * 0.5, y: s, z: -dir.z * s * 0.5 }, true);
      }
    }
    if (f.ammo <= 0) {
      this.events.push({ type: 'empty', player: id });
      // Toss the empty gun aside (it can't be picked up, and vanishes soon).
      if (f.weapon !== 'grenade') this.dropWeapon(id, { x: -dir.z * 2, y: 2.5, z: dir.x * 2 }, false);
      else f.weapon = null;
    }
  }

  /**
   * Cast a ray and knock back whatever it hits. Every gun (and the debug shove) goes through here.
   * `falloff` is the knockback multiplier at max range.
   */
  hitscan(shooter: number | undefined, origin: V3, dir: V3, range: number, knockback: number, falloff: number, lift = 0.25) {
    const ignore = shooter !== undefined ? this.players.get(shooter) : undefined;
    const ray = new this.R.Ray(origin, dir);
    const hit = this.world.castRay(ray, range, true, undefined, undefined, undefined, undefined,
      (c) => !(ignore && ignore.ownsCollider(c)) && !this.isGrenadeCollider(c));
    if (!hit) {
      return { hit: false, point: { x: origin.x + dir.x * range, y: origin.y + dir.y * range, z: origin.z + dir.z * range } };
    }
    const point = ray.pointAt(hit.timeOfImpact);
    const body = hit.collider.parent();
    if (!body || !body.isDynamic()) return { hit: false, point };
    const strength = knockback * (1 + (falloff - 1) * (hit.timeOfImpact / range));
    const imp = { x: dir.x * strength, y: dir.y * strength + strength * lift, z: dir.z * strength };
    const owner = [...this.players.values()].find((r) => r.ownsCollider(hit.collider));
    if (owner) {
      // Scale to the whole character's mass so the same number feels the same on every body part.
      const s = owner.totalMass / 10;
      owner.hit(body, { x: imp.x * s, y: imp.y * s, z: imp.z * s }, point, strength);
      this.noteHit(owner.playerId, strength, dir);
      this.events.push({
        type: 'hit', player: owner.playerId, by: shooter, pos: point, strength,
        entity: this.entityOfBody.get(body.handle) ?? -1, local: worldToLocal(body, point), dir,
      });
    } else {
      const s = body.mass() / 10;
      body.applyImpulseAtPoint({ x: imp.x * s, y: imp.y * s, z: imp.z * s }, point, true);
    }
    return { hit: true, point };
  }

  /** Back-compat debug helper: knock back along a ray with no shooter. */
  shoveRay(origin: V3, dir: V3, impulse: number, maxDist = 60, ignorePlayer?: number): V3 | null {
    const res = this.hitscan(ignorePlayer, origin, dir, maxDist, impulse, 1);
    return res.hit ? res.point : null;
  }

  private throwGrenade(id: number, r: Ragdoll, f: Fighter, dir: V3) {
    const g = this.grenades.find((x) => !x.active);
    if (!g) return;
    // Launch from in front of the aim origin so it travels along the crosshair line, not off to the right hand's side.
    const o = r.aimOrigin();
    const hand = { x: o.x + dir.x * 0.45, y: o.y - 0.1, z: o.z + dir.z * 0.45 };
    const pv = r.chest.linvel();
    g.active = true;
    g.fuse = explosive.fuse;
    g.owner = id;
    // Don't collide with the thrower, or it bonks off their own hand.
    g.collider.setCollisionGroups(groups(WORLD_GROUP, 0xffff ^ playerBit(f.slot)));
    g.body.setEnabled(true);
    g.body.setTranslation(hand, true);
    g.body.setLinvel({
      x: pv.x + dir.x * explosive.throwSpeed,
      y: pv.y * 0.5 + dir.y * explosive.throwSpeed + explosive.throwLift,
      z: pv.z + dir.z * explosive.throwSpeed,
    }, true);
    g.body.setAngvel({ x: 8 * this.rand() - 4, y: 8 * this.rand() - 4, z: 8 * this.rand() - 4 }, true);
    this.events.push({ type: 'throw', player: id, pos: hand });
  }

  private updateGrenades() {
    for (const g of this.grenades) {
      if (!g.active) continue;
      g.fuse -= DT;
      const p = g.body.translation();
      if (g.fuse <= 0) {
        this.explode({ x: p.x, y: p.y, z: p.z });
        this.deactivateGrenade(g);
      } else if (p.y < tuning.killY) {
        this.deactivateGrenade(g);
      }
    }
  }

  explode(c: V3) {
    const R = explosive.radius;
    const push = (body: RAPIER_NS.RigidBody, mass: number): number => {
      const p = body.translation();
      let dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
      const d = Math.hypot(dx, dy, dz);
      if (d >= R) return 0;
      const f = 1 - d / R;
      if (d > 1e-4) { dx /= d; dy /= d; dz /= d; } else { dx = 0; dy = 1; dz = 0; }
      dy += explosive.upBias;
      const s = explosive.strength * f * mass;
      body.applyImpulse({ x: dx * s, y: dy * s, z: dz * s }, true);
      return f;
    };
    for (const r of this.players.values()) {
      let maxF = 0;
      for (const part of r.parts.values()) maxF = Math.max(maxF, push(part.body, part.body.mass()));
      if (maxF > 0) {
        r.addStun(explosive.stun * maxF);
        const cp = r.chest.translation();
        const away = norm({ x: cp.x - c.x, y: cp.y - c.y + 0.5, z: cp.z - c.z });
        this.noteHit(r.playerId, explosive.strength * maxF * 5, away);
        // Blood out of the side facing the blast.
        this.events.push({
          type: 'hit', player: r.playerId, pos: cp, strength: explosive.strength * maxF * 2,
          entity: this.entityOfBody.get(r.chest.handle) ?? -1, local: worldToLocal(r.chest, { x: cp.x - away.x * 0.15, y: cp.y, z: cp.z - away.z * 0.15 }),
          dir: away,
        });
      }
    }
    for (const p of this.props) push(p.body, p.body.mass());
    for (const g of this.loose) if (g.active) push(g.body, g.body.mass());
    this.events.push({ type: 'explosion', pos: c, radius: R });
  }

  private noteHit(id: number, strength: number, dir: V3) {
    const f = this.fighters.get(id);
    if (!f) return;
    f.hitAccum += strength;
    f.hitDir = dir;
  }

  // ---------------------------------------------------------------- loose guns

  /** Throw button, and picking guns up with a grab. */
  private updateHandling(id: number, r: Ragdoll, f: Fighter, input: PlayerInput) {
    const pressedDrop = input.drop && !f.prevDrop;
    f.prevDrop = input.drop;
    if (pressedDrop && f.weapon && r.stiffness > 0.35) {
      const d = aimDir(input.aimYaw, input.aimPitch);
      const s = handling.throwSpeed;
      this.dropWeapon(id, { x: d.x * s, y: d.y * s + 2.5, z: d.z * s }, true);
      return;
    }
    // Grabbing a gun (floating or loose) picks it up, swapping out whatever you hold.
    if (!input.grab || r.stiffness < 0.35) return;
    const hands = r.handPositions();
    const near = (p: V3) => hands.some((h) => Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z) < handling.grabReach);
    for (const g of this.loose) {
      if (!g.active || g.ammo <= 0 || g.age < handling.pickupDelay || !near(g.body.translation())) continue;
      if (f.weapon) this.dropWeapon(id, { x: 0, y: 2, z: 0 }, false);
      this.takeLoose(id, f, g);
      return;
    }
    for (const p of this.pickups) {
      if (p.respawn > 0 || !near(p.model.pos)) continue;
      if (f.weapon) this.dropWeapon(id, { x: 0, y: 2, z: 0 }, false);
      this.takeSpawner(id, p);
      return;
    }
  }

  /** Turn the held weapon into a loose physics gun. `vel` is added to the hand's velocity. */
  dropWeapon(id: number, vel: V3, thrown: boolean) {
    const f = this.fighters.get(id);
    const r = this.players.get(id);
    if (!f || !r || !f.weapon) return;
    const kind = f.weapon;
    f.weapon = null;
    this.events.push({ type: 'drop', player: id, weapon: kind, thrown });
    if (kind === 'grenade' && f.ammo <= 0) return;
    const g = this.loose.find((x) => x.kind === kind && !x.active) ?? this.oldestLoose(kind);
    if (!g) return;
    const held = f.held[kind];
    const hv = r.parts.get('forearmR')!.body.linvel();
    for (const p of this.players.values()) p.releaseIfAttachedTo(g.body.handle);
    g.active = true;
    g.ammo = f.ammo;
    g.age = 0;
    g.thrownBy = id;
    g.bonkTimer = thrown ? 1.2 : 0;
    // Don't collide with the thrower for a moment, so it leaves the hand cleanly.
    g.collider.setCollisionGroups(groups(WORLD_GROUP, 0xffff ^ playerBit(f.slot)));
    g.body.setEnabled(true);
    g.body.setTranslation(held.pos.y > -500 ? held.pos : r.rightHand(), true);
    g.body.setRotation(held.rot, true);
    g.body.setLinvel({ x: hv.x * 0.5 + vel.x, y: hv.y * 0.5 + vel.y, z: hv.z * 0.5 + vel.z }, true);
    g.body.setAngvel({ x: (this.rand() - 0.5) * 14, y: (this.rand() - 0.5) * 14, z: (this.rand() - 0.5) * 14 }, true);
    f.ammo = 0;
  }

  private oldestLoose(kind: WeaponKind) {
    let best: LooseGun | undefined;
    for (const g of this.loose) if (g.kind === kind && (!best || g.age > best.age)) best = g;
    return best;
  }

  private takeLoose(id: number, f: Fighter, g: LooseGun) {
    f.weapon = g.kind;
    f.ammo = g.ammo;
    f.cooldown = 0.15;
    this.events.push({ type: 'pickup', player: id, weapon: g.kind, pos: { ...g.body.translation() } });
    this.deactivateLoose(g);
  }

  private takeSpawner(id: number, p: PickupSpot) {
    this.giveWeapon(id, p.kind);
    p.respawn = PICKUP_RESPAWN;
    p.model.hide();
    this.events.push({ type: 'pickup', player: id, weapon: p.kind, pos: p.pos });
  }

  private updateLoose() {
    for (const g of this.loose) {
      if (!g.active) continue;
      g.age += DT;
      const p = g.body.translation();
      if (p.y < tuning.killY || g.age > (g.ammo > 0 ? handling.despawn : 3)) { this.deactivateLoose(g); continue; }
      if (g.age > 0.3 && g.bonkTimer > 0) g.collider.setCollisionGroups(groups(WORLD_GROUP, 0xffff));
      // Thrown guns bonk whoever they hit.
      if (g.bonkTimer > 0) {
        g.bonkTimer -= DT;
        const v = g.body.linvel();
        const speed = Math.hypot(v.x, v.y, v.z);
        if (speed > handling.bonkSpeed) {
          let victim: Ragdoll | undefined;
          let part: RAPIER_NS.RigidBody | null = null;
          this.world.intersectionsWithShape(p, { x: 0, y: 0, z: 0, w: 1 }, new this.R.Ball(0.22), (c) => {
            const owner = [...this.players.values()].find((r) => r.ownsCollider(c));
            if (owner && owner.playerId !== g.thrownBy) { victim = owner; part = c.parent(); return false; }
            return true;
          });
          if (victim && part) {
            const vr = victim as Ragdoll;
            const d = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
            const kb = handling.throwKnockback;
            const s = vr.totalMass / 10;
            vr.hit(part, { x: d.x * kb * s, y: (d.y + 0.3) * kb * s, z: d.z * kb * s }, p, kb);
            this.noteHit(vr.playerId, kb, d);
            this.events.push({
              type: 'hit', player: vr.playerId, by: g.thrownBy, pos: { ...p }, strength: kb,
              entity: this.entityOfBody.get((part as RAPIER_NS.RigidBody).handle) ?? -1,
              local: worldToLocal(part, p), dir: d,
            });
            g.bonkTimer = 0;
            // Drop at the victim's feet rather than bouncing back to the thrower.
            g.body.setLinvel({ x: v.x * 0.15, y: 1.5, z: v.z * 0.15 }, true);
          }
        }
      }
      // Walk over a loaded gun while unarmed to pick it up.
      if (g.ammo <= 0 || g.age < handling.pickupDelay) continue;
      for (const [id, r] of this.players) {
        const f = this.fighters.get(id)!;
        if (f.weapon || r.stiffness < 0.35) continue;
        // You can't catch your own throw by walking into it straight away.
        if (id === g.thrownBy && g.age < 1.5) continue;
        const c = r.pelvis.translation();
        if (Math.hypot(c.x - p.x, c.z - p.z) < 0.7 && p.y < c.y && c.y - p.y < 1.3) {
          this.takeLoose(id, f, g);
          break;
        }
      }
    }
  }

  private deactivateLoose(g: LooseGun) {
    for (const r of this.players.values()) r.releaseIfAttachedTo(g.body.handle);
    g.active = false;
    g.bonkTimer = 0;
    g.body.setEnabled(false);
    g.body.setTranslation({ x: 0, y: HIDDEN_Y, z: 0 }, false);
    g.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  }

  private buildLoosePool() {
    for (const kind of WEAPON_KINDS) {
      const s = weapons[kind].shape;
      for (let i = 0; i < LOOSE_PER_KIND; i++) {
        const body = this.world.createRigidBody(
          this.R.RigidBodyDesc.dynamic().setTranslation(0, HIDDEN_Y, 0).setEnabled(false).setCcdEnabled(true)
            .setAngularDamping(0.8).setLinearDamping(0.1),
        );
        const desc = s.kind === 'box' ? this.R.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
          : s.kind === 'ball' ? this.R.ColliderDesc.ball(s.r) : this.R.ColliderDesc.capsule(s.hh, s.r);
        const collider = this.world.createCollider(desc.setDensity(900).setFriction(0.7).setRestitution(0.2), body);
        this.loose.push({ kind, body, collider, active: false, ammo: 0, age: 0, thrownBy: -1, bonkTimer: 0 });
        this.addEntity(body, s, weapons[kind].color, 'prop', undefined, kind);
      }
    }
  }

  /** Where guns can be had right now (for bots). */
  availableWeapons(): { kind: WeaponKind; pos: V3 }[] {
    const out: { kind: WeaponKind; pos: V3 }[] = [];
    for (const p of this.pickups) if (p.respawn === 0) out.push({ kind: p.kind, pos: p.pos });
    for (const g of this.loose) if (g.active && g.ammo > 0 && g.age > handling.pickupDelay) out.push({ kind: g.kind, pos: { ...g.body.translation() } });
    return out;
  }

  private muzzle(r: Ragdoll, kind: WeaponKind, dir: V3): V3 {
    const h = r.rightHand();
    const s = weapons[kind].shape;
    const len = s.kind === 'box' ? s.hz * 2 : 0;
    return { x: h.x + dir.x * len, y: h.y + dir.y * len, z: h.z + dir.z * len };
  }

  private spreadDir(dir: V3, spread: number): V3 {
    if (spread <= 0) return dir;
    // Random direction inside a cone around `dir`.
    const up = Math.abs(dir.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const ax = norm(cross(dir, up));
    const ay = cross(ax, dir);
    const a = this.rand() * Math.PI * 2;
    const m = Math.sqrt(this.rand()) * Math.tan(spread);
    return norm({
      x: dir.x + (ax.x * Math.cos(a) + ay.x * Math.sin(a)) * m,
      y: dir.y + (ax.y * Math.cos(a) + ay.y * Math.sin(a)) * m,
      z: dir.z + (ax.z * Math.cos(a) + ay.z * Math.sin(a)) * m,
    });
  }

  /** Deterministic PRNG (mulberry32) so the same inputs give the same sim on any machine. */
  private rand() {
    let t = (this.rngState = (this.rngState + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------- pickups & held models

  private updatePickups() {
    const spin = this.tick * DT * 2;
    for (const p of this.pickups) {
      if (p.respawn > 0) {
        p.respawn = Math.max(0, p.respawn - DT);
        p.model.hide();
        continue;
      }
      p.model.pos = { x: p.pos.x, y: p.pos.y + 0.55 + Math.sin(spin * 1.5) * 0.08, z: p.pos.z };
      p.model.rot = eulerYX(spin, 0);
      for (const [id, r] of this.players) {
        const f = this.fighters.get(id)!;
        if (f.weapon || r.stiffness < 0.35) continue;
        const c = r.pelvis.translation();
        if (Math.hypot(c.x - p.pos.x, c.z - p.pos.z) < 0.9 && Math.abs(c.y - tuning.standHeight - p.pos.y) < 1.2) {
          this.takeSpawner(id, p);
          break;
        }
      }
    }
  }

  private updateHeldModels(inputs: ReadonlyMap<number, PlayerInput>) {
    for (const [id, r] of this.players) {
      const f = this.fighters.get(id)!;
      const input = inputs.get(id) ?? emptyInput();
      for (const k of WEAPON_KINDS) {
        const v = f.held[k];
        if (f.weapon !== k) { v.hide(); continue; }
        const h = r.rightHand();
        // Held guns follow the hand but point down the aim line, which reads better than following the forearm.
        const yaw = r.yaw, pitch = input.grab ? -0.6 : input.aimPitch;
        const d = aimDir(yaw, pitch);
        const s = weapons[k].shape;
        const half = s.kind === 'box' ? s.hz - 0.03 : 0;
        v.pos = { x: h.x + d.x * half, y: h.y + d.y * half, z: h.z + d.z * half };
        v.rot = eulerYX(yaw, -pitch);
      }
    }
  }

  // ---------------------------------------------------------------- snapshot

  /** Writes position (3) + rotation quaternion (4) per entity. This is also the network snapshot layout. */
  writeTransforms(out: Float32Array) {
    for (let i = 0; i < this.sources.length; i++) {
      const b = this.sources[i];
      const t = b.translation();
      const r = b.rotation();
      const o = i * 7;
      out[o] = t.x; out[o + 1] = t.y; out[o + 2] = t.z;
      out[o + 3] = r.x; out[o + 4] = r.y; out[o + 5] = r.z; out[o + 6] = r.w;
    }
  }

  // ---------------------------------------------------------------- world building

  private addEntity(source: TransformSource, shape: ShapeDesc, color: number, role: EntityDesc['role'], playerId?: number, model?: ModelKind) {
    const id = source instanceof Virtual ? this.nextVirtualId-- : (source as RAPIER_NS.RigidBody).handle;
    if (!(source instanceof Virtual)) this.entityOfBody.set(id, this.entities.length);
    this.entities.push({ id, shape, color, role, playerId, model });
    this.sources.push(source);
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

  private addPickup(kind: WeaponKind, pos: V3) {
    const model = new Virtual();
    this.pickups.push({ kind, pos, respawn: 0, model });
    this.addEntity(model, weapons[kind].shape, weapons[kind].color, 'fx', undefined, kind);
  }

  private resetProp(p: Prop) {
    for (const r of this.players.values()) r.releaseIfAttachedTo(p.body.handle);
    p.body.setTranslation(p.spawn, true);
    p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private buildGrenadePool() {
    for (let i = 0; i < GRENADE_POOL; i++) {
      const body = this.world.createRigidBody(
        this.R.RigidBodyDesc.dynamic().setTranslation(0, HIDDEN_Y, i).setEnabled(false).setCcdEnabled(true).setAngularDamping(4).setLinearDamping(0.6),
      );
      const collider = this.world.createCollider(
        this.R.ColliderDesc.ball(0.1).setDensity(400).setRestitution(0.35).setFriction(0.8), body,
      );
      this.grenades.push({ body, collider, active: false, fuse: 0, owner: -1 });
      this.addEntity(body, { kind: 'ball', r: 0.1 }, weapons.grenade.color, 'prop', undefined, 'grenadeLive');
    }
  }

  private deactivateGrenade(g: Grenade) {
    g.active = false;
    g.body.setEnabled(false);
    g.body.setTranslation({ x: 0, y: HIDDEN_Y, z: 0 }, false);
    g.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  }

  private isGrenadeCollider(c: RAPIER_NS.Collider) {
    return this.grenades.some((g) => g.collider.handle === c.handle);
  }

  /** "Cafeteria": a floating floor over a bottomless pit, with lunch tables to climb and crates to throw. */
  private buildArena() {
    // Floor (top surface at y = 0).
    this.addStatic({ x: 0, y: -0.5, z: 0 }, { x: 9, y: 0.5, z: 9 }, 0xe8e2d4);
    // Accent strip so motion reads well.
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
    this.addCrate({ x: -6, y: 0.3, z: 6.5 }, 0.25, 0xd8b47c);

    // Weapon pickups (floor-level positions; the model floats above).
    this.addPickup('pistol', { x: 5.5, y: 0, z: -4 });
    this.addPickup('pistol', { x: -5.5, y: 0, z: 4.5 });
    this.addPickup('shotgun', { x: 4.5, y: 0, z: 6.5 });
    this.addPickup('grenade', { x: -2.5, y: 1, z: -7 });

    this.spawns = [
      { x: 0, y: 0, z: 3 },
      { x: 0, y: 0, z: 0.5 },
      { x: -3, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
    ];
  }
}

export function aimDir(yaw: number, pitch: number): V3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}

function eulerYX(y: number, x: number): Q {
  // q = qy * qx
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
  return { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx };
}

function cross(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function norm(a: V3): V3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
