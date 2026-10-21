// The client: sends inputs, receives the roster / view / events, and buffers snapshots to draw the world
// slightly in the past, interpolating between them so motion is smooth despite 20 Hz updates.
// Events and the GameView are held back to the same point in time, so effects and HUD match the bodies.
import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { emptyInput, type PlayerInput } from '../sim/input';
import type { GameView, SimEvent } from '../sim/sim';
import { openPeer } from './host';
import { hasTurn } from './ice';
import {
  binaryType, BUTTONS, decodeSnapshot, EMOTE_PRESS, encodeInput, FAST_LABEL, patch, PEER_PREFIX, PROTOCOL_VERSION, snapshotTick,
  type ReliableMsg, type RosterEntry, type Snapshot,
} from './protocol';

/** How far behind the newest snapshot we draw (ticks at 60 Hz): 100 ms = two snapshots. */
const INTERP_DELAY = 6;
/** No snapshot for this long: the host is gone. */
const HOST_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 12000;

export class NetClient {
  you = -1;
  roster: RosterEntry[] = [];
  /** Snapshots ordered by tick. */
  private snaps: Snapshot[] = [];
  /** Views and event batches from the host, released once playback reaches their tick. */
  private views: GameView[] = [];
  private shownView: GameView | null = null;
  private lastReceivedView: GameView | null = null;
  private eventQueue: { tick: number; events: SimEvent[] }[] = [];
  private peer: Peer | null = null;
  private rel: DataConnection | null = null;
  private fast: DataConnection | null = null;
  private seq = 0;
  /** Presses per button so far (sent with every input; the host turns increments into taps). */
  private presses = [...BUTTONS.map(() => 0), 0]; // buttons, then emotes started
  private prevButtons = BUTTONS.map(() => false);
  private prevEmote = 0;
  /** The last emote started: sent every packet with its press count, so a lost packet can't lose it. */
  private lastEmote = 0;
  /** The tick being drawn. Advances at the host's measured tick rate, nudged to keep INTERP_DELAY of buffer. */
  private renderTick: number | null = null;
  private lastInterp = 0;
  /** Host ticks per millisecond, measured from snapshot arrivals (nominally 0.06; less if the host lags). */
  private rate = 0.06;
  private lastArrival: { tick: number; time: number } | null = null;
  private heard = 0;
  private lastSent = 0;
  private lastInput: PlayerInput | null = null;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  onRoster: (roster: RosterEntry[]) => void = () => {};
  onClosed: (reason: string) => void = () => {};
  closed = false;

  /** Connect to a room; resolves once both channels are open. */
  async connect(code: string, name: string): Promise<void> {
    try {
      this.peer = await openPeer();
      await this.handshake(PEER_PREFIX + code.toUpperCase(), name);
    } catch (e) {
      this.closed = true;
      this.peer?.destroy();
      throw e;
    }
    // Keep-alive both ways: background tabs get no animation frames (so no per-frame input), and a host
    // whose tab was closed may never fire 'close'.
    this.heard = performance.now();
    this.keepAlive = setInterval(() => {
      const now = performance.now();
      if (now - this.lastSent > 250) this.sendInput(this.lastInput ?? emptyInput());
      if (now - this.heard > HOST_TIMEOUT_MS) this.close('Lost connection to the host.');
    }, 250);
  }

