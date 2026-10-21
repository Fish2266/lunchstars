// Wire protocol. Pure: no PeerJS, no DOM.
//
// Two channels per client:
// - reliable, ordered (JSON): hello / welcome, roster, GameView changes (≤10 Hz, only what changed), SimEvents
// - unreliable (raw binary): host → client snapshots (20 Hz), client → host inputs (when they change, ≤60 Hz)
//
// Entities aren't described on the wire: every peer builds the same map from the same code and mirrors the
// host's roster (players added in the same order), so entity indices line up. Snapshots only carry the
// dynamic entities' transforms, quantized to 12 bytes each, and skip ones that have been resting a while.
//
// Bandwidth matters: when two players can't connect directly, every byte goes through a paid TURN relay.
import type { PlayerInput } from '../sim/input';
import type { GameView, SimEvent } from '../sim/sim';
import type { Look } from '../render/cosmetics';

export const PROTOCOL_VERSION = 5;
/** Peer ids on the public PeerJS broker are `lunchstars-<CODE>` for a room's host. */
export const PEER_PREFIX = 'lunchstars-';
export const MAX_PLAYERS = 4;
/** Label of the unreliable channel (snapshots and inputs). */
export const FAST_LABEL = 'fast';

export interface RosterEntry {
  id: number;
  name: string;
  bot: boolean;
  /** Left the game (their entities stay so indices don't shift; they're just parked). */
  left: boolean;
  /** Bots: difficulty (shown in the lobby). */
  level?: 'easy' | 'normal' | 'hard';
  /** Cosmetics (hat, face, top, bottom). */
  look?: Look;
}

export type ReliableMsg =
  | { t: 'hello'; v: number; name: string; look?: Look }
  /** A client changed their cosmetics. */
  | { t: 'look'; look: Look }
  | { t: 'welcome'; v: number; you: number; roster: RosterEntry[] }
  | { t: 'reject'; reason: string }
  | { t: 'roster'; roster: RosterEntry[] }
  /** The GameView as a patch on the previous one sent on this connection (see `diff`); the first is whole. */
  | { t: 'view'; tick: number; d: unknown }
  /** Events with the host tick they happened by, so the client plays them in step with the (delayed) bodies. */
  | { t: 'events'; batches: [tick: number, events: SimEvent[]][] };

/** Short, unambiguous room codes (no 0/O, 1/I). */
export function makeRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// ---------------------------------------------------------------- views and events (JSON)

const q = (x: number, step: number) => Math.round(x / step) * step;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Round the values that change every tick by amounts nobody can see (timers, meters), so the view only differs
 * from the last one sent when something visible changed — and so patches stay small.
 */
export function quantizeView(v: GameView): GameView {
  return {
    ...v,
    match: { ...v.match, timer: round3(q(v.match.timer, 0.05)) },
    players: v.players.map((p) => ({
      ...p,
      ko: round3(q(p.ko, 0.5)),
      koThreshold: round3(p.koThreshold),
      koTimer: round3(q(p.koTimer, 0.05)),
      stiffness: round3(q(p.stiffness, 0.01)),
      stun: round3(q(p.stun, 0.05)),
      stagger: round3(q(p.stagger, 0.05)),
    })),
  };
}

/** Events with every number rounded to 1 mm / 0.001: invisible, and much shorter as JSON. */
export function roundEvents(events: SimEvent[]): SimEvent[] {
  return roundDeep(events) as SimEvent[];
}
function roundDeep(x: unknown): unknown {
  if (typeof x === 'number') return round3(x);
  if (Array.isArray(x)) return x.map(roundDeep);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = roundDeep(v);
    return out;
  }
  return x;
}

/** "Nothing changed" from `diff`. */
export const SAME = Symbol('same');
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object';

/**
 * A patch turning `a` into `b` (plain JSON data). Objects (and same-length arrays) become an object of just their
 * changed keys; anything else is the new value, wrapped as `{ $: value }` when it's an object itself.
 */
