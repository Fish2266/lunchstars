// Sound, all synthesized with Web Audio — no sound files to download or license.
//
// Every sound comes from SimEvents (so it works the same on a multiplayer client), placed in the world:
// quieter with distance from the listener (your character) and panned left/right relative to the camera.
// The fire pit has a roar that swells as you get close and when the pit flares.
import type { FurnaceState, SimEvent, V3 } from '../sim/sim';

type Dest = AudioNode;

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private listener = { x: 0, y: 0, z: 0 };
  private right = { x: 1, y: 0, z: 0 };
  private fire: { gain: GainNode; crackle: GainNode } | null = null;
  private volume = 0.7;
  private lastPlayed = new Map<string, number>();

  /** Audio can only start after the player clicks or presses a key. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    // A gentle limiter so explosions stacked on gunfire don't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startFireLoop();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Where the listener is (your character) and the camera's right-hand direction, for panning. */
  listen(pos: V3, right: V3) {
    this.listener = { ...pos };
    this.right = { ...right };
  }

  /** Fire pit ambience: louder near the pit, much louder when it flares. */
  update(pitCenter: V3, furnace: FurnaceState) {
    if (!this.ctx || !this.fire) return;
    const d = Math.hypot(pitCenter.x - this.listener.x, pitCenter.z - this.listener.z);
    const near = 1 / (1 + Math.max(0, d - 2) * 0.35);
    const boost = furnace === 'burst' ? 3 : furnace === 'warn' ? 1.8 : 1;
    const t = this.ctx.currentTime;
    this.fire.gain.gain.setTargetAtTime(0.16 * near * boost, t, 0.25);
    this.fire.crackle.gain.setTargetAtTime(0.1 * near * boost, t, 0.25);
  }

  // ---------------------------------------------------------------- events

  handle(e: SimEvent, posOf: (id: number) => V3 | null, localId: number) {
    if (!this.ctx) return;
    switch (e.type) {
      case 'shot':
        if (!e.first) return;
        if (e.weapon === 'shotgun') this.shotgun(e.from);
        else this.pistol(e.from);
        break;
      case 'punch':
        this.whoosh(e.to, 0.55, 900, 2600, 0.13);
        break;
      case 'hit': {
        const s = Math.min(1, e.strength / 12);
        if (e.cause === 'punch' || e.cause === 'bonk' || e.cause === 'shove') this.thud(e.pos, 0.5 + s * 0.5);
        else if (e.cause === 'shot' || e.cause === 'pellet') this.splat(e.pos, 0.4 + s * 0.4);
        // Big hits get a grunt from whoever took them (each player's voice a little different).
        if (s > 0.35 && this.rateOk(`grunt${e.player}`, 0.35)) this.grunt(e.pos, e.player);
        if (e.by === localId && e.player !== localId && this.rateOk('hitmark', 0.06)) this.tick(this.listener, 1800, 0.12);
        break;
      }
      case 'explosion':
        this.explosion(e.pos, e.radius);
        break;
      case 'throw':
        this.whoosh(e.pos, 0.4, 500, 1600, 0.25);
        break;
      case 'ko': {
        const p = posOf(e.player);
        if (p) this.bonk(p);
        break;
      }
      case 'wake': {
        const p = posOf(e.player);
        if (p) this.tone('sine', 280, 620, 0.25, 0.25, this.place(p), 0.01);
        break;
      }
      case 'eliminated':
        if (e.cause === 'fire') this.roarBurst(e.pos);
        else this.fallWhistle(e.pos);
        break;
      case 'burn':
        this.sizzle(e.pos);
        break;
      case 'railBreak':
        this.clank(e.pos, 0.6, [310, 470, 655]);
        break;
      case 'stamp':
        this.slam(e.pos);
        break;
      case 'gunSpawn':
        this.clank(e.pos, 0.25, [520, 780]);
        break;
      case 'pickup':
        this.tick(e.pos, 1400, 0.25);
        this.tick(e.pos, 1000, 0.22, 0.07);
        break;
      case 'empty': {
        const p = posOf(e.player);
        if (p) this.tick(p, 2400, 0.2);
        break;
      }
      case 'drop': {
        const p = posOf(e.player);
        if (p) { if (e.thrown) this.whoosh(p, 0.3, 600, 1800, 0.2); else this.clank(p, 0.15, [900, 1300]); }
        break;
      }
      case 'furnace':
        if (e.state === 'warn') this.rumble();
        break;
      case 'countdown':
        break; // the beeps come from countdownBeep(), once per number
      case 'roundStart':
        this.chord([523, 659, 784, 1047], 0.08, 0.25, 'square', 0.09);
        break;
      case 'roundOver':
        this.chord([392, 523, 659], 0.12, 0.35, 'triangle', 0.16);
        break;
      case 'matchOver':
        this.chord([392, 523, 659, 784, 1047, 1319], 0.11, 0.6, 'triangle', 0.18);
        break;
      case 'matchEnded':
        this.chord([440, 330], 0.15, 0.4, 'triangle', 0.14);
        break;
    }
  }

  /** "3, 2, 1" beeps before a round. */
  countdownBeep() {
    if (this.ctx) this.tone('square', 660, 660, 0.14, 0.2, this.master!, 0.005);
  }

  /** An emote's little sound effect. */
  emote(pos: V3, kind: number) {
    if (!this.ctx) return;
    if (kind === 1) this.chord([660, 880], 0.07, 0.12, 'sine', 0.12, this.place(pos)); // wave: a cheery "hi!"
    else if (kind === 2) this.chord([392, 494, 587, 494], 0.12, 0.12, 'square', 0.06, this.place(pos)); // dance beat
    else if (kind === 3) this.tone('sawtooth', 220, 140, 0.35, 0.08, this.place(pos), 0.01); // taunt raspberry
    else if (kind === 4) this.chord([523, 659, 784], 0.06, 0.2, 'triangle', 0.12, this.place(pos)); // cheer
  }

  // ---------------------------------------------------------------- sound recipes

  private pistol(p: V3) {
    const out = this.place(p);
    this.noise(0.12, 'highpass', 900, 900, 0.7, 0.55, out, 0.001);
    this.tone('sine', 170, 55, 0.09, 0.5, out, 0.001);
  }

  private shotgun(p: V3) {
    const out = this.place(p);
    this.noise(0.38, 'lowpass', 4200, 600, 0.8, 0.85, out, 0.001);
    this.tone('sine', 110, 38, 0.28, 0.75, out, 0.001);
    this.clank(p, 0.12, [1500], 0.26); // pump rack
  }

  private explosion(p: V3, radius: number) {
    const out = this.place(p, 1.6);
    const big = Math.min(1.4, radius / 3);
    this.noise(1.3, 'lowpass', 1400, 140, 0.9, 0.95 * big, out, 0.002);
    this.tone('sine', 75, 28, 0.9, 0.9 * big, out, 0.002);
    for (let i = 0; i < 6; i++) this.tick(p, 2500 + Math.random() * 2500, 0.06, 0.08 + Math.random() * 0.5);
  }

  private thud(p: V3, k: number) {
    const out = this.place(p);
    this.tone('sine', 140, 48, 0.14, 0.7 * k, out, 0.002);
    this.noise(0.06, 'lowpass', 1800, 600, 1, 0.35 * k, out, 0.001);
  }

  private splat(p: V3, k: number) {
    const out = this.place(p);
    this.noise(0.18, 'bandpass', 700, 300, 2, 0.5 * k, out, 0.002);
    this.tone('sine', 220, 90, 0.1, 0.3 * k, out, 0.002);
  }

  private whoosh(p: V3, k: number, f0: number, f1: number, dur: number) {
    this.noise(dur, 'bandpass', f0, f1, 1.4, k, this.place(p), dur * 0.4);
  }

  private bonk(p: V3) {
    const out = this.place(p);
    this.tone('sine', 900, 380, 0.18, 0.45, out, 0.002);
    // Little "seeing stars" twinkle.
    [1568, 1976, 2349].forEach((f, i) => this.tone('sine', f, f, 0.12, 0.12, out, 0.005, 0.16 + i * 0.09));
  }

  private grunt(p: V3, player: number) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const pitch = 150 + ((player * 37) % 90); // a different voice per player
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(pitch * 1.25, t);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.8, t + 0.18);
    // Two formant bands make it sound like a vowel ("oof").
    const out = this.place(p);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    for (const [f, q, a] of [[500, 6, 1], [900, 8, 0.6]] as const) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const ga = ctx.createGain(); ga.gain.value = a;
      osc.connect(bp).connect(ga).connect(g);
    }
    g.connect(out);
    osc.start(t); osc.stop(t + 0.25);
  }

  private roarBurst(p: V3) {
    const out = this.place(p, 1.5);
    this.noise(1.1, 'bandpass', 300, 1200, 0.9, 0.9, out, 0.05);
    this.tone('sine', 90, 45, 0.8, 0.5, out, 0.01);
  }

  private fallWhistle(p: V3) {
    this.tone('sine', 1300, 260, 1.1, 0.2, this.place(p, 1.4), 0.02);
  }

  private sizzle(p: V3) {
    this.noise(0.6, 'highpass', 3000, 5000, 0.7, 0.35, this.place(p), 0.01);
  }

  private clank(p: V3, k: number, freqs: number[], delay = 0) {
    const out = this.place(p);
    for (const f of freqs) this.tone('triangle', f, f * 0.98, 0.35, (0.35 * k) / freqs.length + 0.05 * k, out, 0.001, delay);
    this.noise(0.05, 'highpass', 2000, 2000, 1, 0.3 * k, out, 0.001, delay);
  }

  private slam(p: V3) {
    const out = this.place(p, 1.2);
    this.tone('sine', 80, 40, 0.35, 0.9, out, 0.001);
    this.noise(0.25, 'lowpass', 1600, 200, 1, 0.7, out, 0.001);
    this.clank(p, 0.4, [220, 330]);
  }

  private rumble() {
    if (!this.ctx || !this.master) return;
    this.noise(1.4, 'lowpass', 120, 400, 1, 0.25, this.master, 0.6);
  }

  private tick(p: V3, f: number, k: number, delay = 0) {
    this.tone('square', f, f * 0.9, 0.035, 0.6 * k, this.place(p), 0.001, delay);
  }

  private chord(freqs: number[], gap: number, dur: number, type: OscillatorType, k: number, dest?: Dest) {
    freqs.forEach((f, i) => this.tone(type, f, f, dur, k, dest ?? this.master!, 0.01, i * gap));
  }

  // ---------------------------------------------------------------- building blocks

  /** A gain + pan node placed at `p` relative to the listener. `reach` > 1 for loud, far-carrying sounds. */
  private place(p: V3, reach = 1): Dest {
    const ctx = this.ctx!;
    const dx = p.x - this.listener.x, dy = p.y - this.listener.y, dz = p.z - this.listener.z;
    const d = Math.hypot(dx, dy, dz);
    const g = ctx.createGain();
    g.gain.value = 1 / (1 + (d * 0.16) / reach);
    const pan = ctx.createStereoPanner();
    pan.pan.value = d > 0.5 ? Math.max(-0.85, Math.min(0.85, (dx * this.right.x + dz * this.right.z) / d)) : 0;
    g.connect(pan).connect(this.master!);
    return g;
  }

  /** `delay`: seconds from now (scheduled on the audio clock, so sequences stay exactly in time). */
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, dest: Dest, attack: number, delay = 0) {
    const ctx = this.ctx!, t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, filter: BiquadFilterType, f0: number, f1: number, q: number, gain: number, dest: Dest, attack: number, delay = 0) {
    const ctx = this.ctx!, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loopStart = Math.random();
    const bq = ctx.createBiquadFilter();
    bq.type = filter;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bq).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
  }

  private startFireLoop() {
    const ctx = this.ctx!;
    const mk = (type: BiquadFilterType, f: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const bq = ctx.createBiquadFilter(); bq.type = type; bq.frequency.value = f; bq.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(bq).connect(g).connect(this.master!);
      src.start();
      return g;
    };
    // Low roar plus higher crackle, its loudness wobbling like flames.
    const gain = mk('lowpass', 380, 0.7);
    const crackle = mk('bandpass', 2600, 3);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 3.3;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.04;
    lfo.connect(lfoGain).connect(crackle.gain); lfo.start();
    this.fire = { gain, crackle };
  }

  /** Don't stack the same sound too often (e.g. a shotgun's pellets all grunting). */
  private rateOk(key: string, seconds: number) {
    const now = this.ctx!.currentTime;
    if ((this.lastPlayed.get(key) ?? -1) > now - seconds) return false;
    this.lastPlayed.set(key, now);
    return true;
  }
}
