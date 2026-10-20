// Round / match presentation: score pips at the top, big centre banners, and a short kill feed.
// Reads a GameView (plus events), never the sim, so it works the same on a multiplayer client.
import { PLAYER_COLORS, type GameView, type SimEvent } from '../sim/sim';
import { keyFor } from './bindings';

const CSS = `
#score { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 18px; pointer-events: none;
  font-family: system-ui, sans-serif; color: #fff; text-shadow: 0 2px 3px #000a; }
#score .p { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 12px; background: #0006; }
#score .p.out { opacity: 0.45; }
#score .name { font-weight: 800; font-size: 14px; }
#score .pip { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff8; }
#score .pip.won { background: #ffd54a; border-color: #ffd54a; }
#score .round { align-self: center; font-size: 12px; opacity: 0.8; letter-spacing: 0.1em; text-transform: uppercase; }
#banner { position: fixed; top: 34%; left: 50%; transform: translate(-50%, -50%); text-align: center; pointer-events: none;
  font-family: system-ui, sans-serif; color: #fff; }
#banner .big { font-size: 64px; font-weight: 900; letter-spacing: 0.03em; text-shadow: 0 4px 0 #0008, 0 0 30px #0006; }
#banner .small { font-size: 18px; margin-top: 6px; opacity: 0.9; text-shadow: 0 2px 3px #000a; }
#banner.pop .big { animation: pop 0.35s ease-out; }
@keyframes pop { from { transform: scale(1.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
#feed { position: fixed; top: 60px; right: 16px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end;
  pointer-events: none; font: 600 14px system-ui, sans-serif; color: #fff; }
#feed div { padding: 5px 10px; border-radius: 10px; background: #000a; transition: opacity 0.5s; }
`;

const NAMES = ['Red', 'Blue', 'Yellow', 'Green', 'Purple', 'Pink'];

/** A player's name and CSS colour come from their slot (the order they joined). */
export function slotName(slot: number) {
  return NAMES[slot % NAMES.length];
}
export function slotColor(slot: number) {
  return '#' + PLAYER_COLORS[slot % PLAYER_COLORS.length].toString(16).padStart(6, '0');
}

export class MatchHud {
  private score = document.createElement('div');
  private banner = document.createElement('div');
  private feed = document.createElement('div');
  private bannerTimer = 0;
  private lastCountdown = -1;
  /** Seconds of slow motion still to play (read by the main loop). */
  slowmo = 0;
  /** Only whoever runs the sim (solo, or the host) can start a rematch. */
  canRematch = true;

  /** Latest state, for names/colours and the scoreboard. */
  private view: GameView | null = null;

  constructor(private readonly localId: number) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.score.id = 'score';
    this.banner.id = 'banner';
    this.feed.id = 'feed';
    document.body.append(this.score, this.banner, this.feed);
  }

  /** Display name for a player ("Blue", or "Red (you)"). */
  nameOf(id: number) {
    return this.name(id);
  }

  private slotOf(id: number) {
    return this.view?.players.find((p) => p.id === id)?.slot ?? 0;
  }

  private name(id: number) {
    const n = slotName(this.slotOf(id));
    return id === this.localId ? `${n} (you)` : n;
  }

  private color(id: number) {
    return slotColor(this.slotOf(id));
  }

  private show(big: string, small = '', seconds = 2.5, color = '#fff') {
    this.banner.innerHTML = `<div class="big" style="color:${color}">${big}</div>${small ? `<div class="small">${small}</div>` : ''}`;
    this.banner.classList.remove('pop');
    void this.banner.offsetWidth; // restart the animation
    this.banner.classList.add('pop');
    this.bannerTimer = seconds;
  }

  private post(html: string) {
    const d = document.createElement('div');
    d.innerHTML = html;
    this.feed.prepend(d);
    setTimeout(() => { d.style.opacity = '0'; }, 3500);
    setTimeout(() => d.remove(), 4100);
  }

  handle(e: SimEvent) {
    switch (e.type) {
      case 'countdown':
        this.lastCountdown = -1;
        break;
      case 'roundStart':
        this.show('FIGHT!', '', 0.9, '#ffd54a');
        break;
      case 'eliminated': {
        const how = e.cause === 'fire' ? 'got incinerated' : 'took the long way down';
        this.post(`<b style="color:${this.color(e.player)}">${this.name(e.player)}</b> ${how}`);
        if (this.view?.match.phase !== 'practice') this.slowmo = 0.9;
        break;
      }
      case 'roundOver':
        if (e.winner === null) this.show('DRAW', 'Nobody made it', 3.2);
        else this.show(`${this.name(e.winner).toUpperCase()} WINS`, `Round ${Number(e.round)}`, 3.2, this.color(e.winner));
        break;
      case 'matchOver':
        this.show(`${this.name(e.winner).toUpperCase()} WINS THE MATCH`,
          this.canRematch ? `Press ${keyFor('jump')} for a rematch` : 'A new match starts shortly', 999, this.color(e.winner));
        break;
    }
  }

  update(view: GameView, dt: number) {
    this.view = view;
    const m = view.match;
    // Countdown numbers.
    if (m.phase === 'countdown') {
      const n = Math.ceil(m.timer);
      if (n !== this.lastCountdown && n > 0) {
        this.lastCountdown = n;
        this.show(String(n), m.round === 1 ? `Round 1 · first to ${Number(m.winsToWin)}` : `Round ${Number(m.round)}`, 1.1);
      }
    }
    this.bannerTimer -= dt;
    this.banner.style.display = this.bannerTimer > 0 ? 'block' : 'none';
    if (m.phase === 'matchOver') this.banner.style.display = 'block';

    // Score pips.
    if (m.phase === 'practice') { this.score.style.display = 'none'; return; }
    this.score.style.display = 'flex';
    let html = '';
    for (const p of view.players) {
      if (p.left) continue;
      const id = p.id;
      const wins = m.wins[id] ?? 0;
      let pips = '';
      for (let i = 0; i < Math.min(9, m.winsToWin); i++) pips += `<span class="pip${i < wins ? ' won' : ''}"></span>`;
      html += `<div class="p${m.alive.includes(id) || m.phase === 'countdown' ? '' : ' out'}"><span class="name" style="color:${this.color(id)}">${this.name(id)}</span>${pips}</div>`;
    }
    html += `<div class="round">Round ${Number(m.round)}</div>`;
    if (this.score.innerHTML !== html) this.score.innerHTML = html;
  }
}
