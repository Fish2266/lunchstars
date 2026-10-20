// Weapon definitions. Numbers here are feel numbers just like tuning.ts; the debug panel edits them live.
import type { ShapeDesc } from './sim';

export type WeaponKind = 'pistol' | 'shotgun' | 'grenade';
export const WEAPON_KINDS: WeaponKind[] = ['pistol', 'shotgun', 'grenade'];

export interface WeaponDef {
  /** Shots before the weapon is used up. */
  ammo: number;
  /** Seconds between shots. */
  cooldown: number;
  /** Knockback per pellet (hitscan) — same scale as the debug shove. */
  knockback: number;
  /** Pellets per shot (hitscan). */
  pellets: number;
  /** Cone half-angle in radians. */
  spread: number;
  range: number;
  /** Knockback multiplier at max range (linear falloff from 1 at point blank). */
  falloff: number;
  /** Extra upward kick as a fraction of knockback (launches instead of slides). */
  lift: number;
  /** Pushback on the shooter, same scale as knockback. */
  recoil: number;
  /** Upward kick on the gun arm(s) per shot (visual recoil). */
  armKick: number;
  /** Camera pitch kick for the shooter, radians. */
  camKick: number;
  /** Arms used to aim: 1 = right arm, 2 = both. */
  hands: 1 | 2;
  /** Mesh for the held / pickup model, long axis along +Z. */
  shape: ShapeDesc;
  color: number;
}

export const weapons: Record<WeaponKind, WeaponDef> = {
  pistol: {
    ammo: 12, cooldown: 0.28, knockback: 22, pellets: 1, spread: 0.01, range: 60, falloff: 0.7, lift: 0.25, recoil: 0.6, armKick: 2.5, camKick: 0.03,
    hands: 1, shape: { kind: 'box', hx: 0.04, hy: 0.07, hz: 0.14 }, color: 0x2b2d33,
  },
  shotgun: {
    ammo: 6, cooldown: 0.85, knockback: 16, pellets: 8, spread: 0.1, range: 14, falloff: 0.15, lift: 0.55, recoil: 6, armKick: 6, camKick: 0.09,
    hands: 2, shape: { kind: 'box', hx: 0.045, hy: 0.06, hz: 0.36 }, color: 0x6b3f22,
  },
  grenade: {
    ammo: 3, cooldown: 0.7, knockback: 0, pellets: 0, spread: 0, range: 0, falloff: 1, lift: 0, recoil: 0, armKick: 0, camKick: 0,
    hands: 1, shape: { kind: 'ball', r: 0.1 }, color: 0x3c6e2f,
  },
};

/** Grenade / explosion feel. */
export const explosive = {
  throwSpeed: 9,
  throwLift: 3.5,
  fuse: 1.8,
  radius: 3.8,
  /** Velocity change (m/s) at the center, falling off linearly to 0 at `radius`. */
  strength: 16,
  upBias: 0.45,
  /** Stun seconds at the center. */
  stun: 2.6,
};

/** Unarmed: a short shove from the chest. */
export const punch = { range: 1.3, knockback: 9, lift: 0.3, cooldown: 0.4 };

export const PICKUP_RESPAWN = 8;

/** Dropping, throwing and picking up weapons. */
export const handling = {
  /** Knockback taken in one tick that knocks the gun out of your hands (pistol hit = 22, close shotgun ≈ 100). */
  dropThreshold: 40,
  throwSpeed: 10,
  /** Knockback when a thrown gun bonks someone. */
  throwKnockback: 9,
  /** Thrown gun must be at least this fast to bonk. */
  bonkSpeed: 5,
  /** Seconds before a dropped gun can be picked up again by anyone. */
  pickupDelay: 0.5,
  /** Loose guns disappear after this long (empty ones after 3 s). */
  despawn: 25,
  /** How close a hand must be to grab a gun. */
  grabReach: 0.4,
};
