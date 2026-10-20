// Live tuning panel. Values persist in localStorage so a good feel survives reloads;
// "Copy values" puts them on the clipboard to paste back into src/sim/tuning.ts.
import GUI from 'lil-gui';
import { tuning } from '../sim/tuning';

const STORAGE_KEY = 'lunchstars.tuning.v8'; // bump when tuning meanings change

/**
 * Debug tools (tuning panel, its saved values, shove-dummy) are only available on the dev server or with
 * `?debug` in the URL, so players on the real site can't open them by accident mid-game.
 */
export const DEBUG = typeof location !== 'undefined'
  && (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || new URLSearchParams(location.search).has('debug'));

export function loadSavedTuning() {
  // Outside debug mode always play with the shipped values — a slider nudged once can't linger unseen.
  if (!DEBUG) return;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    for (const k of Object.keys(tuning) as (keyof typeof tuning)[]) {
      if (typeof saved[k] === 'number') tuning[k] = saved[k];
    }
  } catch { /* ignore */ }
}

export function createDebugPanel(actions: { shoveDummy: () => void; reset: () => void; stats: { fps: number; stiffness: number; grounded: string } }) {
  const defaults = { ...tuning };
  const gui = new GUI({ title: 'Lunch Stars tuning' });
  gui.hide(); // off by default; the panel key shows it (debug mode only)
  const save = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning)); } catch { /* ignore */ }
  };
  gui.onChange(save);

  const stats = gui.addFolder('Live');
  stats.add(actions.stats, 'fps').listen().disable();
  stats.add(actions.stats, 'stiffness').listen().disable();
  stats.add(actions.stats, 'grounded').listen().disable();

  const bal = gui.addFolder('Balance');
  bal.add(tuning, 'balanceKp', 0, 2000, 10).name('upright stiffness');
  bal.add(tuning, 'balanceKd', 0, 200, 1).name('upright damping');
  bal.add(tuning, 'limbKp', 0, 1000, 5).name('limb stiffness');
  bal.add(tuning, 'limbKd', 0, 100, 1).name('limb damping');
  bal.add(tuning, 'aimGain', 0.5, 6, 0.1).name('aim arm gain');
  bal.add(tuning, 'armSnap', 1, 10, 0.1).name('arm snap');
  bal.add(tuning, 'punchSpeed', 0, 20, 0.5).name('punch speed');
  bal.add(tuning, 'torsoGain', 0.1, 1.5, 0.01).name('torso stiffness ×');
  bal.add(tuning, 'headGain', 0.05, 1.5, 0.01).name('head stiffness ×');
  bal.add(tuning, 'idleArmGain', 0, 1.5, 0.01).name('idle arm stiffness ×');
  bal.add(tuning, 'legSupport', 0, 1, 0.01).name('legs carry weight');
  bal.add(tuning, 'spineSupport', 0, 1.2, 0.01).name('spine support');
  bal.add(tuning, 'maxAngAccel', 50, 3000, 10).name('max ang accel');
  bal.add(tuning, 'standHeight', 0.7, 1.3, 0.01).name('stand height');
  bal.add(tuning, 'hoverKp', 0, 400, 1).name('hover stiffness');
  bal.add(tuning, 'hoverKd', 0, 60, 0.5).name('hover damping');
  bal.add(tuning, 'maxStepUp', 0, 0.8, 0.01).name('max step up');

  const move = gui.addFolder('Movement');
  move.add(tuning, 'moveSpeed', 0, 10, 0.1).name('move speed');
  move.add(tuning, 'moveAccel', 0, 30, 0.5).name('move accel');
  move.add(tuning, 'maxMoveAccel', 0, 40, 0.5).name('max accel');
  move.add(tuning, 'turnRate', 1, 20, 0.5).name('turn rate');
  move.add(tuning, 'airControl', 0, 1, 0.01).name('air control');
  move.add(tuning, 'jumpImpulse', 0, 15, 0.1).name('jump');
  move.add(tuning, 'turnLean', 0, 0.6, 0.01).name('lean');
  move.add(tuning, 'accelLean', 0, 0.3, 0.005).name('accel lean');
  move.add(tuning, 'stepTime', 0.08, 0.5, 0.005).name('step time');
  move.add(tuning, 'stepDist', 0.05, 0.6, 0.01).name('step trigger dist');
  move.add(tuning, 'stepHeight', 0, 0.4, 0.005).name('step height');
  move.add(tuning, 'stepLead', 0, 0.4, 0.005).name('step lead');
  move.add(tuning, 'stanceWidth', 0, 0.3, 0.005).name('stance width');
  move.add(tuning, 'sway', 0, 1.2, 0.01).name('weight shift');
  move.add(tuning, 'swayKp', 0, 150, 1).name('weight shift stiffness');
  move.add(tuning, 'swayKd', 0, 40, 0.5).name('weight shift damping');
  move.add(tuning, 'footDrive', 0, 2, 0.01).name('foot drive');
  move.add(tuning, 'swingReaction', 0, 1, 0.01).name('swing kickback');
  move.add(tuning, 'legPoseGain', 0, 2, 0.01).name('leg pose ×');
  move.add(tuning, 'footGrip', 0, 2, 0.01).name('foot grip');
  move.add(tuning, 'footGlide', 0, 1, 0.01).name('swing foot friction');
  move.add(tuning, 'footPush', 0, 1, 0.01).name('push through feet');
  move.add(tuning, 'kneeBend', 0, 2, 0.01).name('knee bend');
  move.add(tuning, 'armSwing', 0, 1.5, 0.01).name('arm swing');
  move.add(tuning, 'waddle', 0, 0.4, 0.005);
  move.add(tuning, 'hipTwist', 0, 0.5, 0.005).name('hip twist');
  move.add(tuning, 'bob', 0, 0.2, 0.005);
  move.add(tuning, 'gravity', -40, -5, 0.5);

  const hit = gui.addFolder('Hits & stun');
  hit.add(tuning, 'shoveImpulse', 0, 60, 0.5).name('knockback');
  hit.add(tuning, 'stunFloor', 0, 1, 0.01).name('stunned stiffness');
  hit.add(tuning, 'stunTime', 0.1, 5, 0.05).name('recover time');
  hit.add(tuning, 'staggerTime', 0, 1.5, 0.01).name('lost footing time');
  hit.add(tuning, 'stunPerImpulse', 0, 0.3, 0.005).name('stun per impulse');
  hit.add(tuning, 'grabRadius', 0.05, 0.4, 0.01).name('grab radius');

  const tools = {
    shoveDummy: actions.shoveDummy,
    reset: actions.reset,
    copyValues: () => {
      const text = `export const tuning = ${JSON.stringify(tuning, null, 2)};`;
      navigator.clipboard?.writeText(text);
      console.log(text);
    },
    restoreDefaults: () => {
      Object.assign(tuning, defaults);
      save();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    },
  };
  gui.add(tools, 'shoveDummy').name('Shove dummy (F)');
  gui.add(tools, 'reset').name('Reset (R)');
  gui.add(tools, 'copyValues').name('Copy values');
  gui.add(tools, 'restoreDefaults').name('Restore defaults');

  hit.close();
  gui.close();
  return gui;
}