  private async handshake(hostId: string, name: string) {
    const peer = this.peer!;
    const rel = peer.connect(hostId, { label: 'rel', serialization: 'json', reliable: true });
    this.rel = rel;
    let opened = false;
    await withTimeout(new Promise<void>((resolve, reject) => {
      peer.on('error', (e) => reject(e.type === 'peer-unavailable' ? new Error('No room with that code (check it, and that the host still has the game open).') : e));
      rel.on('open', () => { opened = true; rel.send({ t: 'hello', v: PROTOCOL_VERSION, name } satisfies ReliableMsg); });
      rel.on('data', (d) => {
        const msg = d as ReliableMsg;
        if (msg.t === 'welcome') { this.you = msg.you; this.setRoster(msg.roster); resolve(); }
        else if (msg.t === 'reject') reject(new Error(msg.reason));
        else this.onReliable(msg);
      });
      rel.on('close', () => { reject(new Error('The host closed the connection.')); this.close('The host left the game.'); });
    }), () => opened
      ? 'Reached the host, but it didn\'t answer. Make sure you both have the latest version (refresh).'
      : hasTurn
        ? 'Found the room, but couldn\'t connect to the host — a firewall may be blocking it.'
        : 'Found the room, but your networks won\'t connect directly (common on school/work Wi-Fi and phone hotspots). Try another network, or the game needs a relay server.');
    // Second, unreliable channel for snapshots and inputs.
    const fast = peer.connect(hostId, { label: FAST_LABEL, serialization: 'raw', reliable: false, metadata: { id: this.you } });
    this.fast = fast;
    fast.on('data', (d) => this.onBinary(d as ArrayBuffer));
    await withTimeout(new Promise<void>((resolve) => fast.on('open', () => resolve())), "Connected, but the game data channel didn't open.");
  }

  private onReliable(msg: ReliableMsg) {
    if (msg.t === 'roster') this.setRoster(msg.roster);
    else if (msg.t === 'view') {
      // A patch on the previous view the host sent us (in order: this channel is reliable and ordered).
      const view = { ...(patch(this.lastReceivedView, msg.d) as GameView), tick: msg.tick };
      this.lastReceivedView = view;
      this.views.push(view);
      if (this.views.length > 20) this.views.shift();
    } else if (msg.t === 'events') {
      for (const [tick, events] of msg.batches) this.eventQueue.push({ tick, events });
    }
  }

  private setRoster(roster: RosterEntry[]) {
    this.roster = roster;
    this.onRoster(roster);
  }

  private onBinary(buf: ArrayBuffer) {
    if (binaryType(buf) !== 'snapshot') return;
    const now = performance.now();
    this.heard = now;
    const last = this.snaps[this.snaps.length - 1] ?? null;
    if (last && snapshotTick(buf) <= last.tick) return; // out of order / duplicate (the channel is unordered)
    // Entities the host skipped (resting) are copied from the last snapshot we accepted.
    const s = decodeSnapshot(buf, last);
    if (!s) return;
    this.snaps.push(s);
    if (this.snaps.length > 30) this.snaps.shift();
    // Measure how fast the host's clock actually runs (smoothed: packets arrive with jitter).
    if (this.lastArrival && now > this.lastArrival.time + 1) {
      const inst = (s.tick - this.lastArrival.tick) / (now - this.lastArrival.time);
      this.rate = Math.max(0.005, Math.min(0.12, this.rate + (inst - this.rate) * 0.1));
    }
    this.lastArrival = { tick: s.tick, time: now };
  }

  /** The newest GameView at or before the tick being drawn. */
  get view(): GameView | null {
    const at = this.renderTick ?? Infinity;
    while (this.views.length && this.views[0].tick <= at) this.shownView = this.views.shift()!;
    return this.shownView ?? null;
  }

  /** Events whose time has come (playback reached the tick they happened by). */
  drainEvents(): SimEvent[] {
    const at = this.renderTick ?? Infinity;
    const out: SimEvent[] = [];
    while (this.eventQueue.length && this.eventQueue[0].tick <= at) out.push(...this.eventQueue.shift()!.events);
    return out;
  }

  /**
   * Offer this frame's input. It goes out right away if a button changed; otherwise only if it differs from the
   * last one sent and a host tick (1/60 s) has passed — the host can't use more than one per tick, and fast
   * monitors would otherwise send 144 a second. Unchanged input is still repeated every 100 ms, so a lost packet
   * can't leave the host with a stale one for long.
   */
  sendInput(input: PlayerInput) {
    if (!this.fast?.open) return;
    let pressed = false;
    BUTTONS.forEach((k, i) => {
      if (input[k] !== this.prevButtons[i]) pressed = true;
      if (input[k] && !this.prevButtons[i]) this.presses[i]++;
      this.prevButtons[i] = input[k];
    });
    if (input.emote && input.emote !== this.prevEmote) { this.presses[EMOTE_PRESS]++; this.lastEmote = input.emote; pressed = true; }
    this.prevEmote = input.emote;
    const now = performance.now();
    const last = this.lastInput;
    const changed = !last || last.moveX !== input.moveX || last.moveZ !== input.moveZ
      || last.aimYaw !== input.aimYaw || last.aimPitch !== input.aimPitch;
    const since = now - this.lastSent;
    if (!pressed && !(changed && since >= 1000 / 60 - 1) && since < 100) return;
    this.lastInput = { ...input };
    this.lastSent = now;
    this.fast.send(encodeInput(++this.seq, { ...input, emote: this.lastEmote }, this.presses));
  }

