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
    i.moveX = 0; i.moveZ = 0; i.fire = false; i.grab = false; i.jump = false;
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
