// A bot that produces PlayerInput, exactly like a human client would, so it works the same in multiplayer.
//
// Each tick it picks one thing to do, in priority order:
//   1. Stay alive: get off a belt that's carrying it toward the pit, back away from the rim, step out from
//      under a press that's about to slam.
//   2. Opponent knocked out: drag them onto the nearest belt and let it feed them to the fire.
//   3. Armed: stand on the far side of the opponent from the nearest hazard (pit or open edge) so shots knock
//      them toward it; keep each gun at its best range; lob grenades; shoot barrels next to the opponent.
//   4. Unarmed: grab a gun off a belt if one is safely reachable, else come at them from the hazard side and jab.
// Aim lags and wobbles a little so it's beatable; if it gets stuck it jumps and sidesteps.
import { emptyInput, type PlayerInput } from '../sim/input';
import { activeHand, koThreshold, type Sim } from '../sim/sim';
import { INCINERATOR, type Belt } from '../sim/incinerator';

export type BotMode = 'idle' | 'chase' | 'chase + shoot';
export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

/**
 * What makes a bot hard is mostly that it never makes human mistakes. Each level dials those back:
 * it reacts to where you *were* a moment ago, turns and aims slower and wobblier, moves slower, punches less,
 * doesn't always go for guns or drag knocked-out players to the fire, and now and then zones out.
 */
const LEVELS: Record<Difficulty, {
  reaction: number; // seconds behind the target's real position
  turn: number; // aim turn rate, rad/s
  wobble: number; // aim wobble multiplier
  aimTolerance: number; // how close the aim must be before shooting (rad)
  speed: number; // movement multiplier
  punchBeat: number; // seconds between punches
  fireDelay: number; // multiplier on the gap between shots
  gunChance: number; // chance (re-rolled every few seconds) it bothers going for a gun
  haulChance: number; // chance it drags a knocked-out opponent to the fire (rolled per knockout)
  daydream: number; // chance per second of zoning out for a moment
}> = {
  easy: { reaction: 0.45, turn: 2.6, wobble: 3.5, aimTolerance: 0.3, speed: 0.62, punchBeat: 0.8, fireDelay: 2.2, gunChance: 0.35, haulChance: 0.2, daydream: 0.12 },
  normal: { reaction: 0.22, turn: 4.2, wobble: 2, aimTolerance: 0.18, speed: 0.82, punchBeat: 0.48, fireDelay: 1.45, gunChance: 0.7, haulChance: 0.55, daydream: 0.04 },
  hard: { reaction: 0, turn: 7, wobble: 1, aimTolerance: 0.12, speed: 1, punchBeat: 0.3, fireDelay: 1, gunChance: 1, haulChance: 1, daydream: 0 },
};

type XZ = { x: number; z: number };
type Rag = NonNullable<ReturnType<Sim['players']['get']>>;

/** Inside the waist-high walls (going over them is a fall). */
const WALL = { minX: -9, maxX: 9, maxZ: 7, minZ: -8 };

export class Bot {
  mode: BotMode = 'idle';
  private input = emptyInput();
  private fireHold = 0;
  private punchClock = 0;
  private aimYaw = 0;
  private aimPitch = 0;
  private wobble = Math.random() * 10;
  private stuckClock = 0;
  private lastPos: XZ = { x: 0, z: 0 };
  private unstick = 0;
  private unstickDir = 1;
  /** What the bot is doing, for the debug HUD. */
  state = 'idle';

  private retargetClock = 0;
  difficulty: Difficulty = 'normal';
  private clock = 0;
  /** Where the target has been recently, so a slower bot can react to where it *was*. */
  private seen: { t: number; id: number; x: number; y: number; z: number }[] = [];
  private wantGun = true;
  private gunRoll = 0;
  /** The knockout we last decided about hauling (target id + their KO count), and the decision. */
  private haulFor = '';
  private willHaul = true;
  private daydream = 0;