  /**
   * Write interpolated transforms for the dynamic entities into `out` (7 floats per entity, full array).
   * Returns false until a snapshot matching the current entity list has arrived.
   */
  interpolate(out: Float32Array, dynamic: readonly number[]): boolean {
    if (this.snaps.length === 0) return false;
    const now = performance.now();
    const newest = this.snaps[this.snaps.length - 1].tick;
    const target = newest - INTERP_DELAY;
    if (this.renderTick === null || Math.abs(target - this.renderTick) > 30) {
      this.renderTick = target; // first snapshot, or way off (stall, tab was hidden): jump
    } else {
      // Play at the host's speed, a little faster or slower to drift back to the target buffer.
      const nudge = Math.max(-0.25, Math.min(0.25, (target - this.renderTick) * 0.03));
      this.renderTick = Math.min(newest, this.renderTick + (now - this.lastInterp) * this.rate * (1 + nudge));
    }
    this.lastInterp = now;
    const renderTick = this.renderTick;
    let a = this.snaps[0], b = this.snaps[0];
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i].tick <= renderTick) { a = this.snaps[i]; b = this.snaps[Math.min(i + 1, this.snaps.length - 1)]; break; }
    }
    if (a.count !== dynamic.length || b.count !== dynamic.length) return false; // roster not mirrored yet
    const span = b.tick - a.tick;
    const t = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.tick) / span)) : 0;
    for (let k = 0; k < dynamic.length; k++) {
      const d = k * 7, o = dynamic[k] * 7;
      const A = a.data, B = b.data;
      // Something that just appeared/disappeared (parked at y=-1000) snaps rather than sliding.
      if (A[d + 1] < -500 || B[d + 1] < -500) {
        const src = t < 0.5 ? A : B;
        for (let j = 0; j < 7; j++) out[o + j] = src[d + j];
        continue;
      }
      out[o] = A[d] + (B[d] - A[d]) * t;
      out[o + 1] = A[d + 1] + (B[d + 1] - A[d + 1]) * t;
      out[o + 2] = A[d + 2] + (B[d + 2] - A[d + 2]) * t;
      slerp(A, B, d, t, out, o + 3);
    }
    return true;
  }

  /** For the debug panel: ticks of snapshots buffered beyond what's being drawn, and the host's tick rate. */
  get bufferedTicks() {
    if (!this.snaps.length || this.renderTick === null) return 0;
    return this.snaps[this.snaps.length - 1].tick - this.renderTick;
  }
  get hostTickRate() {
    return this.rate * 1000;
  }

  close(reason = 'Disconnected.') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.rel?.close();
    this.fast?.close();
    this.peer?.destroy();
    this.onClosed(reason);
  }
}

function withTimeout<T>(p: Promise<T>, message: string | (() => string)): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(typeof message === 'string' ? message : message())), CONNECT_TIMEOUT_MS);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Spherical blend of the quaternions at A[d+3..] and B[d+3..] into out[o..o+3]. */
function slerp(A: Float32Array, B: Float32Array, d: number, t: number, out: Float32Array, o: number) {
  let bx = B[d + 3], by = B[d + 4], bz = B[d + 5], bw = B[d + 6];
  const ax = A[d + 3], ay = A[d + 4], az = A[d + 5], aw = A[d + 6];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0 = 1 - t, k1 = t;
  if (cos < 0.9995) {
    const th = Math.acos(cos), s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s;
    k1 = Math.sin(t * th) / s;
  }
  out[o] = ax * k0 + bx * k1;
  out[o + 1] = ay * k0 + by * k1;
  out[o + 2] = az * k0 + bz * k1;
  out[o + 3] = aw * k0 + bw * k1;
}