export function diff(a: unknown, b: unknown): unknown {
  if (a === b) return SAME;
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)
    && (!Array.isArray(a) || a.length === (b as unknown as unknown[]).length)
    && Object.keys(a).every((k) => k in b)) {
    const out: Obj = {};
    let changed = false;
    for (const k of Object.keys(b)) {
      const d = diff(a[k], b[k]);
      if (d !== SAME) { out[k] = d; changed = true; }
    }
    return changed ? out : SAME;
  }
  return isObj(b) ? { $: b } : b;
}

/** Apply a `diff` patch to `a`, returning a new value (unchanged parts are shared). */
export function patch(a: unknown, d: unknown): unknown {
  if (!isObj(d)) return d;
  if ('$' in d) return d.$;
  if (!isObj(a)) return a; // malformed patch: keep what we had
  const out: Obj = Array.isArray(a) ? ([...a] as unknown as Obj) : { ...a };
  for (const [k, v] of Object.entries(d)) out[k] = patch(out[k], v);
  return out;
}

// ---------------------------------------------------------------- binary messages

const SNAPSHOT = 1;
const INPUT = 2;
const POS_SCALE = 500; // 2 mm steps, ±65 m range
const HIDDEN_Y = -1000; // where hidden entities are parked (the sim's HIDDEN_Y)
const BYTES_PER_ENTITY = 12;
const HEADER = 8;
/** An entity unchanged for this many snapshots in a row stops being sent until it moves again. */
const REST_AFTER = 5;
/** Every Nth snapshot sends every visible entity, so a client that missed packets can't stay wrong for long. */
const KEYFRAME_EVERY = 20;
const SQRT1_2 = Math.SQRT1_2;

/** Quantize a rotation "smallest three": drop the largest component (rebuilt from the others) — 15 bits each. */
function packQuat(x: number, y: number, z: number, w: number, out: Int32Array, o: number) {
  const c = [x, y, z, w];
  let big = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(c[i]) > Math.abs(c[big])) big = i;
  const sign = c[big] < 0 ? -1 : 1;
  const rest = [0, 1, 2, 3].filter((i) => i !== big)
    .map((i) => Math.max(0, Math.min(32767, Math.round(((c[i] * sign) / SQRT1_2 + 1) * 0.5 * 32767))));
  out[o] = ((big >> 1) << 15) | rest[0];
  out[o + 1] = ((big & 1) << 15) | rest[1];
  out[o + 2] = rest[2];
}

function unpackQuat(a: number, b: number, c: number, data: Float32Array, d: number) {
  const big = ((a >> 15) << 1) | (b >> 15);
  const vals = [a & 0x7fff, b & 0x7fff, c].map((n) => (n / 32767 * 2 - 1) * SQRT1_2);
  const largest = Math.sqrt(Math.max(0, 1 - vals[0] * vals[0] - vals[1] * vals[1] - vals[2] * vals[2]));
  let j = 0;
  for (let i = 0; i < 4; i++) data[d + 3 + i] = i === big ? largest : vals[j++];
}

/**
 * Packs snapshots for one host (state: which entities have been resting). Layout: u8 type, u32 tick, u16 count,
 * u8 flags, a "visible" bitmask and a "included" bitmask (1 bit per entity each), then for each included entity
 * i16 x,y,z (pos×500) and 3×u16 smallest-three rotation. Hidden entities (pooled grenades, guns not in hand)
 * cost a bit; entities resting for REST_AFTER snapshots cost a bit until they move (or the next keyframe).
 */
export class SnapshotEncoder {
  private last = new Int32Array(0);
  private resting = new Uint8Array(0);
  private count = 0;
  private q = new Int32Array(6);

  /** Make the next snapshot a keyframe (someone just joined and has nothing to fill skipped entities from). */
  keyframeNext() {
    this.count = 0;
  }

