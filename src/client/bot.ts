// A very simple bot that produces PlayerInput, exactly like a human client would.
// Good enough to test guns, knockouts and the map's hazards against something that moves.
import { emptyInput, type PlayerInput } from '../sim/input';
import { activeHand, type Sim } from '../sim/sim';
import { INCINERATOR, type Belt } from '../sim/incinerator';

export type BotMode = 'idle' | 'chase' | 'chase + shoot';

type XZ = { x: number; z: number };

export class Bot {
  mode: BotMode = 'idle';
  private input = emptyInput();
  private fireHold = 0;
  private punchClock = 0;

  constructor(private readonly sim: Sim, private readonly id: number, private readonly targetId: number) {}

  think(dt: number): PlayerInput {
    const i = this.input;
    i.moveX = 0; i.moveZ = 0; i.fire = false; i.jump = false; i.cycle = false;
    const me = this.sim.players.get(this.id);
    const target = this.sim.players.get(this.targetId);
    const f = this.sim.fighters.get(this.id);
    if (!me || !target || !f || this.mode === 'idle') {
      // Idle bots keep holding whatever they were given.
      if (f) { i.handL = !!f.hands[0].item; i.handR = !!f.hands[1].item; }
      return i;
    }
    if (!me.active) return i;
    const a = me.chest.translation();
    const b = target.chest.translation();
    const tf = this.sim.fighters.get(this.targetId);
    const armed = !!(f.hands[0].item || f.hands[1].item);

    // Target knocked out: drag them onto a belt and let it feed them to the fire.
    if (tf && tf.koTimer > 0 && target.active && !armed) return this.haul(i, me, target);

    const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
    const dist = Math.hypot(dx, dz);
    i.aimYaw = Math.atan2(dx, dz);
    i.aimPitch = Math.atan2(dy, dist);

    // Keep holding anything already in hand.
    i.handL = !!f.hands[0].item;
    i.handR = !!f.hands[1].item;
    const hi = activeHand(f);
    const item = hi !== null ? f.hands[hi].item : null;

    // Unarmed: guns only come on the belts, so go and snatch one before it reaches the pit.
    if (!item && dist > 2.5) {
      let best: XZ | null = null, bestD = Infinity;
      for (const w of this.sim.availableWeapons()) {
        if (this.nearPit(w.pos, 0.9)) continue; // too late, it's going in
        const d = Math.hypot(w.pos.x - a.x, w.pos.z - a.z);
        if (d < bestD && Math.abs(w.pos.y - (a.y - 1.3)) < 1.5) { bestD = d; best = w.pos; }
      }
      if (best && bestD < 14) {
        this.steer(i, a, best.x, best.z, 1, true);
        i.aimYaw = Math.atan2(best.x - a.x, best.z - a.z);
        i.aimPitch = -0.7;
        i.handR = bestD < 1.5;
        return i;
      }
    }

    const keepAway = item && item !== 'shotgun' ? 4 : 1.2;
    if (dist > keepAway) this.steer(i, a, b.x, b.z, 1);

    if (!item && dist < 1.6) {
      // Brawl: alternate left and right jabs.
      this.punchClock += dt;
      const beat = Math.floor(this.punchClock / 0.35);
      const on = (this.punchClock % 0.35) < 0.1;
      i.handL = on && beat % 2 === 0;
      i.handR = on && beat % 2 === 1;
    }

    if (this.mode === 'chase + shoot' && item) {
      // Pulse the trigger so the sim sees separate presses.
      this.fireHold -= dt;
      if (this.fireHold <= -0.6) this.fireHold = 0.1;
      i.fire = this.fireHold > 0 && dist < (item === 'shotgun' ? 8 : item === 'grenade' ? 10 : 25);
    }
    return i;
  }

