import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Bot, type BotMode } from './client/bot';
import { Controls } from './client/controls';
import { keyFor, loadSettings } from './client/bindings';
import { Menu } from './client/menu';
import { createDebugPanel, loadSavedTuning } from './client/debug';
import { Effects } from './render/effects';
import { Renderer } from './render/renderer';
import type { PlayerInput } from './sim/input';
import { DT, koThreshold, PLAYER_COLORS, Sim } from './sim/sim';
import { tuning } from './sim/tuning';
import { explosive, handling, punch, weapons, type WeaponKind } from './sim/weapons';
import { Gore, goreSettings } from './render/gore';
import { animateModels } from './render/models';

const LOCAL_ID = 0;
const DUMMY_ID = 1;

async function main() {
  await RAPIER.init();
  loadSavedTuning();
  loadSettings();

  const sim = new Sim(RAPIER);
  const me = sim.addPlayer(LOCAL_ID);
  const dummy = sim.addPlayer(DUMMY_ID);
  const bot = new Bot(sim, DUMMY_ID, LOCAL_ID);

  const renderer = new Renderer(document.body);
  const effects = new Effects(renderer.scene, LOCAL_ID);
  // Ground height under a point, from the level geometry (used by blood splats and casings).
  const downRay = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  let staticMeshes: THREE.Object3D[] = [];
  const groundAt = (p: { x: number; y: number; z: number }) => {
    downRay.set(new THREE.Vector3(p.x, p.y + 0.05, p.z), DOWN);
    downRay.far = 40;
    const hit = downRay.intersectObjects(staticMeshes, false)[0];
    return hit ? hit.point.y : -Infinity;
  };
  const gore = new Gore(renderer.scene, groundAt);
  const crosshair = document.getElementById('crosshair')!;
  let hitMarkerTimer = 0;
  const controls = new Controls(renderer.gl.domElement);
  const menu = new Menu(controls, renderer.gl.domElement);
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
  // Items only stay in a hand while its key is held, so "give" drops one into your right hand — hold the right-hand key to keep it.
  const give = { weapon: 'pistol' as WeaponKind, give: () => sim.giveWeapon(LOCAL_ID, give.weapon, 1) };
  wf.add(give, 'weapon', ['pistol', 'shotgun', 'grenade']).name('debug weapon');
  wf.add(give, 'give').name('Spawn weapon at my hand');
  const botFolder = gui.addFolder('Dummy');
  botFolder.add(bot, 'mode', ['idle', 'chase', 'chase + shoot'] satisfies BotMode[]).name('behavior');
  botFolder.add({ arm: () => sim.giveWeapon(DUMMY_ID, 'pistol', 1) }, 'arm').name('Give dummy a pistol');
  const hf = wf.addFolder('handling');
  hf.add(handling, 'dropThreshold', 5, 200, 1).name('hit to drop gun');
  hf.add(handling, 'throwSpeed', 0, 25, 0.5).name('throw speed');
  hf.add(handling, 'throwKnockback', 0, 30, 0.5).name('thrown gun bonk');
  hf.add(handling, 'grabReach', 0.1, 1, 0.01).name('grab reach');
  hf.close();
  // Debug-only HUD: knockout meters and timers for everyone. Never shown in normal play.
  const debugHud = document.createElement('div');
  debugHud.id = 'debughud';
  document.body.appendChild(debugHud);
  const debugOpts = { showHud: false };
  gui.add(debugOpts, 'showHud').name('Debug HUD (KO, stats)');
  const ko = gui.addFolder('Knockouts');
  ko.add(tuning, 'koThreshold', 20, 300, 5).name('KO at');
  ko.add(tuning, 'koPunch', 0, 60, 1).name('per punch');
  ko.add(tuning, 'koHeadMult', 1, 4, 0.1).name('head multiplier');
  ko.add(tuning, 'koShot', 0, 40, 1).name('per shot');
  ko.add(tuning, 'koBonk', 0, 80, 1).name('thrown-gun bonk');
  ko.add(tuning, 'koBlast', 0, 200, 5).name('explosion');
  ko.add(tuning, 'koDecay', 0, 60, 1).name('drain / s');
  ko.add(tuning, 'koDecayDelay', 0, 6, 0.1).name('drain delay');
  ko.add(tuning, 'koRepeatEase', 0.3, 1, 0.01).name('repeat KO ease');
  ko.add(tuning, 'koTimePerRepeat', 0, 5, 0.25).name('repeat KO +s');
  ko.add(tuning, 'koTime', 0.5, 12, 0.5).name('KO seconds');
  ko.add(tuning, 'koMash', 0, 0.5, 0.01).name('mash cuts');
  ko.close();
  const gf = gui.addFolder('Gore');
  gf.add(goreSettings, 'mode', ['blood', 'ketchup & mustard', 'off']);
  gf.add(goreSettings, 'amount', 0, 3, 0.05);
  gf.add({ clear: () => gore.clear() }, 'clear').name('Mop the floor');

  const help = document.getElementById('help')!;
  const renderHelp = () => {
    help.innerHTML = `<b>${keyFor('forward')}${keyFor('left')}${keyFor('back')}${keyFor('right')}</b> move · <b>${keyFor('jump')}</b> jump · `
      + `<b>${keyFor('handL')}</b> / <b>${keyFor('handR')}</b> left / right hand: tap to punch, hold to grab or hold a gun (let go = drop)<br />`
      + `<b>${keyFor('fire')}</b> shoot / throw grenade · <b>${keyFor('cycle')}</b> switch hands · `
      + `<b>${keyFor('shoveDummy')}</b> shove dummy · <b>${keyFor('reset')}</b> reset · <b>${keyFor('panel')}</b> tuning · <b>Esc</b> menu`;
  };
  renderHelp();
  menu.onBindingsChanged = renderHelp;
  const hud = {
    slots: [...document.querySelectorAll<HTMLElement>('#hud .slot')],
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
    const hit = raycaster.intersectObjects(pickable(), true)[0];
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

  function frame(now: number) {
    const frameDt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (controls.consume('reset')) { sim.resetAll(); gore.clear(); }
    if (controls.consume('shoveDummy')) shoveDummy();
    if (controls.consume('panel')) gui.show(gui._hidden);

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
    // Transforms first, so effects can pin blood to where body parts are now.
    if (renderer.sync(sim.entities, sim.entityVersion)) {
      staticMeshes = renderer.meshes.filter((_, i) => sim.entities[i].role === 'static');
    }
    sim.writeTransforms(transforms);
    for (const e of sim.drainEvents()) {
      effects.handle(e);
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
    effects.update(frameDt);
    gore.update(frameDt, transforms);
    animateModels(now / 1000);
    hitMarkerTimer = Math.max(0, hitMarkerTimer - frameDt);
    crosshair.classList.toggle('hit', hitMarkerTimer > 0);
    // In punching reach (and a hand free to punch with): the crosshair turns into a ring.
    const fme = sim.fighters.get(LOCAL_ID)!;
    const freeHand = !fme.hands[0].item || !fme.hands[1].item;
    crosshair.classList.toggle('reach', freeHand && fme.koTimer === 0 && sim.punchWouldHit(LOCAL_ID, myInput.aimYaw, myInput.aimPitch));

    // Render.
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
    const both = !!(f.hands[0].item && f.hands[1].item);
    for (const i of [0, 1] as const) {
      const h = f.hands[i];
      const el = hud.slots[i];
      const key = keyFor(i === 0 ? 'handL' : 'handR');
      const html = h.item
        ? `<span class="k">${key}</span><span class="name">${h.item}</span><div class="ammo">${h.item === 'grenade' ? 'throw with ' + keyFor('fire') : `${h.ammo} / ${weapons[h.item].ammo}`}</div>`
        : `<span class="k">${key}</span><span class="name">empty</span>`;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.classList.toggle('active', !!h.item && f.active === i);
      el.classList.toggle('empty', !h.item);
    }
    hud.stun.textContent = both ? `${keyFor('cycle')} to switch hands` : '';

    // Knocked-out faces, and the debug HUD.
    for (const [id, ft] of sim.fighters) renderer.setKnockedOut(id, ft.koTimer > 0);
    debugHud.style.display = debugOpts.showHud ? 'block' : 'none';
    if (debugOpts.showHud) {
      let html = '';
      for (const [id, ft] of sim.fighters) {
        const r = sim.players.get(id)!;
        const color = '#' + PLAYER_COLORS[ft.slot % PLAYER_COLORS.length].toString(16).padStart(6, '0');
        const thr = koThreshold(ft);
        const pct = Math.min(100, (ft.ko / thr) * 100);
        const items = ft.hands.map((h) => h.item ? `${h.item}(${h.ammo})` : '–').join(' / ');
        html += `<div class="p"><b style="color:${color}">${id === LOCAL_ID ? 'You' : 'Dummy'}</b>`
          + (ft.koTimer > 0 ? ` <span class="out">KO ${ft.koTimer.toFixed(1)}s</span>` : '')
          + `<div class="bar"><i style="width:${pct}%"></i></div>`
          + `KO meter ${ft.ko.toFixed(0)}/${thr.toFixed(0)} · KOs ${ft.koCount} · hits ${ft.hitsTaken}<br>`
          + `stiffness ${r.stiffness.toFixed(2)} · stun ${r.stunTimer.toFixed(2)}s · stagger ${r.staggerTimer.toFixed(2)}s · ${r.grounded ? 'grounded' : 'airborne'}<br>`
          + `hands ${items} · active ${ft.active === 0 ? 'L' : 'R'}</div>`;
      }
      if (debugHud.innerHTML !== html) debugHud.innerHTML = html;
    }

    fpsFrames++; fpsTime += frameDt;
    if (fpsTime > 0.5) { stats.fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }
    stats.stiffness = Math.round(me.stiffness * 100) / 100;
    stats.grounded = `${me.grounded ? 'yes' : 'no'} / dummy ${dummy.stiffness.toFixed(2)}`;

    requestAnimationFrame(frame);
  }
  camTarget.set(0, 1.6, 3);
  requestAnimationFrame(frame);

  // Exposed for debugging in the console.
  Object.assign(window, { sim, tuning, weapons, explosive, bot, effects, gore, goreSettings, handling, debugOpts });
}

main();