  encode(tick: number, indices: readonly number[], transforms: Float32Array): ArrayBuffer {
    const n = indices.length;
    if (this.last.length !== n * 6) { this.last = new Int32Array(n * 6).fill(-1 << 30); this.resting = new Uint8Array(n); }
    const keyframe = this.count++ % KEYFRAME_EVERY === 0;
    const maskBytes = Math.ceil(n / 8);
    const visible = new Uint8Array(maskBytes), included = new Uint8Array(maskBytes);
    const body = new DataView(new ArrayBuffer(n * BYTES_PER_ENTITY));
    let o = 0;
    const p16 = (x: number) => Math.max(-32767, Math.min(32767, Math.round(x * POS_SCALE)));
    const qv = this.q;
    indices.forEach((i, k) => {
      const s = i * 7;
      if (transforms[s + 1] < -500) { this.last[k * 6] = -1 << 30; this.resting[k] = 0; return; }
      visible[k >> 3] |= 1 << (k & 7);
      qv[0] = p16(transforms[s]); qv[1] = p16(transforms[s + 1]); qv[2] = p16(transforms[s + 2]);
      packQuat(transforms[s + 3], transforms[s + 4], transforms[s + 5], transforms[s + 6], qv, 3);
      let same = true;
      for (let j = 0; j < 6; j++) if (this.last[k * 6 + j] !== qv[j]) { same = false; this.last[k * 6 + j] = qv[j]; }
      this.resting[k] = same ? Math.min(255, this.resting[k] + 1) : 0;
      if (!keyframe && this.resting[k] >= REST_AFTER) return;
      included[k >> 3] |= 1 << (k & 7);
      body.setInt16(o, qv[0]); body.setInt16(o + 2, qv[1]); body.setInt16(o + 4, qv[2]);
      body.setUint16(o + 6, qv[3]); body.setUint16(o + 8, qv[4]); body.setUint16(o + 10, qv[5]);
      o += BYTES_PER_ENTITY;
    });
    const out = new Uint8Array(HEADER + maskBytes * 2 + o);
    const v = new DataView(out.buffer);
    v.setUint8(0, SNAPSHOT);
    v.setUint32(1, tick);
    v.setUint16(5, n);
    v.setUint8(7, keyframe ? 1 : 0);
    out.set(visible, HEADER);
    out.set(included, HEADER + maskBytes);
    out.set(new Uint8Array(body.buffer, 0, o), HEADER + maskBytes * 2);
    return out.buffer;
  }
}

export interface Snapshot { tick: number; count: number; /** 7 floats per listed entity, same order as the indices */ data: Float32Array }

/** The tick of a snapshot, without decoding it (to drop stale ones first). */
export function snapshotTick(buf: ArrayBuffer): number {
  return buf.byteLength >= HEADER ? new DataView(buf).getUint32(1) : -1;
}

/**
 * Decode a snapshot. Entities it skipped because they were resting take their transform from `prev` (the last
 * snapshot this client accepted).
 */
export function decodeSnapshot(buf: ArrayBuffer, prev: Snapshot | null): Snapshot | null {
  const v = new DataView(buf);
  if (buf.byteLength < HEADER || v.getUint8(0) !== SNAPSHOT) return null;
  const tick = v.getUint32(1);
  const count = v.getUint16(5);
  const maskBytes = Math.ceil(count / 8);
  if (buf.byteLength < HEADER + maskBytes * 2) return null;
  const visible = new Uint8Array(buf, HEADER, maskBytes);
  const included = new Uint8Array(buf, HEADER + maskBytes, maskBytes);
  let n = 0;
  for (let k = 0; k < count; k++) if (included[k >> 3] & (1 << (k & 7))) n++;
  if (buf.byteLength < HEADER + maskBytes * 2 + n * BYTES_PER_ENTITY) return null;
  const usable = prev && prev.count === count ? prev.data : null;
  const data = new Float32Array(count * 7);
  let o = HEADER + maskBytes * 2;
  for (let k = 0; k < count; k++) {
    const d = k * 7;
    const bit = 1 << (k & 7);
    if (!(visible[k >> 3] & bit)) { data[d + 1] = HIDDEN_Y; data[d + 6] = 1; continue; }
    if (!(included[k >> 3] & bit)) {
      // Resting: same as before. (If we never saw it, it stays hidden until the next keyframe, ≤1 s.)
      if (usable) for (let j = 0; j < 7; j++) data[d + j] = usable[d + j];
      else { data[d + 1] = HIDDEN_Y; data[d + 6] = 1; }
      continue;
    }
    data[d] = v.getInt16(o) / POS_SCALE;
    data[d + 1] = v.getInt16(o + 2) / POS_SCALE;
    data[d + 2] = v.getInt16(o + 4) / POS_SCALE;
    unpackQuat(v.getUint16(o + 6), v.getUint16(o + 8), v.getUint16(o + 10), data, d);
    o += BYTES_PER_ENTITY;
  }
  return { tick, count, data };
}

