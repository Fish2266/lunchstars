// Live tuning panel. Values persist in localStorage so a good feel survives reloads;
// "Copy values" puts them on the clipboard to paste back into src/sim/tuning.ts.
import GUI from 'lil-gui';
import { tuning } from '../sim/tuning';

const STORAGE_KEY = 'lunchstars.tuning.v8'; // bump when tuning meanings change

export function loadSavedTuning() {
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
