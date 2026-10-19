import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Bot, type BotMode } from './client/bot';
import { Controls } from './client/controls';
import { createDebugPanel, loadSavedTuning } from './client/debug';
import { Effects } from './render/effects';
import { Renderer } from './render/renderer';
import type { PlayerInput } from './sim/input';
import { DT, Sim } from './sim/sim';
import { tuning } from './sim/tuning';
import { explosive, punch, weapons, type WeaponKind } from './sim/weapons';

const LOCAL_ID = 0;
const DUMMY_ID = 1;

async function main() {
  await RAPIER.init();
  loadSavedTuning();

  const sim = new Sim(RAPIER);
  const me = sim.addPlayer(LOCAL_ID);
  const dummy = sim.addPlayer(DUMMY_ID);
  const bot = new Bot(sim, DUMMY_ID, LOCAL_ID);

  const renderer = new Renderer(document.body);
  const effects = new Effects(renderer.scene, LOCAL_ID);
  const controls = new Controls(renderer.gl.domElement);
  const transforms = new Float32Array(4096 * 7);

  const stats = { fps: 0, stiffness: 1, grounded: '' };
  const shoveDummy = () => {
    const p = dummy.chest.translation();
    const m = me.chest.translation();
    const d = new THREE.Vector3(p.x - m.x, 0, p.z - m.z).normalize();
    sim.hitscan(undefined, { x: p.x - d.x * 2, y: p.y, z: p.z - d.z * 2 }, { x: d.x, y: 0, z: d.z }, 4, tuning.shoveImpulse, 1);
  };
  const gui = createDebugPanel({ shoveDummy, reset: () => sim.resetAll(), stats });

  // Weapons + bot controls live in the same panel.
  const wf = gui.addFolder('Weapons');
  for (const k of ['pistol', 'shotgun'] as const) {
    const f = wf.addFolder(k);
    f.add(weapons[k], 'knockback', 0, 40, 0.5);
    f.add(weapons[k], 'pellets', 1, 16, 1);
    f.add(weapons[k], 'spread', 0, 0.4, 0.005);
    f.add(weapons[k], 'range', 2, 80, 1);
    f.add(weapons[k], 'falloff', 0, 1, 0.01);
    f.add(weapons[k], 'cooldown', 0.05, 2, 0.01);
    f.add(weapons[k], 'lift', 0, 1.5, 0.01);
    f.add(weapons[k], 'recoil', 0, 20, 0.1);
    f.close();
  }
  const ef = wf.addFolder('grenade');
  ef.add(explosive, 'throwSpeed', 2, 30, 0.5);
  ef.add(explosive, 'throwLift', 0, 10, 0.1);
  ef.add(explosive, 'fuse', 0.3, 4, 0.05);
  ef.add(explosive, 'radius', 1, 8, 0.1);
  ef.add(explosive, 'strength', 0, 40, 0.5);
  ef.add(explosive, 'upBias', 0, 2, 0.05);
  ef.add(explosive, 'stun', 0, 4, 0.05);
  ef.close();
  wf.add(punch, 'knockback', 0, 20, 0.5).name('punch knockback');
  const give = { weapon: 'pistol' as WeaponKind, give: () => sim.giveWeapon(LOCAL_ID, give.weapon) };
  wf.add(give, 'weapon', ['pistol', 'shotgun', 'grenade']).name('debug weapon');
  wf.add(give, 'give').name('Give me weapon (G)');
  const botFolder = gui.addFolder('Dummy');
  botFolder.add(bot, 'mode', ['idle', 'chase', 'chase + shoot'] satisfies BotMode[]).name('behavior');
  botFolder.add({ arm: () => sim.giveWeapon(DUMMY_ID, 'pistol') }, 'arm').name('Give dummy a pistol');

  const hud = {
    weapon: document.querySelector<HTMLElement>('#hud .weapon')!,
    ammo: document.querySelector<HTMLElement>('#hud .ammo')!,
    stun: document.querySelector<HTMLElement>('#hud .stun')!,
  };

  const inputs = new Map<number, PlayerInput>();
  const camTarget = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const aimPoint = new THREE.Vector3();
  let acc = 0;
  let last = performance.now();
  let fpsFrames = 0, fpsTime = 0;

  // Meshes the crosshair ray should ignore: our own body and non-physical fx.
  const pickable = () => renderer.meshes.filter((m, i) => {
    const e = sim.entities[i];
    return m.visible && e.role !== 'fx' && !(e.role === 'player' && e.playerId === LOCAL_ID);
  });

  /**
   * Over-the-shoulder camera means the crosshair ray and the character's aim line differ.
   * Find what the crosshair is on, then aim from the character's aim origin at that point.
   */
  function crosshairAim(input: PlayerInput) {
    camFwd.set(0, 0, -1).applyQuaternion(renderer.camera.quaternion);
    raycaster.set(renderer.camera.position, camFwd);
    raycaster.far = 80;
    const hit = raycaster.intersectObjects(pickable(), false)[0];
    aimPoint.copy(renderer.camera.position).addScaledVector(camFwd, hit ? hit.distance : 80);
    const o = me.aimOrigin();
    const dx = aimPoint.x - o.x, dy = aimPoint.y - o.y, dz = aimPoint.z - o.z;
    const h = Math.hypot(dx, dz);
    // Very close targets give unstable angles; fall back to the camera direction.
    if (h > 1.2) {
      input.aimYaw = Math.atan2(dx, dz);
      input.aimPitch = Math.atan2(dy, h);
    }
  }

  function frame(now: number) {
    const frameDt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (controls.consume('KeyR')) sim.resetAll();
    if (controls.consume('KeyF')) shoveDummy();
    if (controls.consume('KeyG')) give.give();
    if (controls.consume('Backquote')) gui.show(gui._hidden);

    // Fixed-timestep simulation.
    const myInput = controls.read();
    crosshairAim(myInput);
    inputs.set(LOCAL_ID, myInput);
    inputs.set(DUMMY_ID, bot.think(frameDt));
    acc += frameDt;
    while (acc >= DT) {
      sim.step(inputs);
      acc -= DT;
    }
    controls.endFrame();
    for (const e of sim.drainEvents()) effects.handle(e);
    effects.update(frameDt);

    // Render.
    renderer.sync(sim.entities, sim.entityVersion);
    sim.writeTransforms(transforms);
    renderer.applyTransforms(transforms);

    // Over-the-shoulder third-person camera, smoothed, with shake.
    const o = me.aimOrigin();
    camTarget.lerp(new THREE.Vector3(o.x, o.y, o.z), 1 - Math.exp(-frameDt * 12));
    const dist = 3.6;
    const cp = Math.cos(controls.pitch), sp = Math.sin(controls.pitch);
    const fx = Math.sin(controls.yaw) * cp, fy = sp, fz = Math.cos(controls.yaw) * cp;
    const rx = -Math.cos(controls.yaw), rz = Math.sin(controls.yaw);
    const sh = effects.shake * effects.shake * 0.25;
    const jx = (Math.random() - 0.5) * sh, jy = (Math.random() - 0.5) * sh, jz = (Math.random() - 0.5) * sh;
    const cx = camTarget.x - fx * dist + rx * 0.55, cy = camTarget.y - fy * dist + 0.25, cz = camTarget.z - fz * dist + rz * 0.55;
    renderer.camera.position.set(cx + jx, cy + jy, cz + jz);
    renderer.camera.lookAt(cx + fx * 10, cy + fy * 10, cz + fz * 10);
    renderer.focusShadow(camTarget);
    renderer.render();

    // HUD.
    const f = sim.fighters.get(LOCAL_ID)!;
    hud.weapon.textContent = f.weapon ?? 'fists';
    hud.ammo.textContent = f.weapon ? `${f.ammo} / ${weapons[f.weapon].ammo}` : '';
    hud.stun.textContent = me.stiffness < 0.9 ? 'STUNNED' : '';

    fpsFrames++; fpsTime += frameDt;
    if (fpsTime > 0.5) { stats.fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }
    stats.stiffness = Math.round(me.stiffness * 100) / 100;
    stats.grounded = `${me.grounded ? 'yes' : 'no'} / dummy ${dummy.stiffness.toFixed(2)}`;

    requestAnimationFrame(frame);
  }
  camTarget.set(0, 1.6, 3);
  requestAnimationFrame(frame);

  // Exposed for debugging in the console.
  Object.assign(window, { sim, tuning, weapons, explosive, bot, effects });
}

main();
