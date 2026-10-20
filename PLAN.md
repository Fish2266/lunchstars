# Lunch Stars — Plan

3D active-ragdoll party brawler with guns (Gang Beasts + guns). 2–4 players, knock opponents into hazards, no health bars.

Work one phase at a time. A phase is done only when its "done when" is true. Commit after every working step.

| Phase | Goal | Done when | Status |
|---|---|---|---|
| 0 | Vite + TS + Three + Rapier, floor, falling bodies, camera | Physics and rendering are in sync | ✅ |
| 1 | Jointed ragdoll, balance controller, debug sliders | It stands, gets shoved, recovers in a way that makes you smile | ✅ first pass — keep tuning |
| 2 | Walk cycle, jump, hand grabbing, 3rd-person camera | You can wrestle a physics crate around | ✅ first pass — lifting heavy things is weak |
| 3 | Guns: aim, hitscan/projectiles, knockback, stun, pickups | Shooting someone off a ledge feels great | ✅ first pass — needs real-player feel test |
| 4 | Hazards, elimination, rounds, scoreboard (Incinerator map) | Full local match vs dummy / 2nd keyboard | ✅ first pass |
| 5 | PeerJS lobby, host-authoritative sim, snapshots + interpolation | Two browsers on different networks play a full match | next |
| 6 | Polish: juice, toon look, customization, audio, settings, perf | 60 FPS on a mid laptop and it feels great | |
| 7 | (optional) Dedicated Node/Colyseus server | 6–8 players, no host advantage | |

## Scope rules
- Weapons v1: pistol (light knockback), shotgun (huge, short range), grenade/rocket (chaos).
- Maps v1: "Cafeteria" (floating floor over a pit) + one more.
- Mode: last one standing, best of 5.

## Phase 3 (done, first pass)
- Pistol (12 ammo, light knockback), shotgun (6 ammo, 8 pellets, launches), grenade (3, 1.8 s fuse, launches anyone within 3.8 m).
- Unarmed fire = short punch. Walk over a floating gun to pick it up (only when unarmed); it respawns after 8 s. Empty weapon disappears.
- Dummy bot in the panel: idle / chase / chase + shoot.
- Measured: shotgun at 3 m pushes ~3–4.5 m and knocks down; grenade launches a dummy 5–8 m up; pistol ~0.4 m per hit.

## Phase 4 notes (next)
- `Sim.step` already respawns below `killY`; turn that into elimination + round state in the sim (pure), with a `round` SimEvent stream.
- Hazards: lava/spikes as sensor colliders → elimination or huge stun+impulse.

## Locomotion rework (Gang Beasts feel)
- Removed the puppet-string support: legs and spine now carry weight through internal force pairs.
- Replaced the sine-wave walk with foot placement: planted feet stay put (≈5 cm drift vs. sliding at body speed before), steps alternate ~5/s, feet lift ~12 cm.
- Added waddle, hip twist, acceleration lean, hip bob, floppier head/arms. Knocked-down characters scramble back up through their legs.
- Round 2: neck muscle holds the head up; walking now pushes off the planted foot (no force at the hips), steps are slower and weightier (~3.5/s) with a sideways weight shift over the stance foot; leg swing kicks back on the hips. Any hit causes a 0.4 s stagger (no footing, no braking) so knockback still carries. Knockback raised to compensate: pistol ~1.1 m per hit, shotgun ~2.5 m.

## Gun handling & polish (done, first pass)
- Guns are real objects: big hits (≥ 40 knockback in one tick, e.g. a close shotgun blast or a grenade) knock your gun loose, keeping its ammo. Empty guns get tossed and vanish after 3 s.
- Pick up by walking over a gun while unarmed, or by grabbing one (swaps with what you hold). X / middle mouse throws your gun; a thrown gun bonks whoever it hits.
- Feel: arm recoil kick, camera recoil climb, hit-marker on the crosshair, shell casings (brass / red shotgun shells).
- Models: pistol, shotgun, pineapple grenade (live ones blink red), cartoon faces on heads.
- Gore: pulsing cartoon blood fountains pinned to the wound, streaky droplets, splat decals. Panel → Gore: blood / ketchup & mustard / off, amount, "Mop the floor".
- The bot fetches the nearest gun when unarmed.

