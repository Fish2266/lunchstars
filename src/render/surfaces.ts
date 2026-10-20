// Procedural surface textures (drawn once to canvases) and a box geometry with world-scale UVs,
// so a texture tiles at the same real size on every face of every box.
import * as THREE from 'three';
import type { Surface } from '../sim/incinerator';

type Kind = Surface | 'hazard';

/** Metres covered by one repeat of each texture. */
const TILE: Record<Kind, number> = { concrete: 2, brick: 1.2, grate: 0.6, metal: 1.5, hazard: 0.8 };

function canvas(size: number, draw: (x: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Deterministic noise so textures look the same every load. */
function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

const draw: Record<Kind, (x: CanvasRenderingContext2D, s: number) => void> = {
  // Light grey concrete: speckles, a few darker stains, and expansion-joint seams on the tile edges.
  concrete(x, s) {
    const r = rng(7);
    x.fillStyle = '#c9c9c9'; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const v = 170 + Math.floor(r() * 60);
      x.fillStyle = `rgba(${v},${v},${v},0.5)`;
      x.fillRect(r() * s, r() * s, 1 + r() * 2, 1 + r() * 2);
    }
    for (let i = 0; i < 6; i++) {
      const g = x.createRadialGradient(r() * s, r() * s, 0, r() * s, r() * s, 20 + r() * 50);
      g.addColorStop(0, 'rgba(90,85,80,0.18)'); g.addColorStop(1, 'rgba(90,85,80,0)');
      x.fillStyle = g; x.fillRect(0, 0, s, s);
    }
    x.strokeStyle = 'rgba(70,70,70,0.55)'; x.lineWidth = 2;
    x.strokeRect(1, 1, s - 2, s - 2);
  },
  // Running-bond bricks with mortar lines.
  brick(x, s) {
    const r = rng(3);
    x.fillStyle = '#8a8a86'; x.fillRect(0, 0, s, s);
    const rows = 8, bh = s / rows, bw = s / 4;
    for (let row = 0; row < rows; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let c = -1; c < 5; c++) {
        const v = 0.85 + r() * 0.3;
        x.fillStyle = `rgb(${Math.floor(176 * v)},${Math.floor(170 * v)},${Math.floor(165 * v)})`;
        x.fillRect(c * bw + off + 2, row * bh + 2, bw - 4, bh - 4);
      }
    }
  },
  // Diamond-plate / grating: dark with a grid of lighter bars.
  grate(x, s) {
    x.fillStyle = '#5a5e64'; x.fillRect(0, 0, s, s);
    x.fillStyle = '#2a2c30';
    const n = 6, cell = s / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) x.fillRect(i * cell + 4, j * cell + 4, cell - 8, cell - 8);
    x.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < n; i++) x.fillRect(i * cell, 0, 2, s);
  },
  // Brushed steel panels with rivets.
  metal(x, s) {
    const r = rng(11);
    x.fillStyle = '#9da2a8'; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 160; i++) {
      x.fillStyle = `rgba(255,255,255,${r() * 0.06})`;
      x.fillRect(0, r() * s, s, 1);
    }
    x.strokeStyle = 'rgba(40,40,45,0.6)'; x.lineWidth = 3; x.strokeRect(1, 1, s - 2, s - 2);
    x.fillStyle = 'rgba(40,40,45,0.7)';
    for (const [px, py] of [[10, 10], [s - 10, 10], [10, s - 10], [s - 10, s - 10]]) { x.beginPath(); x.arc(px, py, 4, 0, 7); x.fill(); }
  },
  // Yellow and black diagonal hazard stripes.
  hazard(x, s) {
    x.fillStyle = '#1d1d1f'; x.fillRect(0, 0, s, s);
    x.fillStyle = '#e3b21b';
    for (let i = -2; i < 4; i++) {
      x.beginPath();
      x.moveTo(i * s / 2, 0); x.lineTo(i * s / 2 + s / 4, 0); x.lineTo(i * s / 2 + s / 4 + s, s); x.lineTo(i * s / 2 + s, s);
      x.closePath(); x.fill();
    }
  },
};

const textures = new Map<Kind, THREE.Texture>();
export function surfaceTexture(kind: Kind) {
  let t = textures.get(kind);
  if (!t) { t = canvas(256, draw[kind]); textures.set(kind, t); }
  return t;
}

const materials = new Map<string, THREE.Material>();
/** Material for a textured level piece, tinted by the box's colour. */
export function surfaceMaterial(kind: Kind, color: number, emissive = 0) {
  const key = `${kind}:${color}:${emissive}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      map: surfaceTexture(kind), color, roughness: kind === 'metal' ? 0.5 : 0.9, metalness: kind === 'metal' || kind === 'grate' ? 0.35 : 0,
      emissive: emissive > 0 ? color : 0x000000, emissiveIntensity: emissive,
    });
    materials.set(key, m);
  }
  return m;
}

/**
 * A box whose UVs are in metres / tile size, so the texture keeps the same scale on every face
 * no matter how big the box is.
 */
export function worldBox(hx: number, hy: number, hz: number, kind: Kind) {
  const g = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const tile = TILE[kind];
  // Face order: +x, -x, +y, -y, +z, -z; 4 vertices each. Each face's (u, v) spans (width, height):
  const dims: [number, number][] = [[hz, hy], [hz, hy], [hx, hz], [hx, hz], [hx, hy], [hx, hy]];
  for (let f = 0; f < 6; f++) {
    const [w, h] = dims[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * w * 2) / tile, (uv.getY(i) * h * 2) / tile);
    }
  }
  uv.needsUpdate = true;
  return g;
}
