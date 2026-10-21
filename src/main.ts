// Entry point: wires the pure simulation to input, rendering, effects, HUD and networking.
//
// Three ways to play, same presentation code for all of them:
// - solo:   step the sim locally (you + a bot); the menu pauses it.
// - host:   step the sim locally with everyone's inputs; send snapshots / view / events to the clients.
//           The host never pauses — other people are playing.
// - client: never step. A local copy of the sim exists only to know the level and the entity list; the
//           world is drawn from the host's snapshots (interpolated), the HUD from the host's GameView.
// Everything after the "world state" step below reads only the transforms, the view and the events.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { keyFor, loadSettings, saveSettings, settings } from './client/bindings';
import { Bot, DIFFICULTIES } from './client/bot';
import { CameraRig } from './client/camera';
import { Controls } from './client/controls';
import { addGameFolders, createDebugPanel, DEBUG, loadSavedTuning } from './client/debug';
import { Hud } from './client/hud';
import { MatchHud } from './client/matchHud';
import { Menu, type MenuMode } from './client/menu';
import { Sound } from './client/audio';
import { NetClient } from './net/client';
import { NetHost } from './net/host';
import type { RosterEntry } from './net/protocol';
import { Effects } from './render/effects';
import { PitFire } from './render/fire';
import { Gore, goreSettings } from './render/gore';
import { animateModels } from './render/models';
import { Renderer } from './render/renderer';
import { INCINERATOR } from './sim/incinerator';
import type { PlayerInput } from './sim/input';
import { DT, Sim, type GameView, type SimEvent, type V3 } from './sim/sim';
import { tuning } from './sim/tuning';
import { explosive, handling, punch, weapons } from './sim/weapons';

const BOT_ID = 1;

