// Loads the building templates (CONTRACT v2.4) from assets/office/office.glb and reads the
// desk/screen/lounge/lamp empties. v2 is detected by the node `floor_open`; if it is missing (v1 file) or the
// load fails, a procedural placeholder that follows the same contract is built in code.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildFloorStyles } from './floorstyle.js';

export const DESK_COUNT = 20;
export const LOUNGE_COUNT = 6;
export const SLAB = 0.36;
export const FLOOR_STEP = 1.6;
export const OPEN_H = 2.7;
export const SHAFT_POS = new THREE.Vector2(9.05, -2.6);
const SPOT_RE = /^(desk|screen|lounge)_(\d{2})$/;
const LAMP_RE = /^lamp_(\d{2})$/;
const NAMES = ['floor_open', 'floor_closed', 'roof', 'elevator_shaft', 'elevator_cabin'];

export async function loadOfficeAssets(baseUrl) {
  let glb = null;
  try {
    if (new URLSearchParams(location.search).get('placeholder') === '1') throw new Error('?placeholder=1');   // test switch
    const gltf = await Promise.race([
      new GLTFLoader().loadAsync(`${baseUrl}/office.glb`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
    ]);
    gltf.scene.updateMatrixWorld(true);
    if (gltf.scene.getObjectByName('floor_open')) glb = gltf.scene;
    else console.info('[office] office.glb has no floor_open (v1 file): using the procedural v2 placeholder');
  } catch (err) {
    console.warn('[office] office.glb failed to load, using the procedural placeholder:', err.message);
  }

  const ph = (!glb || NAMES.some((n) => !glb.getObjectByName(n))) ? buildPlaceholder() : null;
  const templates = {};
  const missing = [];
  for (const n of NAMES) {
    const node = glb && glb.getObjectByName(n);
    if (node) templates[n] = node;
    else { templates[n] = ph.templates[n]; missing.push(n); }
  }
  if (glb) {
    for (const n of NAMES) if (!missing.includes(n)) prepareGlbMaterials(templates[n]);
    if (missing.length) console.warn('[office] placeholder used for missing nodes:', missing.join(', '));
  }

  const spots = collectSpots(templates.floor_open);
  if (spots.desks.filter(Boolean).length < DESK_COUNT) {
    console.warn('[office] floor_open has fewer than 20 desk_NN empties: using placeholder floor_open');
    const p = ph || buildPlaceholder();
    templates.floor_open = p.templates.floor_open;
    return finish(templates, collectSpots(templates.floor_open), p.nightMaps, 'placeholder');
  }
  return finish(templates, spots, ph ? ph.nightMaps : new Map(), glb ? (missing.length ? 'glb+placeholder' : 'glb') : 'placeholder');
}

// Per-floor accent + lounge corners (floorstyle.js) are added to the template here, after the spots are read. They need
// the GLB lounge; the placeholder floor keeps one look (style = null).
function finish(templates, spots, nightMaps, source) {
  let style = null;
  try {
    if (new URLSearchParams(location.search).get('floorstyle') !== '0') style = buildFloorStyles(templates.floor_open, spots.lounges);   // test switch: ?floorstyle=0
  } catch (err) {
    console.warn('[office] floor styles skipped:', err.message);
  }
  return { templates, spots, nightMaps, source, style };
}

// Baked surfaces are unlit: day lightmap as a basic material (night map is mixed in by the instance patch).
function prepareGlbMaterials(root) {
  const done = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const baked = bakedName(o);
    if (!baked) return;
    o.userData.bakedName = baked;
    const src = o.material;
    if (!done.has(src)) {
      const map = src.map || src.emissiveMap || src.lightMap || null;
      if (map) map.colorSpace = THREE.SRGBColorSpace;
      done.set(src, new THREE.MeshBasicMaterial({ map, color: map ? 0xffffff : src.color, name: src.name }));
    }
    o.material = done.get(src);
  });
}

export function bakedName(o) {
  for (let n = o; n; n = n.parent) if (n.name && n.name.startsWith('baked_')) return n.name;
  return null;
}

