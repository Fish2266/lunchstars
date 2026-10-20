// Every number that affects game feel lives here so the debug panel can tune it live.
// When something feels off, change it with the sliders first, then copy the values back here.
export const tuning = {
  // Balance: spring-damper that pulls the pelvis/chest/head upright and toward the facing direction.
  balanceKp: 600,
  balanceKd: 40,
  // Limb pose controllers (legs walking, arms reaching).
  limbKp: 220,
  limbKd: 28,
  // Multiplier on limb gains for arms that are aiming or reaching.
  aimGain: 2.5,
  // Max angular acceleration multiplier for reaching / aiming / punching arms.
  armSnap: 4,
  // Fist speed (m/s) at the start of a punch.
  punchSpeed: 9,
  // Cap on controller angular acceleration, prevents explosions when far from the target.
  maxAngAccel: 900,

  // Torso and head follow the pelvis loosely (multipliers on balance gains) — lower = wobblier.
  torsoGain: 0.75,
  headGain: 1.0,
  // Idle arm gain multiplier — low = floppy arms.
  idleArmGain: 0.3,

  // Leg spring that holds the pelvis at standing height. Its reaction pushes the stance foot into the
  // ground (legSupport = 1), so the legs carry the weight. 0 = old puppet-string behavior.
  standHeight: 1.02,
  legSupport: 1,
  // Fraction of the walking push that goes through the feet (1 = fully physical, 0 = pushed at the hips).
  footPush: 1,
  footGrip: 1.0,
  footGlide: 0.2,
  // Fraction of upper-body weight the spine carries (internal, chest up / pelvis down).
  spineSupport: 0.9,
  hoverKp: 120,
  hoverKd: 14,
  maxStepUp: 0.3,

  // Locomotion.
  moveSpeed: 2.8,
  moveAccel: 6,
  maxMoveAccel: 14, // must stay under foot friction (~1.6 * gravity) or feet skid
  airControl: 0.25,
  jumpImpulse: 5.2,
  turnLean: 0.1,
  accelLean: 0.07,
  turnRate: 7,

  // Walk cycle.
  // Foot placement: a foot steps when it falls `stepDist` behind where it should be.
  stepTime: 0.28, // seconds per step
  stepDist: 0.3,
  stepHeight: 0.13,
  stepLead: 0.14, // how far ahead (in seconds of velocity) a step lands
  stanceWidth: 0.13,
  // Hips shift sideways over the stance foot.
  sway: 0.45,
  swayKp: 45,
  swayKd: 8,
  footDrive: 0.6, // how hard feet are pulled to their targets
  swingReaction: 0.3, // how much of the leg-swing pull kicks back on the hips
  stepVelSmoothing: 8,
  legPoseGain: 0.5, // leg pose stiffness multiplier
  kneeBend: 1.1,
  armSwing: 0.32,
  waddle: 0.06, // side-to-side rock toward the stance leg
  hipTwist: 0.08,
  bob: 0.035,

  // Grab.
  grabRadius: 0.2,
  grabBreakForce: 0, // reserved: 0 = unbreakable

  // Hits and stun.
  shoveImpulse: 14,
  stunFloor: 0.04, // stiffness multiplier while fully stunned
  stunTime: 1.4, // seconds to recover to full stiffness
  staggerTime: 0.4, // seconds of lost footing after any hit
  stunPerImpulse: 0.1, // stun seconds added per unit of impulse

  // Knockouts (Gang Beasts style): hits fill a hidden meter; at `koThreshold` you go limp for a while.
  koThreshold: 100,
  koPunch: 16, // per punch
  koHeadMult: 2.2, // punches and bonks to the head count this much more (shots 1.5x)
  koShot: 9, // per pistol hit / per shotgun pellet scales from knockback
  koBonk: 25,
  koBlast: 80, // at the center of an explosion
  koDecayDelay: 1.2, // seconds after a hit before the meter drains
  koDecay: 14, // meter per second
  koTime: 4, // seconds knocked out
  koTimePerRepeat: 1, // each knockout this life adds this much (up to koTimeMax)
  koTimeMax: 8,
  koMash: 0.06, // seconds cut from a knockout per button press

  // World.
  gravity: -18,
  killY: -15,
};

export type Tuning = typeof tuning;
