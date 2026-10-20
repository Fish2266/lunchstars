// "Incinerator": a factory floor around a central fire pit.
//
//            tall back wall (pipes)
//  ┌─────────────────┬───┬─────────────────┐
//  │ platform  ramp  │ ↓ │  ramp  platform │
//  │                 │belt│                 │
//  │ belt → → → ─┐ ┌─┴───┴─┐ ┌─ ← ← ← belt │
//  │             └─│ FIRE  │─┘             │
//  │               │  PIT  │  rails break  │
//  │               └───────┘               │
//  │   spawn                      spawn    │
//  └──────── waist-high wall (drop) ───────┘
//
// - Three conveyor belts run into the pit. Guns only ever arrive on the belts, riding toward the fire,
//   so getting armed means stepping onto a belt next to the pit.
// - The pit is ringed by railing sections that break when a body slams into them or they're shot enough.
// - Every so often the pit flares up and blasts anyone near the rim.
// Coordinates: floor top at y = 0, pit centred on the origin, back wall at -z.
import type { V3 } from './sim';

export interface Box3 { min: V3; max: V3 }

export interface ArenaBuilder {
  box(pos: V3, half: V3, color: number, opts?: { rotY?: number; rotX?: number; emissive?: number; flow?: { x: number; z: number }; friction?: number }): void;
  crate(pos: V3, size: number, color: number): void;
  /** A breakable railing section: solid until a hard hit, then it falls loose. */
  rail(pos: V3, half: V3, color: number): void;
}

export interface Belt {
  /** Anything inside this volume rides the belt. */
  box: Box3;
  /** Belt surface velocity (m/s on the floor plane). */
  vel: { x: number; z: number };
  /** Where guns and crates are dropped onto it (the end away from the pit). */
  spawn: V3;
}

const PIT = 2; // half-width of the pit opening
const BELT_SPEED = 1.6;
// Belts are flush with the floor (recessed conveyors), so you can walk, slide or be dragged straight onto them.
const BELT_TOP = 0.012;
const BELT_HALF_H = 0.11;

/** Map data the simulation's hazards use. */
export const INCINERATOR = {
  spawns: [
    { x: -4.5, y: 0, z: 4.5 },
    { x: 4.5, y: 0, z: 4.5 },
    { x: -4.5, y: 0, z: -3.3 },
    { x: 4.5, y: 0, z: -3.3 },
  ] as V3[],
  /** Below the rim of the pit: incinerated. */
  fire: { min: { x: -PIT, y: -6, z: -PIT }, max: { x: PIT, y: -0.55, z: PIT } } as Box3,
  belts: [
    // Push volumes run 0.6 m past the belt's end so nothing comes to rest balanced on the pit's edge.
    { box: { min: { x: -8.6, y: -0.6, z: -1 }, max: { x: -PIT + 0.6, y: 1.6, z: 1 } }, vel: { x: BELT_SPEED, z: 0 }, spawn: { x: -7.9, y: 1.1, z: 0 } },
    { box: { min: { x: PIT - 0.6, y: -0.6, z: -1 }, max: { x: 8.6, y: 1.6, z: 1 } }, vel: { x: -BELT_SPEED, z: 0 }, spawn: { x: 7.9, y: 1.1, z: 0 } },
    { box: { min: { x: -1, y: -0.6, z: -8 }, max: { x: 1, y: 1.6, z: -PIT + 0.6 } }, vel: { x: 0, z: BELT_SPEED }, spawn: { x: 0, y: 1.1, z: -7.3 } },
  ] as Belt[],
  beltSpeed: BELT_SPEED,
  /** The pit flare hits anyone in here. */
  flare: { min: { x: -3.4, y: -0.6, z: -3.4 }, max: { x: 3.4, y: 3.2, z: 3.4 } } as Box3,
  pitCenter: { x: 0, y: 0, z: 0 } as V3,
  pitHalf: PIT,
};