// Spots in the local space of the floor_open node.
function collectSpots(root) {
  const spots = { desks: [], screens: [], lounges: [], lamps: [] };
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), sc = new THREE.Vector3(), fwd = new THREE.Vector3();
  root.traverse((o) => {
    const s = SPOT_RE.exec(o.name), l = LAMP_RE.exec(o.name);
    if (!s && !l) return;
    m.multiplyMatrices(inv, o.matrixWorld).decompose(pos, quat, sc);
    if (l) { spots.lamps[Number(l[1]) - 1] = pos.clone(); return; }
    fwd.set(0, 0, 1).applyQuaternion(quat);
    const spot = { pos: pos.clone(), yaw: Math.atan2(fwd.x, fwd.z) };
    (s[1] === 'desk' ? spots.desks : s[1] === 'screen' ? spots.screens : spots.lounges)[Number(s[2]) - 1] = spot;
  });
  return spots;
}

// =====================================================================================
// Procedural v2 placeholder (same node names / materials as the contract)
// =====================================================================================

const SEAT_Y = 0.42;
const TABLE_Z = [-3.4, 0.8];
const PAIR_X = [-5.7, -3.9, -2.1, -0.3, 1.5];
const TABLE_X = -2.1, TABLE_LEN = 8.8, TABLE_W = 1.1;
const PENDANTS = [[-5.0, -3.4], [-2.1, -3.4], [0.8, -3.4], [-5.0, 0.8], [-2.1, 0.8], [0.8, 0.8]];

function stdMat(color, roughness = 0.7, metalness = 0, name = '') {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, name });
}

