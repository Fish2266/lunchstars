// Keyboard + mouse -> PlayerInput, via remappable bindings, plus the orbit camera angles.
import type { PlayerInput } from '../sim/input';
import { settings, type Action } from './bindings';

export class Controls {
  yaw = Math.PI; // camera yaw; character faces the same way
  pitch = -0.25;
  baseSensitivity = 0.0025;
  /** Codes currently held (keys and "MouseN"). */
  private down = new Set<string>();
  /** Codes pressed since the last frame — so taps shorter than a frame still count. */
  private tapped = new Set<string>();
  /** While true (settings open, rebinding), the game ignores input. */
  suspended = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (this.suspended) return;
      if (!this.down.has(e.code)) this.tapped.add(e.code);
      this.down.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab' || e.code === 'Backspace') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (this.suspended) return;
      // Can be refused (e.g. inside an embedded preview); the game still works without it.
      if (!this.locked) Promise.resolve(canvas.requestPointerLock()).catch(() => {});
      const code = `Mouse${e.button}`;
      this.down.add(code);
      this.tapped.add(code);
      e.preventDefault();
    });
    addEventListener('mouseup', (e) => this.down.delete(`Mouse${e.button}`));
    addEventListener('mousemove', (e) => {
      if (!this.locked || this.suspended) return;
      const s = this.baseSensitivity * settings.sensitivity;
      this.yaw -= e.movementX * s;
      this.pitch = Math.max(-1.2, Math.min(1.0, this.pitch - e.movementY * s * (settings.invertY ? -1 : 1)));
    });
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  /** Held now, or tapped since last frame. */
  isDown(action: Action) {
    if (this.suspended) return false;
    for (const code of settings.bindings[action]) {
      if (code && (this.down.has(code) || this.tapped.has(code))) return true;
    }
    return false;
  }

  /** True once per press. */
  consume(action: Action) {
    for (const code of settings.bindings[action]) {
      if (code && this.tapped.has(code)) {
        this.tapped.delete(code);
        return true;
      }
    }
    return false;
  }

  /** Build this tick's input. Movement is camera-relative, converted to world space here. */
  read(): PlayerInput {
    const f = (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0);
    const r = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    // Facing yaw: forward = (sin yaw, cos yaw); right = (-cos yaw, sin yaw).
    const sx = Math.sin(this.yaw), cz = Math.cos(this.yaw);
    let mx = f * sx - r * cz;
    let mz = f * cz + r * sx;
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }
    return {
      moveX: mx,
      moveZ: mz,
      aimYaw: this.yaw,
      aimPitch: this.pitch,
      jump: this.isDown('jump'),
      handL: this.isDown('handL'),
      handR: this.isDown('handR'),
      fire: this.isDown('fire'),
      cycle: this.isDown('cycle'),
    };
  }

  endFrame() {
    this.tapped.clear();
  }

  releaseAll() {
    this.down.clear();
    this.tapped.clear();
  }
}
