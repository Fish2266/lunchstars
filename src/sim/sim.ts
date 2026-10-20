// The game simulation. Pure: no rendering, no DOM, no networking.
// It takes inputs, advances physics at a fixed timestep, and exposes state as plain data.
// The same code can run in single-player, on the multiplayer host, or on a Node server.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { emptyInput, type PlayerInput } from './input';
import { Ragdoll, worldToLocal, type ArmMode } from './ragdoll';
import { tuning } from './tuning';
import { explosive, handling, PICKUP_RESPAWN, punch, WEAPON_KINDS, weapons, type WeaponKind } from './weapons';
import { beltAt, buildIncinerator, inBox, INCINERATOR, type ArenaBuilder } from './incinerator';

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
  /** Glow strength for static level pieces (furnace fire). */
  emissive?: number;
  /** For conveyor belts: surface velocity, so the renderer can scroll the belt the right way. */
  flow?: { x: number; z: number };
}

export type ModelKind = WeaponKind | 'grenadeLive' | 'head' | 'torso' | 'hips' | 'limb' | 'forearm' | 'shin' | 'belt' | 'rail';

export type V3 = { x: number; y: number; z: number };
export type HitCause = 'punch' | 'shot' | 'pellet' | 'blast' | 'bonk' | 'shove' | 'flame';
export type FurnaceState = 'idle' | 'warn' | 'burst';
export type MatchPhase = 'practice' | 'countdown' | 'playing' | 'roundOver' | 'matchOver';
type Q = { x: number; y: number; z: number; w: number };

/** Things the client turns into effects (and, in multiplayer, reliable events). Drain with `drainEvents()`. */
export type SimEvent =
  | { type: 'shot'; player: number; weapon: WeaponKind; from: V3; to: V3; hit: boolean; first: boolean; dir: V3 }
  | { type: 'punch'; player: number; to: V3; hit: boolean }
  | { type: 'throw'; player: number; pos: V3 }
  | { type: 'explosion'; pos: V3; radius: number }
  /** A player got hit. `entity`/`local` pin the wound to a body part (for blood); `dir` is the shot direction. */
  | { type: 'hit'; player: number; by?: number; cause: HitCause; pos: V3; strength: number; entity: number; local: V3; dir: V3 }
  | { type: 'ko'; player: number; seconds: number }
  | { type: 'wake'; player: number }
  /** `entity` is the loose gun's entity; `empty` guns smoke until they vanish. */
  | { type: 'drop'; player: number; weapon: WeaponKind; thrown: boolean; entity: number; empty: boolean }
  | { type: 'eliminated'; player: number; cause: 'fall' | 'fire'; pos: V3 }
  | { type: 'burn'; pos: V3 }
  | { type: 'railBreak'; pos: V3 }
  | { type: 'gunSpawn'; weapon: WeaponKind; pos: V3 }
  | { type: 'furnace'; state: FurnaceState }
  | { type: 'countdown'; round: number }
  | { type: 'roundStart'; round: number }
  | { type: 'roundOver'; round: number; winner: number | null }
  | { type: 'matchOver'; winner: number }
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

/** One hand. Index 0 = left (Q), 1 = right (E). */
export interface HandSlot {
  /** What this hand is holding. Items stay only while the hand's key is held. */
  item: WeaponKind | null;
  ammo: number;
  prevKey: boolean;
  punchTimer: number;
  punchCooldown: number;
  /** Held-item models for this hand, one per kind; only the current one is shown. */
  held: Record<WeaponKind, Virtual>;
}

export interface Fighter {
  hands: [HandSlot, HandSlot];
  /** Which hand's item the mouse uses. */
  active: 0 | 1;
  cooldown: number;
  prevFire: boolean;
  prevCycle: boolean;
  /** Knockback taken this tick; enough of it knocks items loose. */
  hitAccum: number;
  /** Direction of the last hit this tick (so dropped items fly the right way). */
  hitDir: V3;
  slot: number;
  /** Knockout meter 0..koThreshold, seconds since last hit, and the knockout itself. */
  ko: number;
  sinceHit: number;
  koTimer: number;
  koCount: number;
  /** Hits taken this life, for the debug HUD. */
  hitsTaken: number;
  mashPrev: boolean;
}

/** Knockouts get easier each time you've been knocked out this life. */
export function koThreshold(f: Fighter) {
  const t = tuning;
  return t.koThreshold * Math.max(t.koMinThreshold, Math.pow(t.koRepeatEase, f.koCount));
}