function addBox(parent, mat, w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function addCyl(parent, mat, rt, rb, h, x, y, z, seg = 28) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function empty(parent, name, x, y, z, yaw = 0) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  o.rotation.y = yaw;
  parent.add(o);
  return o;
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function buildPlaceholder() {
  const M = {
    white: stdMat(0xF4F3F0, 0.8), oak: stdMat(0xC9A57C, 0.6), black: stdMat(0x1C1C1E, 0.45, 0.3),
    fabric: stdMat(0xDAD6CF, 1), laptop: stdMat(0xC9CCD0, 0.35, 0.75),
    sofa: stdMat(0xCDC9C1, 0.95), armchair: stdMat(0x3A3A3E, 0.8), pot: stdMat(0xF6F5F2, 0.55),
    leaf1: stdMat(0x3C7B47, 0.75), leaf2: stdMat(0x5A9A58, 0.75), leaf3: stdMat(0x2F6A3E, 0.75), trunk: stdMat(0x6B4F3A, 0.8),
    mug: stdMat(0xFFFFFF, 0.4), counter: stdMat(0xEAE7E1, 0.6),
    glass: new THREE.MeshStandardMaterial({ color: 0xD6E4EE, roughness: 0.05, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }),
    shaftGlass: new THREE.MeshStandardMaterial({ color: 0xD6E4EE, roughness: 0.05, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
  };
  const lampMat = () => new THREE.MeshStandardMaterial({ name: 'night_lamp', color: 0x2A2724, emissive: 0xFFC070, emissiveIntensity: 0, roughness: 0.5 });
  const screenMat = () => new THREE.MeshStandardMaterial({ name: 'night_screen', color: 0x14171B, emissive: 0x9FD0FF, emissiveIntensity: 0, roughness: 0.3 });

  const nightMaps = new Map();
  const templates = {};

  // ---------------- floor_open ----------------
  const open = new THREE.Group();
  open.name = 'floor_open';
  templates.floor_open = open;
  addBox(open, M.white, 16.4, SLAB, 12.4, 0, -SLAB / 2, 0).name = 'slab';

  const floorTex = bakeFloor();
  nightMaps.set('baked_floor', floorTex.night);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: floorTex.day, name: 'baked_floor' }));
  floor.name = 'baked_floor';
  floor.position.y = 0.002;
  open.add(floor);

  // left wall (solid white) with a baked plane on its inner face
  addBox(open, M.white, 0.2, 2.7, 12.4, -8.1, 1.35, 0);
  const wallTex = bakeWall();
  nightMaps.set('baked_wall_left', wallTex.night);
  const wallL = new THREE.Mesh(new THREE.PlaneGeometry(12, 2.7).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({ map: wallTex.day, name: 'baked_wall_left' }));
  wallL.name = 'baked_wall_left';
  wallL.position.set(-7.995, 1.35, 0);
  open.add(wallL);

  // glass curtain wall at the back with slim black mullions
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(16, 2.7), M.glass);
  glass.position.set(0, 1.35, -6);
  open.add(glass);
  for (let x = -8; x <= 8.001; x += 2) addBox(open, M.black, 0.07, 2.7, 0.08, x, 1.35, -6);
  addBox(open, M.black, 16.2, 0.07, 0.1, 0, 2.7, -6);
  addBox(open, M.black, 16, 0.08, 0.1, 0, 0.04, -6);

  // wall screen + task board on the left wall (UV 0..1 upright, facing +X)
  const mkWallQuad = (name, w, h, z, y) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x15171B, name }));
    m.name = name;
    m.position.set(-7.96, y, z);
    open.add(m);
    return m;
  };
  mkWallQuad('wall_screen', 2.6, 1.46, -4.3, 1.5);
  mkWallQuad('task_board', 3.0, 1.5, 0.1, 1.45);
  for (const [w, h, z, y] of [[2.68, 1.54, -4.3, 1.5], [3.08, 1.58, 0.1, 1.45]]) addBox(open, M.black, 0.03, h, w, -7.985, y, z);

  // two long oak communal tables, 5 poufs per side
  const lap = [];
  for (let t = 0; t < 2; t++) {
    const z0 = TABLE_Z[t];
    addBox(open, M.oak, TABLE_LEN, 0.05, TABLE_W, TABLE_X, 0.725, z0);
    for (const lx of [-4.1, -1.4, 1.4, 4.1]) for (const s of [-1, 1]) addBox(open, M.black, 0.05, 0.7, 0.05, TABLE_X + lx, 0.35, z0 + s * 0.48);
    for (const lx of [-4.1, 4.1]) addBox(open, M.black, 0.04, 0.04, 0.96, TABLE_X + lx, 0.1, z0);
    for (let i = 0; i < 10; i++) {
      const n = t * 10 + i + 1;
      const pair = Math.floor(i / 2), far = i % 2 === 0;
      const x = PAIR_X[pair], sz = far ? -1 : 1;
      addCyl(open, M.fabric, 0.26, 0.29, SEAT_Y, x, SEAT_Y / 2, z0 + sz * 1.05);
      empty(open, `desk_${String(n).padStart(2, '0')}`, x, SEAT_Y, z0 + sz * 1.05, far ? 0 : Math.PI);
      // laptop on the table, screen facing the seat
      const g = new THREE.Group();
      g.position.set(x, 0.75, z0 + sz * 0.3);
      g.rotation.y = far ? Math.PI : 0;
      addBox(g, M.laptop, 0.32, 0.012, 0.22, 0, 0.006, 0);
      const lid = new THREE.Group();
      lid.position.set(0, 0.012, -0.11);
      lid.rotation.x = -0.3;
      addBox(lid, M.laptop, 0.32, 0.21, 0.008, 0, 0.105, 0);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.29, 0.18), screenMat());
      scr.name = `laptop_screen_${String(n).padStart(2, '0')}`;
      scr.position.set(0, 0.105, 0.0045);
      lid.add(scr);
      g.add(lid);
      open.add(g);
      lap.push([n, scr, far]);
      if (i % 3 === 1) addCyl(open, M.mug, 0.04, 0.035, 0.09, x + 0.38, 0.795, z0 + sz * 0.1, 14);
    }
  }
  open.updateMatrixWorld(true);
  for (const [n, scr] of lap) {
    const p = scr.getWorldPosition(new THREE.Vector3());
    const q = scr.getWorldQuaternion(new THREE.Quaternion());
    const e = empty(open, `screen_${String(n).padStart(2, '0')}`, p.x, p.y, p.z);
    e.quaternion.copy(q);
  }

  // pendant lamps
  PENDANTS.forEach(([x, z], i) => {
    const g = new THREE.Group();
    g.position.set(x, 2.05, z);
    addCyl(g, M.black, 0.09, 0.2, 0.2, 0, 0.06, 0, 24);
    addCyl(g, M.black, 0.008, 0.008, 0.9, 0, 0.6, 0, 6);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), lampMat());
    bulb.position.y = -0.07;
    g.add(bulb);
    open.add(g);
    empty(open, `lamp_${String(i + 1).padStart(2, '0')}`, x, 1.95, z);
  });

  // lounge: block sofa, 2 armchairs, round oak coffee table, bar with a stool
  addBox(open, M.sofa, 2.7, 0.42, 0.95, 5.9, 0.21, 0.05);
  addBox(open, M.sofa, 2.7, 0.52, 0.24, 5.9, 0.68, -0.36);
  for (const s of [-1, 1]) addBox(open, M.sofa, 0.26, 0.62, 0.95, 5.9 + s * 1.22, 0.31 + 0.1, 0.05);
  for (let i = 0; i < 3; i++) addBox(open, M.sofa, 0.8, 0.1, 0.66, 5.05 + i * 0.85, 0.47, 0.12);
  [[5.05, 0], [5.9, 1], [6.75, 2]].forEach(([x], i) => empty(open, `lounge_0${i + 1}`, x, 0.52, 0.12, 0));
  const chair = (x, yaw, name) => {
    const g = new THREE.Group();
    g.position.set(x, 0, 2.1);
    g.rotation.y = yaw;
    addBox(g, M.armchair, 0.9, 0.38, 0.9, 0, 0.19, 0);
    addBox(g, M.armchair, 0.2, 0.55, 0.9, -0.35, 0.55, 0);
    for (const s of [-1, 1]) addBox(g, M.armchair, 0.9, 0.2, 0.14, 0, 0.5, s * 0.38);
    open.add(g);
    empty(open, name, x, 0.42, 2.1, yaw);
  };
  chair(4.15, Math.PI / 2, 'lounge_04');
  chair(7.65, -Math.PI / 2, 'lounge_05');
  addCyl(open, M.oak, 0.6, 0.6, 0.04, 5.9, 0.38, 2.1, 40);
  addCyl(open, M.black, 0.04, 0.04, 0.36, 5.9, 0.18, 2.1, 10);
  addBox(open, M.counter, 3.6, 1.0, 0.6, 6.0, 0.5, -5.6);
  addBox(open, M.oak, 3.7, 0.05, 0.7, 6.0, 1.025, -5.6);
  addBox(open, M.black, 0.4, 0.4, 0.3, 4.9, 1.25, -5.7);
  addCyl(open, M.mug, 0.04, 0.035, 0.09, 5.5, 1.095, -5.5, 14);
  addCyl(open, M.mug, 0.04, 0.035, 0.09, 5.65, 1.095, -5.45, 14);
  addCyl(open, M.black, 0.2, 0.2, 0.05, 6.1, 0.66, -4.8, 20);
  addCyl(open, M.black, 0.03, 0.03, 0.64, 6.1, 0.33, -4.8, 8);
  empty(open, 'lounge_06', 6.1, 0.68, -4.8, 0);

  // trees in white pots
  const tree = (x, z, s) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(s);
    addCyl(g, M.pot, 0.3, 0.22, 0.6, 0, 0.3, 0);
    addCyl(g, M.trunk, 0.04, 0.05, 0.9, 0, 0.9, 0, 8);
    [[0, 1.55, 0, 0.5, M.leaf1], [0.3, 1.35, 0.15, 0.36, M.leaf2], [-0.28, 1.4, -0.12, 0.34, M.leaf3], [0.05, 1.95, 0.05, 0.34, M.leaf2]].forEach(([lx, ly, lz, r, m]) => {
      const l = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), m);
      l.position.set(lx, ly, lz);
      g.add(l);
    });
    open.add(g);
  };
  tree(-7.2, 5.2, 1.25);
  tree(7.6, -3.4, 1.0);
  tree(7.5, 5.0, 1.2);

  // ---------------- floor_closed ----------------
  const closed = new THREE.Group();
  closed.name = 'floor_closed';
  templates.floor_closed = closed;
  addBox(closed, M.white, 16.4, SLAB, 12.4, 0, -SLAB / 2, 0);
  const wt = bakeWindows();
  const windowsMat = new THREE.MeshStandardMaterial({
    name: 'night_windows', map: wt.diffuse, emissiveMap: wt.emissive, emissive: 0xFFFFFF, emissiveIntensity: 0,
    roughness: 0.22, metalness: 0.25,
  });
  wt.diffuse.wrapS = wt.emissive.wrapS = THREE.RepeatWrapping;
  const faces = [[0, 6.2, 0, 16.4], [Math.PI, -6.2, 0, 16.4], [Math.PI / 2, 0, 8.2, 12.4], [-Math.PI / 2, 0, -8.2, 12.4]];
  faces.forEach(([ry, z, x, w], i) => {
    const geo = new THREE.PlaneGeometry(w, 1.24);
    const uv = geo.attributes.uv, off = (i * 0.29) % 1;
    for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * (w / 25.6) + off);
    const m = new THREE.Mesh(geo, windowsMat);
    m.rotation.y = ry;
    m.position.set(ry === Math.PI / 2 ? 8.2 : ry === -Math.PI / 2 ? -8.2 : 0, 0.62, z);
    closed.add(m);
  });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) addBox(closed, M.counter, 0.12, 1.24, 0.12, sx * 8.2, 0.62, sz * 6.2);

  // ---------------- roof ----------------
  const roof = new THREE.Group();
  roof.name = 'roof';
  templates.roof = roof;
  addBox(roof, M.white, 16.4, SLAB, 12.4, 0, SLAB / 2, 0);
  for (const [w, d, x, z] of [[16.4, 0.16, 0, 6.12], [16.4, 0.16, 0, -6.12], [0.16, 12.4, 8.12, 0], [0.16, 12.4, -8.12, 0]]) addBox(roof, M.white, w, 0.34, d, x, SLAB + 0.17, z);
  for (const [w, h, d, x, z] of [[1.6, 0.8, 1.1, -4, -2], [1.6, 0.8, 1.1, -1.8, -2], [1.2, 0.6, 1.2, 4, 2.5], [2.2, 1.6, 2.0, 5.5, -3.5]]) {
    addBox(roof, M.counter, w, h, d, x, SLAB + h / 2, z);
    addBox(roof, M.black, w * 0.8, 0.05, d * 0.8, x, SLAB + h + 0.02, z);
  }

  // ---------------- elevator ----------------
  const shaft = new THREE.Group();
  shaft.name = 'elevator_shaft';
  shaft.position.set(SHAFT_POS.x, 0, SHAFT_POS.y);
  templates.elevator_shaft = shaft;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) addBox(shaft, M.black, 0.06, 1, 0.06, sx * 0.72, 0.5, sz * 0.72);
  for (const [ry, x, z] of [[0, 0, 0.72], [Math.PI, 0, -0.72], [Math.PI / 2, 0.72, 0], [-Math.PI / 2, -0.72, 0]]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.44, 1), M.shaftGlass);
    p.rotation.y = ry; p.position.set(x, 0.5, z);
    shaft.add(p);
  }

  const cabin = new THREE.Group();
  cabin.name = 'elevator_cabin';
  cabin.position.set(SHAFT_POS.x, 0, SHAFT_POS.y);
  templates.elevator_cabin = cabin;
  addBox(cabin, M.counter, 1.3, 0.06, 1.3, 0, 0.03, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) addBox(cabin, M.black, 0.05, 2.2, 0.05, sx * 0.625, 1.1, sz * 0.625);
  for (const [w, d, x, z] of [[1.3, 0.05, 0, 0.625], [1.3, 0.05, 0, -0.625], [0.05, 1.3, 0.625, 0], [0.05, 1.3, -0.625, 0]]) addBox(cabin, M.black, w, 0.05, d, x, 2.175, z);
  for (const [ry, x, z] of [[0, 0, 0.625], [Math.PI, 0, -0.625], [Math.PI / 2, 0.625, 0], [-Math.PI / 2, -0.625, 0]]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 2.1), M.shaftGlass);
    p.rotation.y = ry; p.position.set(x, 1.1, z);
    cabin.add(p);
  }

  for (const n of NAMES) templates[n].traverse((o) => { if (o.isMesh && !o.userData.bakedName && /^baked_/.test(o.name)) o.userData.bakedName = o.name; });
  return { templates, nightMaps };
}

