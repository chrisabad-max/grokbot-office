// Per-floor character, a light layer on top of the floor_open template (CONTRACT v2.4): every floor gets one muted accent
// colour, picked from its floor id, and one of four lounge corners, picked by floor order: the GLB's own sofa lounge, a
// media corner, a quiet library corner and a small meeting table. Everything is built once into the template, hidden, so
// the two open-floor instances (building.js) share its geometry and textures; an instance shows the corner of the floor
// it plays and recolours its own cloned accent materials. Every corner has the same five lounge seats (lounge_01..05;
// lounge_06 stays the bar stool), so idle bots always have somewhere to sit.
//
// The baked floor under the GLB lounge carries the sofa's and armchairs' shadows. The other corners lay a clean floor patch
// over it (the bake is one flat colour around there) and bring their own soft shadows, drawn the way the bake falls: a
// blurred sweep of each footprint along the sun offset, plus a tight contact shadow.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Wool-and-ceramic colours (sRGB): sage, eucalyptus, slate, lilac, mauve, clay, ochre.
export const ACCENTS = ['#9CAA93', '#86A4A1', '#8E9DB1', '#A49EB9', '#BB9CA6', '#C79F89', '#CDB27F'];
export const LAYOUTS = ['sofa', 'media', 'library', 'meeting'];

const SUN = [0.85, 1.25];                 // floor offset of a shadow per metre of height, read off the baked floor
const SHADOW_RGB = '26,30,42';             // cool near-black, like the studio shadow
const PLUME_A = 0.3;                       // a baked sweep shadow darkens the floor by about 30 %
const FLOOR_RGB = [240, 235, 227];         // the baked floor around the lounge
const ZONE = { x0: 3.03, x1: 8.0, z0: -0.12, z1: 4.7 };   // clean patch over the GLB lounge's baked shadows
const DROPS = [[4.13, -0.3], [4.13, 3.9]]; // baked shadows of two desk pendants, partly inside the patch
const PPM = 128, SPPM = 64;                // px per metre: patch and rug textures, shadow layers
const RUG_H = 0.012;
const GLB_LOUNGE = ['sofa', 'armchair_1', 'armchair_2', 'coffee_table'];
const FALLBACK = { oak: '#D9C39F', black: '#1C1C1E', graphite: '#3A3A3C', fabric_warm: '#C9C5BE', fabric_light: '#E2DFDA', pot_white: '#F1EFEB', bar_white: '#EBE9E4' };
const BOOKS = ['#ECE6DA', '#D3CABA', '#ABA294', '#6B6762', '#36363A', '#BCA680'];
const WHITE = new THREE.Color(1, 1, 1);
const WOOL = new THREE.Color('#F2EEE6');
const RUG_LIN = new THREE.Color().setRGB(210 / 255, 210 / 255, 210 / 255, THREE.SRGBColorSpace).r;   // the baked round rug
const NIGHT = new Map();                   // corner name -> { layers, rug } for its night textures
const NIGHT_SHADOW = 0.4;                  // the lamps' shadows are much softer than the sun's

// ---------------- which floor gets what ----------------

/** floors sorted by order -> Map(id -> { accent, layout }). The accent comes from the id; a colour an earlier floor
 *  already took moves on to the next free one, so up to seven floors never share one. */
export function floorStyles(floors) {
  const used = new Set(), out = new Map();
  floors.forEach((f, i) => {
    let k = hash(f.id) % ACCENTS.length;
    if (floors.length <= ACCENTS.length) while (used.has(k)) k = (k + 1) % ACCENTS.length;
    used.add(k);
    out.set(f.id, { accent: ACCENTS[k], layout: LAYOUTS[i % LAYOUTS.length] });
  });
  return out;
}

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------- on an instance ----------------

const targets = new WeakMap();

function collect(obj) {
  const t = { layouts: new Map(), glb: [], mats: [] };
  obj.traverse((o) => {
    const m = /^style_(sofa|media|library|meeting)$/.exec(o.name);
    if (m) t.layouts.set(m[1], o);
    if (GLB_LOUNGE.includes(o.name)) t.glb.push(o);
    if (o.isMesh) for (const mat of [].concat(o.material)) if (mat.userData.accent && !t.mats.includes(mat)) t.mats.push(mat);
  });
  return t;
}

/** Show the floor's corner on an open-floor instance (its cloned object) and recolour its accent materials. */
export function applyFloorStyle(obj, style) {
  if (!targets.has(obj)) targets.set(obj, collect(obj));
  const t = targets.get(obj);
  for (const [name, g] of t.layouts) g.visible = name === style.layout;
  for (const o of t.glb) o.visible = style.layout === 'sofa';
  const c = new THREE.Color(style.accent);
  for (const m of t.mats) tint(m, m.userData.accent, c);
}

/** Everything a corner switch may hide (for shader prewarm). */
export function styleObjects(obj) {
  if (!targets.has(obj)) targets.set(obj, collect(obj));
  const t = targets.get(obj);
  return [...t.layouts.values(), ...t.glb];
}

