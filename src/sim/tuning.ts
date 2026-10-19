// Every number that affects game feel lives here so the debug panel can tune it live.
// When something feels off, change it with the sliders first, then copy the values back here.
export const tuning = {
  // Balance: spring-damper that pulls the pelvis/chest/head upright and toward the facing direction.
  balanceKp: 600,
  balanceKd: 40,
  // Limb pose controllers (legs walking, arms reaching).
  limbKp: 220,
  limbKd: 18,
  // Cap on controller angular acceleration, prevents explosions when far from the target.
  maxAngAccel: 900,

  // Hover spring that holds the pelvis at standing height (legs mostly animate, this carries the weight).
  standHeight: 1.02,
  hoverKp: 120,
  hoverKd: 14,
  maxStepUp: 0.3,

  // Locomotion.
  moveSpeed: 4.2,
  moveAccel: 9,
  airControl: 0.25,
  jumpImpulse: 5.2,
  turnLean: 0.12,

  // Walk cycle.
  stepRate: 2.6,
  strideAngle: 0.65,
  kneeBend: 0.9,
  armSwing: 0.45,

  // Grab.
  grabRadius: 0.2,
  grabBreakForce: 0, // reserved: 0 = unbreakable

  // Hits and stun.
  shoveImpulse: 14,
  stunFloor: 0.04, // stiffness multiplier while fully stunned
  stunTime: 1.4, // seconds to recover to full stiffness
  stunPerImpulse: 0.1, // stun seconds added per unit of impulse

  // World.
  gravity: -18,
  killY: -15,
};

export type Tuning = typeof tuning;