  /** Grab a knocked-out player, drag them to the nearest belt, walk them up it toward the pit, let go. */
  private haul(i: PlayerInput, me: NonNullable<ReturnType<Sim['players']['get']>>, target: NonNullable<ReturnType<Sim['players']['get']>>) {
    const a = me.chest.translation();
    const tp = target.pelvis.translation();
    const holding = me.hands.some((h) => h.joint && target.bodyHandles.has(h.joint.body2().handle));
    const dTarget = Math.hypot(tp.x - a.x, tp.z - a.z);
    if (!holding) {
      // Get over the body and reach down for it until a hand catches hold.
      if (dTarget > 0.7) this.steer(i, a, tp.x, tp.z, dTarget > 1.5 ? 1 : 0.5, true);
      i.aimYaw = Math.atan2(tp.x - a.x, tp.z - a.z);
      i.aimPitch = -1.0;
      i.handL = i.handR = dTarget < 1.6;
      return i;
    }
    i.handL = i.handR = true;
    i.aimPitch = -0.6;

    const belt = this.nearestBelt(tp);
    const u = norm(belt.vel); // toward the pit
    const c = INCINERATOR.pitCenter, h = INCINERATOR.pitHalf;
    const edge = { x: c.x - u.x * h, z: c.z - u.z * h }; // where the belt drops into the pit
    const along = (p: XZ) => (edge.x - p.x) * u.x + (edge.z - p.z) * u.z; // metres before the pit
    const across = (p: XZ) => Math.abs((p.x - edge.x) * u.z - (p.z - edge.z) * u.x); // metres off the centre line

    if (across(tp) < 0.9 && along(tp) < 2.6) {
      // They're on the belt close to the pit: let go and hop off sideways.
      i.handL = i.handR = false;
      const side = (a.x - edge.x) * u.z - (a.z - edge.z) * u.x >= 0 ? 1 : -1;
      this.steer(i, a, a.x + u.z * side * 2.5, a.z - u.x * side * 2.5, 1, true);
      return i;
    }
    // Get onto the belt's centre line a few metres back, then walk them up it.
    const entry = { x: edge.x - u.x * 3.4, z: edge.z - u.z * 3.4 };
    const goal = across(a) < 0.6 && along(a) < 4.2 ? { x: edge.x - u.x * 1.4, z: edge.z - u.z * 1.4 } : entry;
    this.steer(i, a, goal.x, goal.z, 1, true);
    i.aimYaw = Math.atan2(goal.x - a.x, goal.z - a.z);
    return i;
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

  /** Walk toward (x, z) without walking into the pit, onto a belt (unless `allowBelt`), or over the wall. */
  private steer(i: PlayerInput, a: XZ, x: number, z: number, speed: number, allowBelt = false) {
    const belt = this.onBelt(a);
    if (!allowBelt && belt) {
      // Standing on a conveyor by accident: get off it sideways (and away from the pit) first.
      const u = norm(belt.vel);
      const cx = (belt.box.min.x + belt.box.max.x) / 2, cz = (belt.box.min.z + belt.box.max.z) / 2;
      const side = (a.x - cx) * u.z - (a.z - cz) * u.x >= 0 ? 1 : -1;
      i.moveX = (u.z * side - u.x * 0.4) * speed;
      i.moveZ = (-u.x * side - u.z * 0.4) * speed;
      return;
    }
    let mx = x - a.x, mz = z - a.z;
    const l = Math.hypot(mx, mz);
    if (l < 0.05) return;
    mx /= l; mz /= l;
    const bad = (px: number, pz: number) =>
      this.nearPit({ x: px, z: pz }, 0.55)
      || (!allowBelt && !!this.onBelt({ x: px, z: pz }))
      || Math.abs(px) > 8.5 || pz > 6.6 || pz < -7.6;
    if (bad(a.x + mx * 0.8, a.z + mz * 0.8)) {
      // Try sliding around it to either side.
      const left = { x: -mz, z: mx }, right = { x: mz, z: -mx };
      const pick = !bad(a.x + left.x * 0.8, a.z + left.z * 0.8) ? left : !bad(a.x + right.x * 0.8, a.z + right.z * 0.8) ? right : null;
      if (!pick) { i.moveX = 0; i.moveZ = 0; return; }
      mx = pick.x; mz = pick.z;
    }
    i.moveX = mx * speed;
    i.moveZ = mz * speed;
  }
}

function norm(v: XZ): XZ {
  const l = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / l, z: v.z / l };
}
