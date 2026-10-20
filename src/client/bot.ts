// A very simple bot that produces PlayerInput, exactly like a human client would.
// Good enough to test guns and knockback against something that moves.
import { emptyInput, type PlayerInput } from '../sim/input';
import { activeHand, type Sim } from '../sim/sim';
import { INCINERATOR } from '../sim/incinerator';

export type BotMode = 'idle' | 'chase' | 'chase + shoot';

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

    // Target knocked out: grab them and haul them onto the conveyor, then let go and get off it.
    if (tf && tf.koTimer > 0 && target.active && !(f.hands[0].item || f.hands[1].item)) {
      const holding = me.hands.some((h) => h.joint && target.bodyHandles.has(h.joint.body2().handle));
      const tp = target.pelvis.translation();
      const dTarget = Math.hypot(tp.x - a.x, tp.z - a.z);
      if (!holding) {
        // Get over the body and reach down for it until a hand catches hold.
        if (dTarget > 0.7) this.steer(i, a, tp.x, tp.z, dTarget > 1.5 ? 1 : 0.5);
        i.aimYaw = Math.atan2(tp.x - a.x, tp.z - a.z);
        i.aimPitch = -1.0;
        i.handL = i.handR = dTarget < 1.6;
        return i;
      }
      i.handL = i.handR = true;
      i.aimPitch = -0.6;
      if (tp.z < 0.0 && Math.abs(tp.x) < 1.0) {
        // They're on the belt: let go and hop off sideways; the belt does the rest.
        i.handL = i.handR = false;
        this.steer(i, a, (a.x >= 0 ? 1 : -1) * 2.4, a.z + 0.5, 1, true);
        return i;
      }
      // Route: around the guard rails to the front of the belt, then straight up onto it.
      let gx: number, gz: number;
      // In line with the belt (in front of it or already on it): march up it.
      const lined = Math.abs(a.x) < 0.7 && a.z < 3.6 && Math.abs(tp.x) < 1.2;
      if (lined) { gx = 0; gz = -0.6; }
      else if (a.z < 2.0 && Math.abs(a.x) < 2.4) { gx = (a.x >= 0 ? 1 : -1) * 2.5; gz = 3.2; } // beside the rails: go round
      else { gx = 0; gz = 2.8; } // head for the front of the belt and let them swing in behind
      this.steer(i, a, gx, gz, 1, true);
      i.aimYaw = Math.atan2(gx - a.x, gz - a.z);
      return i;
    }
    const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
    const dist = Math.hypot(dx, dz);
    i.aimYaw = Math.atan2(dx, dz);
    i.aimPitch = Math.atan2(dy, dist);

    // Keep holding anything already in hand.
    i.handL = !!f.hands[0].item;
    i.handR = !!f.hands[1].item;
    const hi = activeHand(f);
    const item = hi !== null ? f.hands[hi].item : null;

    // Unarmed: go get the nearest gun first (unless the target is right here), reaching with the right hand.
    if (!item && dist > 2.5) {
      let best: { x: number; z: number } | null = null, bestD = Infinity;
      for (const w of this.sim.availableWeapons()) {
        const d = Math.hypot(w.pos.x - a.x, w.pos.z - a.z);
        if (d < bestD && Math.abs(w.pos.y - (a.y - 1.3)) < 1.5) { bestD = d; best = w.pos; }
      }
      if (best && bestD < 12) {
        const gx = best.x - a.x, gz = best.z - a.z;
        this.steer(i, a, best.x, best.z, 1);
        i.aimYaw = Math.atan2(gx, gz);
        i.aimPitch = -0.6;
        i.handR = bestD < 1.4;
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

  /**
   * Walk toward (x, z) without walking into the furnace, onto the conveyor (unless `allowBelt`),
   * or off the ledge.
   */
  private steer(i: PlayerInput, a: { x: number; z: number }, x: number, z: number, speed: number, allowBelt = false) {
    const belt = INCINERATOR.belt;
    if (!allowBelt && a.x > belt.min.x - 0.2 && a.x < belt.max.x + 0.2 && a.z > belt.min.z && a.z < belt.max.z) {
      // Standing on the conveyor by accident: get off it sideways before anything else.
      i.moveX = a.x >= 0 ? speed : -speed;
      i.moveZ = 0.4 * speed;
      return;
    }
    let mx = x - a.x, mz = z - a.z;
    const l = Math.hypot(mx, mz);
    if (l < 0.05) return;
    mx /= l; mz /= l;
    const bad = (px: number, pz: number) => {
      const f = INCINERATOR.fire, b = INCINERATOR.belt;
      if (px > f.min.x - 0.6 && px < f.max.x + 0.6 && pz < f.max.z + 1.2) return true;
      if (!allowBelt && px > b.min.x - 0.3 && px < b.max.x + 0.3 && pz > b.min.z && pz < b.max.z) return true;
      return Math.abs(px) > 7.3 || pz > 5.3 || pz < -6.6;
    };
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