/** Weapon, handling, knockout, gore and dummy folders (everything game-specific in the panel). */
export function addGameFolders(gui: GUI, deps: {
  weapons: typeof import('../sim/weapons').weapons;
  explosive: typeof import('../sim/weapons').explosive;
  punch: typeof import('../sim/weapons').punch;
  handling: typeof import('../sim/weapons').handling;
  goreSettings: { mode: string; amount: number };
  bot: { mode: string };
  giveMe: (kind: 'pistol' | 'shotgun' | 'grenade') => void;
  giveDummy: () => void;
  setPractice: (on: boolean) => void;
  mopFloor: () => void;
  hud: { showDebug: boolean };
}) {
  const { weapons, explosive, punch, handling } = deps;
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
  // Items only stay in a hand while its key is held, so this drops one into your right hand — hold that key to keep it.
  const give = { weapon: 'pistol' as 'pistol' | 'shotgun' | 'grenade', give: () => deps.giveMe(give.weapon) };
  wf.add(give, 'weapon', ['pistol', 'shotgun', 'grenade']).name('debug weapon');
  wf.add(give, 'give').name('Spawn weapon at my hand');
  const hf = wf.addFolder('handling');
  hf.add(handling, 'dropThreshold', 5, 200, 1).name('hit to drop gun');
  hf.add(handling, 'throwSpeed', 0, 25, 0.5).name('throw speed');
  hf.add(handling, 'throwKnockback', 0, 30, 0.5).name('thrown gun bonk');
  hf.add(handling, 'grabReach', 0.1, 1, 0.01).name('grab reach');
  hf.close();

  const botFolder = gui.addFolder('Dummy');
  botFolder.add(deps.bot, 'mode', ['idle', 'chase', 'chase + shoot']).name('behavior');
  botFolder.add({ arm: deps.giveDummy }, 'arm').name('Give dummy a pistol');
  gui.add({ practice: false }, 'practice').name('Practice (no rounds)').onChange(deps.setPractice);
  gui.add(deps.hud, 'showDebug').name('Debug HUD (KO, stats)');

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
  gf.add(deps.goreSettings, 'mode', ['blood', 'ketchup & mustard', 'off']);
  gf.add(deps.goreSettings, 'amount', 0, 3, 0.05);
  gf.add({ clear: deps.mopFloor }, 'clear').name('Mop the floor');
  gf.close();
}
