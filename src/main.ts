// Entry point: wires the pure simulation to input, rendering, effects and HUD.
//
// Per frame: read input → step the sim at a fixed 60 Hz → take a GameView snapshot + body transforms →
// feed events to effects/HUD → render. In multiplayer the middle part (stepping) happens on the host and
// clients get the snapshot, transforms and events over the network instead.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { loadSettings } from './client/bindings';
import { Bot } from './client/bot';
import { CameraRig } from './client/camera';
import { Controls } from './client/controls';
import { addGameFolders, createDebugPanel, loadSavedTuning } from './client/debug';
import { Hud } from './client/hud';
import { MatchHud } from './client/matchHud';
import { Menu } from './client/menu';
import { Effects } from './render/effects';
import { PitFire } from './render/fire';
import { Gore, goreSettings } from './render/gore';
import { animateModels } from './render/models';
import { Renderer } from './render/renderer';
import { INCINERATOR } from './sim/incinerator';
import type { PlayerInput } from './sim/input';
import { DT, Sim } from './sim/sim';
import { tuning } from './sim/tuning';
import { explosive, handling, punch, weapons } from './sim/weapons';

const LOCAL_ID = 0;
const DUMMY_ID = 1;

async function main() {
  await RAPIER.init();
  loadSavedTuning();
  loadSettings();

  // ---------------------------------------------------------------- simulation
  const sim = new Sim(RAPIER);
  const me = sim.addPlayer(LOCAL_ID);
  const dummy = sim.addPlayer(DUMMY_ID);
  const bot = new Bot(sim, DUMMY_ID, LOCAL_ID);
  bot.mode = 'chase + shoot';

  // ---------------------------------------------------------------- presentation
  const renderer = new Renderer(document.body);
  const cam = new CameraRig(renderer.camera);
  const effects = new Effects(renderer.scene, LOCAL_ID);
  const groundRay = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const groundFrom = new THREE.Vector3();
  let staticMeshes: THREE.Object3D[] = [];
  /** Height of the level under a point (blood splats and casings land on it). */
  const groundAt = (p: { x: number; y: number; z: number }) => {
    groundRay.set(groundFrom.set(p.x, p.y + 0.05, p.z), DOWN);
    groundRay.far = 40;
    const hit = groundRay.intersectObjects(staticMeshes, false)[0];
    return hit ? hit.point.y : -Infinity;
  };
  const gore = new Gore(renderer.scene, groundAt);
  const pitFire = new PitFire(renderer.scene, INCINERATOR.pitCenter, INCINERATOR.pitHalf, -1.42);
  const matchHud = new MatchHud(LOCAL_ID);
  const hud = new Hud(LOCAL_ID, (id) => matchHud.nameOf(id));
  const crosshair = document.getElementById('crosshair')!;
  let hitMarkerTimer = 0;

  // ---------------------------------------------------------------- input and menus
  const controls = new Controls(renderer.gl.domElement);
  const menu = new Menu(controls, renderer.gl.domElement);
  // The match starts when Play is first pressed, not at page load.
  menu.onFirstPlay = () => { sim.startMatch(); gore.clear(); };
  menu.onBindingsChanged = () => hud.renderHelp();

  // ---------------------------------------------------------------- debug panel
  const stats = { fps: 0, stiffness: 1, grounded: '' };
  const shoveDummy = () => {
    const p = dummy.chest.translation();
    const m = me.chest.translation();
    const d = new THREE.Vector3(p.x - m.x, 0, p.z - m.z).normalize();
    sim.hitscan(undefined, { x: p.x - d.x * 2, y: p.y, z: p.z - d.z * 2 }, { x: d.x, y: 0, z: d.z }, 4, tuning.shoveImpulse, 1);
  };
  const gui = createDebugPanel({ shoveDummy, reset: () => sim.resetAll(), stats });
  addGameFolders(gui, {
    weapons, explosive, punch, handling, goreSettings, bot, hud,
    giveMe: (kind) => sim.giveWeapon(LOCAL_ID, kind, 1),
    giveDummy: () => sim.giveWeapon(DUMMY_ID, 'pistol', 1),
    setPractice: (on) => { if (on) sim.setPractice(); else sim.startMatch(); gore.fadeAll(); },
    mopFloor: () => gore.clear(),
  });

  // ---------------------------------------------------------------- crosshair aiming
  // The over-the-shoulder camera's crosshair ray and the character's aim line differ, so find what the
  // crosshair is on and aim from the character at that point.
  const aimRay = new THREE.Raycaster();
  const camFwd = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  let pickList: THREE.Object3D[] = [];
  function crosshairAim(input: PlayerInput) {
    camFwd.set(0, 0, -1).applyQuaternion(renderer.camera.quaternion);
    aimRay.set(renderer.camera.position, camFwd);
    aimRay.far = 80;
    const hit = aimRay.intersectObjects(pickList.filter((m) => m.visible), true)[0];
    aimPoint.copy(renderer.camera.position).addScaledVector(camFwd, hit ? hit.distance : 80);
    const o = me.aimOrigin();
    const dx = aimPoint.x - o.x, dy = aimPoint.y - o.y, dz = aimPoint.z - o.z;
    const h = Math.hypot(dx, dz);
    // Only when the crosshair is practically on top of us is the angle unstable; then use the camera direction.
    if (h > 0.35) {
      input.aimYaw = Math.atan2(dx, dz);
      input.aimPitch = Math.atan2(dy, h);
    }
  }

  /** Rebuild the raycast lists after the renderer (re)creates its meshes. */
  function onSceneBuilt() {
    staticMeshes = renderer.meshes.filter((_, i) => sim.entities[i].role === 'static');
    pickList = renderer.meshes.filter((_, i) => {
      const e = sim.entities[i];
      return e.role !== 'fx' && !(e.role === 'player' && e.playerId === LOCAL_ID);
    });
    // Thin floor stencils and signs don't stop the camera; presses do.
    cam.blockers = renderer.meshes.filter((_, i) => {
      const e = sim.entities[i];
      return (e.role === 'static' && e.model !== 'sign') || e.model === 'stamper';
    });
  }

  // ---------------------------------------------------------------- frame loop
  const inputs = new Map<number, PlayerInput>();
  const transforms = new Float32Array(4096 * 7);
  let acc = 0;
  let last = performance.now();
  let fpsFrames = 0, fpsTime = 0;

  function frame(now: number) {
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // A beat of slow motion when someone is eliminated.
    matchHud.slowmo = Math.max(0, matchHud.slowmo - realDt);
    const frameDt = realDt * (matchHud.slowmo > 0 ? 0.3 : 1);

    // Debug / match keys.
    if (controls.consume('reset')) {
      if (sim.match.phase === 'practice') sim.resetAll(); else sim.startMatch();
      gore.fadeAll();
    }
    if (sim.match.phase === 'matchOver' && controls.consume('jump')) sim.startMatch(); // rematch
    if (controls.consume('shoveDummy')) shoveDummy();
    if (controls.consume('panel')) gui.show(gui._hidden);

    // Simulate (fixed 60 Hz). Nothing runs behind the menu: before the first Play, or while paused.
    // (Single-player only — a multiplayer host keeps simulating.)
    const myInput = controls.read();
    crosshairAim(myInput);
    inputs.set(LOCAL_ID, myInput);
    inputs.set(DUMMY_ID, bot.think(frameDt));
    if (menu.open) acc = 0; else acc += frameDt;
    while (acc >= DT) {
      sim.step(inputs);
      acc -= DT;
    }
    controls.endFrame();

    // Snapshot: everything below reads only this, the transforms and the events.
    if (renderer.sync(sim.entities, sim.entityVersion)) onSceneBuilt();
    sim.writeTransforms(transforms);
    const view = sim.view();

    for (const e of sim.drainEvents()) {
      effects.handle(e);
      matchHud.handle(e);
      if (e.type === 'countdown') gore.fadeAll();
      if (e.type === 'hit') {
        gore.wound(e, transforms);
        if (e.by === LOCAL_ID && e.player !== LOCAL_ID) hitMarkerTimer = 0.15;
      } else if (e.type === 'shot' && e.first) {
        gore.casing(e.from, e.dir, e.weapon === 'shotgun');
        if (e.player === LOCAL_ID) {
          // Recoil climbs your aim a little; you pull it back down.
          controls.pitch = Math.min(1.0, controls.pitch + weapons[e.weapon].camKick);
          controls.yaw += (Math.random() - 0.5) * weapons[e.weapon].camKick * 0.5;
        }
      }
    }

    // World presentation.
    effects.update(frameDt, transforms, { state: view.furnace, center: INCINERATOR.pitCenter, half: INCINERATOR.pitHalf });
    gore.update(frameDt, transforms);
    pitFire.update(now / 1000, realDt, renderer.camera, view.furnace);
    renderer.setFurnace(view.furnace);
    renderer.setStampers(view.stampers);
    for (const p of view.players) renderer.setKnockedOut(p.id, p.koTimer > 0);
    animateModels(now / 1000);
    renderer.applyTransforms(transforms);

    // Camera: follow yourself, or whoever's left once you're out.
    const follow = me.active ? me.aimOrigin() : ([...sim.players.values()].find((p) => p.active)?.aimOrigin() ?? { x: 0, y: 1.6, z: 1 });
    cam.update(follow, controls.yaw, controls.pitch, effects.shake, frameDt, realDt);
    // Squeezed right up against your own character (a wall or ceiling behind you): don't fill the screen with it.
    renderer.setPlayerHidden(LOCAL_ID, cam.distance < 1.0);
    renderer.focusShadow(cam.pivot);
    renderer.render();

    // HUD.
    hitMarkerTimer = Math.max(0, hitMarkerTimer - frameDt);
    crosshair.classList.toggle('hit', hitMarkerTimer > 0);
    const meView = view.players.find((p) => p.id === LOCAL_ID)!;
    const freeHand = !meView.hands[0].item || !meView.hands[1].item;
    // In punching reach (and a hand free to punch with): the crosshair turns into a ring.
    crosshair.classList.toggle('reach', freeHand && meView.koTimer === 0 && sim.punchWouldHit(LOCAL_ID, myInput.aimYaw, myInput.aimPitch));
    matchHud.update(view, realDt);
    hud.update(view, (p) => (p.id === DUMMY_ID ? `bot: ${bot.state}` : ''));

    fpsFrames++; fpsTime += realDt;
    if (fpsTime > 0.5) { stats.fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }
    stats.stiffness = Math.round(meView.stiffness * 100) / 100;
    stats.grounded = `${meView.grounded ? 'yes' : 'no'} / dummy ${dummy.stiffness.toFixed(2)}`;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Exposed for debugging in the console.
  Object.assign(window, { sim, tuning, weapons, explosive, bot, effects, gore, goreSettings, handling, hud, renderer, controls });
}

main();
