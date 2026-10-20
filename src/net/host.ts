// The host: owns the only real simulation. Accepts players into the room, collects their inputs, and
// broadcasts snapshots (20 Hz, unreliable), the GameView (10 Hz, reliable) and events (as they happen).
import Peer, { type DataConnection } from 'peerjs';
import { emptyInput, type PlayerInput } from '../sim/input';
import type { Sim, SimEvent } from '../sim/sim';
import {
  binaryType, decodeInput, encodeSnapshot, makeRoomCode, MAX_PLAYERS, PEER_PREFIX, PROTOCOL_VERSION,
  type ReliableMsg, type RosterEntry,
} from './protocol';

interface Remote {
  id: number;
  name: string;
  rel: DataConnection;
  fast: DataConnection | null;
  input: PlayerInput;
  seq: number;
  /** performance.now() of the last packet from them (closing a tab doesn't reliably fire 'close'). */
  heard: number;
}

/** Silence after which a client is treated as gone (clients send input at least every 250 ms, even in a background tab). */
const TIMEOUT_MS = 6000;

const SNAPSHOT_EVERY = 3; // ticks (60 Hz / 3 = 20 Hz)
const VIEW_EVERY = 6; // ticks (10 Hz)
/** Everyone who has ever been in the room, counting players who left (each keeps a collision group). */
const MAX_EVER = 12;

export class NetHost {
  code = '';
  readonly roster: RosterEntry[] = [];
  private peer: Peer | null = null;
  private remotes = new Map<number, Remote>();
  private nextId = 1;
  private lastSnapTick = -999;
  private lastViewTick = -999;
  private pendingEvents: SimEvent[] = [];
  /** Called when someone joins or leaves (for the HUD). */
  onRosterChange: () => void = () => {};

  /** `roster` = the players already in the sim (the host, any bots), in the order they were added. */
  constructor(private readonly sim: Sim, roster: RosterEntry[]) {
    this.roster.push(...roster);
    this.nextId = Math.max(...roster.map((r) => r.id)) + 1;
  }

