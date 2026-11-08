// Procedural beige hardwood for the office floor. One canvas, shared by every floor level: individual
// planks, thin seams, staggered end joints, a little grain and a gentle colour change from plank to plank.
// The satin read is in the boards (lighter centres, softer edges). The office camera is orthographic, so a
// view-dependent highlight would brighten the whole floor by the same amount.
// No image files. Mipmaps stay on; the caller sets anisotropy from the renderer's limit.
import * as THREE from 'three';

const METERS_X = 16, METERS_Z = 12, PPM = 128;
// Pale natural / white-washed oak, sRGB, before the sun shader. The lit floor should land near
// #D9C4A3–#E6D5B8 on screen, so these swatches stay lighter and less orange than the final colour.
const TONES = [
  [246, 234, 214],
  [240, 226, 204],
  [250, 240, 222],
  [236, 220, 196],
  [244, 230, 208],
  [252, 244, 228],
];
const SEAM = [186, 168, 144];

function hash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}
const unit = (n) => hash(n) / 4294967296;

function buildRows() {
  const rows = [];
  const zMax = METERS_Z / 2;
  let z = -zMax, i = 0;
  while (z < zMax - 1e-4) {
    const h = 0.122 + unit(hash(i + 11)) * 0.038;
    const z1 = Math.min(zMax, z + h);
    const cuts = [];
    let x = -METERS_X / 2 - unit(hash(i * 17 + 3)) * 1.2;
    let k = 0;
    while (x < METERS_X / 2 + 0.02) {
      cuts.push(x);
      x += 0.58 + unit(hash(i * 97 + k * 13 + 5)) * 1.12;
      k++;
    }
    rows.push({ z0: z, z1, cuts, i });
    z = z1;
    i++;
  }
  return rows;
}

/** Covers world x=-8..8, z=-6..6. flipY is off: canvas row 0 is z=-6. */
export function createHardwoodTexture(maxAnisotropy = 8) {
  const W = METERS_X * PPM, H = METERS_Z * PPM;
  const rows = buildRows();
  const rowAt = new Uint16Array(H);
  rows.forEach((row, i) => {
    const y0 = Math.max(0, Math.round((row.z0 + METERS_Z / 2) * PPM));
    const y1 = Math.min(H, Math.round((row.z1 + METERS_Z / 2) * PPM));
    for (let y = y0; y < y1; y++) rowAt[y] = i;
  });
  const cutsPx = rows.map((row) => row.cuts.map((x) => Math.round((x + METERS_X / 2) * PPM)));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;

  for (let py = 0; py < H; py++) {
    const row = rows[rowAt[py]];
    const z0px = Math.round((row.z0 + METERS_Z / 2) * PPM);
    const z1px = Math.round((row.z1 + METERS_Z / 2) * PPM);
    const zEdge = Math.min(py - z0px, z1px - 1 - py);
    const z = py / PPM - METERS_Z / 2;
    const cuts = cutsPx[row.i];
    for (let px = 0; px < W; px++) {
      let lo = 0, hi = cuts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cuts[mid] <= px) lo = mid;
        else hi = mid - 1;
      }
      const x0 = cuts[lo];
      const x1 = lo + 1 < cuts.length ? cuts[lo + 1] : W;
      const seam = Math.min(zEdge, px - x0, x1 - 1 - px);
      const plank = hash(row.i * 131 + lo * 17 + 9);
      const tone = TONES[plank % TONES.length];
      const vary = (unit(plank ^ 0x51) - 0.5) * 8;
      const along = (px - x0) / PPM * 11 + unit(plank) * 6;
      const grain = Math.sin(along) * 3.2 + Math.sin(along * 2.6 + z * 28) * 1.8 + (unit(hash((px * 3) ^ (py * 5 + row.i))) - 0.5) * 4;
      const span = Math.max(1, z1px - z0px);
      const across = Math.min(Math.max(zEdge, 0), span * 0.5) / (span * 0.5);
      const satin = Math.pow(across, 0.5) * (5 + unit(plank ^ 3) * 3);
      let r, g, b;
      if (seam <= 0) {
        r = SEAM[0]; g = SEAM[1]; b = SEAM[2];
      } else {
        const edge = seam === 1 ? 0.94 : 1;
        r = (tone[0] + vary + grain * 0.85 + satin) * edge;
        g = (tone[1] + vary * 0.92 + grain * 0.7 + satin * 0.92) * edge;
        b = (tone[2] + vary * 0.7 + grain * 0.45 + satin * 0.75) * edge;
      }
      const o = (py * W + px) * 4;
      d[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'hardwood';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.max(1, Math.min(16, maxAnisotropy || 8));
  tex.needsUpdate = true;
  return tex;
}

// The open floor, and the lounge patches laid over it, on every level.
export const HARDWOOD_FLOOR = /^(baked_floor|style_patch_)/;