function tint(m, role, accent) {
  const c = /^rug/.test(role) ? accent.clone().lerp(WOOL, 0.28) : accent;   // the biggest patch of colour: a shade lighter
  switch (role) {
    case 'rugtint': m.color.setRGB(Math.min(1, c.r / RUG_LIN), Math.min(1, c.g / RUG_LIN), Math.min(1, c.b / RUG_LIN)); break;
    case 'fabric': m.color.copy(c).multiplyScalar(0.86); break;
    case 'panelDark': m.color.copy(c).multiplyScalar(0.6); break;
    case 'book': m.color.copy(c).multiplyScalar(0.78); break;
    case 'rugEdge': m.color.copy(c).multiplyScalar(0.74); break;
    case 'screen': m.color.copy(c).lerp(WHITE, 0.2).multiplyScalar(0.92); break;
    case 'rug': (m.accentUniform ? m.accentUniform.value : m.color).copy(c); break;   // building.js: baked rugs tint in a uniform
    default: m.color.copy(c);                    // panel, pot
  }
}

// ---------------- building the template ----------------

/** Adds the styling to the floor_open template. lounges: the GLB's lounge spots (local to floor_open).
 *  Returns { layouts: { sofa|media|library|meeting: [5 x { pos, yaw }] } }, or null when the GLB lounge is missing. */
export function buildFloorStyles(open, lounges) {
  if (GLB_LOUNGE.some((n) => !open.getObjectByName(n)) || lounges.slice(0, 5).some((s) => !s)) return null;
  const k = new Kit(open);
  wallPanel(k, open);
  accentPot(k, open);
  sofaExtras(k, open);
  const layouts = { sofa: lounges.slice(0, 5).map((s) => ({ pos: s.pos.clone(), yaw: s.yaw })) };
  layouts.media = corner(k, open, 'media', mediaCorner);
  layouts.library = corner(k, open, 'library', libraryCorner);
  layouts.meeting = corner(k, open, 'meeting', meetingCorner);
  return { layouts };
}

class Kit {
  constructor(open) {
    this.open = open;
    this.found = new Map();
    open.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m.name && !this.found.has(m.name)) this.found.set(m.name, m); });
    this.made = new Map();
  }

  mat(name) {
    if (this.found.has(name)) return this.found.get(name);
    if (!this.made.has(name)) this.made.set(name, new THREE.MeshStandardMaterial({ name, color: FALLBACK[name] || '#CCCCCC', roughness: 0.7 }));
    return this.made.get(name);
  }

  // one shared material per accent role (cloned per instance by building.js, recoloured by applyFloorStyle)
  accent(role, base = 'fabric_light', props = {}) {
    const key = `accent_${role}`;
    if (!this.made.has(key)) {
      const m = this.mat(base).clone();
      m.name = key;
      m.userData = { accent: role };
      Object.assign(m, props);
      this.made.set(key, m);
    }
    return this.made.get(key);
  }

  plain(name, color, roughness = 0.75) {
    if (!this.made.has(name)) this.made.set(name, new THREE.MeshStandardMaterial({ name, color, roughness }));
    return this.made.get(name);
  }

  add(parent, geo, mat, x, y, z, ry = 0, rx = 0, rz = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz, 'YXZ');
    parent.add(m);
    return m;
  }

  rbox(w, h, d, r) {
    return new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  }

  group(parent, x, z, yaw = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    parent.add(g);
    return g;
  }
}

// One corner: furniture in a scratch group, its shadows drawn into a clean floor patch and a rug, then every untextured
// mesh merged per material (a corner costs a handful of draw calls).
function corner(k, open, name, build) {
  const src = new THREE.Group();
  const shadows = DROPS.map(([x, z]) => ({ pts: hull([...circle(x, z, 0.15, 14), [x + 0.34, z + 0.36]]), flat: true }));
  const ctx = { shadows, rug: null };
  const seats = build(k, src, ctx);
  const layers = shadowLayers(shadows);
  NIGHT.set(name, { layers, rug: ctx.rug });
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(ZONE.x1 - ZONE.x0, ZONE.z1 - ZONE.z0).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: patchTexture(layers), name: `style_patch_${name}` }));
  patch.position.set((ZONE.x0 + ZONE.x1) / 2, 0.002, (ZONE.z0 + ZONE.z1) / 2);
  patch.userData.bakedName = `style_patch_${name}`;          // night: tinted like the baked floor (building.js)
  src.add(patch);
  if (ctx.rug) rug(k, src, ctx.rug, layers, name);
  const g = flatten(src, `style_${name}`);
  g.visible = false;
  open.add(g);
  return seats.map(([x, y, z, yaw]) => ({ pos: new THREE.Vector3(x, y, z), yaw }));
}

// ---------------- the four corners ----------------

// The GLB's own lounge: two accent cushions on the sofa and the baked round rug tinted in the accent.
function sofaExtras(k, open) {
  const g = new THREE.Group();
  g.name = 'style_sofa';
  const sofa = open.getObjectByName('sofa');
  const sp = sofa.position;
  const cushion = k.rbox(0.42, 0.4, 0.14, 0.065);
  for (const s of [-1, 1]) k.add(g, cushion, k.accent('fabric'), sp.x + s * 1.16, 0.655, sp.z - 0.16, -s * 0.22, -0.3);
  const tintMat = new THREE.MeshBasicMaterial({ name: 'accent_rugtint', color: 0xffffff, blending: THREE.MultiplyBlending, premultipliedAlpha: true, transparent: true, depthWrite: false });
  tintMat.userData = { accent: 'rugtint' };
  const disc = k.add(g, new THREE.CircleGeometry(2.205, 128).rotateX(-Math.PI / 2), tintMat, 5.3, 0.0015, 2.3);
  disc.userData.keep = true;
  disc.renderOrder = -1;
  open.add(g);
}

