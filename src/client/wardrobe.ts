// The character preview on the Customize screen: a small canvas of its own with your character standing in
// its rest pose, slowly turning, dressed in whatever the arrows have picked.
import * as THREE from 'three';
import { PARTS } from '../sim/ragdoll';
import { buildBody } from '../render/body';
import { buildFace, type Face } from '../render/models';
import { animateHat, buildHat, gummyBodyMaterial, paintBody, playerGeometry, type Look } from '../render/cosmetics';

const HEAD_R = 0.195;

export class WardrobePreview {
  readonly canvas: HTMLCanvasElement;
  private gl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1, 0.1, 20);
  private spin = new THREE.Group();
  private geo = playerGeometry();
  private face: Face;
  private head: THREE.Bone;
  private hat: THREE.Object3D | null = null;
  private raf = 0;
  private last = 0;
  private skin = -1;
  private look = '';
  private dragging = false;
  private dragX = 0;

  constructor(width: number, height: number) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.gl.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.gl.setSize(width, height);
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.gl.domElement;
    this.canvas.className = 'wardrobe-canvas';
    this.camera.aspect = width / height;
    // Framed from the shoes to the top of the tallest hat.
    this.camera.position.set(0, 0.05, 3.55);
    this.camera.lookAt(0, 0.0, 0);
    this.camera.updateProjectionMatrix();

    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x3a3048, 1.6));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.4);
    key.position.set(2, 3, 4);
    const rim = new THREE.DirectionalLight(0x9fb0ff, 1.4);
    rim.position.set(-3, 2, -3);
    this.scene.add(key, rim);

    // One bone per body part at its rest position (pelvis at the origin), like the game's skeleton.
    const bones = PARTS.map((p) => {
      const b = new THREE.Bone();
      b.position.set(p.offset[0], p.offset[1], p.offset[2]);
      this.spin.add(b);
      return b;
    });
    this.head = bones[PARTS.findIndex((p) => p.name === 'head')];
    this.face = buildFace(HEAD_R);
    this.head.add(this.face.group);
    const body = buildBody(bones, gummyBodyMaterial(), this.geo);
    this.spin.add(body);
    // A soft shadow disc to stand on.
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.45, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.99;
    this.scene.add(this.spin, disc);

    // Drag to turn it.
    this.canvas.addEventListener('pointerdown', (e) => { this.dragging = true; this.dragX = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.spin.rotation.y += (e.clientX - this.dragX) * 0.012;
      this.dragX = e.clientX;
    });
    this.canvas.addEventListener('pointerup', () => { this.dragging = false; });
  }

  /** Show `look` on a body of colour `skin`. */
  dress(skin: number, look: Look) {
    const key = JSON.stringify(look);
    if (skin === this.skin && key === this.look) return;
    this.skin = skin;
    this.look = key;
    paintBody(this.geo, skin, look);
    this.face.setStyle(look.face);
    if (this.hat) this.head.remove(this.hat);
    this.hat = buildHat(look.head, HEAD_R);
    if (this.hat) this.head.add(this.hat);
  }

  /** Turn to a fixed angle (and stop the slow spin), e.g. for a screenshot. */
  hold(angle: number) {
    this.spin.rotation.y = angle;
    this.dragging = true;
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (!this.dragging) this.spin.rotation.y += dt * 0.6;
      animateHat(this.hat, now / 1000);
      this.gl.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
