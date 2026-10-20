# Performance & code audit (before multiplayer)

Measured in Chrome on the dev build, Incinerator map, 2 players.

## Numbers

| What | Measured | Notes |
|---|---|---|
| Simulation step | 0.2–0.4 ms per 60 Hz tick | ~2% of a frame; ~0.8 ms expected at 4 players |
| Render submit (CPU) | ~1.1 ms per frame | |
| Draw calls | 236 | Mostly many small static boxes (rails, posts, stripes, signs) |
| Triangles | ~104k | Each gummy body is ~17k; fire sheets, spheres |
| Shader programs | 18 | |
| Lights | 13 → **9** | Every light costs on every lit pixel of the clearcoat/sheen body material |
| Body mesh build | ~230 ms, once at load | Marching cubes + skin weights |
| Bundle | 5.07 MB (1.87 MB gzip) | Mostly `@dimforge/rapier3d-compat` with the WASM inlined as base64 |

Nothing here is a frame-rate problem on a desktop. The GPU cost on weaker laptops is dominated by lights × glossy materials, which is why the light count was cut.

## Fixed in this pass

1. **Black characters when limbs twist.** Ball joints let a limb spin all the way round its own axis; linear-blend skinning pinches the skin to nothing ("candy wrapper"), normals degenerate and render black. The renderer now clamps each bone's twist relative to its parent (chest 40°, head 57°, upper arm 57°, thigh 40°, forearm 29°, shin 20°) before skinning. Physics untouched. Verified: a thigh twisted 170° in physics draws at 40°.
2. **Game ran behind the start menu.** The match started at page load. Now nothing simulates until Play is pressed (the match starts then), and the game pauses whenever the menu is open (Esc).
3. **Memory leak in effects.** Every puff, ember, tracer and flash created a material (and tracers a geometry) that was removed from the scene but never disposed. They're now disposed when the effect ends.
4. **Lights 13 → 9.** Press beacons are emissive-only (no light of their own); the effect flash pool is 2 lights instead of 4.
5. **Per-frame waste.** Crosshair raycast list cached on scene build instead of rebuilt every frame; camera/ground vectors reused; blood fade check no longer copies an array every frame.
6. **`main.ts` split up** (347 → ~200 lines): `client/camera.ts` (camera rig + no-clip), `client/hud.ts` (hand slots, help line, debug HUD), game folders moved into `client/debug.ts`.
7. **`GameView` snapshot.** `Sim.view()` returns all non-transform state as plain serializable data (match, furnace, presses, per-player hands/grips/KO/stiffness). The HUD, match HUD and knocked-out faces now read only the view, not the sim — which is exactly what a multiplayer client will receive.
8. **Dead code removed** (old per-part gummy models, `shoveRay`, `rightHand`, belt-speed no-op) and `noUnusedLocals` / `noUnusedParameters` turned on so it stays out. Floating gun spawners are kept, exposed via `ArenaBuilder.pickup`, for maps that want them.

## Still to do before / during multiplayer

Ordered by when it matters.

1. ~~**Incremental scene updates.**~~ Done (Phase 5): `Renderer.sync` only builds entities it hasn't seen; entities are never removed (players who leave are parked), so nothing needs disposing.
2. ~~**Snapshot only what moves.**~~ Done: snapshots carry only `sim.dynamicIndices()` (~100 entities with 3 players), 14 bytes each (int16 positions, int16 quaternion components — smallest-three wasn't worth it) → ~1.4 KB per snapshot. Sent every 3 ticks.
3. ~~**Client-side reads of the sim.**~~ Done: aim origin and camera follow come from the transforms array; the reach ring is `PlayerView.inReach`.
4. **Tuning is a global mutable singleton.** Mostly moot now — clients never step physics, so only the host's tuning matters. The panel still shows on clients and its sim buttons do nothing there.
5. **Bundle size.** Switch to the non-compat `@dimforge/rapier3d` (separate, streamed `.wasm`) or at least split Rapier and Three into their own cached chunk; host with compression (Cloudflare Pages / Netlify do this).
6. **Optional: batch static geometry.** Merging static boxes by material would cut ~140 draw calls. Not needed at current numbers.
7. **Naming.** The pit flare still lives in `Sim.furnace` / `furnace` events from the old furnace map — rename to `flare` when convenient.
8. **Known flaky:** once in testing a round didn't end after an elimination; not reproduced since (likely the test harness running alongside the page loop). Watch for it.

## What's already in good shape for multiplayer

- The sim is pure (no DOM, no rendering) and steps at a fixed 60 Hz from a `Map<id, PlayerInput>`.
- `PlayerInput` and every `SimEvent` are plain objects — ready for the wire as-is (events on the reliable channel).
- All gameplay randomness uses the sim's seeded PRNG; cosmetic randomness (effects, gore) is client-only.
- Entity indices are stable for a match (pools for grenades, loose guns, crates), so snapshot arrays line up.
- The bot produces `PlayerInput` exactly like a human, so it can run on the host for fill-in players.
