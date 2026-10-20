# Architecture

```
src/
  sim/        PURE simulation — no DOM, no Three rendering, no networking
    sim.ts      World, arena, fixed-step loop, weapons/pickups/grenades, SimEvents, transform snapshot
    weapons.ts  Weapon, explosive, and punch definitions (feel numbers, edited live)
    ragdoll.ts  Active ragdoll: bodies, joints, balance/pose PD controllers, walk cycle, grab
    tuning.ts   Every feel number (edited live by the debug panel)
    input.ts    PlayerInput — the only thing a player sends to the sim
  render/     Three.js scene; draws EntityDesc[] + a flat Float32Array of transforms
    effects.ts  Tracers, flashes, explosions, camera shake — driven only by SimEvents
    gore.ts     Blood fountains/splats + shell casings (pooled InstancedMeshes, client-only)
    models.ts   Display models (guns, grenade, faces); collision still uses simple shapes
  client/     Browser-only: controls (via bindings.ts, remappable), menu.ts (pause + settings), lil-gui tuning panel,
              bot (makes PlayerInput like a human)
  main.ts     Wires it together: input -> sim.step (fixed 60 Hz) -> transforms -> render
```

## Rules
1. **`src/sim` stays pure.** It may import Rapier and Three's *math* classes (Vector3/Quaternion), nothing else from Three, and never `window`/`document`. That lets the same sim run in single-player, on the multiplayer host, or on a Node server.
2. **Inputs in, state out.** `sim.step(Map<playerId, PlayerInput>)` is the only way to drive players. `sim.writeTransforms(Float32Array)` (7 floats per entity: pos + quat) is the only way the renderer reads state. That array is also the network snapshot format in Phase 5.
3. **Fixed timestep.** Physics always steps at `DT = 1/60`; the client uses an accumulator.
4. **Effects come from events.** The sim pushes `SimEvent`s (shot, hit, explosion, pickup…); the client drains them with `sim.drainEvents()`. In multiplayer these become the reliable channel.
5. **Hidden entities** (inactive grenades, held guns not in hand, taken pickups) are parked at `HIDDEN_Y`; the renderer hides anything below -500. Entity lists never shrink mid-game, so snapshot indices stay stable.
6. **Deterministic randomness.** Spread etc. use the sim's seeded PRNG, never `Math.random`.
7. **All feel numbers live in `tuning.ts`** (and `weapons.ts`). Tune with the panel (` key), click "Copy values", paste back into the file.

## Active ragdoll model
- 11 bodies: pelvis, chest, head, 2× thigh/shin, 2× upper arm/forearm. Ball joints, revolute knees/elbows with limits. Each player is in its own collision group so it never collides with itself.
- **No strings.** Nothing external holds the character up. Every support force is an internal pair:
  - *Leg spring*: pushes the pelvis to `standHeight` and pushes the stance feet into the ground by the same amount, so the ground (through the feet) carries the weight.
  - *Spine*: lifts the chest and pushes the pelvis down by the upper body's weight, so the torso controller only has to orient it.
  - Walking pushes off the planted foot: force on the hips, equal and opposite on the stance foot (`footPush` = 1), so you only move when a foot is down.
  - *Neck*, *arm* and *swinging-leg* muscles cancel those parts' weight and push the same amount down on the chest/pelvis (`holdUp`).
  - *Weight shift*: hips are pulled sideways over the stance foot (between both feet at rest), faded out when strafing.
- **Stagger**: any hit removes footing and braking for `staggerTime`, so knockback slides you instead of being absorbed by planted feet.
  The surface under the pelvis doesn't count as ground if it's more than `maxStepUp` above the feet (a crate we walked into).
- **Foot placement** (not a sine wave): each foot is *planted* (pinned where it landed, high friction) or *swinging* (low friction, pulled along an arc to its `home`: under the hip, led by velocity). When a planted foot falls `stepDist` behind its home, it steps. One foot at a time, alternating. Legs are posed to point from hip to foot target, bending the knee mid-swing. In the air or stunned, stepping stops and legs go loose.
- **Pose PD**: every body part gets a torque toward a target world orientation (`drive()`), with gains × `stiffness`. Pelvis/chest/head target upright + facing yaw, plus lean (speed and acceleration), waddle (roll over the stance foot), and hip twist from the stride. Torso, head, and idle arms use lower gain multipliers so they wobble.
- **Stun**: hits add `stunTimer`; `stiffness = clamp(1 - stunTimer/stunTime, stunFloor, 1)`, which also scales the hover spring and locomotion, so a big hit makes the character crumple and then stand back up.
- **Arm hold-up**: arms that aim or reach get gravity cancelled, so the PD only has to orient them. PD torque uses per-axis inertia (thin limbs barely resist twist).
- **Grab**: while held, each hand checks a small sphere at its tip; on overlap it creates a ball joint to that body (players, props, or static level geometry — so you can hang off ledges). Released when the button is let go.

## Running
Node lives in `~/.local/node` (added to PATH in `~/.zshrc`).
```
npm install
npm run dev        # http://localhost:5173
npm run typecheck
```

## Weapons and aiming
- Shots don't come from the gun model. They come from `ragdoll.aimOrigin()` (above the chest) along the input's aim yaw/pitch. The client turns the crosshair into that yaw/pitch by raycasting the rendered scene from the camera and aiming the origin at the hit point (`crosshairAim` in main.ts), so the over-the-shoulder camera stays accurate.
- `Sim.hitscan` is the one knockback path: ray → impulse at the hit point scaled by the target's total mass → stun from the weapon's knockback number.
- Grenades are a fixed pool of 12 bodies, enabled on throw, which don't collide with the thrower.

## Hands
- `PlayerInput` has `handL` / `handR` (held state), `fire`, `cycle`. The sim edge-detects presses.
- `Fighter.hands[0|1]` each hold an item + ammo. Each tick `Sim.updateHands` sets `ragdoll.armMode[i]` to idle / reach / aim / punch, and the ragdoll drives each arm on its own. Reaching hands make grab joints; loose guns are excluded from joints (`ragdoll.ignoreGrab`) because touching one picks it up instead.

## Loose guns
- A pool of 4 physics bodies per weapon kind (stable entity indices). Dropping/throwing enables one at the hand with the held model's transform; picking up disables it. Ammo travels with the gun.
- `Fighter.hitAccum` sums knockback per tick; at `handling.dropThreshold` the gun is knocked loose.

## Gore (why it's cheap)
- `hit` events carry the body part's entity index and the wound point in that part's local frame. The client pins a "wound" emitter there, so fountains ride the ragdoll.
- Droplets are struct-of-arrays ballistic points drawn as one InstancedMesh (stretched along velocity). One ground raycast per wound every 0.25 s; droplets below that height become splats in a ring-buffer InstancedMesh.
- Nothing touches physics or the network.
