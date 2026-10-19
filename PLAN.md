# Lunch Stars — Plan

3D active-ragdoll party brawler with guns (Gang Beasts + guns). 2–4 players, knock opponents into hazards, no health bars.

Work one phase at a time. A phase is done only when its "done when" is true. Commit after every working step.

| Phase | Goal | Done when | Status |
|---|---|---|---|
| 0 | Vite + TS + Three + Rapier, floor, falling bodies, camera | Physics and rendering are in sync | ✅ |
| 1 | Jointed ragdoll, balance controller, debug sliders | It stands, gets shoved, recovers in a way that makes you smile | ✅ first pass — keep tuning |
| 2 | Walk cycle, jump, hand grabbing, 3rd-person camera | You can wrestle a physics crate around | ✅ first pass — lifting heavy things is weak |
| 3 | Guns: aim, hitscan/projectiles, knockback, stun, pickups | Shooting someone off a ledge feels great | next |
| 4 | Hazards (pit, lava, spikes, mover), elimination, rounds, scoreboard | Full local match vs dummy / 2nd keyboard | |
| 5 | PeerJS lobby, host-authoritative sim, snapshots + interpolation | Two browsers on different networks play a full match | |
| 6 | Polish: juice, toon look, customization, audio, settings, perf | 60 FPS on a mid laptop and it feels great | |
| 7 | (optional) Dedicated Node/Colyseus server | 6–8 players, no host advantage | |

## Scope rules
- Weapons v1: pistol (light knockback), shotgun (huge, short range), grenade/rocket (chaos).
- Maps v1: "Cafeteria" (floating floor over a pit) + one more.
- Mode: last one standing, best of 5.

## Phase 3 notes (next)
- `Sim.shoveRay` is already the core of a hitscan gun: ray + impulse + stun. Weapons = that plus ammo, spread, cooldown, and an owner.
- Guns attach to a hand (fixed joint to forearm). Aim = arms driven toward camera pitch/yaw (same code path as grab reach).
- Pickups are sensor colliders at spawn points.

## Known feel issues / tuning backlog
- Grab reach takes ~0.8 s; consider stronger arm gains while grabbing.
- One-handed lifting of a 20 kg crate doesn't work; two hands + stronger arms, or lighter props.
- Slight residual wobble (~5°) after recovering from a knockdown.
