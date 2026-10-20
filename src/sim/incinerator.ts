// "Incinerator": an industrial room on a ledge over a drop, built around a furnace fed by a conveyor belt.
// Inspired by the Gang Beasts map of the same name.
//
//            back wall
//   ┌──────────┬──[ FURNACE ]──┬───────────┐
//   │ catwalk  │    ║belt║     │ side room │
//   │ (raised) │    ║ ↓↓ ║     │  (guns)   │
//   │   ramp   │    ║    ║     └──door─────┤
//   │    ║     │                           │
//   └────╨─────── parapet ── gap ──────────┘   ← drop on the far side of the parapet
//
// Coordinates: floor top at y = 0, the furnace at the back (-z), the open front at +z.
import type { V3 } from './sim';
import type { WeaponKind } from './weapons';

export interface ArenaBuilder {
  box(pos: V3, half: V3, color: number, opts?: { rotY?: number; rotX?: number; emissive?: number; belt?: boolean; friction?: number }): void;
  crate(pos: V3, size: number, color: number): void;
  pickup(kind: WeaponKind, pos: V3): void;
}

export interface Box3 { min: V3; max: V3 }

/** Map data the simulation's hazards use. */
export const INCINERATOR = {
  spawns: [
    { x: -3, y: 0, z: 3.8 },
    { x: 3, y: 0, z: 3.8 },
    { x: -4.5, y: 0, z: 0.5 },
    { x: 4.5, y: 0, z: 0.8 },
  ] as V3[],
  /** Touch this and you're incinerated. */
  fire: { min: { x: -1.5, y: -0.5, z: -7.2 }, max: { x: 1.5, y: 2.4, z: -5.5 } } as Box3,
  /** The conveyor: anything resting on it is carried toward the furnace (-z). */
  belt: { min: { x: -1.2, y: 0.15, z: -5.6 }, max: { x: 1.2, y: 1.6, z: 1.5 } } as Box3,
  beltSpeed: 1.5,
  /** Where crates appear on the belt. */
  beltSpawn: { x: 0, y: 1.6, z: 0.9 } as V3,
  /** The furnace's periodic flame burst covers this. */
  burst: { min: { x: -1.5, y: 0, z: -5.6 }, max: { x: 1.5, y: 2.6, z: -2.0 } } as Box3,
  furnaceMouth: { x: 0, y: 1.1, z: -5.4 } as V3,
};

const C = {
  floor: 0x5d6066,
  stripe: 0xe3b21b,
  parapet: 0x3b4047,
  wall: 0x5c3f35,
  iron: 0x2c2d31,
  rust: 0x7a4426,
  fire: 0xff6a1a,
  belt: 0x26272b,
  rail: 0xe3b21b,
  grate: 0x4c525a,
  room: 0x6f7c74,
  shelf: 0x7a6040,
  crate: 0xb08a58,
};