// Media corner: a large screen on a low console along the left edge, two armchairs turned to it, a bench at the back.
function mediaCorner(k, g, ctx) {
  const white = k.mat('bar_white'), oak = k.mat('oak'), black = k.mat('black');
  const cx = 3.44, cz = 2.45, L = 2.7, D = 0.44, H = 0.46;
  k.add(g, k.rbox(D - 0.08, 0.05, L - 0.12, 0.01), black, cx, 0.025, cz);
  k.add(g, k.rbox(D, H - 0.08, L, 0.012), white, cx, 0.05 + (H - 0.08) / 2, cz);
  k.add(g, k.rbox(D + 0.02, 0.03, L + 0.02, 0.008), oak, cx, H - 0.015, cz);
  for (const dz of [-L / 6, L / 6]) k.add(g, new THREE.BoxGeometry(0.004, H - 0.12, 0.006), black, cx + D / 2 + 0.001, 0.05 + (H - 0.08) / 2, cz + dz);   // door seams
  ctx.shadows.push({ pts: rect(cx, cz, D, L), y0: 0, y1: H, core: 0.75 });

  const sw = 2.0, sh = 1.125, sy = H + 0.17 + sh / 2, px = cx - 0.02;
  k.add(g, k.rbox(0.22, 0.012, 0.44, 0.006), black, px, H + 0.006, cz);
  k.add(g, k.rbox(0.035, 0.2, 0.12, 0.01), black, px - 0.02, H + 0.1, cz);
  k.add(g, k.rbox(0.032, sh + 0.036, sw + 0.036, 0.01), black, px, sy, cz);
  const screen = new THREE.MeshBasicMaterial({ name: 'accent_screen', map: screenTexture(), toneMapped: false });
  screen.userData = { accent: 'screen' };
  k.add(g, new THREE.PlaneGeometry(sw, sh).rotateY(Math.PI / 2), screen, px + 0.0165, sy, cz);
  ctx.shadows.push({ pts: rect(px, cz, 0.032, sw + 0.036), y0: sy - sh / 2 - 0.02, y1: sy + sh / 2 + 0.02 });

  const seats = [];
  for (const z of [1.75, 3.3]) {
    const x = 5.1, yaw = Math.atan2(cx - x, cz - z);
    armchair(k, g, ctx, x, z, yaw);
    seats.push(seatAt(x, z, yaw, 0.48, 0.05));
  }
  bench(k, g, ctx, 6.0, 0.5, 2.5, 0);
  ctx.rug = { kind: 'rect', x0: 3.9, z0: 0.1, x1: 7.65, z1: 4.25, r: 0.08 };
  return [[5.15, 0.46, 0.5, 0], [6.0, 0.46, 0.5, 0], [6.85, 0.46, 0.5, 0], ...seats];
}

// Library corner: low shelving along the back and the left edge, a bench in front of it, a reading chair with a floor
// lamp and a footstool.
function libraryCorner(k, g, ctx) {
  const rnd = mulberry(11);
  shelf(k, g, ctx, (3.12 + 7.35) / 2, 0.27, 7.35 - 3.12, 0, rnd);
  shelf(k, g, ctx, 3.3, (0.45 + 3.75) / 2, 3.75 - 0.45, Math.PI / 2, rnd);
  bench(k, g, ctx, 3.97, 2.15, 2.45, Math.PI / 2);

  const cx = 6.7, cz = 2.85, yaw = -0.69;
  armchair(k, g, ctx, cx, cz, yaw);
  floorLamp(k, g, ctx, 7.38, 2.12);
  ottoman(k, g, ctx, 5.75, 3.72);

  // a small plant and a vase on the long run
  const plant = k.open.getObjectByName('tree_3').clone(true);
  plant.position.set(6.85, 0.78, 0.27);
  plant.scale.setScalar(0.24);
  g.add(plant);
  const vase = new THREE.LatheGeometry([[0, 0], [0.045, 0], [0.06, 0.05], [0.058, 0.12], [0.03, 0.2], [0.028, 0.23], [0, 0.23]].map(([x, y]) => new THREE.Vector2(x, y)), 28);
  k.add(g, vase, k.mat('pot_white'), 4.15, 0.78, 0.25);
  ctx.rug = { kind: 'round', cx: 5.7, cz: 2.4, r: 1.72 };
  return [[3.97, 0.46, 1.3, Math.PI / 2], [3.97, 0.46, 2.15, Math.PI / 2], [3.97, 0.46, 3.0, Math.PI / 2], seatAt(cx, cz, yaw, 0.48, 0.05), [5.75, 0.41, 3.72, 0.3]];
}

