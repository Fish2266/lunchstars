// Pause card + settings screen with key remapping. Plain DOM, no framework.
import { ACTIONS, bind, codeName, DEFAULT_BINDINGS, saveSettings, settings, type Action } from './bindings';
import type { Controls } from './controls';
import { DEBUG } from './debug';
import { slotColor, slotName } from './matchHud';
import type { RosterEntry } from '../net/protocol';

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
#menu .hint { font-size: 12px; color: #8f98c8; margin-top: 10px; word-break: break-all; }
#menu .join { display: flex; gap: 8px; margin-top: 8px; }
#menu .join input { flex: 1; min-width: 0; font: 800 18px system-ui, sans-serif; letter-spacing: 0.3em; text-transform: uppercase;
  text-align: center; border: 0; border-radius: 10px; padding: 8px; background: #fff; color: #1f2440; }
#menu .join button { width: auto; margin: 0; padding: 10px 18px; }
#menu .error { color: #ff8a8a; font-size: 13px; min-height: 0; margin-top: 6px; }
#menu .room { display: flex; align-items: center; gap: 12px; font-size: 18px; margin-top: 8px; }
#menu .room b { font-size: 30px; letter-spacing: 0.2em; color: #ffd54a; }
#menu .room .key { padding: 7px 12px; }
#menu .player { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 15px; }
#menu .player i { width: 14px; height: 14px; border-radius: 50%; }
#menu .player span { flex: 1; }
#menu .player .key { padding: 4px 10px; }
#menu button:disabled { opacity: 0.6; cursor: default; }
#menu .pick { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 14px; }
#menu .pick > span { flex: 1; }
#menu .pick b { min-width: 92px; text-align: center; font-size: 15px; }
#menu .pick .arrow { width: 34px; height: 34px; background: #343b66; color: #fff; font-size: 20px; line-height: 1; padding: 0; }
#menu .pick .arrow:hover { background: #4a5390; }
#menu .pick.compact { margin-top: 0; }
#menu .pick.compact b { min-width: 64px; font-size: 13px; }
#menu .pick.compact .arrow { width: 26px; height: 26px; font-size: 16px; }
#menu .lvl { font-size: 13px; opacity: 0.8; }
`;

/** A "label  ‹ value ›" row; clicks reach `Menu.onPick(key, ±1)`. */
function picker(text: string, value: string, key: string, compact = false) {
  return `<div class="pick${compact ? ' compact' : ''}">${text ? `<span>${escapeHtml(text)}</span>` : ''}
    <button class="arrow" data-pick="${key}" data-step="-1" aria-label="Previous">‹</button>
    <b>${escapeHtml(value)}</b>
    <button class="arrow" data-pick="${key}" data-step="1" aria-label="Next">›</button></div>`;
}

function label(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** What the pause card shows: the title screen, or the room you're in. */
export type MenuMode = 'title' | 'solo' | 'host' | 'client';

/** The room, for the lobby card. */
export interface Lobby {
  code: string;
  roster: RosterEntry[];
  you: number;
  /** Match underway (vs. messing around in practice before the host starts). */
  matchRunning: boolean;
  canAddBot: boolean;
}

export class Menu {
  private root: HTMLDivElement;
  private listening: { action: Action; slot: 0 | 1; el: HTMLButtonElement } | null = null;
  private screen: 'pause' | 'settings' | 'status' = 'pause';
  /** True once the player has clicked "Play" at least once (pointer lock may be unavailable). */
  playing = false;
  mode: MenuMode = 'title';
  lobby: Lobby | null = null;
  onBindingsChanged: () => void = () => {};
  onSolo: () => void = () => {};
  onHost: () => Promise<void> = async () => {};
  onStartMatch: () => void = () => {};
  onEndMatch: () => void = () => {};
  /** An arrow picker was clicked: `key` says which ('bot', 'bot:<id>', or a wardrobe slot), `step` is -1 / +1. */
  onPick: (key: string, step: number) => void = () => {};
  onVolume: (v: number) => void = () => {};
  /** Whether a match (rounds) is underway, vs. free play — for the solo pause card. */
  matchRunning: () => boolean = () => false;
  onAddBot: () => void = () => {};
  onRemoveBot: (id: number) => void = () => {};

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

  private openCard() {
    this.controls.suspended = true;
    this.controls.releaseAll();
    this.root.classList.remove('hidden');
  }

  private on(sel: string, fn: () => void) {
    const el = this.root.querySelector<HTMLElement>(sel);
    if (el) el.onclick = fn;
  }

  showPause() {
    this.openCard();
    this.screen = 'pause';
    const settingsBtn = `<button class="plain" data-settings>Controls &amp; settings</button>`;
    if (this.mode === 'title') {
      const code = new URLSearchParams(location.search).get('join') ?? '';
      this.root.innerHTML = `
        <div class="card">
          <h1>LUNCH STARS</h1>
          <button class="big" data-solo>Play solo</button>
          ${picker('Bot difficulty', label(settings.botDifficulty), 'bot')}
          <h2>Online</h2>
          <button class="plain" data-host>Host a game</button>
          <div class="join"><input data-code maxlength="4" placeholder="CODE" value="${escapeHtml(code)}" spellcheck="false" autocomplete="off">
            <button class="plain" data-join>Join</button></div>
          <div class="error" data-error></div>
          ${settingsBtn}
          <div class="hint">Press Esc any time to come back here.</div>
        </div>`;
      const input = this.root.querySelector<HTMLInputElement>('[data-code]')!;
      input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
      input.onkeydown = (e) => { if (e.key === 'Enter') join(); };
      const join = () => {
        if (input.value.length !== 4) { this.error('Room codes are 4 letters.'); return; }
        location.search = `?join=${input.value}`;
      };
      this.on('[data-solo]', () => { this.mode = 'solo'; this.onSolo(); this.play(); });
      this.on('[data-host]', () => this.host());
      this.on('[data-join]', join);
    } else if (this.mode === 'solo') {
      const running = this.matchRunning();
      this.root.innerHTML = `
        <div class="card">
          <h1>LUNCH STARS</h1>
          <button class="big" data-play>Resume</button>
          <h2>Match</h2>
          <button class="plain" data-start>${running ? 'Restart match' : 'Start a new match'}</button>
          ${running ? `<button class="plain" data-end>End match (free play)</button>` : ''}
          ${picker('Bot difficulty', label(settings.botDifficulty), 'bot')}
          <button class="plain" data-quit>Quit to title screen</button>
          <h2>More</h2>
          <button class="plain" data-host>Host this as an online game</button>
          ${settingsBtn}
          <div class="error" data-error></div>
          <div class="hint">Press Esc any time to come back here.</div>
        </div>`;
      this.on('[data-play]', () => this.play());
      this.on('[data-start]', () => { this.onStartMatch(); this.play(); });
      this.on('[data-end]', () => { this.onEndMatch(); this.play(); });
      this.on('[data-quit]', () => { location.href = location.pathname; });
      this.on('[data-host]', () => this.host());
    } else {
      const l = this.lobby;
      const isHost = this.mode === 'host';
      const link = l ? `${location.origin}${location.pathname}?join=${l.code}` : '';
      const players = l ? l.roster.map((r, slot) => (r.left ? '' : `
        <div class="player"><i style="background:${slotColor(slot)}"></i>
          <span>${slotName(slot)}${r.id === l.you ? ' (you)' : ''}${r.bot ? ' · bot' : ''}${slot === 0 ? ' · host' : ''}</span>
          ${r.bot ? (isHost ? picker('', label(r.level ?? 'normal'), `bot:${r.id}`, true) : `<span class="lvl">${label(r.level ?? 'normal')}</span>`) : ''}
          ${isHost && r.bot ? `<button class="key" data-kick="${r.id}">Remove</button>` : ''}</div>`)).join('') : '';
      this.root.innerHTML = `
        <div class="card">
          <h1>LUNCH STARS</h1>
          ${l ? `<div class="room">Room <b>${l.code}</b>
            <button class="key" data-copy>Copy invite link</button></div>
            <div class="hint" style="margin-top:2px">${escapeHtml(link)}</div>` : ''}
          <h2>Players</h2>
          ${players}
          ${isHost && l?.canAddBot ? `<button class="plain" data-bot>Add a bot</button>` : ''}
          ${isHost ? (l && l.roster.filter((r) => !r.left).length < 2
            ? `<button class="big" disabled>Start match</button><div class="hint" style="margin-top:4px">Needs at least 2 players — wait for a friend or add a bot.</div>`
            : `<button class="big" data-start>${l?.matchRunning ? 'Restart match' : 'Start match'}</button>`) : ''}
          ${isHost && l?.matchRunning ? `<button class="plain" data-end>End match (back to free play)</button>` : ''}
          <button class="${isHost ? 'plain' : 'big'}" data-play>${this.playing ? 'Resume' : isHost ? 'Practice while people join' : 'Play'}</button>
          ${settingsBtn}
          <button class="plain" data-leave>${isHost ? 'Close room' : 'Leave game'}</button>
          <div class="hint">${isHost ? 'The game keeps running while this menu is open.' : 'The host starts the match. The game keeps running while this menu is open.'}</div>
        </div>`;
      this.on('[data-copy]', () => navigator.clipboard?.writeText(link).catch(() => {}));
      this.on('[data-bot]', () => this.onAddBot());
      this.on('[data-start]', () => { this.onStartMatch(); this.play(); });
      this.on('[data-end]', () => { this.onEndMatch(); this.play(); });
      this.on('[data-play]', () => this.play());
      this.on('[data-leave]', () => { location.href = location.pathname; });
      for (const el of this.root.querySelectorAll<HTMLButtonElement>('[data-kick]')) el.onclick = () => this.onRemoveBot(Number(el.dataset.kick));
    }
    this.on('[data-settings]', () => this.showSettings());
    this.wirePickers();
  }

  /** ‹ › arrow pickers: tell main which one and which way. */
  private wirePickers() {
    for (const el of this.root.querySelectorAll<HTMLButtonElement>('[data-pick]')) {
      el.onclick = () => { this.onPick(el.dataset.pick!, Number(el.dataset.step)); this.refreshPickers(); };
    }
  }

  /** Re-draw whatever screen is showing so pickers show their new values. */
  private refreshPickers() {
    if (this.screen === 'pause') this.showPause();
  }

  /** Re-draw the lobby card if it's showing (someone joined or left). */
  refresh() {
    if (this.open && this.screen === 'pause' && (this.mode === 'host' || this.mode === 'client')) this.showPause();
  }

  /** A message card (connecting, disconnected, errors) with a way back to the title screen. */
  showStatus(title: string, message: string, backButton = true) {
    this.openCard();
    this.screen = 'status';
    this.root.innerHTML = `
      <div class="card">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        ${backButton ? `<button class="big" data-back>Back to the title screen</button>` : ''}
      </div>`;
    this.on('[data-back]', () => { location.href = location.pathname; });
  }

  private async host() {
    const btn = this.root.querySelector<HTMLButtonElement>('[data-host]');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening a room…'; }
    try {
      await this.onHost();
      this.mode = 'host';
      this.showPause();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Host a game'; }
      this.error(`Couldn't open a room: ${(e as Error).message ?? e}`);
    }
  }

  private error(msg: string) {
    const el = this.root.querySelector('[data-error]');
    if (el) el.textContent = msg;
  }

  play() {
    this.playing = true;
    this.root.classList.add('hidden');
    this.controls.suspended = false;
    Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
  }

  showSettings() {
    this.listening = null;
    this.screen = 'settings';
    // Debug-only keys (tuning panel, shove dummy) aren't listed unless debug mode is on.
    const actions = ACTIONS.filter((a) => DEBUG || (a.action !== 'panel' && a.action !== 'shoveDummy'));
    const groups = [...new Set(actions.map((a) => a.group))];
    this.root.innerHTML = `
      <div class="card">
        <h1>Controls</h1>
        <p>Click a binding, then press any key or mouse button. Esc cancels, Backspace clears.</p>
        ${groups.map((g) => `<h2>${g}</h2>` + actions.filter((a) => a.group === g).map((a) => `
          <div class="row"><span>${a.label}</span>
            <button class="key" data-action="${a.action}" data-slot="0">${codeName(settings.bindings[a.action][0])}</button>
            <button class="key" data-action="${a.action}" data-slot="1">${codeName(settings.bindings[a.action][1])}</button>
          </div>`).join('')).join('')}
        <h2>Mouse</h2>
        <div class="slider">Sensitivity <input type="range" min="0.2" max="3" step="0.05" value="${settings.sensitivity}" data-sens>
          <span data-sens-val>${settings.sensitivity.toFixed(2)}</span></div>
        <div class="slider"><label><input type="checkbox" data-invert ${settings.invertY ? 'checked' : ''}> Invert look up/down</label></div>
        <h2>Sound</h2>
        <div class="slider">Volume <input type="range" min="0" max="1" step="0.05" value="${settings.volume}" data-volume>
          <span data-volume-val>${Math.round(settings.volume * 100)}%</span></div>
        <h2>Screen</h2>
        <div class="slider"><label><input type="checkbox" data-show-controls ${settings.showControls ? 'checked' : ''}> Show controls at the bottom of the screen</label></div>
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
    const vol = this.root.querySelector<HTMLInputElement>('[data-volume]')!;
    vol.oninput = () => {
      settings.volume = Number(vol.value);
      this.root.querySelector('[data-volume-val]')!.textContent = `${Math.round(settings.volume * 100)}%`;
      saveSettings();
      this.onVolume(settings.volume);
    };
    this.root.querySelector<HTMLInputElement>('[data-show-controls]')!.onchange = (e) => {
      settings.showControls = (e.target as HTMLInputElement).checked;
      saveSettings();
      this.onBindingsChanged(); // re-renders the help line
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