// ---------------- procedural baked textures (day + night) for the placeholder ----------------

const PX = 100;                                    // texture pixels per meter on the floor
const fx = (x) => (x + 8) * PX, fz = (z) => (z + 6) * PX;

function bakeFloor() {
  const W = 16 * PX, H = 12 * PX;
  const shadows = [];                              // [kind, x, z, w, d] in meters
  for (const z0 of TABLE_Z) {
    shadows.push(['rect', TABLE_X, z0, TABLE_LEN + 0.2, TABLE_W + 0.1]);
    for (let i = 0; i < 10; i++) shadows.push(['circle', PAIR_X[Math.floor(i / 2)], z0 + (i % 2 ? 1.05 : -1.05), 0.3, 0.3]);
  }
  shadows.push(['rect', 5.9, 0.05, 2.9, 1.0], ['rect', 4.15, 2.1, 0.95, 0.95], ['rect', 7.65, 2.1, 0.95, 0.95], ['circle', 5.9, 2.1, 0.62, 0.62],
    ['rect', 6.0, -5.6, 3.7, 0.7], ['circle', -7.2, 5.2, 0.4, 0.4], ['circle', 7.6, -3.4, 0.35, 0.35], ['circle', 7.5, 5.0, 0.4, 0.4]);

  const day = canvasTex(W, H, (g) => {
    g.fillStyle = '#F0ECE5'; g.fillRect(0, 0, W, H);
    let grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#E9E4DC'); grad.addColorStop(1, '#F6F3EE');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    // rug
    g.fillStyle = '#DDD9D0'; g.beginPath(); g.arc(fx(5.9), fz(1.3), 2.25 * PX, 0, 7); g.fill();
    g.fillStyle = '#E6E2DA'; g.beginPath(); g.arc(fx(5.9), fz(1.3), 1.75 * PX, 0, 7); g.fill();
    // sun coming through the curtain wall: warm slanted patches across the floor
    g.save(); g.filter = 'blur(18px)';
    for (let x = -8; x < 8; x += 2) {
      g.fillStyle = 'rgba(255,250,238,0.55)';
      g.beginPath();
      g.moveTo(fx(x + 0.15), fz(-6)); g.lineTo(fx(x + 1.85), fz(-6));
      g.lineTo(fx(x + 1.85 + 5.2), fz(-6 + 3.9)); g.lineTo(fx(x + 0.15 + 5.2), fz(-6 + 3.9));
      g.fill();
    }
    g.restore();
    softShadows(g, shadows, 'rgba(70,62,52,0.30)', 0.45, 0.55, 14);
    softShadows(g, shadows, 'rgba(60,52,44,0.28)', 0, 0, 5);
    const ao = g.createLinearGradient(0, 0, 130, 0); ao.addColorStop(0, 'rgba(90,80,70,0.30)'); ao.addColorStop(1, 'rgba(90,80,70,0)');
    g.fillStyle = ao; g.fillRect(0, 0, 130, H);
    const ao2 = g.createLinearGradient(0, 0, 0, 90); ao2.addColorStop(0, 'rgba(90,80,70,0.18)'); ao2.addColorStop(1, 'rgba(90,80,70,0)');
    g.fillStyle = ao2; g.fillRect(0, 0, W, 90);
  });

  const night = canvasTex(W, H, (g) => {
    g.fillStyle = '#222A3E'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#2A3248'; g.beginPath(); g.arc(fx(5.9), fz(1.3), 2.25 * PX, 0, 7); g.fill();
    g.save(); g.filter = 'blur(26px)';
    for (let x = -8; x < 8; x += 2) {
      g.fillStyle = 'rgba(120,150,230,0.10)';
      g.beginPath();
      g.moveTo(fx(x + 0.15), fz(-6)); g.lineTo(fx(x + 1.85), fz(-6));
      g.lineTo(fx(x + 1.85 + 5.2), fz(-6 + 3.9)); g.lineTo(fx(x + 0.15 + 5.2), fz(-6 + 3.9));
      g.fill();
    }
    g.restore();
    // warm pools under the pendants and the lounge
    for (const [x, z] of PENDANTS.concat([[5.9, 1.2]])) {
      const r = 2.3 * PX, p = g.createRadialGradient(fx(x + 0.3), fz(z + 0.4), 0, fx(x + 0.3), fz(z + 0.4), r);
      p.addColorStop(0, 'rgba(255,196,130,0.5)'); p.addColorStop(1, 'rgba(255,196,130,0)');
      g.fillStyle = p; g.fillRect(fx(x + 0.3) - r, fz(z + 0.4) - r, r * 2, r * 2);
    }
    softShadows(g, shadows, 'rgba(5,7,14,0.55)', 0.35, 0.45, 12);
    const ao = g.createLinearGradient(0, 0, 130, 0); ao.addColorStop(0, 'rgba(0,0,0,0.45)'); ao.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = ao; g.fillRect(0, 0, 130, H);
  });
  return { day, night };
}