/** The hand whose item the mouse would use, or null if both hands are empty. */
export function activeHand(f: Fighter): 0 | 1 | null {
  if (f.hands[f.active].item) return f.active;
  const other = (1 - f.active) as 0 | 1;
  return f.hands[other].item ? other : null;
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
  /** Crates that come out onto the conveyor and ride into the furnace. */
  private beltCrates: { body: RAPIER_NS.RigidBody; active: boolean }[] = [];
  private beltTimer = 2;
  private gunTimer = 1.5;
  /** Breakable pit railing sections. */
  private rails: { body: RAPIER_NS.RigidBody; collider: RAPIER_NS.Collider; broken: boolean; hp: number; pos: V3 }[] = [];
  readonly furnace = { state: 'idle' as FurnaceState, timer: 8, hit: new Set<number>() };
  /** Rounds: last one standing wins, first to `winsToWin` wins the match. 'practice' = respawn, no rounds. */
  readonly match = {
    phase: 'practice' as MatchPhase,
    timer: 0,
    round: 0,
    winsToWin: 3,
    wins: new Map<number, number>(),
    alive: new Set<number>(),
    roundWinner: null as number | null,
    matchWinner: null as number | null,
  };
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
    this.buildBeltCrates();
  }

  addPlayer(id: number): Ragdoll {
    const slot = this.players.size;
    const spawn = this.spawns[slot % this.spawns.length];
    const color = PLAYER_COLORS[slot % PLAYER_COLORS.length];
    const r = new Ragdoll(this.R, this.world, id, color, { x: spawn.x, y: spawn.y + tuning.standHeight, z: spawn.z }, playerGroups(slot));
    this.players.set(id, r);
    // Display models are soft "gummy" shapes; physics uses the plain boxes and capsules.
    const looks: Record<string, ModelKind> = {
      head: 'head', chest: 'torso', pelvis: 'hips', thighL: 'limb', thighR: 'limb', upperArmL: 'limb', upperArmR: 'limb',
      forearmL: 'forearm', forearmR: 'forearm', shinL: 'shin', shinR: 'shin',
    };
    for (const part of r.parts.values()) {
      this.addEntity(part.body, part.def.shape, color, 'player', id, looks[part.def.name]);
    }
    const makeHand = (): HandSlot => {
      const held = {} as Record<WeaponKind, Virtual>;
      for (const k of WEAPON_KINDS) {
        held[k] = new Virtual();
        this.addEntity(held[k], weapons[k].shape, weapons[k].color, 'fx', id, k);
      }
      return { item: null, ammo: 0, prevKey: false, punchTimer: 0, punchCooldown: 0, held };
    };
    this.fighters.set(id, {
      hands: [makeHand(), makeHand()], active: 1, cooldown: 0, prevFire: false, prevCycle: false,
      hitAccum: 0, hitDir: { x: 0, y: 0, z: 0 }, slot,
      ko: 0, sinceHit: 99, koTimer: 0, koCount: 0, hitsTaken: 0, mashPrev: false,
    });
    // Standing on the conveyor carries your planted feet along.
    r.surfaceVelocity = (p) => beltAt(p)?.vel ?? null;
    if (this.match.phase !== 'practice') this.match.alive.add(id);
    // Reaching hands pick guns up instead of latching onto them.
    r.ignoreGrab = (c) => this.loose.some((g) => g.active && g.collider.handle === c.handle);
    return r;
  }

  /** Put an item straight into a hand (debug / tests). It still drops as soon as that hand's key is up. */
  giveWeapon(id: number, kind: WeaponKind | null, hand: 0 | 1 = 1) {
    const f = this.fighters.get(id);
    if (!f) return;
    const h = f.hands[hand];
    h.item = kind;
    h.ammo = kind ? weapons[kind].ammo : 0;
    f.cooldown = 0;
    if (kind && !f.hands[1 - hand].item) f.active = hand;
  }

  respawn(id: number) {
    const r = this.players.get(id);
    if (!r) return;
    const slot = this.fighters.get(id)!.slot;
    const s = this.spawns[slot % this.spawns.length];
    for (const other of this.players.values()) for (const b of r.bodyHandles) other.releaseIfAttachedTo(b);
    r.teleport({ x: s.x, y: s.y + tuning.standHeight + 0.3, z: s.z }, Math.atan2(-s.x, -s.z));
    this.giveWeapon(id, null, 0);
    this.giveWeapon(id, null, 1);
    const f = this.fighters.get(id)!;
    f.ko = 0; f.koTimer = 0; f.koCount = 0; f.hitsTaken = 0; f.sinceHit = 99;
    r.knockedOut = false;
  }

  resetAll() {
    for (const id of this.players.keys()) this.respawn(id);
    for (const p of this.props) this.resetProp(p);
    for (const p of this.pickups) p.respawn = 0;
    for (const g of this.grenades) this.deactivateGrenade(g);
    for (const g of this.loose) this.deactivateLoose(g);
    for (const c of this.beltCrates) this.deactivateBeltCrate(c);
    this.beltTimer = 3;
    this.gunTimer = 1.5;
    this.furnace.state = 'idle';
    this.furnace.timer = tuning.furnaceEvery;
    for (const r of this.rails) this.repairRail(r);
  }

  step(inputs: ReadonlyMap<number, PlayerInput>) {
    this.world.gravity = { x: 0, y: tuning.gravity, z: 0 };
    const m = this.match;
    for (const [id, r] of this.players) {
      if (!r.active) continue;
      const raw = inputs.get(id) ?? emptyInput();
      const f = this.fighters.get(id)!;
      this.updateKnockout(id, r, f, raw);
      // Knocked out: no control at all. Countdown: look around, but stay put.
      const input = f.koTimer > 0 ? { ...emptyInput(), aimYaw: r.yaw }
        : m.phase === 'countdown' ? { ...emptyInput(), aimYaw: raw.aimYaw, aimPitch: raw.aimPitch } : raw;
      this.updateHands(id, r, f, input);
      r.step(input, DT);
      this.updateFire(id, r, f, input);
    }
    this.updateCarry();
    this.world.step();
    this.tick++;

    this.updateGrenades();
    this.updateLoose();
    this.updatePickups();
    this.updateHazards();
    // Big hits knock items out of your hands.
    for (const [id, f] of this.fighters) {
      if (f.hitAccum >= handling.dropThreshold) {
        const d = f.hitDir;
        for (const i of [0, 1] as const) this.dropItem(id, i, { x: d.x * 4, y: 3, z: d.z * 4 });
      }
      f.hitAccum = 0;
    }
    this.updateHeldModels(inputs);

    // Falling out of the world.
    for (const [id, r] of this.players) if (r.active && r.pelvis.translation().y < tuning.killY) this.eliminate(id, 'fall');
    for (const p of this.props) if (p.body.translation().y < tuning.killY) this.resetProp(p);
    this.updateMatch();
  }

  // ---------------------------------------------------------------- rounds

  /** Start a best-of match from round 1. */
  startMatch() {
    this.match.wins.clear();
    for (const id of this.players.keys()) this.match.wins.set(id, 0);
    this.match.round = 0;
    this.match.matchWinner = null;
    this.startRound();
  }

  /** Sandbox mode: no rounds, falling or burning just respawns you. */
  setPractice() {
    this.match.phase = 'practice';
    this.resetAll();
  }

  private startRound() {
    const m = this.match;
    m.round++;
    m.roundWinner = null;
    this.resetAll();
    m.alive = new Set(this.players.keys());
    m.phase = 'countdown';
    m.timer = 3;
    this.events.push({ type: 'countdown', round: m.round });
  }

  private updateMatch() {
    const m = this.match;
    if (m.phase === 'practice') return;
    m.timer -= DT;
    if (m.phase === 'countdown' && m.timer <= 0) {
      m.phase = 'playing';
      this.events.push({ type: 'roundStart', round: m.round });
    } else if (m.phase === 'playing' && this.players.size >= 2 && m.alive.size <= 1) {
      const winner = m.alive.size === 1 ? [...m.alive][0] : null;
      m.roundWinner = winner;
      if (winner !== null) m.wins.set(winner, (m.wins.get(winner) ?? 0) + 1);
      m.phase = 'roundOver';
      m.timer = 3.5;
      this.events.push({ type: 'roundOver', round: m.round, winner });
    } else if (m.phase === 'roundOver' && m.timer <= 0) {
      const w = m.roundWinner;
      if (w !== null && (m.wins.get(w) ?? 0) >= m.winsToWin) {
        m.phase = 'matchOver';
        m.matchWinner = w;
        m.timer = 12;
        this.events.push({ type: 'matchOver', winner: w });
      } else {
        this.startRound();
      }
    } else if (m.phase === 'matchOver' && m.timer <= 0) {
      this.startMatch();
    }
  }

  /** Out for the rest of the round (or respawn, in practice). */
  eliminate(id: number, cause: 'fall' | 'fire') {
    const r = this.players.get(id);
    if (!r || !r.active) return;
    const pos = { ...r.chest.translation() };
    this.events.push({ type: 'eliminated', player: id, cause, pos });
    if (this.match.phase === 'practice') { this.respawn(id); return; }
    if (!this.match.alive.has(id)) return;
    this.match.alive.delete(id);
    for (const i of [0, 1] as const) this.dropItem(id, i, { x: 0, y: 1, z: 0 });
    for (const other of this.players.values()) for (const b of r.bodyHandles) other.releaseIfAttachedTo(b);
    const f = this.fighters.get(id)!;
    f.koTimer = 0;
    r.knockedOut = false;
    r.setActive(false);
  }

  /**
   * Carrying: whatever your hands are holding (a limp player, a crate) is partly lifted and pulled along with
   * you, so you can drag someone to the furnace instead of fighting the floor's friction.
   */
  private updateCarry() {
    for (const [, r] of this.players) {
      if (!r.active || r.stiffness < 0.35) continue;
      const held = r.hands.filter((h) => h.joint).map((h) => h.joint!.body2());
      if (held.length === 0) continue;
      const cv = r.chest.linvel();
      const share = held.length / 2; // one hand helps half as much as two
      const bodies = new Set<RAPIER_NS.RigidBody>();
      for (const b of held) {
        const owner = [...this.players.values()].find((p) => p !== r && p.bodyHandles.has(b.handle));
        if (owner) for (const p of owner.parts.values()) bodies.add(p.body);
        else if (b.isDynamic()) bodies.add(b);
      }
      for (const b of bodies) {
        const m = b.mass();
        const v = b.linvel();
        b.applyImpulse({
          x: (cv.x - v.x) * m * tuning.carryPull * share,
          y: -tuning.gravity * m * DT * tuning.carryLift * share,
          z: (cv.z - v.z) * m * tuning.carryPull * share,
        }, true);
      }
    }
  }

  // ---------------------------------------------------------------- hazards

  private updateHazards() {
    const map = INCINERATOR;
    // Conveyors: whatever rests on a belt is dragged along it (toward the pit).
    const push = (b: RAPIER_NS.RigidBody) => {
      if (!b.isEnabled()) return;
      const p = b.translation();
      const belt = map.belts.find((bl) => inBox(p, bl.box));
      if (!belt) return;
      const v = b.linvel();
      const m = b.mass() * 0.35;
      b.applyImpulse({ x: (belt.vel.x - v.x) * m * Math.abs(Math.sign(belt.vel.x)), y: 0, z: (belt.vel.z - v.z) * m * Math.abs(Math.sign(belt.vel.z)) }, true);
    };
    // Players on their feet walk relative to the belt (see Ragdoll locomotion); only limp bodies get dragged.
    for (const r of this.players.values()) if (r.active && r.stiffness < 0.35) for (const p of r.parts.values()) push(p.body);
    for (const p of this.props) push(p.body);
    for (const c of this.beltCrates) if (c.active) push(c.body);
    for (const g of this.loose) if (g.active) push(g.body);

    if (this.match.phase !== 'countdown') {
      // Guns only ever arrive on the belts, riding toward the fire.
      this.gunTimer -= DT;
      if (this.gunTimer <= 0) {
        this.gunTimer = tuning.gunEvery * (0.75 + this.rand() * 0.5);
        const belt = map.belts[Math.floor(this.rand() * map.belts.length)];
        const roll = this.rand();
        const kind: WeaponKind = roll < 0.5 ? 'pistol' : roll < 0.8 ? 'shotgun' : 'grenade';
        this.spawnLoose(kind, belt.spawn);
      }
      // And the odd crate.
      this.beltTimer -= DT;
      if (this.beltTimer <= 0) {
        this.beltTimer = 5 + this.rand() * 3;
        const c = this.beltCrates.find((x) => !x.active);
        const belt = map.belts[Math.floor(this.rand() * map.belts.length)];
        if (c) {
          c.active = true;
          c.body.setEnabled(true);
          c.body.setTranslation({ x: belt.spawn.x, y: belt.spawn.y + 0.2, z: belt.spawn.z }, true);
          c.body.setRotation(eulerYX(this.rand() * 6, 0), true);
          c.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      }
    }

    // Railing gives way when something slams into it hard.
    for (const rail of this.rails) {
      if (rail.broken) continue;
      let hitter: RAPIER_NS.RigidBody | null = null;
      this.world.contactPairsWith(rail.collider, (other) => {
        const ob = other.parent();
        if (ob && ob.isDynamic() && ob.isEnabled()) {
          const v = ob.linvel();
          if (Math.hypot(v.x, v.y, v.z) > tuning.railBreakSpeed) hitter = ob;
        }
      });
      if (hitter) {
        const v = (hitter as RAPIER_NS.RigidBody).linvel();
        this.breakRail(rail, { x: v.x * 0.6, y: 1, z: v.z * 0.6 });
      }
    }

    // The pit incinerates whatever falls in.
    for (const [id, r] of this.players) {
      if (r.active && (inBox(r.chest.translation(), map.fire) || inBox(r.pelvis.translation(), map.fire))) this.eliminate(id, 'fire');
    }
    const burn = (p: V3) => this.events.push({ type: 'burn', pos: { ...p } });
    for (const c of this.beltCrates) if (c.active && inBox(c.body.translation(), map.fire)) { burn(c.body.translation()); this.deactivateBeltCrate(c); }
    for (const p of this.props) if (inBox(p.body.translation(), map.fire)) { burn(p.body.translation()); this.resetProp(p); }
    for (const g of this.loose) if (g.active && inBox(g.body.translation(), map.fire)) { burn(g.body.translation()); this.deactivateLoose(g); }
    for (const g of this.grenades) if (g.active && inBox(g.body.translation(), map.fire)) { this.explode({ ...g.body.translation() }); this.deactivateGrenade(g); }
    for (const r of this.rails) {
      if (r.broken && r.body.isEnabled() && inBox(r.body.translation(), map.fire)) {
        burn(r.body.translation());
        r.body.setEnabled(false);
        r.body.setTranslation({ x: 0, y: HIDDEN_Y, z: 0 }, false);
      }
    }

    // Pit flare: it glows, then erupts and blasts everyone near the rim up and away.
    const fu = this.furnace;
    if (this.match.phase === 'countdown') return;
    fu.timer -= DT;
    if (fu.timer <= 0) {
      fu.state = fu.state === 'idle' ? 'warn' : fu.state === 'warn' ? 'burst' : 'idle';
      fu.timer = fu.state === 'warn' ? tuning.furnaceWarn : fu.state === 'burst' ? 0.9 : tuning.furnaceEvery;
      fu.hit.clear();
      this.events.push({ type: 'furnace', state: fu.state });
    }
    if (fu.state === 'burst') {
      const c = map.pitCenter;
      for (const [id, r] of this.players) {
        if (!r.active || fu.hit.has(id) || !inBox(r.chest.translation(), map.flare)) continue;
        fu.hit.add(id);
        const p = r.chest.translation();
        const d = Math.hypot(p.x - c.x, p.z - c.z) || 1;
        const ox = (p.x - c.x) / d, oz = (p.z - c.z) / d;
        for (const part of r.parts.values()) {
          const mm = part.body.mass();
          part.body.applyImpulse({ x: ox * tuning.furnacePush * mm, y: tuning.furnaceLift * mm, z: oz * tuning.furnacePush * mm }, true);
        }
        r.addStun(1.5);
        this.addKo(id, tuning.furnaceKo);
        this.events.push({
          type: 'hit', player: id, cause: 'flame', pos: { ...p }, strength: 30,
          entity: this.entityOfBody.get(r.chest.handle) ?? -1, local: { x: 0, y: 0, z: 0 }, dir: { x: ox, y: 0.5, z: oz },
        });
      }
      for (const b of [...this.props.map((p) => p.body), ...this.beltCrates.filter((x) => x.active).map((x) => x.body)]) {
        if (fu.hit.has(-1 - b.handle) || !inBox(b.translation(), map.flare)) continue;
        fu.hit.add(-1 - b.handle);
        b.applyImpulse({ x: 0, y: 6 * b.mass(), z: 0 }, true);
      }
    }
  }

  /** A loaded gun dropped onto a belt (the only way guns enter the game). */
  private spawnLoose(kind: WeaponKind, at: V3) {
    const g = this.loose.find((x) => x.kind === kind && !x.active) ?? this.oldestLoose(kind);
    if (!g) return;
    for (const p of this.players.values()) p.releaseIfAttachedTo(g.body.handle);
    g.active = true;
    g.ammo = weapons[kind].ammo;
    g.age = handling.pickupDelay; // grabbable straight away
    g.thrownBy = -1;
    g.bonkTimer = 0;
    g.collider.setCollisionGroups(groups(WORLD_GROUP, 0xffff));
    g.body.setEnabled(true);
    g.body.setTranslation({ x: at.x, y: at.y, z: at.z }, true);
    g.body.setRotation(eulerYX(this.rand() * 6, 0), true);
    g.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    g.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.events.push({ type: 'gunSpawn', weapon: kind, pos: { ...at } });
  }

  private addRail(pos: V3, half: V3, color: number) {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z));
    const collider = this.world.createCollider(
      this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setDensity(400).setFriction(0.6)
        .setCollisionGroups(groups(WORLD_GROUP, 0xffff))
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    this.rails.push({ body, collider, broken: false, hp: tuning.railHp, pos: { ...pos } });
    this.addEntity(body, { kind: 'box', hx: half.x, hy: half.y, hz: half.z }, color, 'prop', undefined, 'rail');
  }

  private breakRail(r: (typeof this.rails)[number], vel: V3) {
    r.broken = true;
    r.body.setBodyType(this.R.RigidBodyType.Dynamic, true);
    r.body.setLinvel(vel, true);
    r.body.setAngvel({ x: (this.rand() - 0.5) * 6, y: (this.rand() - 0.5) * 6, z: (this.rand() - 0.5) * 6 }, true);
    this.events.push({ type: 'railBreak', pos: { ...r.body.translation() } });
  }

  private repairRail(r: (typeof this.rails)[number]) {
    r.broken = false;
    r.hp = tuning.railHp;
    r.body.setEnabled(true);
    r.body.setBodyType(this.R.RigidBodyType.Fixed, true);
    r.body.setTranslation(r.pos, true);
    r.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    r.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    r.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private buildBeltCrates() {
    for (let i = 0; i < 4; i++) {
      const body = this.world.createRigidBody(
        this.R.RigidBodyDesc.dynamic().setTranslation(0, HIDDEN_Y, 20 + i).setEnabled(false),
      );
      this.world.createCollider(
        this.R.ColliderDesc.cuboid(0.3, 0.3, 0.3).setDensity(60).setFriction(0.8).setCollisionGroups(groups(WORLD_GROUP, 0xffff)),
        body,
      );
      this.beltCrates.push({ body, active: false });
      this.addEntity(body, { kind: 'box', hx: 0.3, hy: 0.3, hz: 0.3 }, 0x9c7a4d, 'prop');
    }
  }

  private deactivateBeltCrate(c: { body: RAPIER_NS.RigidBody; active: boolean }) {
    for (const r of this.players.values()) r.releaseIfAttachedTo(c.body.handle);
    c.active = false;
    c.body.setEnabled(false);
    c.body.setTranslation({ x: 0, y: HIDDEN_Y, z: 0 }, false);
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---------------------------------------------------------------- weapons

  /** Left mouse: use the active hand's item. R: switch active hand. */
  private updateFire(id: number, r: Ragdoll, f: Fighter, input: PlayerInput) {
    f.cooldown = Math.max(0, f.cooldown - DT);
    const cycle = input.cycle && !f.prevCycle;
    f.prevCycle = input.cycle;
    if (cycle && f.hands[0].item && f.hands[1].item) f.active = (1 - f.active) as 0 | 1;

    const pressed = input.fire && !f.prevFire;
    f.prevFire = input.fire;
    const hi = activeHand(f);
    if (!pressed || hi === null || f.cooldown > 0 || r.stiffness < 0.35) return;
    f.active = hi;
    const hand = f.hands[hi];
    const kind = hand.item!;
    const dir = aimDir(input.aimYaw, input.aimPitch);
    const w = weapons[kind];
    f.cooldown = w.cooldown;
    hand.ammo--;

    if (kind === 'grenade') {
      // Single use: it leaves your hand live.
      this.throwGrenade(id, r, f, dir, hi);
      hand.item = null;
      hand.ammo = 0;
      if (f.hands[1 - hi].item) f.active = (1 - hi) as 0 | 1;
      return;
    }

    const origin = r.aimOrigin();
    const muzzle = this.muzzle(r, kind, dir, hi);
    for (let i = 0; i < w.pellets; i++) {
      const d = this.spreadDir(dir, w.spread);
      const res = this.hitscan(id, origin, d, w.range, w.knockback, w.falloff, w.lift, w.pellets > 1 ? 'pellet' : 'shot', w.radius);
      this.events.push({ type: 'shot', player: id, weapon: kind, from: muzzle, to: res.point, hit: res.hit, first: i === 0, dir: d });
    }
    if (w.recoil > 0) {
      const s = (r.totalMass / 10) * w.recoil;
      r.chest.applyImpulse({ x: -dir.x * s, y: -dir.y * s * 0.3, z: -dir.z * s }, true);
    }
    // Kick the gun arm up and back.
    const fore = r.parts.get(hi === 0 ? 'forearmL' : 'forearmR')!.body;
    const ks = fore.mass() * w.armKick;
    fore.applyImpulse({ x: -dir.x * ks * 0.5, y: ks, z: -dir.z * ks * 0.5 }, true);

    if (hand.ammo <= 0) {
      this.events.push({ type: 'empty', player: id });
      // Toss the empty gun aside (it can't be picked up, and vanishes soon).
      const side = hi === 0 ? 1 : -1;
      this.dropItem(id, hi, { x: dir.z * 2 * side, y: 2.5, z: -dir.x * 2 * side });
    }
  }

  /**
   * Cast a ray and knock back whatever it hits. Every gun (and the debug shove) goes through here.
   * `falloff` is the knockback multiplier at max range.
   */
  hitscan(shooter: number | undefined, origin: V3, dir: V3, range: number, knockback: number, falloff: number,
    lift = 0.25, cause: HitCause = 'shove', radius = 0) {
    const found = this.sweep(shooter, origin, dir, range, radius);
    if (!found) {
      return { hit: false, point: { x: origin.x + dir.x * range, y: origin.y + dir.y * range, z: origin.z + dir.z * range } };
    }
    const hit = { collider: found.collider, timeOfImpact: found.toi };
    const point = found.point;
    const body = hit.collider.parent();
    const rail = this.rails.find((r) => !r.broken && r.collider.handle === hit.collider.handle);
    if (rail) {
      // Railing takes damage from hits; enough and it gives way.
      rail.hp -= knockback;
      if (rail.hp <= 0) this.breakRail(rail, { x: dir.x * 4, y: 1, z: dir.z * 4 });
      return { hit: true, point };
    }
    if (!body || !body.isDynamic()) return { hit: false, point };
    const strength = knockback * (1 + (falloff - 1) * (hit.timeOfImpact / range));
    const imp = { x: dir.x * strength, y: dir.y * strength + strength * lift, z: dir.z * strength };
    const owner = [...this.players.values()].find((r) => r.ownsCollider(hit.collider));
    if (owner) {
      // Scale to the whole character's mass so the same number feels the same on every body part.
      const s = owner.totalMass / 10;
      owner.hit(body, { x: imp.x * s, y: imp.y * s, z: imp.z * s }, point, strength);
      this.noteHit(owner.playerId, strength, dir);
      const head = owner.partName(body.handle) === 'head';
      const t = tuning;
      const ko = cause === 'punch' ? t.koPunch * (head ? t.koHeadMult : 1)
        : cause === 'shot' || cause === 'pellet' ? t.koShot * (strength / 20) * (head ? 1.5 : 1)
        : 0;
      this.addKo(owner.playerId, ko);
      this.events.push({
        type: 'hit', player: owner.playerId, by: shooter, cause, pos: point, strength,
        entity: this.entityOfBody.get(body.handle) ?? -1, local: worldToLocal(body, point), dir,
      });
    } else {
      const s = body.mass() / 10;
      body.applyImpulseAtPoint({ x: imp.x * s, y: imp.y * s, z: imp.z * s }, point, true);
    }
    return { hit: true, point };
  }

  /**
   * First thing along `dir` from `origin`, ignoring the shooter: a thin ray, or a sphere of `radius` swept
   * along it (fists and bullets have thickness, so near misses at close range still count).
   */
  private sweep(shooter: number | undefined, origin: V3, dir: V3, range: number, radius: number) {
    const ignore = shooter !== undefined ? this.players.get(shooter) : undefined;
    const filter = (c: RAPIER_NS.Collider) => !(ignore && ignore.ownsCollider(c)) && !this.isGrenadeCollider(c);
    if (radius <= 0) {
      const ray = new this.R.Ray(origin, dir);
      const h = this.world.castRay(ray, range, true, undefined, undefined, undefined, undefined, filter);
      return h ? { collider: h.collider, toi: h.timeOfImpact, point: ray.pointAt(h.timeOfImpact) } : null;
    }
    const h = this.world.castShape(origin, { x: 0, y: 0, z: 0, w: 1 }, dir, new this.R.Ball(radius), 0, range, true,
      undefined, undefined, undefined, undefined, filter);
    if (!h) return null;
    // witness1 is the touched point on the hit collider (world space).
    return { collider: h.collider, toi: h.time_of_impact, point: { ...h.witness1 } };
  }

  /** Would a punch from this player land on someone right now? (For the crosshair's in-reach cue.) */
  punchWouldHit(id: number, aimYaw: number, aimPitch: number): boolean {
    const r = this.players.get(id);
    if (!r) return false;
    const found = this.sweep(id, this.punchOrigin(r), aimDir(aimYaw, aimPitch), punch.range, punch.radius);
    return !!found && [...this.players.values()].some((p) => p !== r && p.ownsCollider(found.collider));
  }

  private punchOrigin(r: Ragdoll): V3 {
    const o = r.aimOrigin();
    return { x: o.x, y: o.y - 0.32, z: o.z };
  }

  /** Back-compat debug helper: knock back along a ray with no shooter. */
  shoveRay(origin: V3, dir: V3, impulse: number, maxDist = 60, ignorePlayer?: number): V3 | null {
    const res = this.hitscan(ignorePlayer, origin, dir, maxDist, impulse, 1);
    return res.hit ? res.point : null;
  }

  private throwGrenade(id: number, r: Ragdoll, f: Fighter, dir: V3, _hand: 0 | 1) {
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
        this.addKo(r.playerId, tuning.koBlast * maxF);
        // Blood out of the side facing the blast.
        this.events.push({
          type: 'hit', player: r.playerId, cause: 'blast', pos: cp, strength: explosive.strength * maxF * 2,
          entity: this.entityOfBody.get(r.chest.handle) ?? -1, local: worldToLocal(r.chest, { x: cp.x - away.x * 0.15, y: cp.y, z: cp.z - away.z * 0.15 }),
          dir: away,
        });
      }
    }
    for (const p of this.props) push(p.body, p.body.mass());
    for (const g of this.loose) if (g.active) push(g.body, g.body.mass());
    this.events.push({ type: 'explosion', pos: c, radius: R });
  }

  // ---------------------------------------------------------------- knockouts

  private addKo(id: number, amount: number) {
    const f = this.fighters.get(id);
    if (!f || amount <= 0) return;
    f.hitsTaken++;
    f.sinceHit = 0;
    if (f.koTimer > 0) return; // already out
    f.ko += amount;
    if (f.ko >= koThreshold(f)) {
      const t = tuning;
      f.ko = 0;
      f.koTimer = Math.min(t.koTimeMax, t.koTime + f.koCount * t.koTimePerRepeat);
      f.koCount++;
      for (const i of [0, 1] as const) this.dropItem(id, i, { x: 0, y: 1, z: 0 });
      this.events.push({ type: 'ko', player: id, seconds: f.koTimer });
    }
  }

  private updateKnockout(id: number, r: Ragdoll, f: Fighter, input: PlayerInput) {
    const t = tuning;
    f.sinceHit += DT;
    if (f.koTimer > 0) {
      // Mashing buttons brings you round a little sooner.
      const mash = input.handL || input.handR || input.jump;
      if (mash && !f.mashPrev) f.koTimer -= t.koMash;
      f.mashPrev = mash;
      f.koTimer -= DT;
      if (f.koTimer <= 0) {
        f.koTimer = 0;
        // Wake up groggy: stiffness ramps back up over the normal stun recovery.
        r.stunTimer = t.stunTime;
        this.events.push({ type: 'wake', player: id });
      }
    } else if (f.sinceHit > t.koDecayDelay) {
      f.ko = Math.max(0, f.ko - t.koDecay * DT);
    }
    r.knockedOut = f.koTimer > 0;
  }

  private noteHit(id: number, strength: number, dir: V3) {
    const f = this.fighters.get(id);
    if (!f) return;
    f.hitAccum += strength;
    f.hitDir = dir;
  }

  // ---------------------------------------------------------------- loose guns

  /**
   * Q / E. Per hand: a press with an empty hand throws a punch; holding reaches and grabs.
   * A reaching empty hand that touches a gun picks it up, and the item stays only while the key is held.
   * Letting go drops it, tossed along with the hand's motion.
   */
  private updateHands(id: number, r: Ragdoll, f: Fighter, input: PlayerInput) {
    const keys = [input.handL, input.handR];
    const limp = r.stiffness < 0.35;
    for (const i of [0, 1] as const) {
      const h = f.hands[i];
      const key = keys[i] && !limp;
      const pressed = key && !h.prevKey;
      h.prevKey = key;
      h.punchTimer = Math.max(0, h.punchTimer - DT);
      h.punchCooldown = Math.max(0, h.punchCooldown - DT);

      // Let go (or knocked silly): drop what's in the hand.
      if (!key && h.item) {
        const d = aimDir(input.aimYaw, Math.max(input.aimPitch, 0.1));
        const t = limp ? 0 : handling.releaseToss;
        this.dropItem(id, i, { x: d.x * t, y: d.y * t + 1, z: d.z * t });
      }

      if (key && !h.item) {
        // Pick up a gun the hand is touching.
        const hp = r.handPosition(i);
        const near = (p: V3) => Math.hypot(hp.x - p.x, hp.y - p.y, hp.z - p.z) < handling.grabReach;
        // Things on the floor are scooped up: the hand just has to be over them, reaching down.
        const scoop = (p: V3) => input.aimPitch < -0.35 && Math.hypot(hp.x - p.x, hp.z - p.z) < handling.grabReach
          && p.y < hp.y + 0.2 && hp.y - p.y < 1.1;
        for (const g of this.loose) {
          const gp = g.body.translation();
          if (!g.active || g.ammo <= 0 || g.age < handling.pickupDelay || !(near(gp) || scoop(gp))) continue;
          if (id === g.thrownBy && g.age < 1) continue;
          this.takeLoose(id, f, i, g);
          break;
        }
        if (!h.item) {
          for (const p of this.pickups) {
            if (p.respawn > 0 || !near(p.model.pos)) continue;
            this.takeSpawner(id, f, i, p);
            break;
          }
        }
        // Otherwise a fresh press is a punch.
        if (!h.item && pressed && h.punchCooldown === 0) this.throwPunch(id, r, h, i, input);
      }

      r.armMode[i] = (limp ? 'idle' : h.item ? 'aim' : h.punchTimer > 0 ? 'punch' : key ? 'reach' : 'idle') as ArmMode;
    }
    if (activeHand(f) !== null) f.active = activeHand(f)!;
  }

  private throwPunch(id: number, r: Ragdoll, h: HandSlot, i: 0 | 1, input: PlayerInput) {
    h.punchTimer = 0.2;
    h.punchCooldown = punch.cooldown;
    const dir = aimDir(input.aimYaw, input.aimPitch);
    r.punch(i, dir);
    // Same sweep as `punchWouldHit`, so the crosshair cue and the real punch always agree.
    const res = this.hitscan(id, this.punchOrigin(r), dir, punch.range, punch.knockback, 1, punch.lift, 'punch', punch.radius);
    this.events.push({ type: 'punch', player: id, to: res.point, hit: res.hit });
  }

  /** Turn a hand's item into a loose physics object. `vel` is added to the hand's velocity. */
  dropItem(id: number, hand: 0 | 1, vel: V3) {
    const f = this.fighters.get(id);
    const r = this.players.get(id);
    if (!f || !r) return;
    const h = f.hands[hand];
    if (!h.item) return;
    const kind = h.item;
    const ammo = h.ammo;
    h.item = null;
    h.ammo = 0;
    if (f.hands[1 - hand].item) f.active = (1 - hand) as 0 | 1;
    const g = this.loose.find((x) => x.kind === kind && !x.active) ?? this.oldestLoose(kind);
    if (!g) return;
    const held = h.held[kind];
    const hv = r.parts.get(hand === 0 ? 'forearmL' : 'forearmR')!.body.linvel();
    const v = { x: hv.x * 0.8 + vel.x, y: hv.y * 0.8 + vel.y, z: hv.z * 0.8 + vel.z };
    const thrown = Math.hypot(v.x, v.y, v.z) > handling.bonkSpeed;
    this.events.push({ type: 'drop', player: id, weapon: kind, thrown, entity: this.entityOfBody.get(g.body.handle) ?? -1, empty: ammo <= 0 });
    for (const p of this.players.values()) p.releaseIfAttachedTo(g.body.handle);
    g.active = true;
    g.ammo = ammo;
    g.age = 0;
    g.thrownBy = id;
    g.bonkTimer = thrown ? 1.2 : 0;
    // Don't collide with the thrower for a moment, so it leaves the hand cleanly.
    g.collider.setCollisionGroups(groups(WORLD_GROUP, 0xffff ^ playerBit(f.slot)));
    g.body.setEnabled(true);
    g.body.setTranslation(held.pos.y > -500 ? held.pos : r.handPosition(hand), true);
    g.body.setRotation(held.rot, true);
    g.body.setLinvel(v, true);
    g.body.setAngvel({ x: (this.rand() - 0.5) * 14, y: (this.rand() - 0.5) * 14, z: (this.rand() - 0.5) * 14 }, true);
  }

  private oldestLoose(kind: WeaponKind) {
    let best: LooseGun | undefined;
    for (const g of this.loose) if (g.kind === kind && (!best || g.age > best.age)) best = g;
    return best;
  }

  private takeLoose(id: number, f: Fighter, hand: 0 | 1, g: LooseGun) {
    const h = f.hands[hand];
    h.item = g.kind;
    h.ammo = g.ammo;
    if (!f.hands[1 - hand].item) f.active = hand;
    f.cooldown = Math.max(f.cooldown, 0.15);
    this.events.push({ type: 'pickup', player: id, weapon: g.kind, pos: { ...g.body.translation() } });
    this.deactivateLoose(g);
  }

  private takeSpawner(id: number, f: Fighter, hand: 0 | 1, p: PickupSpot) {
    this.giveWeapon(id, p.kind, hand);
    f.cooldown = Math.max(f.cooldown, 0.15);
    p.respawn = PICKUP_RESPAWN;
    p.model.hide();
    this.events.push({ type: 'pickup', player: id, weapon: p.kind, pos: p.pos });
  }

  private updateLoose() {
    for (const g of this.loose) {
      if (!g.active) continue;
      g.age += DT;
      const p = g.body.translation();
      if (p.y < tuning.killY || g.age > (g.ammo > 0 ? handling.despawn : 5)) { this.deactivateLoose(g); continue; }
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
            const head = vr.partName((part as RAPIER_NS.RigidBody).handle) === 'head';
            this.addKo(vr.playerId, tuning.koBonk * (head ? tuning.koHeadMult : 1));
            this.events.push({
              type: 'hit', player: vr.playerId, by: g.thrownBy, cause: 'bonk', pos: { ...p }, strength: kb,
              entity: this.entityOfBody.get((part as RAPIER_NS.RigidBody).handle) ?? -1,
              local: worldToLocal(part, p), dir: d,
            });
            g.bonkTimer = 0;
            // Drop at the victim's feet rather than bouncing back to the thrower.
            g.body.setLinvel({ x: v.x * 0.15, y: 1.5, z: v.z * 0.15 }, true);
          }
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

  private muzzle(r: Ragdoll, kind: WeaponKind, dir: V3, hand: 0 | 1): V3 {
    const h = r.handPosition(hand);
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
      // Float at hand height so a reaching hand finds it.
      p.model.pos = { x: p.pos.x, y: p.pos.y + 1.0 + Math.sin(spin * 1.5) * 0.06, z: p.pos.z };
      p.model.rot = eulerYX(spin, 0);
    }
  }

  private updateHeldModels(inputs: ReadonlyMap<number, PlayerInput>) {
    for (const [id, r] of this.players) {
      const f = this.fighters.get(id)!;
      const input = inputs.get(id) ?? emptyInput();
      for (const i of [0, 1] as const) {
        const hand = f.hands[i];
        for (const k of WEAPON_KINDS) {
          const v = hand.held[k];
          if (hand.item !== k) { v.hide(); continue; }
          const h = r.handPosition(i);
          // Held guns follow the hand but point down the aim line, which reads better than following the forearm.
          const yaw = r.yaw, pitch = input.aimPitch;
          const d = aimDir(yaw, pitch);
          const s = weapons[k].shape;
          const half = s.kind === 'box' ? s.hz - 0.03 : 0;
          v.pos = { x: h.x + d.x * half, y: h.y + d.y * half, z: h.z + d.z * half };
          v.rot = eulerYX(yaw, -pitch);
        }
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

  private addStatic(pos: V3, half: V3, color: number, opts: Parameters<ArenaBuilder['box']>[3] = {}) {
    const q = eulerYX(opts.rotY ?? 0, opts.rotX ?? 0);
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z).setRotation(q));
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(opts.friction ?? 0.9).setCollisionGroups(groups(WORLD_GROUP, 0xffff)),
      body,
    );
    this.addEntity(body, { kind: 'box', hx: half.x, hy: half.y, hz: half.z }, color, 'static', undefined, opts.flow ? 'belt' : undefined);
    const e = this.entities[this.entities.length - 1];
    if (opts.emissive) e.emissive = opts.emissive;
    if (opts.flow) e.flow = opts.flow;
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

  private buildArena() {
    buildIncinerator({
      box: (pos, half, color, opts) => this.addStatic(pos, half, color, opts),
      crate: (pos, size, color) => this.addCrate(pos, size, color),
      rail: (pos, half, color) => this.addRail(pos, half, color),
    });
    this.spawns = INCINERATOR.spawns;
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
