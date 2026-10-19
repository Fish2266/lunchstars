// The only thing a player can send to the simulation. Keep it small: in multiplayer this is
// exactly what a client sends to the host every tick.
export interface PlayerInput {
  /** World-space desired move direction on the XZ plane, length 0..1. */
  moveX: number;
  moveZ: number;
  /** Aim yaw (radians, 0 = facing +Z) and pitch (radians, + = up). */
  aimYaw: number;
  aimPitch: number;
  jump: boolean;
  grab: boolean;
}

export function emptyInput(): PlayerInput {
  return { moveX: 0, moveZ: 0, aimYaw: 0, aimPitch: 0, jump: false, grab: false };
}