// Meeting table: an oak racetrack top on two pedestals, three chairs on the far side, one at each end, two tucked in.
function meetingCorner(k, g, ctx) {
  const oak = k.mat('oak'), black = k.mat('black');
  const cx = 5.55, cz = 2.05, L = 2.4, W = 1.1, top = 0.74;
  const geo = new THREE.ExtrudeGeometry(roundRect(L, W, W / 2), { depth: 0.024, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 16 });
  geo.rotateX(Math.PI / 2);                                  // shape xy -> floor xz, extruded downwards
  k.add(g, geo, oak, cx, top - 0.006, cz);
  for (const s of [-1, 1]) {
    k.add(g, new THREE.CylinderGeometry(0.04, 0.04, top - 0.05, 20), black, cx + s * 0.62, (top - 0.05) / 2 + 0.012, cz);
    k.add(g, k.rbox(0.09, 0.024, 0.74, 0.01), black, cx + s * 0.62, 0.012, cz);
    ctx.shadows.push({ pts: rect(cx + s * 0.62, cz, 0.08, 0.08), y0: 0, y1: top - 0.04 }, { pts: rect(cx + s * 0.62, cz, 0.09, 0.74), core: 0.55, blur: 0.02 });
  }
  ctx.shadows.push({ pts: roundRect(L, W, W / 2).getPoints(12).map((p) => [cx + p.x, cz - p.y]), y0: top - 0.036, y1: top });

  const seats = [];
  for (const x of [cx - 0.8, cx, cx + 0.8]) { chair(k, g, ctx, x, cz - W / 2 - 0.47, 0); seats.push([x, 0.47, cz - W / 2 - 0.47, 0]); }
  chair(k, g, ctx, cx - L / 2 - 0.5, cz, Math.PI / 2); seats.push([cx - L / 2 - 0.5, 0.47, cz, Math.PI / 2]);
  chair(k, g, ctx, cx + L / 2 + 0.5, cz, -Math.PI / 2); seats.push([cx + L / 2 + 0.5, 0.47, cz, -Math.PI / 2]);
  for (const x of [cx - 0.42, cx + 0.42]) chair(k, g, ctx, x, cz + W / 2 + 0.3, Math.PI);
  ctx.rug = { kind: 'rect', x0: 3.35, z0: 0.42, x1: 7.75, z1: 3.68, r: 0.08 };
  return seats;
}

// ---------------- pieces ----------------

function seatAt(x, z, yaw, y, fwd) {
  return [x + Math.sin(yaw) * fwd, y, z + Math.cos(yaw) * fwd, yaw];
}

function armchair(k, g, ctx, x, z, yaw) {
  const a = k.open.getObjectByName('armchair_1').clone(true);
  a.position.set(x, 0, z);
  a.rotation.set(0, yaw, 0);
  g.add(a);
  ctx.shadows.push(
    { pts: rect(x, z, 0.95, 0.9, yaw), y0: 0, y1: 0.37, core: 0.88, blur: 0.04 },
    { pts: rect(...rot(x, z, 0, -0.38, yaw), 0.95, 0.16, yaw), y0: 0, y1: 0.85 },
    ...[-0.5, 0.5].map((lx) => ({ pts: rect(...rot(x, z, lx, 0, yaw), 0.1, 0.8, yaw), y0: 0, y1: 0.62 })),
  );
}

// Backless bench: upholstered pad on an oak frame, four slim black legs. Local length along x, seats face local +z.
function bench(k, g, ctx, x, z, L, yaw) {
  const b = k.group(g, x, z, yaw), D = 0.46;
  k.add(b, k.rbox(L, 0.035, D, 0.012), k.mat('oak'), 0, 0.322, 0);
  k.add(b, k.rbox(L - 0.03, 0.115, D - 0.03, 0.05), k.mat('fabric_warm'), 0, 0.395, 0);
  const leg = new THREE.CylinderGeometry(0.016, 0.014, 0.305, 12);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const lx = sx * (L / 2 - 0.09), lz = sz * (D / 2 - 0.07);
    k.add(b, leg, k.mat('black'), lx, 0.1525, lz);
    const [wx, wz] = rot(x, z, lx, lz, yaw);
    ctx.shadows.push({ pts: rect(wx, wz, 0.03, 0.03), y0: 0, y1: 0.3, core: 0.5, blur: 0.015 });
  }
  ctx.shadows.push({ pts: rect(x, z, L, D, yaw), y0: 0.305, y1: 0.452, core: 0.22, blur: 0.1 });
}

// Meeting chair: upholstered seat and back on a thin black frame. Seats face local +z.
function chair(k, g, ctx, x, z, yaw) {
  const c = k.group(g, x, z, yaw), fab = k.mat('graphite'), black = k.mat('black');
  k.add(c, k.rbox(0.48, 0.07, 0.46, 0.03), fab, 0, 0.43, 0.01);
  k.add(c, k.rbox(0.46, 0.33, 0.05, 0.022), fab, 0, 0.73, -0.215, 0, -0.1);
  const leg = new THREE.CylinderGeometry(0.011, 0.011, 0.395, 10);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    k.add(c, leg, black, sx * 0.2, 0.1975, sz * 0.18);
    ctx.shadows.push({ pts: rect(...rot(x, z, sx * 0.2, sz * 0.18, yaw), 0.024, 0.024), y0: 0, y1: 0.395, core: 0.45, blur: 0.012 });
  }
  const post = new THREE.CylinderGeometry(0.009, 0.009, 0.16, 8);
  for (const sx of [-1, 1]) k.add(c, post, black, sx * 0.18, 0.54, -0.205);
  ctx.shadows.push(
    { pts: rect(...rot(x, z, 0, 0.01, yaw), 0.48, 0.46, yaw), y0: 0.395, y1: 0.465, core: 0.16, blur: 0.08 },
    { pts: rect(...rot(x, z, 0, -0.215, yaw), 0.46, 0.05, yaw), y0: 0.565, y1: 0.895 },
  );
}

