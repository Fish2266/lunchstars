import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Controls } from './client/controls';
import { createDebugPanel, loadSavedTuning } from './client/debug';
import { Renderer } from './render/renderer';
import { emptyInput, type PlayerInput } from './sim/input';
import { DT, Sim } from './sim/sim';
import { tuning } from './sim/tuning';

const LOCAL_ID = 0;
const DUMMY_ID = 1;

async function main() {
  await RAPIER.init();
  loadSavedTuning();

  const sim = new Sim(RAPIER);
  const me = sim.addPlayer(LOCAL_ID);
  const dummy = sim.addPlayer(DUMMY_ID);

  const renderer = new Renderer(document.body);
  const controls = new Controls(renderer.gl.domElement);
  const transforms = new Float32Array(4096 * 7);

  const stats = { fps: 0, stiffness: 1, grounded: '' };
  const shoveDummy = () => {
    const p = dummy.chest.translation();
    const m = me.chest.translation();
    const d = new THREE.Vector3(p.x - m.x, 0, p.z - m.z).normalize();
    sim.shoveRay({ x: p.x - d.x * 2, y: p.y, z: p.z - d.z * 2 }, { x: d.x, y: 0, z: d.z }, tuning.shoveImpulse, 4);
  };
  const gui = createDebugPanel({ shoveDummy, reset: () => sim.resetAll(), stats });

  // Shot tracer (debug shove ray), fades out.
  const tracerMat = new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true });
  const tracerGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const tracer = new THREE.Line(tracerGeo, tracerMat);
  tracer.frustumCulled = false;
  renderer.scene.add(tracer);

  const inputs = new Map<number, PlayerInput>();
  const dummyInput = emptyInput();
  const camTarget = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  let acc = 0;
  let last = performance.now();
  let fpsFrames = 0, fpsTime = 0;

  function frame(now: number) {
    const frameDt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (controls.consume('KeyR')) sim.resetAll();
    if (controls.consume('KeyF')) shoveDummy();
    if (controls.consume('Backquote')) gui.show(gui._hidden);

    // Debug shove ray from the crosshair (becomes the pistol in Phase 3).
    camFwd.set(0, 0, -1).applyQuaternion(renderer.camera.quaternion);
    if (controls.fireClicked) {
      const o = renderer.camera.position;
      const hit = sim.shoveRay({ x: o.x, y: o.y, z: o.z }, { x: camFwd.x, y: camFwd.y, z: camFwd.z }, tuning.shoveImpulse, 80, LOCAL_ID);
      const start = me.parts.get('forearmR')!.body.translation();
      const end = hit ?? { x: o.x + camFwd.x * 80, y: o.y + camFwd.y * 80, z: o.z + camFwd.z * 80 };
      tracerGeo.setFromPoints([new THREE.Vector3(start.x, start.y, start.z), new THREE.Vector3(end.x, end.y, end.z)]);
      tracerMat.opacity = 1;
    }
    tracerMat.opacity = Math.max(0, tracerMat.opacity - frameDt * 6);

    // Fixed-timestep simulation.
    inputs.set(LOCAL_ID, controls.read());
    dummyInput.aimYaw = 0;
    inputs.set(DUMMY_ID, dummyInput);
    acc += frameDt;
    while (acc >= DT) {
      sim.step(inputs);
      acc -= DT;
    }
    controls.endFrame();

    // Render.
    renderer.sync(sim.entities, sim.entityVersion);
    sim.writeTransforms(transforms);
    renderer.applyTransforms(transforms);

    // Third-person camera: orbit around the chest, smoothed.
    const c = me.chest.translation();
    camTarget.lerp(new THREE.Vector3(c.x, c.y + 0.35, c.z), 1 - Math.exp(-frameDt * 12));
    const dist = 4.2;
    const cp = Math.cos(controls.pitch), sp = Math.sin(controls.pitch);
    const fx = Math.sin(controls.yaw) * cp, fy = sp, fz = Math.cos(controls.yaw) * cp;
    renderer.camera.position.set(camTarget.x - fx * dist, camTarget.y - fy * dist + 0.4, camTarget.z - fz * dist);
    renderer.camera.lookAt(camTarget.x + fx * 4, camTarget.y + fy * 4 + 0.2, camTarget.z + fz * 4);
    renderer.focusShadow(camTarget);
    renderer.render();

    fpsFrames++; fpsTime += frameDt;
    if (fpsTime > 0.5) { stats.fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }
    stats.stiffness = Math.round(me.stiffness * 100) / 100;
    stats.grounded = `${me.grounded ? 'yes' : 'no'} / dummy ${dummy.stiffness.toFixed(2)}`;

    requestAnimationFrame(frame);
  }
  camTarget.set(0, 1.5, 3);
  requestAnimationFrame(frame);

  // Exposed for debugging in the console.
  Object.assign(window, { sim, tuning });
}

main();
