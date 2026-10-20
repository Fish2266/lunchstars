// The client: sends inputs, receives the roster / view / events, and buffers snapshots to draw the world
// slightly in the past, interpolating between them so motion is smooth despite 20 Hz updates.
import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import type { PlayerInput } from '../sim/input';
import type { GameView, SimEvent } from '../sim/sim';
import { openPeer } from './host';
import {
  binaryType, decodeSnapshot, encodeInput, PEER_PREFIX, PROTOCOL_VERSION,
  type ReliableMsg, type RosterEntry, type Snapshot,
} from './protocol';

/** How far behind the newest known host tick we draw (ticks at 60 Hz): 100 ms = two snapshots. */
const INTERP_DELAY = 6;
/** Hold quick taps (punch, shoot, jump, switch) for this many sends so a dropped packet can't eat them. */
const TAP_HOLD = 4;
/** No snapshot for this long: the host is gone. */
const HOST_TIMEOUT_MS = 8000;

export class NetClient {
  you = -1;
  roster: RosterEntry[] = [];
  view: GameView | null = null;
  /** Snapshots ordered by tick. */
  private snaps: Snapshot[] = [];
  private events: SimEvent[] = [];
  private peer: Peer | null = null;
  private rel: DataConnection | null = null;
  private fast: DataConnection | null = null;
  private seq = 0;
  private held: Record<string, number> = {};
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

  /** Connect to a room; resolves after the host welcomes us. */
  async connect(code: string, name: string): Promise<void> {
    this.peer = await openPeer();
    const hostId = PEER_PREFIX + code.toUpperCase();
    const rel = this.peer.connect(hostId, { label: 'rel', serialization: 'json', reliable: true });
    this.rel = rel;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No room with that code (or the host is unreachable).')), 10000);
      this.peer!.on('error', (e) => { clearTimeout(timer); reject(e); });
      rel.on('open', () => rel.send({ t: 'hello', v: PROTOCOL_VERSION, name } satisfies ReliableMsg));
      rel.on('data', (d) => {
        const msg = d as ReliableMsg;
        if (msg.t === 'welcome') { clearTimeout(timer); this.you = msg.you; this.setRoster(msg.roster); resolve(); }
        else if (msg.t === 'reject') { clearTimeout(timer); reject(new Error(msg.reason)); }
        else this.onReliable(msg);
      });
      rel.on('close', () => this.close('The host left the game.'));
    });
    // Second, unreliable channel for snapshots and inputs.
    this.fast = this.peer.connect(hostId, { label: 'fast', serialization: 'raw', reliable: false, metadata: { id: this.you } });
    this.fast.on('data', (d) => this.onBinary(d as ArrayBuffer));
    // Keep-alive both ways: background tabs get no animation frames (so no per-frame input), and a host
    // whose tab was closed may never fire 'close'.
    this.heard = performance.now();
    this.keepAlive = setInterval(() => {
      const now = performance.now();
      if (now - this.lastSent > 250 && this.lastInput) this.sendInput(this.lastInput);
      if (now - this.heard > HOST_TIMEOUT_MS) this.close('Lost connection to the host.');
    }, 250);
  }

  private onReliable(msg: ReliableMsg) {
    if (msg.t === 'roster') this.setRoster(msg.roster);
    else if (msg.t === 'view') this.view = msg.view;
    else if (msg.t === 'events') this.events.push(...msg.events);
  }

  private setRoster(roster: RosterEntry[]) {
    this.roster = roster;
    this.onRoster(roster);
  }

  private onBinary(buf: ArrayBuffer) {
    if (binaryType(buf) !== 'snapshot') return;
    const s = decodeSnapshot(buf);
    if (!s) return;
    this.heard = performance.now();
    const last = this.snaps[this.snaps.length - 1];
    if (last && s.tick <= last.tick) return; // out of order / duplicate
    this.snaps.push(s);
    if (this.snaps.length > 30) this.snaps.shift();
    // Measure how fast the host's clock actually runs (smoothed: packets arrive with jitter).
    const now = performance.now();
    if (this.lastArrival && now > this.lastArrival.time + 1) {
      const inst = (s.tick - this.lastArrival.tick) / (now - this.lastArrival.time);
      this.rate = Math.max(0.005, Math.min(0.12, this.rate + (inst - this.rate) * 0.1));
    }
    this.lastArrival = { tick: s.tick, time: now };
  }

  /** Events received since the last call. */
  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Send this frame's input. Quick taps are held a few sends so a lost packet can't swallow them. */
  sendInput(input: PlayerInput) {
    if (!this.fast?.open) return;
    this.lastInput = { ...input, fire: false, jump: false, cycle: false };
    this.lastSent = performance.now();
    const out = { ...input };
    for (const k of ['fire', 'handL', 'handR', 'jump', 'cycle'] as const) {
      if (input[k]) this.held[k] = TAP_HOLD;
      else if ((this.held[k] ?? 0) > 0) { this.held[k]--; out[k] = true; }
    }
    this.fast.send(encodeInput(++this.seq, out));
  }

  /**
   * Write interpolated transforms for the dynamic entities into `out` (7 floats per entity, full array).
   * Returns false until enough snapshots have arrived.
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