  /** Open a room on the public PeerJS broker. Resolves with the room code. */
  async open(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeRoomCode();
      try {
        this.peer = await openPeer(PEER_PREFIX + code);
        this.code = code;
        this.peer.on('connection', (c) => this.onConnection(c));
        this.peer.on('disconnected', () => this.peer?.reconnect());
        return code;
      } catch (e) {
        if ((e as { type?: string }).type !== 'unavailable-id') throw e;
      }
    }
    throw new Error('Could not get a room code — try again.');
  }

  /** Players in the room right now (humans and bots). */
  get playing() {
    return this.roster.filter((r) => !r.left).length;
  }

  /** Room for one more? (Players who left keep their slot, so there's also a cap on everyone ever.) */
  get hasRoom() {
    return this.playing < MAX_PLAYERS && this.roster.length < MAX_EVER;
  }

  /** Add a bot (run on the host like any player). Returns its id, or null if the room is full. */
  addBot(name: string): number | null {
    if (!this.hasRoom) return null;
    const id = this.nextId++;
    this.sim.addPlayer(id);
    this.roster.push({ id, name, bot: true, left: false });
    this.broadcastRoster();
    return id;
  }

  /** Take a bot out of the game (it's parked like a player who left). */
  removeBot(id: number) {
    const entry = this.roster.find((e) => e.id === id && e.bot && !e.left);
    if (!entry) return;
    entry.left = true;
    this.sim.removePlayer(id);
    this.broadcastRoster();
  }

  /** Latest input from each connected remote player. */
  remoteInputs(): [number, PlayerInput][] {
    return [...this.remotes.values()].map((r) => [r.id, r.input]);
  }

  /** Queue this frame's events to send. */
  queueEvents(events: SimEvent[]) {
    if (events.length) this.pendingEvents.push(...events);
  }

  /** Send whatever is due: snapshot, view, events. `transforms` is the full 7-floats-per-entity array. */
  broadcast(transforms: Float32Array) {
    const tick = this.sim.tick;
    const now = performance.now();
    for (const r of [...this.remotes.values()]) if (now - r.heard > TIMEOUT_MS) this.dropConnection(r.rel);
    if (this.pendingEvents.length) {
      this.sendAll({ t: 'events', events: this.pendingEvents });
      this.pendingEvents = [];
    }
    if (tick - this.lastViewTick >= VIEW_EVERY) {
      this.lastViewTick = tick;
      this.sendAll({ t: 'view', view: this.sim.view() });
    }
    if (tick - this.lastSnapTick >= SNAPSHOT_EVERY) {
      this.lastSnapTick = tick;
      const buf = encodeSnapshot(tick, this.sim.dynamicIndices(), transforms);
      for (const r of this.remotes.values()) if (r.fast?.open) r.fast.send(buf);
    }
  }

  close() {
    for (const r of this.remotes.values()) { r.rel.close(); r.fast?.close(); }
    this.remotes.clear();
    this.peer?.destroy();
    this.peer = null;
  }

  // ---------------------------------------------------------------- connections

  private onConnection(conn: DataConnection) {
    if (conn.label === 'fast') {
      // The client's second (unreliable) channel, opened after it was welcomed.
      const id = Number(conn.metadata?.id);
      const r = this.remotes.get(id);
      if (!r) { conn.close(); return; }
      r.fast = conn;
      conn.on('data', (d) => {
        if (binaryType(d as ArrayBuffer) !== 'input') return;
        const m = decodeInput(d as ArrayBuffer);
        r.heard = performance.now();
        if (m && m.seq > r.seq) { r.seq = m.seq; r.input = m.input; }
      });
      return;
    }
    conn.on('data', (d) => this.onReliable(conn, d as ReliableMsg));
    conn.on('close', () => this.dropConnection(conn));
    conn.on('error', () => this.dropConnection(conn));
  }

  private onReliable(conn: DataConnection, msg: ReliableMsg) {
    if (msg.t !== 'hello') return;
    if (msg.v !== PROTOCOL_VERSION) {
      conn.send({ t: 'reject', reason: 'Different game version — refresh both pages.' } satisfies ReliableMsg);
      return;
    }
    if (!this.hasRoom) {
      conn.send({ t: 'reject', reason: 'Room is full.' } satisfies ReliableMsg);
      return;
    }
    const id = this.nextId++;
    const name = String(msg.name || 'Player').slice(0, 16);
    // Order matters: every peer adds players in roster order so entity indices match.
    this.sim.addPlayer(id);
    this.roster.push({ id, name, bot: false, left: false });
    this.remotes.set(id, { id, name, rel: conn, fast: null, input: emptyInput(), seq: 0, heard: performance.now() });
    (conn as DataConnection & { _playerId?: number })._playerId = id;
    conn.send({ t: 'welcome', v: PROTOCOL_VERSION, you: id, roster: this.roster } satisfies ReliableMsg);
    this.broadcastRoster(id);
    this.lastViewTick = -999; // send the newcomer a view right away
  }

  private dropConnection(conn: DataConnection) {
    const id = (conn as DataConnection & { _playerId?: number })._playerId;
    if (id === undefined || !this.remotes.has(id)) return;
    const r = this.remotes.get(id)!;
    this.remotes.delete(id);
    r.rel.close();
    r.fast?.close();
    const entry = this.roster.find((e) => e.id === id);
    if (entry) entry.left = true;
    this.sim.removePlayer(id);
    this.broadcastRoster();
  }

  private broadcastRoster(except?: number) {
    for (const r of this.remotes.values()) if (r.id !== except && r.rel.open) r.rel.send({ t: 'roster', roster: this.roster } satisfies ReliableMsg);
    this.onRosterChange();
  }

  private sendAll(msg: ReliableMsg) {
    for (const r of this.remotes.values()) if (r.rel.open) r.rel.send(msg);
  }
}

/** Create a Peer with a fixed id; resolves once registered with the broker. */
export function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id) : new Peer();
    const fail = (e: unknown) => { peer.destroy(); reject(e); };
    peer.once('open', () => { peer.off('error', fail); resolve(peer); });
    peer.once('error', fail);
  });
}