// Low shelving, white carcass with an oak top, two levels of books. Local length along x, opening faces local +z.
function shelf(k, g, ctx, x, z, L, yaw, rnd) {
  const s = k.group(g, x, z, yaw), D = 0.36, H = 0.78, T = 0.022;
  const white = k.mat('bar_white');
  k.add(s, k.rbox(L - 0.05, 0.05, D - 0.06, 0.008), k.mat('black'), 0, 0.025, -0.015);
  k.add(s, k.rbox(L, T, D, 0.004), white, 0, 0.05 + T / 2, 0);
  k.add(s, k.rbox(L + 0.012, 0.03, D + 0.012, 0.008), k.mat('oak'), 0, H - 0.015, 0);
  k.add(s, k.rbox(L, H - 0.08, 0.012, 0.003), white, 0, 0.05 + (H - 0.08) / 2, -D / 2 + 0.006);
  const n = Math.max(1, Math.round(L / 0.82)), cw = L / n;
  for (let i = 0; i <= n; i++) k.add(s, k.rbox(T, H - 0.08, D, 0.004), white, -L / 2 + T / 2 + i * (L - T) / n, 0.05 + (H - 0.08) / 2, 0);
  const mid = 0.05 + T + (H - 0.08 - T) / 2;
  k.add(s, k.rbox(L - T, T, D - 0.015, 0.004), white, 0, mid, 0.0075);
  for (let i = 0; i < n; i++) {
    const a = -L / 2 + i * cw + T, b = a + cw - T;
    books(k, s, a, b, 0.05 + T, mid - T / 2 - (0.05 + T), D, rnd);
    books(k, s, a, b, mid + T / 2, H - 0.03 - (mid + T / 2), D, rnd);
  }
  ctx.shadows.push({ pts: rect(x, z, L, D, yaw), y0: 0, y1: H, core: 0.72, blur: 0.03 });
}

function books(k, s, x0, x1, y0, h, D, rnd) {
  const pick = () => (rnd() < 0.12 ? k.accent('book', 'fabric_light', { roughness: 0.75 }) : k.plain(`book_${Math.floor(rnd() * BOOKS.length)}`, BOOKS[Math.floor(rnd() * BOOKS.length)]));
  const back = -D / 2 + 0.016;
  if (rnd() < 0.16) {                                          // a lying stack instead
    let y = y0;
    for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
      const t = 0.028 + rnd() * 0.014, w = 0.2 + rnd() * 0.05, d = 0.16 + rnd() * 0.05;
      k.add(s, new THREE.BoxGeometry(w, t, d), pick(), x0 + 0.04 + w / 2 + (rnd() - 0.5) * 0.02, y + t / 2, back + d / 2, (rnd() - 0.5) * 0.12);
      y += t;
    }
    return;
  }
  const stop = x1 - 0.008 - (rnd() < 0.55 ? 0.1 + rnd() * 0.3 : 0);
  let x = x0 + 0.006 + rnd() * 0.05;
  while (true) {
    const t = 0.02 + rnd() * 0.024, bh = Math.min(h - 0.03, 0.19 + rnd() * 0.11), d = 0.16 + rnd() * 0.07;
    if (x + t > stop) break;
    k.add(s, new THREE.BoxGeometry(t, bh, d), pick(), x + t / 2, y0 + bh / 2, back + d / 2);
    x += t + (rnd() < 0.12 ? 0.006 : 0.0015);
  }
}

function floorLamp(k, g, ctx, x, z) {
  const black = k.mat('black');
  k.add(g, new THREE.CylinderGeometry(0.15, 0.16, 0.018, 32), black, x, 0.009, z);
  k.add(g, new THREE.CylinderGeometry(0.011, 0.011, 1.3, 10), black, x, 0.018 + 0.65, z);
  k.add(g, new THREE.CylinderGeometry(0.16, 0.19, 0.26, 40), k.mat('fabric_light'), x, 1.43, z);
  ctx.shadows.push(
    { pts: circle(x, z, 0.16, 16), y0: 0, y1: 0.02, core: 0.5, blur: 0.02 },
    { pts: rect(x, z, 0.024, 0.024), y0: 0, y1: 1.3 },
    { pts: circle(x, z, 0.19, 16), y0: 1.3, y1: 1.56 },
  );
}

function ottoman(k, g, ctx, x, z) {
  const prof = [[0, 0], [0.27, 0], [0.295, 0.02], [0.31, 0.12], [0.31, 0.3], [0.295, 0.375], [0.26, 0.405], [0, 0.41]];
  k.add(g, new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 40), k.accent('fabric'), x, 0, z);
  ctx.shadows.push({ pts: circle(x, z, 0.31, 20), y0: 0, y1: 0.41, core: 0.82, blur: 0.04 });
}

// Slatted acoustic panel on the free stretch of the left wall, in the floor's accent.
function wallPanel(k, open) {
  const src = new THREE.Group();
  const W = 1.26, H = 2.05, zc = 3.35, yc = 1.33, x = -8.0, n = 12, sw = 0.062;
  k.add(src, k.rbox(0.018, H, W, 0.006), k.accent('panelDark'), x + 0.009, yc, zc);
  const gap = (W - 0.04 - n * sw) / (n - 1);
  const slat = k.rbox(0.026, H - 0.04, sw, 0.008);
  for (let i = 0; i < n; i++) k.add(src, slat, k.accent('panel', 'fabric_light', { roughness: 0.9 }), x + 0.018 + 0.013, yc, zc - W / 2 + 0.02 + sw / 2 + i * (sw + gap));
  const g = flatten(src, 'style_panel');
  open.add(g);
}

// The big tree next to the lounge gets an accent pot.
function accentPot(k, open) {
  const tree = open.getObjectByName('tree_1');
  if (!tree) return;
  tree.traverse((o) => { if (o.isMesh && o.material.name === 'pot_white') o.material = k.accent('pot', 'pot_white'); });
}