export function buildIncinerator(b: ArenaBuilder) {
  // ---------------------------------------------------------------- floor and edges
  b.box({ x: 0, y: -0.5, z: -0.5 }, { x: 8, y: 0.5, z: 6.5 }, C.floor);
  // Parapet around the open sides (waist-ish high: you can be knocked over it), with a gap at the front-left.
  const ph = 0.38; // half height
  b.box({ x: 1.75, y: ph, z: 5.9 }, { x: 6.25, y: ph, z: 0.1 }, C.parapet); // front, x -4.5..8
  b.box({ x: -7.6, y: ph, z: 5.9 }, { x: 0.4, y: ph, z: 0.1 }, C.parapet); // front, x -8..-7.2 (gap -7.2..-4.5)
  b.box({ x: -7.9, y: ph, z: -0.6 }, { x: 0.1, y: ph, z: 6.4 }, C.parapet); // left side
  b.box({ x: 7.9, y: ph, z: 1.8 }, { x: 0.1, y: ph, z: 4.0 }, C.parapet); // right side, in front of the side room
  // Yellow rail caps.
  b.box({ x: 1.75, y: ph * 2 + 0.03, z: 5.9 }, { x: 6.25, y: 0.03, z: 0.13 }, C.stripe);
  b.box({ x: -7.6, y: ph * 2 + 0.03, z: 5.9 }, { x: 0.4, y: 0.03, z: 0.13 }, C.stripe);
  b.box({ x: -7.9, y: ph * 2 + 0.03, z: -0.6 }, { x: 0.13, y: 0.03, z: 6.4 }, C.stripe);
  b.box({ x: 7.9, y: ph * 2 + 0.03, z: 1.8 }, { x: 0.13, y: 0.03, z: 4.0 }, C.stripe);
  // Hazard stripes either side of the gap.
  b.box({ x: -5.85, y: 0.005, z: 5.6 }, { x: 1.35, y: 0.01, z: 0.35 }, C.stripe);

  // ---------------------------------------------------------------- back wall and furnace
  b.box({ x: 0, y: 2.5, z: -7.25 }, { x: 8, y: 2.5, z: 0.25 }, C.wall);
  // Furnace: two pillars and a lintel framing a fiery mouth, with a chimney above.
  b.box({ x: -2.05, y: 2, z: -6.1 }, { x: 0.55, y: 2, z: 0.9 }, C.iron);
  b.box({ x: 2.05, y: 2, z: -6.1 }, { x: 0.55, y: 2, z: 0.9 }, C.iron);
  b.box({ x: 0, y: 3.2, z: -6.1 }, { x: 1.5, y: 0.8, z: 0.9 }, C.rust);
  b.box({ x: 0, y: 5.5, z: -6.6 }, { x: 1.0, y: 1.5, z: 0.6 }, C.iron);
  // The fire inside (glowing).
  b.box({ x: 0, y: 1.2, z: -6.95 }, { x: 1.5, y: 1.2, z: 0.05 }, C.fire, { emissive: 1.6 });
  b.box({ x: 0, y: 0.03, z: -6.2 }, { x: 1.5, y: 0.03, z: 0.8 }, C.fire, { emissive: 1.2 });

  // ---------------------------------------------------------------- conveyor
  // Low enough (0.24 m) to step onto: you can walk up the belt, or be dragged onto it.
  b.box({ x: 0, y: 0.12, z: -2.05 }, { x: 1.2, y: 0.12, z: 3.55 }, C.belt, { belt: true, friction: 1.2 });
  // Guard rails along both sides (stop at the start so you can step / be knocked on).
  for (const side of [-1, 1]) {
    // Rails cover the back two thirds; the front of the belt is open so bodies can be dragged on.
    b.box({ x: side * 1.32, y: 0.6, z: -3.05 }, { x: 0.06, y: 0.06, z: 2.45 }, C.rail);
    for (const z of [-5.3, -3.05, -0.8]) b.box({ x: side * 1.32, y: 0.3, z }, { x: 0.05, y: 0.3, z: 0.05 }, C.rail);
  }

  // ---------------------------------------------------------------- catwalk (left) with ramp
  b.box({ x: -6.25, y: 1.9, z: -4.75 }, { x: 1.65, y: 0.1, z: 2.25 }, C.grate);
  for (const [x, z] of [[-4.75, -2.7], [-4.75, -6.8]]) b.box({ x, y: 0.9, z }, { x: 0.1, y: 0.9, z: 0.1 }, C.iron);
  b.box({ x: -6.8, y: 1.0, z: 0 }, { x: 0.8, y: 0.08, z: 2.69 }, C.grate, { rotX: 0.38 });

  // ---------------------------------------------------------------- side room (right): door + windows
  const wh = 1.3; // wall half height
  const t = 0.08;
  // Inner wall at x = 4.6 (from the back wall to the front corner), door z -4.4..-3.2, window z -6.4..-5.0.
  b.box({ x: 4.6, y: wh, z: -6.7 }, { x: t, y: wh, z: 0.3 }, C.room);
  b.box({ x: 4.6, y: 0.5, z: -5.7 }, { x: t, y: 0.5, z: 0.7 }, C.room);
  b.box({ x: 4.6, y: 2.2, z: -5.7 }, { x: t, y: 0.4, z: 0.7 }, C.room);
  b.box({ x: 4.6, y: wh, z: -4.7 }, { x: t, y: wh, z: 0.3 }, C.room);
  b.box({ x: 4.6, y: wh, z: -2.85 }, { x: t, y: wh, z: 0.35 }, C.room);
  b.box({ x: 4.6, y: 2.35, z: -3.8 }, { x: t, y: 0.25, z: 0.6 }, C.room); // above the door
  // Front wall at z = -2.5 with a window x 5.6..7.0.
  b.box({ x: 5.1, y: wh, z: -2.5 }, { x: 0.5, y: wh, z: t }, C.room);
  b.box({ x: 6.3, y: 0.5, z: -2.5 }, { x: 0.7, y: 0.5, z: t }, C.room);
  b.box({ x: 6.3, y: 2.2, z: -2.5 }, { x: 0.7, y: 0.4, z: t }, C.room);
  b.box({ x: 7.5, y: wh, z: -2.5 }, { x: 0.5, y: wh, z: t }, C.room);
  b.box({ x: 7.95, y: wh, z: -4.75 }, { x: 0.05, y: wh, z: 2.25 }, C.room); // outer wall
  // Shelves.
  b.box({ x: 6.3, y: 0.55, z: -6.75 }, { x: 1.4, y: 0.04, z: 0.25 }, C.shelf);
  b.box({ x: 6.3, y: 1.25, z: -6.75 }, { x: 1.4, y: 0.04, z: 0.25 }, C.shelf);

  // ---------------------------------------------------------------- loose crates
  b.crate({ x: 3.2, y: 0.4, z: 2.6 }, 0.35, C.crate);
  b.crate({ x: -3.5, y: 0.4, z: -1.5 }, 0.35, C.crate);
  b.crate({ x: -6.2, y: 2.4, z: -6 }, 0.3, C.crate);
  b.crate({ x: 6.8, y: 0.4, z: -4.2 }, 0.3, C.crate);

  // ---------------------------------------------------------------- weapons
  b.pickup('pistol', { x: -6.3, y: 2.0, z: -4.2 }); // on the catwalk
  b.pickup('shotgun', { x: 6.2, y: 0, z: -5.6 }); // in the side room
  b.pickup('pistol', { x: 4.5, y: 0, z: 3.2 });
  b.pickup('grenade', { x: -3, y: 0, z: -5.6 }); // by the furnace
}

export function inBox(p: V3, b: Box3) {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
}