const C = {
  floor: 0x5d6066,
  stripe: 0xe3b21b,
  parapet: 0x3b4047,
  wall: 0x5c3f35,
  iron: 0x2c2d31,
  rust: 0x7a4426,
  pitWall: 0x6a3420,
  fire: 0xff6a1a,
  belt: 0x26272b,
  rail: 0xe3b21b,
  grate: 0x4c525a,
  pipeA: 0x7a6a3a,
  pipeB: 0x3e6a6e,
  crate: 0xb08a58,
};

export function buildIncinerator(b: ArenaBuilder) {
  // ---------------------------------------------------------------- floor with a hole in the middle
  b.box({ x: 0, y: -0.5, z: 4.5 }, { x: 9, y: 0.5, z: 2.5 }, C.floor); // front (z 2..7)
  b.box({ x: 0, y: -0.5, z: -5 }, { x: 9, y: 0.5, z: 3 }, C.floor); // back (z -8..-2)
  b.box({ x: -5.5, y: -0.5, z: 0 }, { x: 3.5, y: 0.5, z: PIT }, C.floor); // left
  b.box({ x: 5.5, y: -0.5, z: 0 }, { x: 3.5, y: 0.5, z: PIT }, C.floor); // right
  // Hazard stripes around the rim.
  for (const [x, z, hx, hz] of [[0, 2.3, 2.6, 0.18], [0, -2.3, 2.6, 0.18], [-2.3, 0, 0.18, 2.6], [2.3, 0, 0.18, 2.6]]) {
    b.box({ x, y: 0.005, z }, { x: hx, y: 0.008, z: hz }, C.stripe);
  }

  // ---------------------------------------------------------------- the pit
  // Glowing walls down to a bed of fire about a metre and a half below the rim (visible from the floor).
  for (const s of [-1, 1]) {
    b.box({ x: s * (PIT + 0.1), y: -1.0, z: 0 }, { x: 0.1, y: 0.95, z: PIT + 0.2 }, C.pitWall, { emissive: 0.6 });
    b.box({ x: 0, y: -1.0, z: s * (PIT + 0.1) }, { x: PIT + 0.2, y: 0.95, z: 0.1 }, C.pitWall, { emissive: 0.6 });
  }
  b.box({ x: 0, y: -1.5, z: 0 }, { x: PIT, y: 0.08, z: PIT }, C.fire, { emissive: 2.6 });

  // Breakable railing around the rim, with gaps where the belts come in.
  const r = PIT + 0.12;
  const seg = (PIT * 2 + 0.24) / 4; // four sections per side
  const railHalf = { x: seg / 2 - 0.02, y: 0.42, z: 0.04 };
  for (let i = 0; i < 4; i++) {
    const t = -r + seg * (i + 0.5);
    b.rail({ x: t, y: 0.42, z: r }, railHalf, C.rail); // front: full
    if (i === 0 || i === 3) {
      b.rail({ x: t, y: 0.42, z: -r }, railHalf, C.rail); // back: gap for the back belt
      b.rail({ x: -r, y: 0.42, z: t }, { x: railHalf.z, y: railHalf.y, z: railHalf.x }, C.rail); // left: gap for the left belt
      b.rail({ x: r, y: 0.42, z: t }, { x: railHalf.z, y: railHalf.y, z: railHalf.x }, C.rail); // right
    }
  }

  // ---------------------------------------------------------------- conveyor belts into the pit
  const by = BELT_TOP - BELT_HALF_H;
  b.box({ x: -5.3, y: by, z: 0 }, { x: 3.3, y: BELT_HALF_H, z: 1 }, C.belt, { flow: { x: BELT_SPEED, z: 0 }, friction: 1.2 });
  b.box({ x: 5.3, y: by, z: 0 }, { x: 3.3, y: BELT_HALF_H, z: 1 }, C.belt, { flow: { x: -BELT_SPEED, z: 0 }, friction: 1.2 });
  b.box({ x: 0, y: by, z: -5 }, { x: 1, y: BELT_HALF_H, z: 3 }, C.belt, { flow: { x: 0, z: BELT_SPEED }, friction: 1.2 });
  // Chutes the belts feed out of.
  b.box({ x: -8.75, y: 0.9, z: 0 }, { x: 0.25, y: 0.9, z: 1.15 }, C.iron);
  b.box({ x: 8.75, y: 0.9, z: 0 }, { x: 0.25, y: 0.9, z: 1.15 }, C.iron);
  b.box({ x: 0, y: 1.4, z: -7.9 }, { x: 1.15, y: 0.5, z: 0.15 }, C.iron);

  // ---------------------------------------------------------------- walls
  b.box({ x: 0, y: 2.5, z: -8.25 }, { x: 9.2, y: 2.5, z: 0.25 }, C.wall); // back (tall)
  const ph = 0.4;
  b.box({ x: 0, y: ph, z: 7.1 }, { x: 9.2, y: ph, z: 0.1 }, C.parapet); // front
  b.box({ x: -9.1, y: ph, z: -0.6 }, { x: 0.1, y: ph, z: 7.6 }, C.parapet); // left
  b.box({ x: 9.1, y: ph, z: -0.6 }, { x: 0.1, y: ph, z: 7.6 }, C.parapet); // right
  for (const [x, z, hx, hz] of [[0, 7.1, 9.2, 0.13], [-9.1, -0.6, 0.13, 7.6], [9.1, -0.6, 0.13, 7.6]]) {
    b.box({ x, y: ph * 2 + 0.03, z }, { x: hx, y: 0.03, z: hz }, C.stripe);
  }
  // Pipes along the back wall.
  b.box({ x: 0, y: 3.6, z: -7.85 }, { x: 9, y: 0.16, z: 0.16 }, C.pipeA);
  b.box({ x: 0, y: 4.3, z: -7.8 }, { x: 9, y: 0.22, z: 0.22 }, C.pipeB);
  for (const x of [-6, -3, 3, 6]) b.box({ x, y: 2.2, z: -7.85 }, { x: 0.14, y: 2, z: 0.14 }, C.pipeA);

  // ---------------------------------------------------------------- raised platforms (back corners) with ramps
  for (const s of [-1, 1]) {
    b.box({ x: s * 6.6, y: 1.7, z: -6.6 }, { x: 2.4, y: 0.1, z: 1.4 }, C.grate);
    for (const [px, pz] of [[s * 4.4, -5.4], [s * 4.4, -7.8]]) b.box({ x: px, y: 0.8, z: pz }, { x: 0.1, y: 0.8, z: 0.1 }, C.iron);
    // Ramp down the side wall toward the front (high end at the platform).
    b.box({ x: s * 8.1, y: 0.86, z: -3.3 }, { x: 0.7, y: 0.08, z: 2.1 }, C.grate, { rotX: 0.44 });
  }

  // ---------------------------------------------------------------- hood above the pit (scenery)
  b.box({ x: 0, y: 6.6, z: 0 }, { x: 2.6, y: 0.25, z: 2.6 }, C.iron);
  b.box({ x: 0, y: 8.2, z: 0 }, { x: 0.9, y: 1.4, z: 0.9 }, C.rust);

  // ---------------------------------------------------------------- loose crates
  b.crate({ x: -6.5, y: 0.4, z: 4.5 }, 0.35, C.crate);
  b.crate({ x: 6.8, y: 0.4, z: 3.8 }, 0.35, C.crate);
  b.crate({ x: -6.5, y: 2.2, z: -6.8 }, 0.3, C.crate);
  b.crate({ x: 3.6, y: 0.4, z: -5.8 }, 0.3, C.crate);
}

export function inBox(p: V3, b: Box3) {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
}

/** The belt under a point (feet height), or null. */
export function beltAt(p: V3): Belt | null {
  for (const b of INCINERATOR.belts) {
    if (p.x > b.box.min.x && p.x < b.box.max.x && p.z > b.box.min.z && p.z < b.box.max.z && p.y > -0.15 && p.y < 0.45) return b;
  }
  return null;
}
