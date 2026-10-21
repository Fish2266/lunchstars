// Remappable controls. Each action has up to two bindings: keyboard `KeyboardEvent.code`s or mouse
// buttons written as "Mouse0" (left), "Mouse1" (middle), "Mouse2" (right). Saved per browser.

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump'
  | 'handL' | 'handR' | 'fire' | 'cycle'
  | 'emote1' | 'emote2' | 'emote3' | 'emote4'
  | 'shoveDummy' | 'reset' | 'panel';

/** Emote names, by number (1-based, matching the keys). */
export const EMOTES = ['Wave', 'Dance', 'Taunt', 'Cheer'];

export const ACTIONS: { action: Action; label: string; group: string }[] = [
  { action: 'forward', label: 'Move forward', group: 'Movement' },
  { action: 'back', label: 'Move back', group: 'Movement' },
  { action: 'left', label: 'Move left', group: 'Movement' },
  { action: 'right', label: 'Move right', group: 'Movement' },
  { action: 'jump', label: 'Jump', group: 'Movement' },
  { action: 'handL', label: 'Left hand (tap: punch, hold: grab / hold item)', group: 'Hands' },
  { action: 'handR', label: 'Right hand (tap: punch, hold: grab / hold item)', group: 'Hands' },
  { action: 'fire', label: 'Use active item (shoot / throw grenade)', group: 'Hands' },
  { action: 'cycle', label: 'Switch active hand', group: 'Hands' },
  { action: 'emote1', label: 'Emote: wave', group: 'Emotes' },
  { action: 'emote2', label: 'Emote: dance', group: 'Emotes' },
  { action: 'emote3', label: 'Emote: taunt', group: 'Emotes' },
  { action: 'emote4', label: 'Emote: cheer', group: 'Emotes' },
  { action: 'shoveDummy', label: 'Shove the dummy', group: 'Debug' },
  { action: 'reset', label: 'Reset the round', group: 'Debug' },
  { action: 'panel', label: 'Toggle tuning panel', group: 'Debug' },
];

export type Bindings = Record<Action, [string | null, string | null]>;

export const DEFAULT_BINDINGS: Bindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space', null],
  handL: ['KeyQ', null],
  handR: ['KeyE', null],
  fire: ['Mouse0', null],
  cycle: ['KeyM', null],
  emote1: ['Digit1', null],
  emote2: ['Digit2', null],
  emote3: ['Digit3', null],
  emote4: ['Digit4', null],
  shoveDummy: ['KeyF', null],
  reset: ['KeyT', null],
  panel: ['Backquote', null],
};

// v2: switch hands moved from R to M.
const STORAGE_KEY = 'lunchstars.bindings.v2';

export const settings = {
  bindings: structuredClone(DEFAULT_BINDINGS) as Bindings,
  sensitivity: 1,
  invertY: false,
  /** The controls reminder along the bottom-left of the screen. */
  showControls: true,
  /** Difficulty for solo bots, and for new bots in a hosted game. */
  botDifficulty: 'normal' as 'easy' | 'normal' | 'hard',
  /** Master sound volume, 0..1. */
  volume: 0.7,
  /** Your character's cosmetics (indices into the lists in render/cosmetics.ts). */
  look: { head: 0, face: 0, torso: 1, pants: 1 },
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved) return;
    for (const { action } of ACTIONS) {
      const b = saved.bindings?.[action];
      if (Array.isArray(b) && b.length === 2) settings.bindings[action] = [b[0] ?? null, b[1] ?? null];
    }
    if (typeof saved.sensitivity === 'number') settings.sensitivity = saved.sensitivity;
    if (typeof saved.invertY === 'boolean') settings.invertY = saved.invertY;
    if (typeof saved.showControls === 'boolean') settings.showControls = saved.showControls;
    if (['easy', 'normal', 'hard'].includes(saved.botDifficulty)) settings.botDifficulty = saved.botDifficulty;
    if (typeof saved.volume === 'number') settings.volume = Math.max(0, Math.min(1, saved.volume));
    if (saved.look && typeof saved.look === 'object') settings.look = { ...settings.look, ...saved.look };
  } catch { /* ignore */ }
}

export function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

/** Bind `code` to `action` in `slot`, removing it from anywhere else so one input never does two things. */
export function bind(action: Action, slot: 0 | 1, code: string | null) {
  if (code) {
    for (const { action: a } of ACTIONS) {
      const b = settings.bindings[a];
      if (b[0] === code) b[0] = null;
      if (b[1] === code) b[1] = null;
    }
  }
  settings.bindings[action][slot] = code;
  saveSettings();
}

/** "KeyQ" -> "Q", "Mouse0" -> "Left mouse", etc. */
export function codeName(code: string | null): string {
  if (!code) return '—';
  const mouse: Record<string, string> = { Mouse0: 'Left mouse', Mouse1: 'Middle mouse', Mouse2: 'Right mouse', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5' };
  if (mouse[code]) return mouse[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5) + ' arrow';
  const named: Record<string, string> = {
    Space: 'Space', Backquote: '`', Backspace: 'Backspace', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Tab: 'Tab', Enter: 'Enter', CapsLock: 'Caps Lock', Minus: '-', Equal: '=',
  };
  return named[code] ?? code;
}

/** Short label for the first binding of an action, for on-screen hints. */
export function keyFor(action: Action): string {
  const [a, b] = settings.bindings[action];
  return codeName(a ?? b);
}
