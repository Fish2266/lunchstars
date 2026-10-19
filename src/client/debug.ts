// Live tuning panel. Values persist in localStorage so a good feel survives reloads;
// "Copy values" puts them on the clipboard to paste back into src/sim/tuning.ts.
import GUI from 'lil-gui';
import { tuning } from '../sim/tuning';

const STORAGE_KEY = 'lunchstars.tuning';

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
  bal.add(tuning, 'maxAngAccel', 50, 3000, 10).name('max ang accel');
  bal.add(tuning, 'standHeight', 0.7, 1.3, 0.01).name('stand height');
  bal.add(tuning, 'hoverKp', 0, 400, 1).name('hover stiffness');
  bal.add(tuning, 'hoverKd', 0, 60, 0.5).name('hover damping');
  bal.add(tuning, 'maxStepUp', 0, 0.8, 0.01).name('max step up');

  const move = gui.addFolder('Movement');
  move.add(tuning, 'moveSpeed', 0, 10, 0.1).name('move speed');
  move.add(tuning, 'moveAccel', 0, 30, 0.5).name('move accel');
  move.add(tuning, 'airControl', 0, 1, 0.01).name('air control');
  move.add(tuning, 'jumpImpulse', 0, 15, 0.1).name('jump');
  move.add(tuning, 'turnLean', 0, 0.6, 0.01).name('lean');
  move.add(tuning, 'stepRate', 0, 6, 0.05).name('step rate');
  move.add(tuning, 'strideAngle', 0, 1.4, 0.01).name('stride');
  move.add(tuning, 'kneeBend', 0, 2, 0.01).name('knee bend');
  move.add(tuning, 'armSwing', 0, 1.5, 0.01).name('arm swing');
  move.add(tuning, 'gravity', -40, -5, 0.5);

  const hit = gui.addFolder('Hits & stun');
  hit.add(tuning, 'shoveImpulse', 0, 60, 0.5).name('knockback');
  hit.add(tuning, 'stunFloor', 0, 1, 0.01).name('stunned stiffness');
  hit.add(tuning, 'stunTime', 0.1, 5, 0.05).name('recover time');
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
