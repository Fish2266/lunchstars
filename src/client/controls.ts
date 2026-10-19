// Keyboard + mouse -> PlayerInput, plus the orbit camera angles.
import type { PlayerInput } from '../sim/input';

export class Controls {
  yaw = Math.PI; // camera yaw; character faces the same way
  pitch = -0.25;
  sensitivity = 0.0025;
  private keys = new Set<string>();
  private mouseButtons = new Set<number>();
  /** One-shot actions the client handles itself (debug tools). */
  readonly pressed = new Set<string>();
  fireClicked = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouseButtons.clear(); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) {
        canvas.requestPointerLock();
        return;
      }
      this.mouseButtons.add(e.button);
      if (e.button === 0) this.fireClicked = true;
    });
    addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = Math.max(-1.2, Math.min(1.0, this.pitch - e.movementY * this.sensitivity));
    });
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  /** Build this tick's input. Movement is camera-relative, converted to world space here. */
  read(): PlayerInput {
    const f = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const r = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
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
      jump: this.keys.has('Space'),
      grab: this.keys.has('KeyE') || this.mouseButtons.has(2),
    };
  }

  consume(code: string) {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  endFrame() {
    this.pressed.clear();
    this.fireClicked = false;
  }
}