## Hands & controls (done)
Gang Beasts PC uses one input per hand (tap = punch, hold = grab). We use:
- WASD move, Space jump, Q / E = left / right hand: tap to punch, hold to grab (crates, players, ledges) or to hold an item.
- An item stays only while its hand key is held; let go and it drops (tossed along with the hand's motion — swing and release to throw).
- Reach toward a gun (floating or on the floor) while holding a hand key to pick it up into that hand.
- Left mouse uses the active hand's item; M switches active hand when both hold something.
- Grenades are single use: one per pickup, thrown with left mouse.
- Being knocked silly (stiffness < 0.35) or a big hit makes both hands let go.
- Every binding is remappable (Esc → Controls & settings), saved per browser, plus mouse sensitivity / invert.
- Characters render as one seamless glossy gummy mesh each (skinned to the physics parts), with mitten hands, feet and a face. Physics bodies are unchanged.
- Punches snap out in ~4 frames; held hands come up in ~4 frames. Switch hands defaults to M.

## Knockouts (done)
- Hidden KO meter per player. Punch 22 (head ×2), shots scale with knockback (head ×1.5), thrown-gun bonk 30, explosions up to 90. Drains only 5/s, and only after 2.5 s without a hit. ~4 landed punches knock someone out.
- Knocked out: fully limp, drops items, X eyes + circling stars, can be dragged/thrown. Mashing hand/jump keys shortens it a little. Wakes groggy (stiffness ramps back).
- Each KO this life makes the next one easier and longer: threshold 100 → 75% → 56% … (min 35%), duration 4 s → +2 s each (max 12 s). Currently per life; becomes per round in Phase 4.
- Debug HUD (panel → "Debug HUD (KO, stats)") shows meters/timers; not shown in normal play. KO numbers are in the panel's Knockouts folder.
- Blood only from guns and explosions; droplets re-check the ground as they fly, so no puddles over the pit.

## Hit detection
- Punches and bullets are swept spheres (punch 0.28 m, pistol 6 cm, pellets 4.5 cm), so close-range near misses count. Punch reach ≈ 1.3 m chest-to-chest.
- The crosshair turns into a yellow ring whenever a punch would land (same sweep as the real punch).

## Phase 4: the Incinerator (done, first pass)
Inspired by the Gang Beasts map: an industrial room on a ledge with a furnace at the back fed by a conveyor.
- Elimination: over the waist-high parapet (or through the gap at front-left) → fall; into the furnace mouth → incinerated. In a match you're out for the round; Practice (panel) respawns instead.
- Conveyor (moving hazard): low enough to walk onto; carries anything on it into the furnace at 1.5 m/s. Standing players walk relative to it (you can walk off); limp bodies get dragged. Crates drop onto it every ~5 s.
- Furnace burst (survivable hazard, replaces spikes): every 9 s it glows for 1.3 s, then blasts flame over the belt: big push out of the mouth + 45 KO.
- Catwalk with ramp (left), side room with door/windows and guns (right).
- Rounds: 3-2-1 countdown (frozen), last one standing, first to 3 wins, rematch with Jump (or auto after 12 s). KO escalation resets each round. Score pips, banners, kill feed, slow-mo on eliminations, spectate the survivor.
- Carrying: anything you hold (a KO'd player, a crate) is partly lifted and pulled along with you.
- Bot: avoids the furnace/belt/edges, and tries to drag KO'd players onto the belt (works sometimes; it's slow against a 4 s knockout).
- Empty guns smoke on the ground until they vanish; blood puddles fade out (and fade away between rounds).

## Known feel issues / tuning backlog
- Grab reach takes ~0.8 s; consider stronger arm gains while grabbing.
- One-handed lifting of a 20 kg crate doesn't work; two hands + stronger arms, or lighter props.
- Slight residual wobble (~5°) after recovering from a knockdown.
- Aiming arms sway ±8° for ~0.7 s after a fast flick (cosmetic: shots use the crosshair aim, not the arm).
- Weapon sliders aren't saved to localStorage yet (only `tuning` is).
- Bot hauling to the furnace only succeeds sometimes before the target wakes up.
