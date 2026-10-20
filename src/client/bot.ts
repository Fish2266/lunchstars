// A very simple bot that produces PlayerInput, exactly like a human client would.
// Good enough to test guns and knockback against something that moves.
import { emptyInput, type PlayerInput } from '../sim/input';
import type { Sim } from '../sim/sim';

export type BotMode = 'idle' | 'chase' | 'chase + shoot';

export class Bot {
  mode: BotMode = 'idle';
  private input = emptyInput();
  private fireHold = 0;

  constructor(private readonly sim: Sim, private readonly id: number, private readonly targetId: number) {}

  think(dt: number): PlayerInput {
    const i = this.input;
    i.moveX = 0; i.moveZ = 0; i.fire = false; i.grab = false; i.jump = false; i.drop = false;
    const me = this.sim.players.get(this.id);
    const target = this.sim.players.get(this.targetId);
    if (!me || !target || this.mode === 'idle') return i;

    const a = me.chest.translation();
    const b = target.chest.translation();
    const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
    const dist = Math.hypot(dx, dz);
    i.aimYaw = Math.atan2(dx, dz);
    i.aimPitch = Math.atan2(dy, dist);

    const f = this.sim.fighters.get(this.id)!;
    // Unarmed: go get the nearest gun first (unless the target is right here).
    if (!f.weapon && dist > 2.5) {
      let best: { x: number; z: number } | null = null, bestD = Infinity;
      for (const w of this.sim.availableWeapons()) {
        const d = Math.hypot(w.pos.x - a.x, w.pos.z - a.z);
        if (d < bestD && Math.abs(w.pos.y - (a.y - 1.3)) < 1.5) { bestD = d; best = w.pos; }
      }
      if (best && bestD < 12) {
        const gx = best.x - a.x, gz = best.z - a.z;
        i.moveX = gx / (bestD || 1); i.moveZ = gz / (bestD || 1);
        i.grab = bestD < 1.2;
        i.aimPitch = -0.6;
        return i;
      }
    }
    const keepAway = f.weapon && f.weapon !== 'shotgun' ? 4 : 1.2;
    if (dist > keepAway) { i.moveX = dx / dist; i.moveZ = dz / dist; }
    i.grab = !f.weapon && dist < 1.4;

    if (this.mode === 'chase + shoot' && f.weapon) {
      // Pulse the trigger so the sim sees separate presses.
      this.fireHold -= dt;
      if (this.fireHold <= -0.6) this.fireHold = 0.1;
      i.fire = this.fireHold > 0 && dist < (f.weapon === 'shotgun' ? 8 : 25);
    }
    return i;
  }
}