async function main() {
  await RAPIER.init();
  loadSavedTuning();
  loadSettings();

  const renderer = new Renderer(document.body);
  const controls = new Controls(renderer.gl.domElement);
  const menu = new Menu(controls, renderer.gl.domElement);

  // ---------------------------------------------------------------- session
  // A ?join=CODE link connects straight away; otherwise we start on the title screen with a solo game ready.
  const sim = new Sim(RAPIER);
  const joinCode = new URLSearchParams(location.search).get('join')?.toUpperCase() ?? null;
  let mode: Exclude<MenuMode, 'title'> = 'solo';
  let localId = 0;
  let host: NetHost | null = null;
  let client: NetClient | null = null;
  const bots = new Map<number, Bot>();
  const roster: RosterEntry[] = [];

  if (joinCode) {
    menu.showStatus('Joining…', `Connecting to room ${joinCode}.`, false);
    hideLoading(); // the "Joining…" card takes over from here
    client = new NetClient();
    try {
      await client.connect(joinCode, 'Player');
    } catch (e) {
      menu.showStatus("Couldn't join", (e as Error).message ?? String(e));
      return;
    }
    mode = 'client';
    localId = client.you;
    menu.mode = 'client';
    // Mirror the host's players in the host's order so entity indices line up.
    const mirror = (r: RosterEntry[]) => {
      for (let i = sim.players.size; i < r.length; i++) sim.addPlayer(r[i].id);
    };
    mirror(client.roster);
    client.onRoster = (r) => { mirror(r); updateLobby(); };
    client.onClosed = (reason) => menu.showStatus('Disconnected', reason);
  } else {
    sim.addPlayer(0);
    sim.addPlayer(BOT_ID);
    const bot = new Bot(sim, BOT_ID, 0);
    bot.mode = 'chase + shoot';
    bot.difficulty = settings.botDifficulty;
    bots.set(BOT_ID, bot);
    roster.push({ id: 0, name: 'Host', bot: false, left: false }, { id: BOT_ID, name: 'Bot', bot: true, left: false, level: bot.difficulty });
  }
  const firstBot = bots.get(BOT_ID) ?? new Bot(sim, -1, -1);

  // ---------------------------------------------------------------- presentation
  const cam = new CameraRig(renderer.camera);
  const effects = new Effects(renderer.scene, localId);
  const groundRay = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const groundFrom = new THREE.Vector3();
  let staticMeshes: THREE.Object3D[] = [];
  /** Height of the level under a point (blood splats and casings land on it). */
  const groundAt = (p: V3) => {
    groundRay.set(groundFrom.set(p.x, p.y + 0.05, p.z), DOWN);
    groundRay.far = 40;
    const hit = groundRay.intersectObjects(staticMeshes, false)[0];
    return hit ? hit.point.y : -Infinity;
  };
  const gore = new Gore(renderer.scene, groundAt);
  const pitFire = new PitFire(renderer.scene, INCINERATOR.pitCenter, INCINERATOR.pitHalf, -1.42);
  const matchHud = new MatchHud(localId);
  matchHud.canRematch = mode !== 'client';
  const hud = new Hud(localId, (id) => matchHud.nameOf(id));
  const sound = new Sound();
  sound.setVolume(settings.volume);
  menu.onVolume = (v) => sound.setVolume(v);
  // Browsers only allow audio after the player interacts with the page.
  const unlockAudio = () => sound.unlock();
  addEventListener('pointerdown', unlockAudio);
  addEventListener('keydown', unlockAudio);
  let lastCountdown = -1;
  /** Spectating (while you're out): whose camera, or the arena overview. */
  let spectate: number | null = null;
  let overview = false;
  let overviewSpin = 0;
  const camRight = new THREE.Vector3();
  const crosshair = document.getElementById('crosshair')!;
  let hitMarkerTimer = 0;

  // ---------------------------------------------------------------- menus and lobby
  function updateLobby() {
    const r = host ? host.roster : client ? client.roster : roster;
    menu.lobby = {
      code: host?.code ?? joinCode ?? '',
      roster: r,
      you: localId,
      matchRunning: (client?.view?.match.phase ?? sim.match.phase) !== 'practice',
      canAddBot: !!host?.hasRoom,
    };
    menu.refresh();
  }
  menu.onBindingsChanged = () => hud.renderHelp();
  menu.onSolo = () => { sim.startMatch(); gore.clear(); };
  menu.onHost = async () => {
    const h = new NetHost(sim, roster);
    await h.open();
    host = h;
    mode = 'host';
    h.onRosterChange = updateLobby;
    // Mess around in practice until the host starts the match.
    sim.setPractice();
    gore.fadeAll();
    updateLobby();
  };
  menu.onStartMatch = () => { sim.startMatch(); gore.fadeAll(); updateLobby(); };
  menu.onEndMatch = () => { sim.endMatch('host'); gore.fadeAll(); updateLobby(); };
  menu.matchRunning = () => sim.match.phase !== 'practice';
  menu.onAddBot = () => {
    const id = host?.addBot('Bot', settings.botDifficulty);
    if (id == null) return;
    const b = new Bot(sim, id, localId);
    b.mode = firstBot.mode === 'idle' ? 'chase + shoot' : firstBot.mode;
    b.difficulty = settings.botDifficulty;
    bots.set(id, b);
  };
  // ‹ › pickers: 'bot' = the solo / default difficulty, 'bot:<id>' = one bot in a hosted game.
  const step = <T,>(list: readonly T[], cur: T, dir: number) => list[(list.indexOf(cur) + dir + list.length) % list.length];
  menu.onPick = (key, dir) => {
    if (key === 'bot') {
      settings.botDifficulty = step(DIFFICULTIES, settings.botDifficulty, dir);
      saveSettings();
      // Solo: the bot changes right away. (Hosting: new bots start at this level; each has its own picker.)
      if (mode === 'solo') for (const b of bots.values()) b.difficulty = settings.botDifficulty;
      const entry = roster.find((r) => r.bot);
      if (mode === 'solo' && entry) entry.level = settings.botDifficulty;
    } else if (key.startsWith('bot:') && host) {
      const id = Number(key.slice(4));
      const b = bots.get(id);
      if (!b) return;
      b.difficulty = step(DIFFICULTIES, b.difficulty, dir);
      host.setBotLevel(id, b.difficulty);
    }
  };
  menu.onRemoveBot = (id) => { host?.removeBot(id); bots.delete(id); };
  if (mode === 'client') { updateLobby(); menu.showPause(); }
  addEventListener('beforeunload', () => { host?.close(); client?.close(); });

  // ---------------------------------------------------------------- debug panel
  const stats = { fps: 0, stiffness: 1, grounded: '', net: '' };
  const shoveDummy = () => {
    if (mode === 'client') return;
    const me = sim.players.get(localId), dummy = [...bots.keys()].map((id) => sim.players.get(id)).find((r) => r?.active);
    if (!me || !dummy) return;
    const p = dummy.chest.translation(), m = me.chest.translation();
    const d = new THREE.Vector3(p.x - m.x, 0, p.z - m.z).normalize();
    sim.hitscan(undefined, { x: p.x - d.x * 2, y: p.y, z: p.z - d.z * 2 }, { x: d.x, y: 0, z: d.z }, 4, tuning.shoveImpulse, 1);
  };
  const gui = createDebugPanel({ shoveDummy, reset: () => { if (mode !== 'client') sim.resetAll(); }, stats });
  addGameFolders(gui, {
    weapons, explosive, punch, handling, goreSettings, bot: firstBot, hud,
    giveMe: (kind) => sim.giveWeapon(localId, kind, 1),
    giveDummy: () => sim.giveWeapon(BOT_ID, 'pistol', 1),
    setPractice: (on) => { if (mode === 'client') return; if (on) sim.setPractice(); else sim.startMatch(); gore.fadeAll(); updateLobby(); },
    mopFloor: () => gore.clear(),
  });

  // ---------------------------------------------------------------- body positions from the transforms
  // (The same on host and client: nothing below touches ragdolls.)
  const transforms = new Float32Array(4096 * 7);
  let chestEntity = new Map<number, number>();
  const chestPos = (id: number): V3 | null => {
    const i = chestEntity.get(id);
    if (i === undefined) return null;
    const y = transforms[i * 7 + 1];
    return y < -500 ? null : { x: transforms[i * 7], y, z: transforms[i * 7 + 2] };
  };
  /** Where shots come from and the camera looks from: just above the chest (matches `Ragdoll.aimOrigin`). */
  const aimOrigin = (id: number): V3 | null => {
    const c = chestPos(id);
    return c ? { x: c.x, y: c.y + 0.35, z: c.z } : null;
  };

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
    const o = aimOrigin(localId);
    if (!o) return;
    const dx = aimPoint.x - o.x, dy = aimPoint.y - o.y, dz = aimPoint.z - o.z;
    const h = Math.hypot(dx, dz);
    // Only when the crosshair is practically on top of us is the angle unstable; then use the camera direction.
    if (h > 0.35) {
      input.aimYaw = Math.atan2(dx, dz);
      input.aimPitch = Math.atan2(dy, h);
    }
  }

  /** Refresh the raycast lists and lookups after the renderer adds meshes (startup, someone joined). */
  function onSceneBuilt() {
    staticMeshes = renderer.meshes.filter((_, i) => sim.entities[i].role === 'static');
    pickList = renderer.meshes.filter((_, i) => {
      const e = sim.entities[i];
      return e.role !== 'fx' && !(e.role === 'player' && e.playerId === localId);
    });
    // Thin floor stencils and signs don't stop the camera; presses do.
    cam.blockers = renderer.meshes.filter((_, i) => {
      const e = sim.entities[i];
      return (e.role === 'static' && e.model !== 'sign') || e.model === 'stamper';
    });
    chestEntity = new Map();
    sim.entities.forEach((e, i) => { if (e.model === 'torso' && e.playerId !== undefined) chestEntity.set(e.playerId, i); });
    // A client never steps its sim: this puts the level (and anything not yet in a snapshot) in place.
    if (mode === 'client') sim.writeTransforms(transforms);
  }

  // ---------------------------------------------------------------- simulation (solo / host)
  const inputs = new Map<number, PlayerInput>();
  let myInput: PlayerInput = controls.read();
  let acc = 0;
  let lastSim = performance.now();
  let frameEvents: SimEvent[] = [];

  /** Step the sim up to `now`. Called every frame, and on a timer while a host's tab is in the background. */
  function simulate(now: number, maxCatchUp: number) {
    const realDt = Math.min(maxCatchUp, (now - lastSim) / 1000);
    lastSim = now;
    if (mode === 'client') return;
    // A beat of slow motion when someone is eliminated (solo only: online, everyone shares the host's clock).
    const dt = realDt * (mode === 'solo' && matchHud.slowmo > 0 ? 0.3 : 1);
    inputs.set(localId, myInput);
    for (const [id, b] of bots) inputs.set(id, b.think(dt));
    // Solo: nothing runs behind the menu. Online: the game goes on.
    if (mode === 'solo' && menu.open) acc = 0; else acc += dt;
    let stepped = false;
    while (acc >= DT) {
      // Per step: a remote tap that arrived since the last step is held for exactly this one.
      if (host) for (const [id, inp] of host.remoteInputs()) inputs.set(id, inp);
      sim.step(inputs);
      acc -= DT;
      stepped = true;
    }
    if (!stepped) return;
    const events = sim.drainEvents();
    frameEvents.push(...events);
    if (host) {
      sim.writeTransforms(transforms);
      host.queueEvents(events);
      host.broadcast(transforms);
    }
  }
  // Browsers stop animation frames in background tabs and throttle their timers to once a second, but a host
  // must keep the game running for everyone else. Timers inside a worker aren't throttled like that, so a tiny
  // worker ticks the host while its tab is hidden.
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16)'], { type: 'text/javascript' })));
  ticker.onmessage = () => {
    if (mode === 'host' && document.hidden) { simulate(performance.now(), 0.25); frameEvents = frameEvents.slice(-200); }
  };

  // ---------------------------------------------------------------- frame loop
  let last = performance.now();
  let fpsFrames = 0, fpsTime = 0;
  let lastView: GameView | null = null;

  function frame(now: number) {
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    matchHud.slowmo = Math.max(0, matchHud.slowmo - realDt);
    const frameDt = realDt * (mode === 'solo' && matchHud.slowmo > 0 ? 0.3 : 1);

    // Match / debug keys (the host runs the match).
    const authority = mode !== 'client';
    if (controls.consume('reset') && authority) {
      if (sim.match.phase === 'practice') sim.resetAll(); else sim.startMatch();
      gore.fadeAll();
    }
    if (authority && sim.match.phase === 'matchOver' && controls.consume('jump')) sim.startMatch(); // rematch
    if (controls.consume('shoveDummy') && DEBUG) shoveDummy();
    if (controls.consume('panel') && DEBUG) gui.show(gui._hidden);
    // Spectator keys (read here: taps are cleared once input has gone to the sim).
    const outNow = !!lastView && lastView.players.some((p) => p.id === localId && !p.active) && !menu.open;
    const specKeys = outNow ? { next: controls.consume('handR'), prev: controls.consume('handL'), toggle: controls.consume('jump') } : null;

    myInput = controls.read();
    crosshairAim(myInput);
    if (mode === 'client') client!.sendInput(myInput);
    else simulate(now, 0.1);
    controls.endFrame();

    // World state: transforms, view and events, from the sim or from the network.
    if (renderer.sync(sim.entities, sim.entityVersion)) onSceneBuilt();
    let view: GameView | null;
    let events: SimEvent[];
    if (mode === 'client') {
      client!.interpolate(transforms, sim.dynamicIndices());
      view = client!.view;
      events = client!.drainEvents();
    } else {
      sim.writeTransforms(transforms);
      view = sim.view();
      events = frameEvents;
      frameEvents = [];
    }
    if (view && lastView && view.match.phase !== lastView.match.phase && (view.match.phase === 'practice' || lastView.match.phase === 'practice')) updateLobby();
    lastView = view;

    for (const e of events) {
      effects.handle(e);
      sound.handle(e, chestPos, localId);
      matchHud.handle(e);
      if (e.type === 'countdown') gore.fadeAll();
      if (e.type === 'hit') {
        gore.wound(e, transforms);
        if (e.by === localId && e.player !== localId) hitMarkerTimer = 0.15;
      } else if (e.type === 'shot' && e.first) {
        gore.casing(e.from, e.dir, e.weapon === 'shotgun');
        if (e.player === localId) {
          // Recoil climbs your aim a little; you pull it back down.
          controls.pitch = Math.min(1.0, controls.pitch + weapons[e.weapon].camKick);
          controls.yaw += (Math.random() - 0.5) * weapons[e.weapon].camKick * 0.5;
        }
      }
    }

    // World presentation.
    const furnace = view?.furnace ?? 'idle';
    effects.update(frameDt, transforms, { state: furnace, center: INCINERATOR.pitCenter, half: INCINERATOR.pitHalf });
    gore.update(frameDt, transforms);
    pitFire.update(now / 1000, realDt, renderer.camera, furnace);
    renderer.setFurnace(furnace);
    if (view) {
      renderer.setStampers(view.stampers);
      for (const p of view.players) renderer.setKnockedOut(p.id, p.koTimer > 0);
    }
    animateModels(now / 1000);
    renderer.applyTransforms(transforms);

    // Camera: follow yourself — or, once you're out, spectate: watch another player (Q / E to switch) or
    // an overview of the arena (jump to toggle).
    const meView = view?.players.find((p) => p.id === localId);
    let follow = meView?.active ? aimOrigin(localId) : null;
    let range = 1, pitch = controls.pitch, yaw = controls.yaw;
    const spectating = !!view && !!meView && !meView.active && !menu.open;
    if (spectating) {
      const others = view!.players.filter((p) => p.active && !p.left && p.id !== localId).map((p) => p.id);
      if (spectate === null || !others.includes(spectate)) spectate = others[0] ?? null;
      if (spectate !== null && others.length) {
        const k = others.indexOf(spectate);
        if (specKeys?.next) spectate = others[(k + 1) % others.length];
        if (specKeys?.prev) spectate = others[(k - 1 + others.length) % others.length];
      }
      if (specKeys?.toggle) overview = !overview;
      if (overview || spectate === null) {
        // Slowly circling the pit, high up; the mouse can still turn it.
        overviewSpin += realDt * 0.12;
        follow = { x: INCINERATOR.pitCenter.x, y: 1.2, z: INCINERATOR.pitCenter.z };
        range = 3.3; yaw = controls.yaw + overviewSpin; pitch = -0.62;
      } else {
        follow = aimOrigin(spectate);
      }
      hud.setSpectating(overview || spectate === null ? 'Overview' : matchHud.nameOf(spectate),
        `${keyFor('handL')} / ${keyFor('handR')} switch player · ${keyFor('jump')} ${overview ? 'follow a player' : 'overview'}`);
    } else {
      hud.setSpectating(null);
    }
    if (!follow && view) for (const p of view.players) if (p.active && !p.left && (follow = aimOrigin(p.id))) break;
    // Sinking into the fire: the camera stays above the lava and watches you go under.
    if (follow) follow = { ...follow, y: Math.max(follow.y, INCINERATOR.lavaY + 0.6) };
    cam.update(follow ?? { x: 0, y: 1.6, z: 1 }, yaw, pitch, effects.shake, frameDt, realDt, range);
    // Squeezed right up against your own character (a wall or ceiling behind you): don't fill the screen with it.
    renderer.setPlayerHidden(localId, cam.distance < 1.0);
    renderer.focusShadow(cam.pivot);
    // Sound: hear from your character, panned by where the camera faces.
    camRight.set(1, 0, 0).applyQuaternion(renderer.camera.quaternion);
    sound.listen(cam.pivot, camRight);
    sound.update(INCINERATOR.pitCenter, furnace);
    if (view?.match.phase === 'countdown') {
      const n = Math.ceil(view.match.timer);
      if (n !== lastCountdown && n > 0) sound.countdownBeep();
      lastCountdown = n;
    } else lastCountdown = -1;
    renderer.render();

    // HUD.
    hitMarkerTimer = Math.max(0, hitMarkerTimer - frameDt);
    crosshair.classList.toggle('hit', hitMarkerTimer > 0);
    // In punching reach (and a hand free to punch with): the crosshair turns into a ring.
    crosshair.classList.toggle('reach', !!meView?.inReach);
    if (view) {
      matchHud.update(view, realDt);
      hud.update(view, (p) => { const b = bots.get(p.id); return b ? `bot: ${b.state}` : ''; });
    }

    fpsFrames++; fpsTime += realDt;
    if (fpsTime > 0.5) { stats.fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }
    if (meView) {
      stats.stiffness = Math.round(meView.stiffness * 100) / 100;
      stats.grounded = meView.grounded ? 'yes' : 'no';
    }
    stats.net = mode === 'client' ? `client · ${client!.bufferedTicks.toFixed(1)} ticks buffered · host ${client!.hostTickRate.toFixed(0)} Hz` : mode === 'host' ? `host · room ${host!.code}` : 'solo';

    requestAnimationFrame(frame);
    hideLoading(); // after the first frame is drawn, so the menu opens over the arena, not a blank screen
  }
  requestAnimationFrame(frame);

  // Exposed for debugging in the console.
  Object.assign(window, { sim, tuning, weapons, explosive, bots, effects, gore, goreSettings, handling, hud, renderer, controls, net: () => ({ mode, host, client }) });
}

/** Fade out the loading screen in index.html (once). */
function hideLoading() {
  const el = document.getElementById('loading');
  if (!el || el.classList.contains('done')) return;
  el.classList.add('done');
  setTimeout(() => el.remove(), 400);
}

main().catch((e) => {
  // Never leave people staring at "Loading…" forever.
  console.error(e);
  const msg = document.querySelector('#loading .msg');
  if (msg) msg.textContent = `Couldn't start the game: ${(e as Error).message ?? e}. Try refreshing, or another browser.`;
  document.querySelector('#loading .bar')?.remove();
});