function softShadows(g, list, color, dx, dz, blur) {
  g.save();
  g.filter = `blur(${blur}px)`;
  g.fillStyle = color;
  for (const [kind, x, z, w, d] of list) {
    if (kind === 'rect') g.fillRect(fx(x + dx - w / 2), fz(z + dz - d / 2), w * PX, d * PX);
    else { g.beginPath(); g.ellipse(fx(x + dx), fz(z + dz), w * PX, d * PX, 0, 0, 7); g.fill(); }
  }
  g.restore();
}

function bakeWall() {
  const W = 1200, H = 270;
  const day = canvasTex(W, H, (g) => {
    let grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#F7F6F3'); grad.addColorStop(0.7, '#F2F0EC'); grad.addColorStop(1, '#E2DFD9');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    const c = g.createLinearGradient(W - 140, 0, W, 0); c.addColorStop(0, 'rgba(120,110,100,0)'); c.addColorStop(1, 'rgba(120,110,100,0.22)');
    g.fillStyle = c; g.fillRect(W - 140, 0, 140, H);
  });
  const night = canvasTex(W, H, (g) => {
    let grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#242A3A'); grad.addColorStop(0.7, '#2A2F3E'); grad.addColorStop(1, '#161A26');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    for (const px of [300, 700]) {
      const r = g.createRadialGradient(px, 120, 0, px, 120, 320); r.addColorStop(0, 'rgba(255,190,120,0.16)'); r.addColorStop(1, 'rgba(255,190,120,0)');
      g.fillStyle = r; g.fillRect(px - 320, 0, 640, H);
    }
  });
  return { day, night };
}

function bakeWindows() {
  const PW = 64, N = 16, H = 64;
  const rnd = mulberry(7);
  const diffuse = canvasTex(PW * N, H, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#9AA7B5'); grad.addColorStop(0.5, '#6E7C8C'); grad.addColorStop(1, '#58687A');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = '#E8EAED';
    for (let i = 0; i <= N; i++) g.fillRect(i * PW - 2, 0, 4, h);
    g.fillRect(0, 0, w, 4); g.fillRect(0, h - 5, w, 5); g.fillRect(0, h * 0.55, w, 2);
  });
  const emissive = canvasTex(PW * N, H, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < N; i++) {
      if (rnd() > 0.42) continue;
      const k = 0.45 + rnd() * 0.35;
      g.fillStyle = `rgb(${Math.round(255 * k)},${Math.round(196 * k)},${Math.round(120 * k)})`;
      g.fillRect(i * PW + 5, 8, PW - 10, h * 0.55 - 10);
      g.fillRect(i * PW + 5, h * 0.55 + 5, PW - 10, h * 0.45 - 14);
    }
  });
  return { diffuse, emissive };
}

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