// ---------------- rug, patch, shadows ----------------

function rug(k, src, spec, layers, name) {
  let shape, cx, cz, w, h;
  if (spec.kind === 'round') {
    cx = spec.cx; cz = spec.cz; w = h = spec.r * 2;
    shape = new THREE.Shape().absarc(0, 0, spec.r, 0, Math.PI * 2, false);
  } else {
    cx = (spec.x0 + spec.x1) / 2; cz = (spec.z0 + spec.z1) / 2; w = spec.x1 - spec.x0; h = spec.z1 - spec.z0;
    shape = roundRect(w, h, spec.r);
  }
  const bb = { x0: cx - w / 2, x1: cx + w / 2, z0: cz - h / 2, z1: cz + h / 2 };
  const top = new THREE.ShapeGeometry(shape, 40);
  const p = top.attributes.position, uv = top.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  top.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ name: `style_rug_${name}`, map: rugTexture(spec, bb, layers) });
  mat.userData = { accent: 'rug' };
  const m = k.add(src, top, mat, cx, RUG_H, cz);
  m.userData.bakedName = `style_rug_${name}`;
  const outline = shape.getPoints(40).map((v) => [v.x, -v.y]);
  k.add(src, edgeStrip(outline, RUG_H), k.accent('rugEdge', 'fabric_light', { roughness: 1, side: THREE.FrontSide }), cx, 0, cz);
}

function rugBox(spec) {
  if (spec.kind === 'round') return { x0: spec.cx - spec.r, x1: spec.cx + spec.r, z0: spec.cz - spec.r, z1: spec.cz + spec.r };
  return { x0: spec.x0, x1: spec.x1, z0: spec.z0, z1: spec.z1 };
}

function rugTexture(spec, bb, layers, light = null) {
  const W = Math.round((bb.x1 - bb.x0) * PPM), H = Math.round((bb.z1 - bb.z0) * PPM);
  return canvasTex(W, H, (g) => {
    paintRug(g, W, H, spec, bb, layers, light ? NIGHT_SHADOW : 1);
    if (light) {                                             // night: the same rug under the night light field
      g.globalCompositeOperation = 'multiply';
      g.drawImage(fieldCanvas(light, bb), 0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
    }
  });
}

// Near-white wool with a faint weave and a fine bound line 18 cm in from the edge (the accent comes from the material).
function paintRug(g, W, H, spec, bb, layers, shadowK) {
  g.fillStyle = 'rgb(247,247,246)';
  g.fillRect(0, 0, W, H);
  grain(g, W, H, 7, 5);
  const inset = 0.18 * PPM;
  g.strokeStyle = 'rgba(0,0,0,0.07)';
  g.lineWidth = 1.5;
  g.beginPath();
  if (spec.kind === 'round') g.arc(W / 2, H / 2, W / 2 - inset, 0, Math.PI * 2);
  else roundRectPath(g, inset, inset, W - inset * 2, H - inset * 2, Math.max(2, spec.r * PPM - inset * 0.3));
  g.stroke();
  drawLayers(g, layers, bb, shadowK);
}

// light: null = the day floor colour; else the night field (x, z) -> [r, g, b]
function patchTexture(layers, light = null) {
  const W = Math.round((ZONE.x1 - ZONE.x0) * PPM), H = Math.round((ZONE.z1 - ZONE.z0) * PPM);
  return canvasTex(W, H, (g) => {
    if (light) g.drawImage(fieldCanvas(light, ZONE), 0, 0, W, H);
    else { g.fillStyle = `rgb(${FLOOR_RGB.join(',')})`; g.fillRect(0, 0, W, H); }
    grain(g, W, H, 3, 0);
    g.fillStyle = 'rgba(60,50,40,0.035)';                    // stone joints every 1.6 m x 1.5 m, as in the bake
    for (let x = -8; x <= 8; x += 1.6) if (x > ZONE.x0 && x < ZONE.x1) g.fillRect(Math.round((x - ZONE.x0) * PPM), 0, 1, H);
    for (let z = -6; z <= 6; z += 1.5) if (z > ZONE.z0 && z < ZONE.z1) g.fillRect(0, Math.round((z - ZONE.z0) * PPM), W, 1);
    drawLayers(g, layers, ZONE, light ? NIGHT_SHADOW : 1);
  });
}

// ---------------- night ----------------

/** Night textures for the corners' floor patches and rugs, lit like the night lightmap around them: a smooth fit of
 *  the night floor sampled on a ring just outside the patch (shadowed samples dropped). img: the night baked_floor
 *  image (the whole 16 x 12 m floor). -> Map(material name -> texture); the caller owns (disposes) them. */
export function styleNightMaps(img) {
  const out = new Map();
  const field = nightField(img);
  if (!field) return out;
  const ratio = (x, z) => field(x, z).map((v, i) => Math.min(255, (v / FLOOR_RGB[i]) * 255));   // night light / day floor
  for (const [name, src] of NIGHT) {
    out.set(`style_patch_${name}`, patchTexture(src.layers, field));
    if (src.rug) out.set(`style_rug_${name}`, rugTexture(src.rug, rugBox(src.rug), src.layers, ratio));
  }
  return out;
}

function nightField(img) {
  const S = 8, W = 16 * S, H = 12 * S;
  const c = canvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
  try {
    g.drawImage(img, 0, 0, W, H);
  } catch { return null; }
  const d = g.getImageData(0, 0, W, H).data;
  const at = (x, z) => {                                     // floor UVs: row 0 is the front edge (z = +6)
    const u = Math.min(W - 1, Math.max(0, Math.floor((x + 8) * S))), v = Math.min(H - 1, Math.max(0, Math.floor((6 - z) * S)));
    const i = (v * W + u) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  let samples = [];
  for (let t = 0; t <= 1.0001; t += 0.025) for (const off of [0.18, 0.4]) {
    const x = ZONE.x0 + t * (ZONE.x1 - 0.12 - ZONE.x0), z = ZONE.z0 + t * (ZONE.z1 - ZONE.z0);
    for (const [sx, sz] of [[ZONE.x0 - off, z], [x, ZONE.z0 - off], [x, ZONE.z1 + off]]) samples.push({ x: sx - 5.5, z: sz - 2.3, c: at(sx, sz) });
  }
  const lum = (c) => c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15;
  let coef = null;
  for (let pass = 0; pass < 4 && samples.length >= 12; pass++) {
    coef = [0, 1, 2].map((ch) => fit(samples, ch));
    const f = coef;
    samples = samples.filter((s) => lum(s.c) >= lum(evalFit(f, s.x, s.z)) * 0.93);
  }
  return coef && ((x, z) => evalFit(coef, x - 5.5, z - 2.3).map((v) => Math.max(0, Math.min(255, v))));
}

const basis = (x, z) => [1, x, z, x * x, z * z, x * z];
const evalFit = (coef, x, z) => coef.map((c) => basis(x, z).reduce((s, b, i) => s + b * c[i], 0));

// Least squares (normal equations, Gauss-Jordan) of one colour channel on the quadratic basis.
function fit(samples, ch) {
  const n = 6, A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const s of samples) {
    const b = basis(s.x, s.z);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) A[i][j] += b[i] * b[j]; A[i][n] += b[i] * s.c[ch]; }
  }
  for (let i = 0; i < n; i++) A[i][i] += 1e-6;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < n; r++) if (r !== i) { const k = A[r][i] / A[i][i]; for (let cI = i; cI <= n; cI++) A[r][cI] -= k * A[i][cI]; }
  }
  return A.map((row, i) => row[n] / row[i]);
}