/** The buttons. Besides its current state, each has a press counter so a quick tap survives lost or bunched packets. */
export const BUTTONS = ['jump', 'handL', 'handR', 'fire', 'cycle'] as const;
/** In the press-count list, after the buttons: how many emotes have been started. */
export const EMOTE_PRESS = BUTTONS.length;
const EMOTE_AT = 22 + BUTTONS.length + 1;
const INPUT_BYTES = EMOTE_AT + 1;

/**
 * u8 type, u32 seq, f32 moveX, moveZ, aimYaw, aimPitch, u8 button flags, u8 press count per button and one for
 * emotes, u8 emote held — 29 bytes. `presses` = BUTTONS.length button counts, then the emote count.
 */
export function encodeInput(seq: number, input: PlayerInput, presses: readonly number[]): ArrayBuffer {
  const buf = new ArrayBuffer(INPUT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, INPUT);
  v.setUint32(1, seq);
  v.setFloat32(5, input.moveX); v.setFloat32(9, input.moveZ);
  v.setFloat32(13, input.aimYaw); v.setFloat32(17, input.aimPitch);
  let f = 0;
  BUTTONS.forEach((k, i) => { if (input[k]) f |= 1 << i; });
  for (let i = 0; i <= EMOTE_PRESS; i++) v.setUint8(22 + i, (presses[i] ?? 0) & 255);
  v.setUint8(21, f);
  v.setUint8(EMOTE_AT, input.emote & 7);
  return buf;
}

export function decodeInput(buf: ArrayBuffer): { seq: number; input: PlayerInput; presses: number[] } | null {
  if (buf.byteLength < INPUT_BYTES) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== INPUT) return null;
  const f = v.getUint8(21);
  const input = {
    moveX: v.getFloat32(5), moveZ: v.getFloat32(9), aimYaw: v.getFloat32(13), aimPitch: v.getFloat32(17),
  } as PlayerInput;
  BUTTONS.forEach((k, i) => { input[k] = !!(f & (1 << i)); });
  const presses = Array.from({ length: EMOTE_PRESS + 1 }, (_, i) => v.getUint8(22 + i));
  input.emote = Math.min(4, v.getUint8(EMOTE_AT));
  // Never trust a peer's floats blindly.
  const ok = (x: number) => Number.isFinite(x);
  if (!ok(input.moveX) || !ok(input.moveZ) || !ok(input.aimYaw) || !ok(input.aimPitch)) return null;
  const l = Math.hypot(input.moveX, input.moveZ);
  if (l > 1) { input.moveX /= l; input.moveZ /= l; }
  input.aimPitch = Math.max(-1.5, Math.min(1.5, input.aimPitch));
  return { seq: v.getUint32(1), input, presses };
}

/** Which kind of binary message this is (or null). */
export function binaryType(buf: ArrayBuffer): 'snapshot' | 'input' | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 1) return null;
  const t = new DataView(buf).getUint8(0);
  return t === SNAPSHOT ? 'snapshot' : t === INPUT ? 'input' : null;
}
