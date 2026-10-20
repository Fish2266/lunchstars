// In-game HUD (hand slots, help line) and the debug-only stats HUD. Both read a GameView, never the sim,
// so they work the same on a multiplayer client.
import { PLAYER_COLORS, type GameView, type PlayerView } from '../sim/sim';
import { weapons } from '../sim/weapons';
import { keyFor, settings } from './bindings';
import { DEBUG } from './debug';

function esc(s: unknown) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export class Hud {
  private slots = [...document.querySelectorAll<HTMLElement>('#hud .slot')];
  private note = document.querySelector<HTMLElement>('#hud .stun')!;
  private help = document.getElementById('help')!;
  private debug = document.createElement('div');
  showDebug = false;

  constructor(private readonly localId: number, private readonly nameOf: (id: number) => string) {
    this.debug.id = 'debughud';
    document.body.appendChild(this.debug);
    this.renderHelp();
  }

  /** Rebuild the help line (after rebinding keys). */
  renderHelp() {
    this.help.style.display = settings.showControls ? '' : 'none';
    this.help.innerHTML = `<b>${keyFor('forward')}${keyFor('left')}${keyFor('back')}${keyFor('right')}</b> move · <b>${keyFor('jump')}</b> jump · `
      + `<b>${keyFor('handL')}</b> / <b>${keyFor('handR')}</b> left / right hand: tap to punch, hold to grab or hold a gun (let go = drop)<br />`
      + `Hanging on a ledge: hold <b>${keyFor('jump')}</b> to pull up, swap hands to climb · `
      + `<b>${keyFor('fire')}</b> shoot / throw grenade · <b>${keyFor('cycle')}</b> switch hands · `
      + (DEBUG ? `<b>${keyFor('shoveDummy')}</b> shove dummy · <b>${keyFor('panel')}</b> tuning · ` : '')
      + `<b>${keyFor('reset')}</b> reset · <b>Esc</b> menu`;
  }

  update(view: GameView, extraDebug: (p: PlayerView) => string = () => '') {
    const me = view.players.find((p) => p.id === this.localId);
    if (me) this.updateHands(me);
    this.debug.style.display = this.showDebug ? 'block' : 'none';
    if (this.showDebug) this.updateDebug(view, extraDebug);
  }

  private updateHands(me: PlayerView) {
    const both = !!(me.hands[0].item && me.hands[1].item);
    for (const i of [0, 1] as const) {
      const h = me.hands[i];
      const el = this.slots[i];
      const key = keyFor(i === 0 ? 'handL' : 'handR');
      // Online, the view comes from another player's browser: escape anything that goes into HTML.
      const gripName = h.grip ? esc('player' in h.grip ? this.nameOf(h.grip.player) : h.grip.object) : null;
      const html = h.item
        ? `<span class="k">${key}</span><span class="name">${esc(h.item)}</span><div class="ammo">${h.item === 'grenade' ? 'throw with ' + keyFor('fire') : `${Number(h.ammo)} / ${weapons[h.item]?.ammo ?? '?'}`}</div>`
        : gripName
          ? `<span class="k">${key}</span><span class="name">${gripName}</span><div class="ammo">holding · let go of ${key} to drop</div>`
          : `<span class="k">${key}</span><span class="name">empty</span>`;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.classList.toggle('active', !!h.item && me.activeHand === i);
      el.classList.toggle('empty', !h.item && !gripName);
      el.classList.toggle('gripping', !h.item && !!gripName);
    }
    this.note.textContent = both ? `${keyFor('cycle')} to switch hands` : '';
  }

  private updateDebug(view: GameView, extra: (p: PlayerView) => string) {
    let html = '';
    for (const p of view.players) {
      const color = '#' + PLAYER_COLORS[p.slot % PLAYER_COLORS.length].toString(16).padStart(6, '0');
      const pct = Math.min(100, (p.ko / p.koThreshold) * 100);
      const items = p.hands.map((h) => h.item ? `${esc(h.item)}(${Number(h.ammo)})` : '–').join(' / ');
      const ex = extra(p);
      html += `<div class="p"><b style="color:${color}">${p.id === this.localId ? 'You' : this.nameOf(p.id)}</b>`
        + (p.koTimer > 0 ? ` <span class="out">KO ${p.koTimer.toFixed(1)}s</span>` : '')
        + `<div class="bar"><i style="width:${pct}%"></i></div>`
        + `KO meter ${p.ko.toFixed(0)}/${p.koThreshold.toFixed(0)} · KOs ${p.koCount} · hits ${p.hitsTaken}<br>`
        + `stiffness ${p.stiffness.toFixed(2)} · stun ${p.stun.toFixed(2)}s · stagger ${p.stagger.toFixed(2)}s · ${p.grounded ? 'grounded' : 'airborne'}<br>`
        + `hands ${items} · active ${p.activeHand === 0 ? 'L' : 'R'}${ex ? '<br>' + ex : ''}</div>`;
    }
    if (this.debug.innerHTML !== html) this.debug.innerHTML = html;
  }
}
