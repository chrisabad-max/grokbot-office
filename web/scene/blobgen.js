// Procedural jelly blobs: the browser-side twin of assets/_src/blobs/build_blobs.py.
// generateBlob({ shape, color, accessory, seed }) returns a THREE.Group with the blob GLB structure of
// CONTRACT §7 (root `blob`; children `body`, `eye_L`, `eye_R`, optional `extra`; origin bottom centre,
// ~0.8 m, faces +Z), so actor.js treats it exactly like a loaded GLB.
//
// Same recipe as the hand-made blobs: a closed 2D outline that is star-shaped around its origin becomes a
// polar radius function r(theta); the body is an "inflated gummy slab" (flat, slightly domed face + a round
// bevel) built ring by ring; two white vertical-oval eyes sit on the front surface. Geometry is cached per
// shape (+ a small tilt bucket + accessory), materials per colour, so a floor of 20 bots costs a handful of
// meshes. Everything is deterministic: same input, same blob.
import * as THREE from 'three';
import { SHAPES, ACCESSORIES, normShape, normAccessory, normColor, hash32, hashShape } from './looks.js';
import { makeOutline, toPolar, csmooth } from './outlines.js';

export { SHAPES, ACCESSORIES };

const SIZE = 0.8;                      // m, max dimension of a blob (§7)
const FLAT_BOTTOM = 0.018;             // soft-flattened contact patch so a blob "sits" instead of touching at a point
const TRI_BUDGET = 6000;
const OVERHANG = 0.05;                 // m, how far accessories may count beyond the body's bounding box

// ---------------------------------------------------------------- small math (plain arrays, no allocations that matter)