  constructor(private readonly sim: Sim, private readonly id: number, private targetId: number) {}

  private get level() {
    return LEVELS[this.difficulty];
  }

  /** The target's chest as this bot perceives it: `reaction` seconds late. */
  private perceive(target: Rag) {
    const p = target.chest.translation();
    if (this.seen.length && this.seen[this.seen.length - 1].id !== this.targetId) this.seen = [];
    this.seen.push({ t: this.clock, id: this.targetId, x: p.x, y: p.y, z: p.z });
    const want = this.clock - this.level.reaction;
    while (this.seen.length > 1 && this.seen[1].t <= want) this.seen.shift();
    const s = this.seen[0];
    return { x: s.x, y: s.y, z: s.z };
  }

  /** With more than one opponent: go after the nearest one still standing (but finish a haul first). */
  private retarget(dt: number) {
    this.retargetClock -= dt;
    const cur = this.sim.players.get(this.targetId);
    const hauling = (this.sim.fighters.get(this.targetId)?.koTimer ?? 0) > 0;
    if (cur?.active && !this.sim.left.has(this.targetId) && (hauling || this.retargetClock > 0)) return;
    this.retargetClock = 2;
    const me = this.sim.players.get(this.id);
    if (!me?.active) return;
    const a = me.chest.translation();
    let best = Infinity;
    for (const [id, r] of this.sim.players) {
      if (id === this.id || !r.active || this.sim.left.has(id)) continue;
      const b = r.chest.translation();
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < best) { best = d; this.targetId = id; }
    }
  }

  think(dt: number): PlayerInput {
    const i = this.input;
    i.moveX = 0; i.moveZ = 0; i.fire = false; i.jump = false; i.cycle = false;
    this.retarget(dt);
    const me = this.sim.players.get(this.id);
    const target = this.sim.players.get(this.targetId);
    const f = this.sim.fighters.get(this.id);
    if (!me || !target || !f || this.mode === 'idle') {
      // Idle bots keep holding whatever they were given.
      if (f) { i.handL = !!f.hands[0].item; i.handR = !!f.hands[1].item; }
      this.state = 'idle';
      return i;
    }
    if (!me.active || f.koTimer > 0) { this.state = f.koTimer > 0 ? 'knocked out' : 'out'; return i; }

    const lv = this.level;
    this.clock += dt;
    const a = me.chest.translation();
    const tf = this.sim.fighters.get(this.targetId)!;
    const armed = !!(f.hands[0].item || f.hands[1].item);
    i.handL = !!f.hands[0].item;
    i.handR = !!f.hands[1].item;
    // Easier bots don't always bother with guns (re-decided every few seconds)...
    this.gunRoll -= dt;
    if (this.gunRoll <= 0) { this.gunRoll = 4; this.wantGun = Math.random() < lv.gunChance; }
    // ...or with dragging a knocked-out opponent to the fire (decided once per knockout).
    const koKey = `${this.targetId}:${tf.koCount}`;
    if (tf.koTimer > 0 && this.haulFor !== koKey) { this.haulFor = koKey; this.willHaul = Math.random() < lv.haulChance; }

    // 1. Stay alive (while hauling, the bot walks ahead of the body up the belt, so it lets itself get closer).
    const hauling = tf.koTimer > 0 && target.active && !armed && this.willHaul;
    if (this.escape(i, me, a, hauling)) { this.state = 'escaping'; return this.finish(i, me, a, dt); }

    // Now and then an easier bot just... zones out for a moment.
    this.daydream -= dt;
    if (this.daydream <= 0 && Math.random() < lv.daydream * dt) this.daydream = 0.6 + Math.random() * 0.8;
    if (this.daydream > 0) { this.state = 'zoned out'; i.fire = false; return this.finish(i, me, a, dt); }

    // 2. Opponent knocked out: feed them to the fire — or, if it doesn't fancy it, wait for them to get up.
    if (hauling) { this.state = 'hauling'; this.haul(i, me, target); return this.finish(i, me, a, dt); }
    if (!target.active) { this.state = 'waiting'; return this.finish(i, me, a, dt); }
    if (tf.koTimer > 0 && !armed) { this.state = 'waiting for them to get up'; this.aimAt(i, a, target.chest.translation(), 0, dt); return this.finish(i, me, a, dt); }

    const b = this.perceive(target);
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const hi = activeHand(f);
    const item = hi !== null ? f.hands[hi].item : null;
    const hurt = f.ko > koThreshold(f) * 0.6;
    const hazard = this.nearestHazard(b);

    // 3. Armed.
    if (item) {
      const range = item === 'shotgun' ? (hurt ? 4.5 : 3) : item === 'grenade' ? 7 : (hurt ? 8 : 6);
      // Stand so the opponent is between us and the hazard.
      const away = norm({ x: b.x - hazard.x, z: b.z - hazard.z });
      const spot = { x: b.x + away.x * range, z: b.z + away.z * range };
      if (Math.hypot(spot.x - a.x, spot.z - a.z) > 0.8) this.steer(i, a, spot.x, spot.z, 1);
      // Shoot a barrel sitting next to them, if there is one; otherwise them.
      let aimAt = { x: b.x, y: b.y, z: b.z };
      if (item !== 'grenade') {
        for (const br of this.sim.liveBarrels()) {
          const dTB = Math.hypot(br.x - b.x, br.z - b.z), dMeB = Math.hypot(br.x - a.x, br.z - a.z);
          if (dTB < 2.2 && dMeB > 3.5) { aimAt = br; break; }
        }
      }
      this.aimAt(i, a, aimAt, item === 'grenade' ? 0.35 : 0, dt);
      const inRange = item === 'shotgun' ? dist < 7 : item === 'grenade' ? dist > 3.5 && dist < 11 : dist < 22;
      this.state = `armed (${item})`;
      if (this.mode === 'chase + shoot' && inRange && this.aimSettled(i, a, aimAt)) {
        // Pulse the trigger so the sim sees separate presses.
        this.fireHold -= dt;
        if (this.fireHold <= -(item === 'shotgun' ? 0.9 : 0.45) * lv.fireDelay) this.fireHold = 0.08;
        i.fire = this.fireHold > 0;
      }
      return this.finish(i, me, a, dt);
    }

    // 4. Unarmed: get a gun if one's safely in reach (and they aren't right on top of us).
    if ((dist > 3 || hurt) && this.wantGun) {
      let best: XZ | null = null, bestD = Infinity;
      for (const w of this.sim.availableWeapons()) {
        if (this.nearPit(w.pos, 1.6)) continue; // too close to the fire to be worth it
        if (Math.abs(w.pos.y - (a.y - 1.3)) > 1.5) continue;
        const d = Math.hypot(w.pos.x - a.x, w.pos.z - a.z);
        if (d < bestD) { bestD = d; best = w.pos; }
      }
      if (best && bestD < 12) {
        this.state = 'getting a gun';
        this.steer(i, a, best.x, best.z, 1, true);
        this.aimAt(i, a, { x: best.x, y: 0.2, z: best.z }, 0, dt);
        i.handR = bestD < 1.6;
        return this.finish(i, me, a, dt);
      }
    }
    if (hurt && dist < 4) {
      // Hurt and unarmed: back off rather than trade punches.
      this.state = 'backing off';
      const away = norm({ x: a.x - b.x, z: a.z - b.z });
      this.steer(i, a, a.x + away.x * 2, a.z + away.z * 2, 1);
      this.aimAt(i, a, b, 0, dt);
      return this.finish(i, me, a, dt);
    }
    // Brawl: come in from the hazard-far side so punches drive them toward it.
    this.state = 'brawling';
    const away = norm({ x: b.x - hazard.x, z: b.z - hazard.z });
    const spot = dist > 2.5 ? { x: b.x + away.x * 0.9, z: b.z + away.z * 0.9 } : { x: b.x, z: b.z };
    if (dist > 1.0) this.steer(i, a, spot.x, spot.z, 1);
    this.aimAt(i, a, b, -0.1, dt);
    if (dist < 1.6) {
      this.punchClock += dt;
      const beat = Math.floor(this.punchClock / lv.punchBeat);
      const on = (this.punchClock % lv.punchBeat) < 0.08;
      i.handL = on && beat % 2 === 0;
      i.handR = on && beat % 2 === 1;
    }
    return this.finish(i, me, a, dt);
  }

  // ------------------------------------------------------------------ behaviours

  /** Get out of immediate danger. Returns true if that's what we're doing this tick. */
  private escape(i: PlayerInput, me: Rag, a: XZ, hauling: boolean): boolean {
    // On a belt and being carried toward the pit.
    const belt = this.onBelt(a);
    if (belt) {
      const u = norm(belt.vel);
      const edge = this.beltEdge(belt);
      const along = (edge.x - a.x) * u.x + (edge.z - a.z) * u.z;
      if (along < (hauling ? 0.9 : 2.3)) {
        const cx = (belt.box.min.x + belt.box.max.x) / 2, cz = (belt.box.min.z + belt.box.max.z) / 2;
        const side = (a.x - cx) * u.z - (a.z - cz) * u.x >= 0 ? 1 : -1;
        i.moveX = u.z * side - u.x * 0.7;
        i.moveZ = -u.x * side - u.z * 0.7;
        return true;
      }
    }
    // Right at the rim.
    if (this.nearPit(a, hauling ? 0.3 : 0.7)) {
      const c = INCINERATOR.pitCenter;
      const away = norm({ x: a.x - c.x, z: a.z - c.z });
      i.moveX = away.x; i.moveZ = away.z;
      return true;
    }
    // Under a press that's about to come down.
    const h = INCINERATOR.stamperHead;
    for (const st of this.sim.stampers) {
      if ((st.phase === 'warn' || st.phase === 'slam') && Math.abs(a.x - st.x) < h.x + 0.4 && Math.abs(a.z - st.z) < h.z + 0.4) {
        const dz = a.z - st.z;
        i.moveX = 0; i.moveZ = dz >= 0 ? 1 : -1;
        return true;
      }
    }
    void me;
    return false;
  }

  /** Grab a knocked-out player, drag them to the nearest belt, walk them up it toward the pit, let go. */
  private haul(i: PlayerInput, me: Rag, target: Rag) {
    const a = me.chest.translation();
    const tp = target.pelvis.translation();
    const holding = me.hands.some((h) => h.joint && target.bodyHandles.has(h.joint.body2().handle));
    const dTarget = Math.hypot(tp.x - a.x, tp.z - a.z);
    if (!holding) {
      // Get to arm's length from the body (not on top of it: arms can't reach straight down), then reach
      // down at it until a hand catches hold.
      if (dTarget > 1.3) this.steer(i, a, tp.x, tp.z, dTarget > 2 ? 1 : 0.6, true);
      else if (dTarget < 0.8) this.steer(i, a, a.x + (a.x - tp.x), a.z + (a.z - tp.z), 0.6, true);
      i.aimYaw = Math.atan2(tp.x - a.x, tp.z - a.z);
      i.aimPitch = Math.max(-1.25, Math.min(-0.3, Math.atan2(tp.y - (a.y + 0.1), Math.max(0.3, dTarget))));
      i.handL = i.handR = dTarget < 1.7;
      return;
    }
    i.handL = i.handR = true;
    i.aimPitch = -0.6;
    const belt = this.nearestBelt(tp);
    const u = norm(belt.vel); // toward the pit
    const edge = this.beltEdge(belt);
    const along = (p: XZ) => (edge.x - p.x) * u.x + (edge.z - p.z) * u.z; // metres before the pit
    const across = (p: XZ) => Math.abs((p.x - edge.x) * u.z - (p.z - edge.z) * u.x); // metres off the centre line
    if (across(tp) < 0.9 && along(tp) < 2.6) {
      // They're on the belt close to the pit: let go and hop off sideways.
      i.handL = i.handR = false;
      const side = (a.x - edge.x) * u.z - (a.z - edge.z) * u.x >= 0 ? 1 : -1;
      this.steer(i, a, a.x + u.z * side * 2.5, a.z - u.x * side * 2.5, 1, true);
      return;
    }
    // Get onto the belt's centre line a few metres back, then walk them up it.
    const entry = { x: edge.x - u.x * 3.4, z: edge.z - u.z * 3.4 };
    const goal = across(a) < 0.6 && along(a) < 4.2 ? { x: edge.x - u.x * 1.4, z: edge.z - u.z * 1.4 } : entry;
    this.steer(i, a, goal.x, goal.z, 1, true);
    i.aimYaw = Math.atan2(goal.x - a.x, goal.z - a.z);
  }

  /** Bookkeeping every tick: notice if we're stuck and wriggle free. */
  private finish(i: PlayerInput, _me: Rag, a: XZ, dt: number) {
    const wantsToMove = Math.hypot(i.moveX, i.moveZ) > 0.3;
    const moved = Math.hypot(a.x - this.lastPos.x, a.z - this.lastPos.z);
    if (wantsToMove && moved < 0.25) this.stuckClock += dt; else { this.stuckClock = 0; this.lastPos = { x: a.x, z: a.z }; }
    if (this.stuckClock > 1.4) { this.unstick = 0.5; this.unstickDir = Math.random() < 0.5 ? -1 : 1; this.stuckClock = 0; this.lastPos = { x: a.x, z: a.z }; }
    if (this.unstick > 0) {
      this.unstick -= dt;
      // Sidestep (perpendicular to where we were going) and hop.
      const mx = i.moveX, mz = i.moveZ;
      i.moveX = -mz * this.unstickDir + mx * 0.3;
      i.moveZ = mx * this.unstickDir + mz * 0.3;
      i.jump = this.unstick > 0.35;
    }
    return i;
  }

  // ------------------------------------------------------------------ aiming

  /** Turn toward a point with human-ish lag and a slow wobble (so it can miss). */
  private aimAt(i: PlayerInput, a: { x: number; y?: number; z: number }, p: { x: number; y: number; z: number }, lob: number, dt: number) {
    const ay = (a as { y?: number }).y ?? 1.3;
    const yaw = Math.atan2(p.x - a.x, p.z - a.z);
    const pitch = Math.atan2(p.y - ay, Math.hypot(p.x - a.x, p.z - a.z)) + lob;
    let dy = yaw - this.aimYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const lv = this.level;
    const turn = lv.turn * dt;
    this.aimYaw += Math.max(-turn, Math.min(turn, dy));
    this.aimPitch += (pitch - this.aimPitch) * Math.min(1, lv.turn * 1.4 * dt);
    this.wobble += dt;
    const w = lv.wobble;
    i.aimYaw = this.aimYaw + (Math.sin(this.wobble * 1.7) * 0.035 + Math.sin(this.wobble * 4.1) * 0.015) * w;
    i.aimPitch = this.aimPitch + Math.sin(this.wobble * 2.3) * 0.02 * w;
  }

  /** Only pull the trigger once the aim has roughly caught up. */
  private aimSettled(i: PlayerInput, a: XZ, p: XZ) {
    const want = Math.atan2(p.x - a.x, p.z - a.z);
    const d = Math.atan2(Math.sin(want - i.aimYaw), Math.cos(want - i.aimYaw));
    return Math.abs(d) < this.level.aimTolerance;
  }

  // ------------------------------------------------------------------ map knowledge

  /** The closest thing they could be knocked into: the pit, or an open edge (left, right, front). */
  private nearestHazard(p: XZ): XZ {
    const c = INCINERATOR.pitCenter, h = INCINERATOR.pitHalf;
    const options: [number, XZ][] = [
      [Math.max(Math.abs(p.x - c.x), Math.abs(p.z - c.z)) - h, { x: c.x, z: c.z }],
      [p.x - WALL.minX, { x: WALL.minX - 1, z: p.z }],
      [WALL.maxX - p.x, { x: WALL.maxX + 1, z: p.z }],
      [WALL.maxZ - p.z, { x: p.x, z: WALL.maxZ + 1 }],
    ];
    options.sort((u, v) => u[0] - v[0]);
    return options[0][1];
  }

  private beltEdge(belt: Belt): XZ {
    const u = norm(belt.vel);
    const c = INCINERATOR.pitCenter, h = INCINERATOR.pitHalf;
    return { x: c.x - u.x * h, z: c.z - u.z * h };
  }

  private nearestBelt(p: XZ): Belt {
    let best = INCINERATOR.belts[0], bd = Infinity;
    for (const b of INCINERATOR.belts) {
      const cx = (b.box.min.x + b.box.max.x) / 2, cz = (b.box.min.z + b.box.max.z) / 2;
      const d = Math.hypot(cx - p.x, cz - p.z);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** Under a press that's about to (or is) slamming down. */
  private underPress(p: XZ) {
    const h = INCINERATOR.stamperHead;
    return this.sim.stampers.some((st) => st.phase !== 'up' && st.phase !== 'rise'
      && Math.abs(p.x - st.x) < h.x + 0.5 && Math.abs(p.z - st.z) < h.z + 0.5);
  }

  private nearPit(p: XZ, margin: number) {
    const c = INCINERATOR.pitCenter, h = INCINERATOR.pitHalf + margin;
    return Math.abs(p.x - c.x) < h && Math.abs(p.z - c.z) < h;
  }

  private onBelt(p: XZ): Belt | null {
    for (const b of INCINERATOR.belts) {
      if (p.x > b.box.min.x - 0.15 && p.x < b.box.max.x + 0.15 && p.z > b.box.min.z - 0.15 && p.z < b.box.max.z + 0.15) return b;
    }
    return null;
  }

  /** Walk toward (x, z) without walking into the pit, onto a belt (unless `allowBelt`), under a press, or over the wall. */
  private steer(i: PlayerInput, a: XZ, x: number, z: number, speed: number, allowBelt = false) {
    let mx = x - a.x, mz = z - a.z;
    const l = Math.hypot(mx, mz);
    if (l < 0.05) return;
    mx /= l; mz /= l;
    const bad = (px: number, pz: number) =>
      this.nearPit({ x: px, z: pz }, 0.55)
      || this.underPress({ x: px, z: pz })
      || (!allowBelt && !!this.onBelt({ x: px, z: pz }))
      || px < WALL.minX + 0.6 || px > WALL.maxX - 0.6 || pz > WALL.maxZ - 0.6 || pz < WALL.minZ + 0.4;
    if (bad(a.x + mx * 0.8, a.z + mz * 0.8)) {
      // Try sliding around it, preferring the side closer to where we want to go.
      const left = { x: -mz, z: mx }, right = { x: mz, z: -mx };
      const order = (left.x * (x - a.x) + left.z * (z - a.z)) >= 0 ? [left, right] : [right, left];
      const pick = order.find((d) => !bad(a.x + d.x * 0.8, a.z + d.z * 0.8)) ?? null;
      if (!pick) { i.moveX = 0; i.moveZ = 0; return; }
      mx = pick.x; mz = pick.z;
    }
    i.moveX = mx * speed * this.level.speed;
    i.moveZ = mz * speed * this.level.speed;
  }
}

function norm(v: XZ): XZ {
  const l = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / l, z: v.z / l };
}