// A field (x, z) -> [r, g, b] (0..255) painted over a floor box, coarse (it is smooth): drawn scaled up.
function fieldCanvas(field, bb) {
  const S = 16, W = Math.max(2, Math.round((bb.x1 - bb.x0) * S)), H = Math.max(2, Math.round((bb.z1 - bb.z0) * S));
  const c = canvas(W, H), g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
    const v = field(bb.x0 + (x + 0.5) / S, bb.z0 + (y + 0.5) / S);
    img.data[i] = v[0]; img.data[i + 1] = v[1]; img.data[i + 2] = v[2]; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Fine grain: per-pixel luminance noise (amp), plus a faint weave every other row (weave).
function grain(g, W, H, amp, weave) {
  const img = g.getImageData(0, 0, W, H), d = img.data, rnd = mulberry(3);
  for (let y = 0, i = 0; y < H; y++) {
    const row = weave ? ((y & 1) ? weave * 0.5 : -weave * 0.5) : 0;
    for (let x = 0; x < W; x++, i += 4) {
      const v = (rnd() - 0.5) * amp + row;
      d[i] += v; d[i + 1] += v; d[i + 2] += v;
    }
  }
  g.putImageData(img, 0, 0);
}

// Two layers in zone space: the sweep (union of every footprint swept along the sun offset, blurred more the higher it
// rises) and the contact shadows (footprints, tight blur, own darkness each).
function shadowLayers(items) {
  const W = Math.round((ZONE.x1 - ZONE.x0) * SPPM), H = Math.round((ZONE.z1 - ZONE.z0) * SPPM);
  const plume = canvas(W, H), ao = canvas(W, H);
  const pg = plume.getContext('2d'), ag = ao.getContext('2d');
  const P = (x, z) => [(x - ZONE.x0) * SPPM, (z - ZONE.z0) * SPPM];
  for (const it of items) {
    if (it.flat) softPoly(pg, it.pts, P, 0.07 * SPPM, `rgb(${SHADOW_RGB})`);
    else if (it.y1 > 0) {
      const sw = [it.y0, it.y1].flatMap((y) => it.pts.map(([x, z]) => [x + SUN[0] * y, z + SUN[1] * y]));
      softPoly(pg, hull(sw), P, (0.035 + 0.17 * it.y1) * SPPM, `rgb(${SHADOW_RGB})`);
    }
    if (it.core) softPoly(ag, it.pts, P, (it.blur ?? 0.03) * SPPM, `rgba(${SHADOW_RGB},${it.core})`);
  }
  return { plume, ao };
}

// k: shadow strength (night shadows of the lamps are softer than the sun's)
function drawLayers(g, layers, bb, k = 1) {
  const dx = (ZONE.x0 - bb.x0) * PPM, dy = (ZONE.z0 - bb.z0) * PPM, dw = (ZONE.x1 - ZONE.x0) * PPM, dh = (ZONE.z1 - ZONE.z0) * PPM;
  g.save();
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.globalAlpha = PLUME_A * k;
  g.drawImage(layers.plume, dx, dy, dw, dh);
  g.globalAlpha = k;
  g.drawImage(layers.ao, dx, dy, dw, dh);
  g.restore();
}

// Blurred polygon via the canvas shadow (works where ctx.filter does not, e.g. Safari): the shape is drawn far off the
// canvas and only its shadow lands.
function softPoly(g, pts, P, blur, color) {
  const off = blur > 0.5 ? 20000 : 0;
  g.save();
  if (off) { g.shadowColor = color; g.shadowBlur = blur; g.shadowOffsetX = off; g.fillStyle = '#000'; } else g.fillStyle = color;
  g.beginPath();
  pts.forEach(([x, z], i) => { const [px, py] = P(x, z); if (i) g.lineTo(px - off, py); else g.moveTo(px - off, py); });
  g.closePath();
  g.fill();
  g.restore();
}

// Quiet ambient picture for the media screen, in grey (the material tints it with the accent): dusk over soft dunes,
// one low sun, a faint sheen on the glass.
function screenTexture() {
  return canvasTex(640, 360, (g, W, H) => {
    const sky = g.createLinearGradient(0, 0, 0, H * 0.66);
    sky.addColorStop(0, '#202020'); sky.addColorStop(0.7, '#8C8C8C'); sky.addColorStop(1, '#B4B4B4');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    const sun = g.createRadialGradient(W * 0.64, H * 0.58, 0, W * 0.64, H * 0.58, H * 0.42);
    sun.addColorStop(0, 'rgba(255,255,255,0.95)'); sun.addColorStop(0.08, 'rgba(255,255,255,0.75)'); sun.addColorStop(0.1, 'rgba(255,255,255,0.3)'); sun.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sun; g.fillRect(0, 0, W, H);
    const ridges = [[0.6, '#6E6E6E', '#555555', 0.05], [0.7, '#474747', '#333333', 0.07], [0.82, '#2A2A2A', '#181818', 0.06]];
    ridges.forEach(([y0, c0, c1, a], i) => {
      const gr = g.createLinearGradient(0, H * y0, 0, H);
      gr.addColorStop(0, c0); gr.addColorStop(1, c1);
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) g.lineTo(x, H * (y0 + a * Math.sin(x / W * Math.PI * (1.3 + i * 0.7) + i * 1.9) + a * 0.4 * Math.sin(x / W * Math.PI * 4.1 + i)));
      g.lineTo(W, H);
      g.closePath();
      g.fill();
    });
    const sheen = g.createLinearGradient(0, 0, W * 0.6, H);
    sheen.addColorStop(0, 'rgba(255,255,255,0.06)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.015)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen; g.fillRect(0, 0, W, H);
  });
}

// ---------------- small helpers ----------------

// Every untextured mesh merged per material into one mesh (position + normal); textured and `keep` meshes move over as
// they are. src must sit at the origin.
function flatten(src, name) {
  const out = new THREE.Group();
  out.name = name;
  src.updateMatrixWorld(true);
  const buckets = new Map(), keep = [];
  src.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.map || o.userData.keep) { keep.push(o); return; }
    if (!buckets.has(o.material)) buckets.set(o.material, []);
    buckets.get(o.material).push([o.geometry, o.matrixWorld]);
  });
  for (const [mat, parts] of buckets) out.add(new THREE.Mesh(merge(parts), mat));
  for (const o of keep) {
    o.matrixWorld.decompose(o.position, o.quaternion, o.scale);
    o.removeFromParent();
    out.add(o);
  }
  return out;
}