const rad = (d) => (d * Math.PI) / 180;
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mulMV = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
function mulMM(A, B) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
}
const rzMat = (deg) => { const c = Math.cos(rad(deg)), s = Math.sin(rad(deg)); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
/** rotation taking +Z onto the unit vector n (Rodrigues) */
function alignTo(n) {
  const c = n[2];
  if (c > 0.99999) return IDENT;
  const v = [-n[1], n[0], 0];
  const vx = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
  const vx2 = mulMM(vx, vx);
  return IDENT.map((e, i) => e + vx[i] + vx2[i] / (1 + c));
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- bodies
// A body answers: emit() -> {V, F} closed mesh, zAt(x, y) front surface height, nAt(x, y) front normal,
// rimAt(theta) silhouette point seen from `centre`, plus `D` (its size) for scaling accessories.

/** "Inflated slab": polar outline + flat domed face + round bevel (+ optional straight wall). */
class Slab {
  constructor(def, D = SIZE) {
    const N = def.N ?? 88;
    this.N = N;
    this.D = D;
    this.th = Float64Array.from({ length: N }, (_, i) => (2 * Math.PI * i) / N);
    const pts = makeOutline(def.outline);
    let r = csmooth(toPolar(pts, N), def.smooth ?? 1);         // traced (fourier) outlines are smooth already
    const xs = [], ys = [];
    for (let i = 0; i < N; i++) { xs.push(r[i] * Math.cos(this.th[i])); ys.push(r[i] * Math.sin(this.th[i])); }
    const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    this.r = r.map((v) => (v * D) / ext);
    this.T = ((def.depth ?? 0.5) * D) / 2;
    this.dome = def.dome ?? 0.1;
    this.nb = def.nb ?? 7;
    this.flat = def.flat ?? [0.45, 0.8];
    this.wall = (def.wall ?? 0) * this.T;
    const bevel = def.bevel ?? 0.92;
    this.W = csmooth(this.r.map((v) => Math.min(bevel * this.T, 0.85 * v)), 3);
    if (def.inner) {
      // deep notches (flower, cloud): the face rings get a smoother outline than the rim, else every notch draws a
      // crease from the rim to the middle of the face. The bevel then widens in the notches and the rim stays exact.
      const inner = csmooth(this.r.map((v, k) => v - this.W[k]), def.inner);
      this.W = this.W.map((w, k) => this.r[k] - Math.min(inner[k], this.r[k] - 0.35 * w));
    }
    this.centre = [0, 0];
  }

  _interp(arr, th) {
    const N = this.N;
    const u = (((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * N;
    const i = Math.floor(u) % N, f = u - Math.floor(u);
    return lerp(arr[i], arr[(i + 1) % N], f);
  }

  rimAt(theta) { const r = this._interp(this.r, theta); return [this.centre[0] + r * Math.cos(theta), this.centre[1] + r * Math.sin(theta)]; }

  zAt(x, y) {
    const th = Math.atan2(y, x);
    const r = this._interp(this.r, th), W = this._interp(this.W, th);
    const rho = Math.min(Math.hypot(x, y), r * 0.999);
    const e = r - rho;
    if (e >= W) {
      const f = rho / (r - W);
      return this.T * (1 + this.dome * (1 - f * f) ** 2);
    }
    const s = 1 - e / W;
    return this.wall + (this.T - this.wall) * Math.sqrt(Math.max(0, 1 - s * s));
  }

  nAt(x, y) { return frontNormal(this, x, y); }

  rings() {
    const { r, W, T, dome, N, nb, wall } = this;
    const front = [];
    for (const f of this.flat) {
      front.push({ rho: Float64Array.from({ length: N }, (_, k) => f * (r[k] - W[k])), z: T * (1 + dome * (1 - f * f) ** 2) });
    }
    for (let i = 0; i <= nb; i++) {
      const a = (Math.PI / 2) * (i / nb);
      front.push({ rho: Float64Array.from({ length: N }, (_, k) => r[k] - W[k] * (1 - Math.sin(a))), z: wall + (T - wall) * Math.cos(a) });
    }
    const keep = wall > 0 ? front : front.slice(0, -1);             // a straight wall needs both rims
    const back = keep.slice().reverse().map((g) => ({ rho: g.rho, z: -g.z }));
    return front.concat(back);
  }

  emit(off = [0, 0, 0]) {
    const rings = this.rings(), N = this.N, R = rings.length, th = this.th;
    const top = this.T * (1 + this.dome);
    const V = [[off[0], off[1], off[2] + top]];
    for (const g of rings) for (let k = 0; k < N; k++) V.push([off[0] + g.rho[k] * Math.cos(th[k]), off[1] + g.rho[k] * Math.sin(th[k]), off[2] + g.z]);
    V.push([off[0], off[1], off[2] - top]);
    const F = [];
    for (let k = 0; k < N; k++) F.push([0, 1 + ((k + 1) % N), 1 + k]);
    for (let j = 0; j < R - 1; j++) {
      for (let k = 0; k < N; k++) {
        const k1 = (k + 1) % N;
        F.push([1 + j * N + k, 1 + j * N + k1, 1 + (j + 1) * N + k1, 1 + (j + 1) * N + k]);
      }
    }
    const base = 1 + (R - 1) * N, last = 1 + R * N;
    for (let k = 0; k < N; k++) F.push([last, base + k, base + ((k + 1) % N)]);
    return { V, F };
  }
}

/** Cone: a rounded isosceles triangle revolved around the vertical axis (flat base, rounded tip). */
class Lathe {
  constructor(def, D = SIZE) {
    this.D = D;
    const H = D, rr = def.rr ?? 0.12 * (D / SIZE), Rt = (def.width ?? 0.9) * D / 2;
    const Rc = Rt - rr, Hc = H - rr;
    const phi = Math.atan2(Rc, Hc - rr);                           // outward normal of the slanted side
    const prof = [[0, 0], [Rc * 0.5, 0], [Rc, 0]];
    const arcN = 7, sideN = 4;
    for (let i = 1; i <= arcN; i++) { const a = lerp(-Math.PI / 2, phi, i / arcN); prof.push([Rc + rr * Math.cos(a), rr + rr * Math.sin(a)]); }
    const sx = Math.cos(phi), sy = Math.sin(phi);
    for (let i = 1; i < sideN; i++) { const t = i / sideN; prof.push([lerp(Rc, 0, t) + rr * sx, lerp(rr, Hc, t) + rr * sy]); }
    for (let i = 0; i <= arcN; i++) { const a = lerp(phi, Math.PI / 2, i / arcN); prof.push([rr * Math.cos(a), Hc + rr * Math.sin(a)]); }
    prof[prof.length - 1][0] = 0;
    this.prof = prof;
    this.sectors = def.sectors ?? 56;
    this.H = H;
    this.centre = [0, H * 0.45];
    const outline = prof.slice(1).concat(prof.slice(1, -1).reverse().map(([x, y]) => [-x, y]));   // closed silhouette
    this.N = 96;
    this.r = toPolar(outline, this.N, this.centre);
    this.side = prof.slice(3);                                       // monotone in y: rho(y)
  }

  rho(y) {
    const s = this.side;
    if (y <= s[0][1]) return s[0][0];
    for (let i = 1; i < s.length; i++) if (y <= s[i][1]) return lerp(s[i - 1][0], s[i][0], (y - s[i - 1][1]) / Math.max(1e-9, s[i][1] - s[i - 1][1]));
    return 0;
  }

  zAt(x, y) { const r = this.rho(y); const xx = Math.min(Math.abs(x), r * 0.999); return Math.sqrt(Math.max(0, r * r - xx * xx)); }
  nAt(x, y) { return frontNormal(this, x, y); }
  rimAt(theta) {
    const u = ((((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * this.N, i = Math.floor(u) % this.N, f = u - Math.floor(u);
    const r = lerp(this.r[i], this.r[(i + 1) % this.N], f);
    return [this.centre[0] + r * Math.cos(theta), this.centre[1] + r * Math.sin(theta)];
  }

  emit(off = [0, 0, 0]) {
    const prof = this.prof, S = this.sectors, V = [], F = [], rows = [];
    for (const [rho, y] of prof) {
      if (rho < 1e-9) { rows.push({ pole: V.length }); V.push([off[0], off[1] + y, off[2]]); continue; }
      const start = V.length;
      for (let k = 0; k < S; k++) { const t = (2 * Math.PI * k) / S; V.push([off[0] + rho * Math.cos(t), off[1] + y, off[2] + rho * Math.sin(t)]); }
      rows.push({ start });
    }
    for (let j = 0; j < rows.length - 1; j++) {
      const a = rows[j], b = rows[j + 1];
      for (let k = 0; k < S; k++) {
        const k1 = (k + 1) % S;
        if (a.pole !== undefined) F.push([a.pole, b.start + k1, b.start + k]);
        else if (b.pole !== undefined) F.push([a.start + k, a.start + k1, b.pole]);
        else F.push([a.start + k, a.start + k1, b.start + k1, b.start + k]);
      }
    }
    return { V, F };
  }
}

function frontNormal(body, x, y) {
  const h = 0.004 * (body.D / SIZE);
  const dzdx = (body.zAt(x + h, y) - body.zAt(x - h, y)) / (2 * h);
  const dzdy = (body.zAt(x, y + h) - body.zAt(x, y - h)) / (2 * h);
  return norm3([-dzdx, -dzdy, 1]);
}

// ---------------------------------------------------------------- the shapes
// The 14 avatars of the Grok Bot app's picker (13 shapes; the 14th is sphere + stem), traced from the app itself:
// each outline was fitted to the picker's silhouette (area overlap 0.95-0.99), each face to its eyes (centre, spacing,
// slant), at the app's own angle. Convex ones are hulls of circles (straight sides, own corner radii); the organic
// ones are Fourier series of the traced radius. rounded_cube, cone and trio are older ids that the app no longer
// shows: still drawn, so old looks keep working.
// face: c = face centre (units of D from the outline's area centre), sp = eye spacing, w/h = eye size (units of D),
//       pair = angle of the line through both eyes (deg, CCW), tilt = slant of each oval (deg, CCW).

const POLY = (n, rr, rot, extra = {}) => ({ kind: 'poly', n, R: 1, rr, rot, ...extra });
const APP_EYES = (c, sp, h, pair, tilt) => ({ c, sp, w: +(h / 2.6).toFixed(3), h, pair, tilt });   // the app's slim slanted ovals

const TRACED = {
  cloud: [0.4644, -0.0013, 0.0016, 0.0344, 0.0162, 0.0252, -0.0051, -0.0056, -0.0039, 0.0193, -0.0015, 0.0026, -0.0043, -0.0025, 0.0049, -0.0053, 0.0015],
  star4: [0.4131, 0.0001, 0, -0.0003, -0.0167, -0.0002, -0.0002, 0.0736, 0.0341, -0.0002, -0.0001, 0.0002, 0.0022, -0.0004, 0, 0.0012, -0.0004, 0.0001, -0.0001, -0.0014, 0.0007, 0.0002, 0.0001, 0.0027, 0.0053],
  clover: [0.4623, 0, 0, 0.0045, -0.0273, 0.0002, -0.0001, -0.0036, -0.0449, -0.0004, 0.0001, 0.0002, 0.0008, -0.0004, 0, 0.0105, -0.0056, 0, 0.0002, -0.002, 0.0005],
  bubble: [0.4568, 0.0013, -0.0022, 0.0313, 0.0104, -0.0395, 0.0269, -0.0026, 0.0079, 0.0083, 0.002, 0.0007, 0.0027, -0.0027, -0.0001, 0.0007, -0.0011],
  flower: [0.4574, 0, 0, 0.0025, -0.022, 0, 0, 0.0026, 0.0003, 0.0002, 0, 0.0207, -0.0284, 0, 0, 0.0046, 0.0035, -0.0001, -0.0003, 0.0023, -0.002, 0, 0.0001, 0.0014, 0.0062, -0.0001, 0.0001, -0.0023, 0.0006, 0.0003, -0.0002, 0, -0.0003, 0.0001, 0.0003, -0.003, -0.001, -0.0001, -0.0001, 0.0004, -0.0018],
  star6: [0.4235, -0.0001, 0, 0.0048, -0.0394, 0, 0, -0.0051, -0.0014, 0.0004, -0.0001, 0.0417, -0.0574, 0.0004, 0.0002, 0.0021, 0.0032, -0.0001, -0.0001, -0.003, -0.0002, 0.0001, 0, 0.001, 0.0033, 0.0001, 0.0001, 0.0058, -0.0008, -0.0001, 0.0003, 0.0002, -0.0049, -0.0001, 0, -0.0006, 0],
};
const traced = (name) => ({ kind: 'fourier', c: TRACED[name] });

const SHAPE_DEFS = {
  // row 1 of the app's picker
  sphere: { type: 'slab', outline: { kind: 'sup', a: 1, b: 1, n: 2 }, face: APP_EYES([0.17, 0.218], 0.26, 0.272, 25, 36) },
  cloud: { type: 'slab', N: 96, smooth: 0, inner: 10, outline: traced('cloud'), face: APP_EYES([0.161, 0.15], 0.214, 0.236, 16, 28) },
  rounded_square: { type: 'slab', outline: { kind: 'hull', circles: [[0.146, 0.381, 0.107], [-0.393, 0.195, 0.141], [-0.149, -0.383, 0.106], [0.397, -0.195, 0.139]] }, face: APP_EYES([0.08, 0.023], 0.18, 0.212, 16, 29) },
  star4: { type: 'slab', N: 112, smooth: 0, depth: 0.3, bevel: 0.5, outline: traced('star4'), face: APP_EYES([0.076, 0.086], 0.186, 0.191, 16, 28) },
  clover: { type: 'slab', N: 104, smooth: 0, inner: 10, outline: traced('clover'), face: APP_EYES([0.062, 0.081], 0.212, 0.212, 15, 28) },
  // row 2
  bubble: { type: 'slab', N: 96, smooth: 0, inner: 8, outline: traced('bubble'), face: APP_EYES([0.179, 0.087], 0.208, 0.214, 16, 24) },
  flower: { type: 'slab', N: 108, smooth: 0, inner: 10, outline: traced('flower'), face: APP_EYES([0.107, 0.033], 0.179, 0.213, 15, 28) },
  drop: { type: 'slab', outline: { kind: 'hull', circles: [[0.015, -0.031, 0.419], [-0.166, 0.34, 0.148]] }, face: APP_EYES([0.192, 0.145], 0.201, 0.227, 16, 27) },
  pill: { type: 'slab', outline: { kind: 'hull', circles: [[0.149, 0.042, 0.339], [-0.148, -0.042, 0.34]] }, face: APP_EYES([0.144, 0.14], 0.267, 0.233, 15, 27) },
  triangle: { type: 'slab', outline: { kind: 'hull', circles: [[0.723, -0.02, 0.185], [-0.23, 0.471, 0.319], [-0.222, -0.339, 0.41]] }, face: APP_EYES([0.145, 0.213], 0.201, 0.216, 12, 54) },
  // row 3 (the 14th avatar is sphere + stem)
  pentagon: { type: 'slab', outline: { kind: 'hull', circles: [[0.276, 0.325, 0.101], [-0.184, 0.425, 0.177], [-0.414, 0.049, 0.157], [-0.202, -0.411, 0.151], [0.41, -0.181, 0.211]] }, face: APP_EYES([0.075, 0.053], 0.203, 0.222, 15, 28) },
  star6: { type: 'slab', N: 108, smooth: 0, depth: 0.3, bevel: 0.5, outline: traced('star6'), face: APP_EYES([0.092, 0.017], 0.189, 0.202, 16, 28) },
  hexagon: { type: 'slab', outline: { kind: 'hull', circles: [[0.264, 0.33, 0.112], [-0.154, 0.4, 0.152], [-0.404, 0.073, 0.162], [-0.267, -0.334, 0.108], [0.153, -0.399, 0.153], [0.412, -0.073, 0.155]] }, face: APP_EYES([0.1, 0.029], 0.275, 0.274, 15, 28) },
  // older ids, not in the app any more
  rounded_cube: { type: 'slab', outline: { ...POLY(4, 0.27, 45), rotate: 18 }, depth: 0.74, bevel: 0.62, wall: 0.5, face: { c: [0.04, 0.03], sp: 0.22, w: 0.1, h: 0.23, pair: 12, tilt: 25 } },
  cone: { type: 'lathe', face: { c: [0.0, 0.31], sp: 0.22, w: 0.105, h: 0.23, pair: 0, tilt: 0 } },
  trio: { type: 'trio' },
};

// Three small blobs (like the "trendy-x" blob): orange round, teal hexagon in front, black star behind on top.
const TRIO = [
  { key: 'a', mat: 0, D: 0.42, at: [-0.2, 0.2, 0.0], def: { type: 'slab', N: 48, nb: 5, flat: [0.5], outline: { kind: 'sup', a: 1, b: 0.93, n: 2.4, rotate: 5 }, face: { c: [0.12, 0.08], sp: 0.25, w: 0.12, h: 0.25, pair: 14, tilt: 18 } } },
  { key: 'b', mat: 1, D: 0.46, at: [0.19, 0.23, 0.05], primary: true, def: { type: 'slab', N: 48, nb: 5, flat: [0.5], outline: { ...POLY(6, 0.3, 90), rotate: -6 }, face: { c: [0.03, -0.02], sp: 0.26, w: 0.11, h: 0.25, pair: 10, tilt: 4 } } },
  { key: 'c', mat: 2, D: 0.42, at: [0.02, 0.57, -0.09], host: true, def: { type: 'slab', N: 60, nb: 5, flat: [0.5], depth: 0.4, bevel: 0.7, outline: { kind: 'star', k: 6, rin: 0.58, p: 1.1, tip: 90 }, face: { c: [0.0, -0.07], sp: 0.25, w: 0.115, h: 0.24, pair: 0, tilt: 0 } } },
];

function makeBody(def, D) { return def.type === 'lathe' ? new Lathe(def, D) : new Slab(def, D); }

// ---------------------------------------------------------------- closed-mesh primitives (return {V, F})

function ellipsoid(rx, ry, rz, S = 16, Rg = 10, m = 2.7) {
  const V = [[0, 0, rz]];
  for (let i = 1; i < Rg; i++) {
    const ph = (Math.PI * i) / Rg;
    for (let j = 0; j < S; j++) {
      const t = (2 * Math.PI * j) / S, c = Math.cos(t), s = Math.sin(t);
      const k = (Math.abs(c) ** m + Math.abs(s) ** m) ** (-1 / m);   // squarish cross-section
      V.push([rx * Math.sin(ph) * c * k, ry * Math.sin(ph) * s * k, rz * Math.cos(ph)]);
    }
  }
  V.push([0, 0, -rz]);
  const F = [];
  for (let j = 0; j < S; j++) F.push([0, 1 + ((j + 1) % S), 1 + j]);
  for (let i = 0; i < Rg - 2; i++) {
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      F.push([1 + i * S + j, 1 + i * S + j1, 1 + (i + 1) * S + j1, 1 + (i + 1) * S + j]);
    }
  }
  const last = V.length - 1, b = 1 + (Rg - 2) * S;
  for (let j = 0; j < S; j++) F.push([last, b + j, b + ((j + 1) % S)]);
  return { V, F };
}

function torus(R, r, nu = 22, nv = 8) {
  const V = [], F = [];
  for (let i = 0; i < nu; i++) {
    const a = (2 * Math.PI * i) / nu;
    for (let j = 0; j < nv; j++) {
      const b = (2 * Math.PI * j) / nv;
      V.push([(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b)]);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) F.push([i * nv + j, ((i + 1) % nu) * nv + j, ((i + 1) % nu) * nv + ((j + 1) % nv), i * nv + ((j + 1) % nv)]);
  return { V, F };
}

/** capped tube along a 3D polyline */
function tube(path, radii, sides = 8) {
  const M = path.length, V = [], F = [];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  for (let i = 0; i < M; i++) {
    const T = norm3(sub(path[Math.min(i + 1, M - 1)], path[Math.max(i - 1, 0)]));
    let n1 = cross(T, [0, 0, 1]);
    if (Math.hypot(...n1) < 1e-6) n1 = cross(T, [0, 1, 0]);
    n1 = norm3(n1);
    const n2 = cross(T, n1);
    for (let j = 0; j < sides; j++) {
      const a = (2 * Math.PI * j) / sides, c = Math.cos(a) * radii[i], s = Math.sin(a) * radii[i];
      V.push([path[i][0] + c * n1[0] + s * n2[0], path[i][1] + c * n1[1] + s * n2[1], path[i][2] + c * n1[2] + s * n2[2]]);
    }
  }
  for (let i = 0; i < M - 1; i++) for (let j = 0; j < sides; j++) { const j1 = (j + 1) % sides; F.push([i * sides + j, i * sides + j1, (i + 1) * sides + j1, (i + 1) * sides + j]); }
  const T0 = norm3(sub(path[1], path[0])), T1 = norm3(sub(path[M - 1], path[M - 2]));
  const c0 = V.length;
  V.push([path[0][0] - T0[0] * radii[0] * 0.5, path[0][1] - T0[1] * radii[0] * 0.5, path[0][2] - T0[2] * radii[0] * 0.5]);
  const c1 = V.length;
  V.push([path[M - 1][0] + T1[0] * radii[M - 1] * 0.8, path[M - 1][1] + T1[1] * radii[M - 1] * 0.8, path[M - 1][2] + T1[2] * radii[M - 1] * 0.8]);
  for (let j = 0; j < sides; j++) { const j1 = (j + 1) % sides; F.push([c0, j1, j]); F.push([c1, (M - 1) * sides + j, (M - 1) * sides + j1]); }
  return { V, F };
}

const bez = (p0, p1, p2, t) => [0, 1, 2].map((i) => (1 - t) ** 2 * p0[i] + 2 * (1 - t) * t * p1[i] + t * t * p2[i]);
const transform = (V, M, off = [0, 0, 0]) => V.map((v) => { const r = mulMV(M, v); return [r[0] + off[0], r[1] + off[1], r[2] + off[2]]; });

// ---------------------------------------------------------------- face: eyes (+ glasses geometry helpers)

function eyeFrame(body, x, y, tiltDeg, lean = 0.7) {
  const z = body.zAt(x, y), n = body.nAt(x, y);
  const nb = norm3([lean * n[0], lean * n[1], lean * n[2] + (1 - lean)]);
  return { z, M: mulMM(alignTo(nb), rzMat(tiltDeg)) };
}

/** eye layout of one unit (`face` may be adjusted for glasses) -> two descriptors, geometry relative to the eye centre */
function faceEyes(unit, accessory) {
  const { body, at, D } = unit;
  const f = { ...unit.face };
  if (accessory === 'glasses' && unit.glasses) { f.sp = Math.max(f.sp, 0.25); f.h = Math.min(f.h, 0.2); f.w = Math.min(f.w, 0.09); }
  const fc = [f.c[0] * D, f.c[1] * D];
  const d = [Math.cos(rad(f.pair)) * f.sp * D / 2, Math.sin(rad(f.pair)) * f.sp * D / 2];
  const rx = (f.w * D) / 2, ry = (f.h * D) / 2, rz = 0.62 * rx;
  const out = [];
  for (const [side, c] of [['L', [fc[0] - d[0], fc[1] - d[1]]], ['R', [fc[0] + d[0], fc[1] + d[1]]]]) {
    const { z, M } = eyeFrame(body, c[0], c[1], f.tilt);
    const e = ellipsoid(rx, ry, rz, unit.eyeSeg ?? 16, unit.eyeRings ?? 10);
    out.push({ side, c, M, centre: [c[0] + at[0], c[1] + at[1], z + 0.15 * rz + at[2]], V: transform(e.V, M), F: e.F });
  }
  return out;
}

// ---------------------------------------------------------------- accessories (design coordinates, unrotated)

/** the rim point furthest up, or furthest along a direction leaned leanDeg to the left of up */
function topPoint(body, leanDeg = 0) {
  const dx = -Math.sin(rad(leanDeg)), dy = Math.cos(rad(leanDeg));
  let best = -Infinity, p = body.rimAt(Math.PI / 2);
  for (let i = 0; i < 180; i++) {
    const q = body.rimAt((2 * Math.PI * i) / 180), v = q[0] * dx + q[1] * dy;
    if (v > best + 1e-9) { best = v; p = q; }
  }
  return p;
}

function buildAccessory(kind, unit, eyes, accent) {
  const { body, at, D } = unit;
  const k = D / SIZE;
  const off = (p, z = 0) => [p[0] + at[0], p[1] + at[1], z + at[2]];
  const pieces = [];                                                   // {V, F, mat} mat 0 = dark, 1 = accent
  if (kind === 'stem') {
    const top = topPoint(body, 20);                                  // the app's stem: top-left, short, leaning out
    const base = [top[0] + 0.012 * k, top[1] - 0.045 * k, 0];
    const P1 = [base[0] - 0.035 * k, base[1] + 0.09 * k, 0], P2 = [base[0] - 0.1 * k, base[1] + 0.155 * k, 0];
    const ts = Array.from({ length: 11 }, (_, i) => i / 10);
    const t = tube(ts.map((u) => off(bez(base, P1, P2, u))), ts.map((u) => k * (0.045 - 0.01 * u)), 8);
    pieces.push({ ...t, mat: 0 });
  } else if (kind === 'antenna') {
    const top = topPoint(body);
    const base = [top[0] - 0.01 * k, top[1] - 0.06 * k, 0];
    const P1 = [base[0] + 0.015 * k, base[1] + 0.1 * k, 0], P2 = [base[0] + 0.05 * k, base[1] + 0.2 * k, 0];
    const ts = Array.from({ length: 9 }, (_, i) => i / 8);
    const t = tube(ts.map((u) => off(bez(base, P1, P2, u))), ts.map((u) => k * (0.036 - 0.008 * u)), 8);
    pieces.push({ ...t, mat: 0 });
    const br = 0.075 * k;
    const ball = ellipsoid(br, br, br, 14, 10, 2);
    const c = off([P2[0] + 0.004 * k, P2[1] + 0.5 * br], 0);
    pieces.push({ V: ball.V.map((v) => [v[0] + c[0], v[1] + c[1], v[2] + c[2]]), F: ball.F, mat: 1 });
  } else if (kind === 'bow') {
    const th = rad(64);
    const p = body.rimAt(th);
    const rimIn = [p[0] * 0.93 + (1 - 0.93) * body.centre[0], p[1] * 0.93 + (1 - 0.93) * body.centre[1]];
    const z = body.T !== undefined ? body.T * 0.34 : 0.08 * k;
    const ang = th + Math.PI / 2 - rad(14);                              // lobes along the tangent, slightly cocked
    const R = rzMat((ang * 180) / Math.PI);
    const lobe = ellipsoid(0.13 * k, 0.085 * k, 0.06 * k, 14, 9, 2);
    const knot = ellipsoid(0.06 * k, 0.06 * k, 0.058 * k, 12, 8, 2);
    const centre = off(rimIn, z);
    for (const s of [-1, 1]) pieces.push({ V: transform(lobe.V, R, [centre[0] + s * 0.12 * k * Math.cos(ang), centre[1] + s * 0.12 * k * Math.sin(ang), centre[2] - 0.004 * k]), F: lobe.F, mat: 1 });
    pieces.push({ V: transform(knot.V, IDENT, centre), F: knot.F, mat: 1 });
  } else if (kind === 'glasses') {
    const Rr = Math.min(0.118, (eyes.sp * 0.5 - 0.006)) * D, rt = 0.017 * D;
    const cs = [];
    for (const e of eyes.list) {
      const { z, M } = eyeFrame(body, e.c[0], e.c[1], 0, 0.7);
      const cc = [e.c[0], e.c[1], z + 0.004 * k];
      const t = torus(Rr, rt, D < 0.6 ? 14 : 24, D < 0.6 ? 6 : 8);
      pieces.push({ V: transform(t.V, M, off([cc[0], cc[1]], cc[2])), F: t.F, mat: 0 });
      cs.push(e.c);
    }
    const [c1, c2] = cs;
    const dl = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
    const dv = [(c2[0] - c1[0]) / dl, (c2[1] - c1[1]) / dl];
    const path = [];
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const px = c1[0] + dv[0] * Rr + (c2[0] - c1[0] - 2 * dv[0] * Rr) * t, py = c1[1] + dv[1] * Rr + (c2[1] - c1[1] - 2 * dv[1] * Rr) * t;
      path.push(off([px, py], body.zAt(px, py) + rt * 1.2 + 0.006 * k * Math.sin(Math.PI * t)));
    }
    pieces.push({ ...tube(path, Array(5).fill(rt), 6), mat: 0 });
    for (const [sgn, cc] of [[-1, c1], [1, c2]]) {
      const tp = [];
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        let px = cc[0] + sgn * dv[0] * (Rr + t * (0.4 * D - Rr + 0.02 * k)), py = cc[1] + sgn * dv[1] * (Rr + t * (0.4 * D - Rr + 0.02 * k));
        const rmax = body.rimAt(Math.atan2(py - body.centre[1], px - body.centre[0]));
        const lim = Math.hypot(rmax[0] - body.centre[0], rmax[1] - body.centre[1]) * 0.985, len = Math.hypot(px - body.centre[0], py - body.centre[1]);
        if (len > lim) { const s = lim / len; px = body.centre[0] + (px - body.centre[0]) * s; py = body.centre[1] + (py - body.centre[1]) * s; }
        tp.push(off([px, py], body.zAt(px, py) + rt * 1.2));
      }
      pieces.push({ ...tube(tp, Array(9).fill(rt * 0.9), 6), mat: 0 });
    }
  }
  return pieces;
}

// ---------------------------------------------------------------- mesh assembly

/** pieces [{V, F(tris|quads), mat}] -> one indexed BufferGeometry with a group per material, closed pieces wound outward */
function buildGeometry(pieces, xf = (v) => v) {
  const mats = [...new Set(pieces.map((p) => p.mat))].sort((a, b) => a - b);
  const pos = [], idx = [], groups = [];
  for (const m of mats) {
    const start = idx.length;
    for (const p of pieces) {
      if (p.mat !== m) continue;
      const V = p.V.map(xf);
      const tris = [];
      for (const f of p.F) { if (f.length === 3) tris.push(f); else { tris.push([f[0], f[1], f[2]]); tris.push([f[0], f[2], f[3]]); } }
      let vol = 0;
      for (const [a, b, c] of tris) {
        const A = V[a], B = V[b], C = V[c];
        vol += A[0] * (B[1] * C[2] - B[2] * C[1]) + A[1] * (B[2] * C[0] - B[0] * C[2]) + A[2] * (B[0] * C[1] - B[1] * C[0]);
      }
      const base = pos.length / 3;
      for (const v of V) pos.push(v[0], v[1], v[2]);
      for (const [a, b, c] of tris) idx.push(base + a, base + (vol < 0 ? c : b), base + (vol < 0 ? b : c));
    }
    groups.push({ start, count: idx.length - start, materialIndex: m });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function makeUnits(shape) {
  const def = SHAPE_DEFS[shape];
  if (def.type === 'trio') return TRIO.map((t) => ({ body: makeBody(t.def, t.D), at: t.at, D: t.D, face: t.def.face, mat: t.mat, primary: !!t.primary, host: !!t.host, glasses: !!t.primary, eyeSeg: 12, eyeRings: 8 }));
  return [{ body: makeBody(def, SIZE), at: [0, 0, 0], D: SIZE, face: def.face, mat: 0, primary: true, host: true, glasses: true }];
}

const bodyCache = new Map();           // shape|tilt -> body stage
const partsCache = new Map();          // shape|tilt|accessory -> eyes + extra

/** stage 1: the body mesh in its final frame (tilted, bottom flattened, centred, bottom at y = 0) */
function bodyStage(shape, tilt) {
  const key = `${shape}|${tilt}`;
  if (bodyCache.has(key)) return bodyCache.get(key);
  const units = makeUnits(shape);
  const R = rzMat(tilt);
  const rot = (v) => mulMV(R, v);
  const pieces = units.map((u) => ({ ...u.body.emit(u.at), mat: u.mat }));
  const rotated = pieces.map((p) => ({ ...p, V: p.V.map(rot) }));
  let ymin = Infinity;
  for (const p of rotated) for (const v of p.V) ymin = Math.min(ymin, v[1]);
  const k0 = 0.01, c0 = FLAT_BOTTOM;
  for (const p of rotated) for (const v of p.V) { const t = v[1] - ymin - c0; v[1] = ymin + c0 + 0.5 * (t + Math.sqrt(t * t + k0 * k0)); }
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of rotated) for (const v of p.V) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], v[i]); mx[i] = Math.max(mx[i], v[i]); }
  const shift = [-(mn[0] + mx[0]) / 2, -mn[1], -(mn[2] + mx[2]) / 2];
  const geo = buildGeometry(rotated, (v) => [v[0] + shift[0], v[1] + shift[1], v[2] + shift[2]]);
  const st = { units, R, shift, geo, nMats: new Set(units.map((u) => u.mat)).size, tris: geo.index.count / 3 };
  bodyCache.set(key, st);
  return st;
}

/** stage 2: eyes (+ accessory) of one shape/tilt/accessory combination */
function partsStage(shape, tilt, accessory) {
  const key = `${shape}|${tilt}|${accessory}`;
  if (partsCache.has(key)) return partsCache.get(key);
  const st = bodyStage(shape, tilt);
  const { units, R, shift } = st;
  const place = (v) => { const r = mulMV(R, v); return [r[0] + shift[0], r[1] + shift[1], r[2] + shift[2]]; };
  const eyes = [];
  let order = 2;
  let glassesEyes = null;
  for (const u of units) {
    const list = faceEyes(u, accessory);
    if (accessory === 'glasses' && u.glasses) glassesEyes = { u, list, sp: Math.max(u.face.sp, 0.25) };
    for (const e of list) {
      const name = u.primary ? `eye_${e.side}` : `eye_${e.side}_${order}`;
      const geo = buildGeometry([{ V: transform(e.V, R), F: e.F, mat: 0 }]);
      eyes.push({ name, geo, pos: place(e.centre) });
    }
    if (!u.primary) order++;
  }
  let extra = null;
  if (accessory !== 'none') {
    let pieces = [];
    if (accessory === 'glasses') {
      if (glassesEyes) pieces = buildAccessory('glasses', glassesEyes.u, glassesEyes, null);
    } else {
      const host = units.find((u) => u.host) || units[0];
      pieces = buildAccessory(accessory, host, null, null);
    }
    if (pieces.length) {
      const geo = buildGeometry(pieces.map((p) => ({ ...p, V: p.V.map((v) => mulMV(R, v)) })), (v) => [v[0] + shift[0], v[1] + shift[1], v[2] + shift[2]]);
      // actor.setModel scales a model to fit its whole bounding box. A tall antenna would make its blob visibly smaller
      // than its neighbours, so the extra reports a bounding box that overhangs the body by at most OVERHANG metres.
      const bb = geo.boundingBox.clone(), bodyBox = st.geo.boundingBox;
      bb.min.max(bodyBox.min.clone().subScalar(OVERHANG));
      bb.max.min(bodyBox.max.clone().addScalar(OVERHANG));
      geo.boundingBox = bb;
      extra = { geo, accent: pieces.some((p) => p.mat === 1) };
    }
  }
  let tris = st.tris;
  for (const e of eyes) tris += e.geo.index.count / 3;
  if (extra) tris += extra.geo.index.count / 3;
  const out = { body: st, eyes, extra, tris };
  partsCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- materials (cached per colour)

// Any user picks the colour, so the face and the accessories adapt to it the way the brand's two Grok Bots do:
// white eyes on a colour or on black, glossy black eyes on a near-white body (the white bot); black glasses and
// stem, light ones on a near-black body. Thresholds are relative luminance (linear): warm cream (#F6DCC2, ~0.73)
// keeps white eyes like the hand-made warren-buffett, #F3E7DB (~0.81) and lighter get dark eyes.
const LIGHT_BODY = 0.78, DARK_BODY = 0.06;
export function bodyTone(hex) {
  const c = new THREE.Color(hex);                                       // linear (colour management is on)
  const L = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return L >= LIGHT_BODY ? 'light' : L < DARK_BODY ? 'dark' : 'mid';
}

// Eyes: 'dark' on a near-white body; 'bright' (white that stays white in shade) on a grey body, where only lightness
// separates the eyes from the body (the app's gray, #959595, is as light as its orange); else the usual white.
function eyeKind(hex) {
  const tone = bodyTone(hex);
  if (tone === 'light') return 'dark';
  const s = new THREE.Color(hex).convertLinearToSRGB();
  return tone === 'mid' && Math.max(s.r, s.g, s.b) - Math.min(s.r, s.g, s.b) < 0.12 ? 'bright' : 'white';
}

const bodyMats = new Map();
function bodyMaterial(hex) {
  if (!bodyMats.has(hex)) bodyMats.set(hex, new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 }));
  return bodyMats.get(hex);
}

const eyeMats = new Map();
function eyeMaterial(kind = 'white') {
  const glow = kind === 'bright' ? 0.42 : 0.1;
  if (!eyeMats.has(kind)) eyeMats.set(kind, new THREE.MeshPhysicalMaterial(kind === 'dark'
    ? { color: '#141417', roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 }
    : { color: 0xffffff, roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.05, emissive: new THREE.Color().setRGB(glow, glow, glow, THREE.LinearSRGBColorSpace) }));
  return eyeMats.get(kind);
}

const darkMats = new Map();
function darkMaterial(kind, onDark = false) {
  const key = `${kind}|${onDark}`;
  if (!darkMats.has(key)) darkMats.set(key, new THREE.MeshPhysicalMaterial(onDark
    ? (kind === 'glasses'
      ? { color: '#ECECEF', roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.05 }
      : { color: '#8A8D93', roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.06 })
    : (kind === 'glasses'
      ? { color: '#101012', roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.06 }
      : { color: '#3A3D40', roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.06 })));
  return darkMats.get(key);
}

const accentMats = new Map();
function accentMaterial(hex) {
  if (!accentMats.has(hex)) accentMats.set(hex, new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 }));
  return accentMats.get(hex);
}

/** contrasting accent for bows / antenna balls: the candidate furthest from the body colour (redmean distance).
 * Always a colour (a black bow on a white blob reads as a bug), white only on near-black bodies. */
const ACCENTS = ['#FFD60A', '#FF2D6F', '#2D7BFF', '#2FD067'];
export function accentFor(hex) {
  const c = new THREE.Color(hex).convertLinearToSRGB();                // 0..1 sRGB
  const list = bodyTone(hex) === 'dark' ? ['#FFFFFF', ...ACCENTS] : ACCENTS;
  let best = list[0], bestD = -1;
  for (const a of list) {
    const o = new THREE.Color(a).convertLinearToSRGB();
    const rm = (c.r + o.r) / 2;
    const d = (2 + rm) * (c.r - o.r) ** 2 + 4 * (c.g - o.g) ** 2 + (3 - rm) * (c.b - o.b) ** 2;
    if (d > bestD) { bestD = d; best = a; }
  }
  return best;
}

/** trio palette: the colour itself, a companion hue, and a dark (or white, for dark colours) third */
function trioColors(hex) {
  const hsl = {};
  new THREE.Color(hex).getHSL(hsl);
  const b = new THREE.Color().setHSL((hsl.h + 150 / 360) % 1, Math.max(hsl.s, 0.7), Math.min(0.46, Math.max(0.36, hsl.l * 0.85)));
  const c = hsl.l < 0.22 ? new THREE.Color('#F4F4F6') : new THREE.Color('#111113');
  return [hex, `#${b.getHexString().toUpperCase()}`, `#${c.getHexString().toUpperCase()}`];
}

// ---------------------------------------------------------------- public API

// The Grok Bot app's 11 avatar colours, for blobs nobody described (the gray last: never picked by the hash).
export const APP_COLORS = ['#000000', '#A06B39', '#FB2B3E', '#FD690F', '#F59312', '#14C16F', '#13B7A2', '#1E86FC', '#8F59F9', '#F93498', '#959595'];
export const PALETTE = APP_COLORS.slice(0, 10);

// The app draws every shape at one angle (already in its outline); the old per-bot random tilt is gone.
function tiltFor() { return 0; }

/**
 * @param {{shape?: string, color?: string, accessory?: string, seed?: string|number}} look
 * @returns {THREE.Group} root `blob` (children: body, eye_L, eye_R, [eye_*_N for trio], [extra])
 */
export function generateBlob({ shape, color, accessory, seed } = {}) {
  const sd = String(seed ?? 'blob');
  const sh = normShape(shape) ?? hashShape(sd);
  const col = normColor(color) ?? PALETTE[hash32(`color:${sd}`) % PALETTE.length];
  const acc = normAccessory(accessory);
  const parts = partsStage(sh, tiltFor(sd), acc);
  const colors = parts.body.nMats > 1 ? trioColors(col) : [col];
  // trio: eye_L / eye_R sit on the primary (second) blob, eye_*_2 / eye_*_3 on the first and third
  const eyeColor = (name) => colors[parts.body.nMats > 1 ? { 2: 0, 3: 2 }[name.split('_')[2]] ?? 1 : 0];
  const host = colors[parts.body.nMats > 1 ? (acc === 'glasses' ? 1 : 2) : 0];   // glasses on the primary, the rest on the top star

  const root = new THREE.Group();
  root.name = 'blob';
  const body = new THREE.Mesh(parts.body.geo, parts.body.nMats > 1 ? colors.map(bodyMaterial) : bodyMaterial(col));
  body.name = 'body';
  root.add(body);
  for (const e of parts.eyes) {
    const m = new THREE.Mesh(e.geo, eyeMaterial(eyeKind(eyeColor(e.name))));
    m.name = e.name;
    m.position.set(e.pos[0], e.pos[1], e.pos[2]);
    root.add(m);
  }
  if (parts.extra) {
    const dark = darkMaterial(acc === 'glasses' ? 'glasses' : 'stem', bodyTone(host) === 'dark');
    const mats = parts.extra.accent ? [dark, accentMaterial(accentFor(col))] : dark;
    const extra = new THREE.Mesh(parts.extra.geo, mats);
    extra.name = 'extra';
    root.add(extra);
  }
  root.userData = { generated: true, look: { shape: sh, color: col, accessory: acc }, tris: parts.tris, tilt: tiltFor(sd) };
  return root;
}

export { TRI_BUDGET };
