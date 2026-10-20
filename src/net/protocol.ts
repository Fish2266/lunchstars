// Wire protocol. Pure: no PeerJS, no DOM.
//
// Two channels per client:
// - reliable (JSON): hello / welcome, roster, GameView (10 Hz), SimEvents (as they happen)
// - unreliable (raw binary): host → client snapshots (20 Hz), client → host inputs (every frame)
//
// Entities aren't described on the wire: every peer builds the same map from the same code and mirrors the
// host's roster (players added in the same order), so entity indices line up. Snapshots only carry the
// dynamic entities' transforms, quantized to 14 bytes each.
import type { PlayerInput } from '../sim/input';
import type { GameView, SimEvent } from '../sim/sim';

export const PROTOCOL_VERSION = 1;
/** Peer ids on the public PeerJS broker are `lunchstars-<CODE>` for a room's host. */
export const PEER_PREFIX = 'lunchstars-';
export const MAX_PLAYERS = 4;

export interface RosterEntry {
  id: number;
  name: string;
  bot: boolean;
  /** Left the game (their entities stay so indices don't shift; they're just parked). */
  left: boolean;
}

export type ReliableMsg =
  | { t: 'hello'; v: number; name: string }
  | { t: 'welcome'; v: number; you: number; roster: RosterEntry[] }
  | { t: 'reject'; reason: string }
  | { t: 'roster'; roster: RosterEntry[] }
  | { t: 'view'; view: GameView }
  | { t: 'events'; events: SimEvent[] };

/** Short, unambiguous room codes (no 0/O, 1/I). */
export function makeRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// ---------------------------------------------------------------- binary messages

const SNAPSHOT = 1;
const INPUT = 2;
const POS_SCALE = 500; // 2 mm steps, ±65 m range
const HIDDEN = -32768; // y sentinel for entities parked off-map
const BYTES_PER_ENTITY = 14;

/**
 * Pack the transforms of the given entity indices (from a full 7-floats-per-entity array).
 * Layout: u8 type, u32 tick, u16 count, then per entity i16 x,y,z (pos×500) and i16 qx,qy,qz,qw (×32767).
 */
export function encodeSnapshot(tick: number, indices: readonly number[], transforms: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(7 + indices.length * BYTES_PER_ENTITY);
  const v = new DataView(buf);
  v.setUint8(0, SNAPSHOT);
  v.setUint32(1, tick);
  v.setUint16(5, indices.length);
  let o = 7;
  const q16 = (x: number) => Math.max(-32767, Math.min(32767, Math.round(x * 32767)));
  const p16 = (x: number) => Math.max(-32767, Math.min(32767, Math.round(x * POS_SCALE)));
  for (const i of indices) {
    const s = i * 7;
    const hidden = transforms[s + 1] < -500;
    v.setInt16(o, p16(transforms[s])); v.setInt16(o + 2, hidden ? HIDDEN : p16(transforms[s + 1])); v.setInt16(o + 4, p16(transforms[s + 2]));
    v.setInt16(o + 6, q16(transforms[s + 3])); v.setInt16(o + 8, q16(transforms[s + 4]));
    v.setInt16(o + 10, q16(transforms[s + 5])); v.setInt16(o + 12, q16(transforms[s + 6]));
    o += BYTES_PER_ENTITY;
  }
  return buf;
}

export interface Snapshot { tick: number; count: number; /** 7 floats per listed entity, same order as the indices */ data: Float32Array }

export function decodeSnapshot(buf: ArrayBuffer): Snapshot | null {
  const v = new DataView(buf);
  if (buf.byteLength < 7 || v.getUint8(0) !== SNAPSHOT) return null;
  const tick = v.getUint32(1);
  const count = v.getUint16(5);
  if (buf.byteLength < 7 + count * BYTES_PER_ENTITY) return null;
  const data = new Float32Array(count * 7);
  let o = 7;
  for (let k = 0; k < count; k++) {
    const d = k * 7;
    const y = v.getInt16(o + 2);
    data[d] = v.getInt16(o) / POS_SCALE;
    data[d + 1] = y === HIDDEN ? -1000 : y / POS_SCALE;
    data[d + 2] = v.getInt16(o + 4) / POS_SCALE;
    let qx = v.getInt16(o + 6) / 32767, qy = v.getInt16(o + 8) / 32767, qz = v.getInt16(o + 10) / 32767, qw = v.getInt16(o + 12) / 32767;
    const l = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= l; qy /= l; qz /= l; qw /= l;
    data[d + 3] = qx; data[d + 4] = qy; data[d + 5] = qz; data[d + 6] = qw;
    o += BYTES_PER_ENTITY;
  }
  return { tick, count, data };
}

const FLAGS = ['jump', 'handL', 'handR', 'fire', 'cycle'] as const;

/** u8 type, u32 seq, f32 moveX, moveZ, aimYaw, aimPitch, u8 button flags — 22 bytes. */
export function encodeInput(seq: number, input: PlayerInput): ArrayBuffer {
  const buf = new ArrayBuffer(22);
  const v = new DataView(buf);
  v.setUint8(0, INPUT);
  v.setUint32(1, seq);
  v.setFloat32(5, input.moveX); v.setFloat32(9, input.moveZ);
  v.setFloat32(13, input.aimYaw); v.setFloat32(17, input.aimPitch);
  let f = 0;
  FLAGS.forEach((k, i) => { if (input[k]) f |= 1 << i; });
  v.setUint8(21, f);
  return buf;
}

export function decodeInput(buf: ArrayBuffer): { seq: number; input: PlayerInput } | null {
  if (buf.byteLength < 22) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== INPUT) return null;
  const f = v.getUint8(21);
  const input = {
    moveX: v.getFloat32(5), moveZ: v.getFloat32(9), aimYaw: v.getFloat32(13), aimPitch: v.getFloat32(17),
  } as PlayerInput;
  FLAGS.forEach((k, i) => { input[k] = !!(f & (1 << i)); });
  // Never trust a peer's floats blindly.
  const ok = (x: number) => Number.isFinite(x);
  if (!ok(input.moveX) || !ok(input.moveZ) || !ok(input.aimYaw) || !ok(input.aimPitch)) return null;
  const l = Math.hypot(input.moveX, input.moveZ);
  if (l > 1) { input.moveX /= l; input.moveZ /= l; }
  input.aimPitch = Math.max(-1.5, Math.min(1.5, input.aimPitch));
  return { seq: v.getUint32(1), input };
}

/** Which kind of binary message this is (or null). */
export function binaryType(buf: ArrayBuffer): 'snapshot' | 'input' | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 1) return null;
  const t = new DataView(buf).getUint8(0);
  return t === SNAPSHOT ? 'snapshot' : t === INPUT ? 'input' : null;
}