function merge(parts) {
  const geos = parts.map(([g, m]) => {
    const x = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(x.attributes)) if (k !== 'position' && k !== 'normal') x.deleteAttribute(k);
    return x.applyMatrix4(m);
  });
  const n = geos.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o);
    nor.set(g.attributes.normal.array, o);
    o += g.attributes.position.count * 3;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

// Vertical strip along a closed outline [[x, z]...] (the rug's cut edge), facing outwards.
function edgeStrip(pts, h) {
  const pos = [], nor = [];
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % pts.length];
    const dx = bx - ax, dz = bz - az;
    if (Math.hypot(dx, dz) < 1e-6) continue;
    let nx = dz, nz = -dx;
    if (nx * ((ax + bx) / 2 - cx) + nz * ((az + bz) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
    const l = Math.hypot(nx, nz);
    nx /= l; nz /= l;
    const A0 = [ax, 0, az], A1 = [ax, h, az], B0 = [bx, 0, bz], B1 = [bx, h, bz];
    const tris = (-dz * nx + dx * nz) > 0 ? [A0, B0, B1, A0, B1, A1] : [A0, B1, B0, A0, A1, B1];
    for (const v of tris) { pos.push(...v); nor.push(nx, 0, nz); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return geo;
}

function roundRect(w, h, r) {
  const s = new THREE.Shape(), x = w / 2 - r, y = h / 2 - r;
  s.moveTo(-x, -h / 2);
  s.lineTo(x, -h / 2); s.absarc(x, -y, r, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, y); s.absarc(x, y, r, 0, Math.PI / 2, false);
  s.lineTo(-x, h / 2); s.absarc(-x, y, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -y); s.absarc(-x, -y, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

function roundRectPath(g, x, y, w, h, r) {
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function rot(cx, cz, lx, lz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [cx + lx * c + lz * s, cz - lx * s + lz * c];
}

function rect(cx, cz, w, d, yaw = 0) {
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([lx, lz]) => rot(cx, cz, lx, lz, yaw));
}

function circle(cx, cz, r, n) {
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * Math.PI * 2), cz + r * Math.sin(i / n * Math.PI * 2)]);
}

function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function canvasTex(w, h, draw) {
  const c = canvas(w, h);
  draw(c.getContext('2d', { willReadFrequently: true }), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
