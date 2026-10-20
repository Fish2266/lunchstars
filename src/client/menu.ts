// Pause card + settings screen with key remapping. Plain DOM, no framework.
import { ACTIONS, bind, codeName, DEFAULT_BINDINGS, saveSettings, settings, type Action } from './bindings';
import type { Controls } from './controls';

const CSS = `
#menu { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 20;
  background: rgba(20, 30, 60, 0.45); backdrop-filter: blur(3px); font-family: system-ui, sans-serif; color: #fff; }
#menu.hidden { display: none; }
#menu .card { background: #1f2440; border-radius: 18px; padding: 22px 26px; width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 40px); overflow: auto; box-shadow: 0 20px 60px #0008; }
#menu h1 { margin: 0 0 4px; font-size: 34px; letter-spacing: 0.02em; color: #ffd54a; text-shadow: 0 3px 0 #b5502d; }
#menu h2 { margin: 18px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.12em; color: #9fb0ff; }
#menu p { margin: 4px 0 14px; color: #c8cff5; font-size: 14px; }
#menu button { font: inherit; border: 0; border-radius: 10px; cursor: pointer; }
#menu .big { background: #ffd54a; color: #2a1d00; font-weight: 800; font-size: 18px; padding: 12px 20px; width: 100%; margin-top: 6px; }
#menu .plain { background: #343b66; color: #fff; padding: 10px 14px; width: 100%; margin-top: 8px; }
#menu .row { display: grid; grid-template-columns: 1fr 110px 110px; gap: 6px; align-items: center; padding: 3px 0; font-size: 14px; }
#menu .key { background: #343b66; color: #fff; padding: 7px 6px; font-size: 13px; }
#menu .key.listening { background: #ffd54a; color: #2a1d00; }
#menu .slider { display: flex; align-items: center; gap: 10px; font-size: 14px; margin: 6px 0; }
#menu .slider input[type=range] { flex: 1; }
#menu .footer { display: flex; gap: 8px; margin-top: 14px; }
#menu .footer button { flex: 1; }
#menu .hint { font-size: 12px; color: #8f98c8; margin-top: 10px; }
`;

export class Menu {
  private root: HTMLDivElement;
  private listening: { action: Action; slot: 0 | 1; el: HTMLButtonElement } | null = null;
  /** True once the player has clicked "Play" at least once (pointer lock may be unavailable). */
  playing = false;
  onBindingsChanged: () => void = () => {};

  constructor(private readonly controls: Controls, private readonly canvas: HTMLCanvasElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.id = 'menu';
    document.body.appendChild(this.root);

    // Losing pointer lock (Esc) pauses.
    document.addEventListener('pointerlockchange', () => {
      if (!this.controls.locked && this.playing) this.showPause();
    });
    // Esc pauses even when pointer lock isn't available.
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !this.listening && this.playing && !this.open) this.showPause();
    });
    // Rebinding: the next key or mouse button.
    addEventListener('keydown', (e) => this.capture(e.code, e), true);
    this.root.addEventListener('mousedown', (e) => {
      if (this.listening && !(e.target as HTMLElement).classList.contains('listening')) this.capture(`Mouse${e.button}`, e);
    }, true);
    this.root.addEventListener('contextmenu', (e) => { if (this.listening) e.preventDefault(); });
    this.showPause();
  }

  get open() {
    return !this.root.classList.contains('hidden');
  }

  showPause() {
    this.controls.suspended = true;
    this.controls.releaseAll();
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <div class="card">
        <h1>LUNCH STARS</h1>
        <button class="big" data-play>Click to play</button>
        <button class="plain" data-settings>Controls &amp; settings</button>
        <div class="hint">Press Esc any time to come back here.</div>
      </div>`;
    this.root.querySelector<HTMLButtonElement>('[data-play]')!.onclick = () => this.play();
    this.root.querySelector<HTMLButtonElement>('[data-settings]')!.onclick = () => this.showSettings();
  }

  play() {
    this.playing = true;
    this.root.classList.add('hidden');
    this.controls.suspended = false;
    Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
  }

  showSettings() {
    this.listening = null;
    const groups = [...new Set(ACTIONS.map((a) => a.group))];
    this.root.innerHTML = `
      <div class="card">
        <h1>Controls</h1>
        <p>Click a binding, then press any key or mouse button. Esc cancels, Backspace clears.</p>
        ${groups.map((g) => `<h2>${g}</h2>` + ACTIONS.filter((a) => a.group === g).map((a) => `
          <div class="row"><span>${a.label}</span>
            <button class="key" data-action="${a.action}" data-slot="0">${codeName(settings.bindings[a.action][0])}</button>
            <button class="key" data-action="${a.action}" data-slot="1">${codeName(settings.bindings[a.action][1])}</button>
          </div>`).join('')).join('')}
        <h2>Mouse</h2>
        <div class="slider">Sensitivity <input type="range" min="0.2" max="3" step="0.05" value="${settings.sensitivity}" data-sens>
          <span data-sens-val>${settings.sensitivity.toFixed(2)}</span></div>
        <div class="slider"><label><input type="checkbox" data-invert ${settings.invertY ? 'checked' : ''}> Invert look up/down</label></div>
        <div class="footer">
          <button class="plain" data-defaults>Reset to defaults</button>
          <button class="big" data-back>Done</button>
        </div>
      </div>`;
    for (const el of this.root.querySelectorAll<HTMLButtonElement>('.key')) {
      el.onclick = () => {
        for (const other of this.root.querySelectorAll('.key.listening')) other.classList.remove('listening');
        this.listening = { action: el.dataset.action as Action, slot: Number(el.dataset.slot) as 0 | 1, el };
        el.classList.add('listening');
        el.textContent = 'Press…';
      };
    }
    const sens = this.root.querySelector<HTMLInputElement>('[data-sens]')!;
    sens.oninput = () => {
      settings.sensitivity = Number(sens.value);
      this.root.querySelector('[data-sens-val]')!.textContent = settings.sensitivity.toFixed(2);
      saveSettings();
    };
    this.root.querySelector<HTMLInputElement>('[data-invert]')!.onchange = (e) => {
      settings.invertY = (e.target as HTMLInputElement).checked;
      saveSettings();
    };
    this.root.querySelector<HTMLButtonElement>('[data-defaults]')!.onclick = () => {
      settings.bindings = structuredClone(DEFAULT_BINDINGS);
      saveSettings();
      this.onBindingsChanged();
      this.showSettings();
    };
    this.root.querySelector<HTMLButtonElement>('[data-back]')!.onclick = () => this.showPause();
  }

  private capture(code: string, e: Event) {
    if (!this.listening) {
      // Esc while playing is handled by the browser (exits pointer lock -> pause).
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const { action, slot } = this.listening;
    this.listening = null;
    if (code === 'Escape') { this.showSettings(); return; }
    bind(action, slot, code === 'Backspace' || code === 'Delete' ? null : code);
    this.onBindingsChanged();
    this.showSettings();
  }
}
