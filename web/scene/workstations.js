// Desk tops and workstation screens, added to the floor_open template (every level clones it).
// Tops are a shared near-white material so they stay lighter than the beige floor after the sun.
// About two thirds of the seats get a monitor (some dual); the rest keep a small laptop.
// The pattern is fixed, geometry and materials are shared, and nothing is named laptop_screen_
// except the laptops, so the working-glow pass still finds those and leaves the monitors alone.
import * as THREE from 'three';

const DESK_COUNT = 20;
// 0 laptop, 1 one monitor, 2 two monitors. 13 of 20 seats get a screen.
const KIND = [2, 0, 1, 1, 2, 0, 1, 0, 2, 1, 0, 1, 2, 0, 0, 1, 2, 1, 0, 1];
const REACH = 0.84;                 // metres from the seat empty to the stand, onto the table
const DESK_Y = 0.75;                // table top
const SCREEN_W = 0.44, SCREEN_H = 0.26, BEZEL = 0.011;
const DUAL_GAP = 0.05;

// Cool white plus a little emissive: the warm sun otherwise pulls a white top down into the beige floor.
const TOP = new THREE.MeshStandardMaterial({
  name: 'desk_top', color: 0xF4F7FA, emissive: 0x9BB4CC, emissiveIntensity: 0.55, roughness: 0.9, metalness: 0,
});
const BEZEL_MAT = new THREE.MeshStandardMaterial({ name: 'monitor_bezel', color: 0x1A1C1E, roughness: 0.5, metalness: 0.15 });
const STAND_MAT = new THREE.MeshStandardMaterial({ name: 'monitor_stand', color: 0x2A2C2E, roughness: 0.45, metalness: 0.2 });
const SCREEN_MAT = new THREE.MeshStandardMaterial({
  name: 'monitor_screen', color: 0x1A2744, emissive: 0x8FB4FF, emissiveIntensity: 0.28, roughness: 0.32, metalness: 0,
});
const LAPTOP_BODY = new THREE.MeshStandardMaterial({ name: 'laptop_body', color: 0xC8CCD0, roughness: 0.4, metalness: 0.55 });
const LAPTOP_LID = new THREE.MeshStandardMaterial({ name: 'laptop_lid', color: 0x2C2E30, roughness: 0.5, metalness: 0.1 });
const LAPTOP_SCREEN = () => new THREE.MeshStandardMaterial({
  name: 'night_screen', color: 0x14171B, emissive: 0x9FD0FF, emissiveIntensity: 0, roughness: 0.3,
});

const GEO = {
  bezel: new THREE.BoxGeometry(SCREEN_W + BEZEL * 2, SCREEN_H + BEZEL * 2, 0.012),
  screen: new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
  neck: new THREE.BoxGeometry(0.016, 0.07, 0.014),
  foot: new THREE.BoxGeometry(0.15, 0.01, 0.09),
  lapBase: new THREE.BoxGeometry(0.32, 0.012, 0.22),
  lapLid: new THREE.BoxGeometry(0.32, 0.2, 0.008),
  lapScreen: new THREE.PlaneGeometry(0.29, 0.17),
};
// Local offsets so one instance matrix places a whole monitor (origin on the desktop, screen facing +Z).
GEO.bezel.translate(0, 0.012 + 0.07 + SCREEN_H / 2, -0.004);
GEO.screen.translate(0, 0.012 + 0.07 + SCREEN_H / 2, 0.004);
GEO.neck.translate(0, 0.012 + 0.035, -0.01);
GEO.foot.translate(0, 0.005, -0.01);

function pad(n) { return String(n).padStart(2, '0'); }

/** White tops, then monitors and the laptops that remain. Safe to call once per floor template. */
export function dressWorkstations(open) {
  if (!open || open.getObjectByName('desk_monitors')) return;
  whitenTops(open);
  stripBuiltInLaptops(open);
  const desks = [];
  open.traverse((o) => {
    const m = /^desk_(\d{2})$/.exec(o.name);
    if (m) desks[Number(m[1])] = o;
  });
  if (!desks[1]) return;

  const monitors = [];
  const laptops = [];
  const dummy = new THREE.Object3D();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  for (let n = 1; n <= DESK_COUNT; n++) {
    const desk = desks[n];
    if (!desk) continue;
    forward.set(0, 0, 1).applyQuaternion(desk.quaternion);
    right.set(1, 0, 0).applyQuaternion(desk.quaternion);
    const at = desk.position.clone().addScaledVector(forward, REACH);
    at.y = DESK_Y;
    dummy.position.copy(at);
    dummy.lookAt(desk.position.x, at.y, desk.position.z);
    dummy.rotateY(Math.PI);
    dummy.updateMatrix();
    const kind = KIND[n - 1];
    if (kind === 0) laptops.push({ n, matrix: dummy.matrix.clone() });
    else {
      const offs = kind === 2 ? [-(SCREEN_W + DUAL_GAP) / 2, (SCREEN_W + DUAL_GAP) / 2] : [0];
      for (const off of offs) {
        const m = dummy.matrix.clone();
        m.multiply(new THREE.Matrix4().makeTranslation(off, 0, 0));
        monitors.push(m);
      }
    }
  }
  if (monitors.length) addInstanced(open, 'desk_monitors', monitors);
  for (const lap of laptops) addLaptop(open, lap.n, lap.matrix);
}

function whitenTops(open) {
  // The GLB groups each table's top and legs as two meshes under a node named table_N.
  open.traverse((o) => {
    if (!o.isMesh) return;
    const named = /^table_\d+$/.test(o.name) || (o.parent && /^table_\d+$/.test(o.parent.name));
    if (!named) return;
    const list = [].concat(o.material);
    o.material = list.length === 1 ? swapOak(list[0]) : list.map(swapOak);
  });
}
function swapOak(m) { return m && m.name === 'oak' ? TOP : m; }

function stripBuiltInLaptops(open) {
  const drop = [];
  open.traverse((o) => {
    if (o.name === 'laptops' || /^laptop_screen_\d\d$/.test(o.name)) drop.push(o);
  });
  for (const o of drop) {
    let top = o;
    while (top.parent && top.parent !== open) top = top.parent;
    top.removeFromParent();
  }
}

function addInstanced(open, name, matrices) {
  const group = new THREE.Group();
  group.name = name;
  const parts = [
    [GEO.bezel, BEZEL_MAT],
    [GEO.screen, SCREEN_MAT],
    [GEO.neck, STAND_MAT],
    [GEO.foot, STAND_MAT],
  ];
  for (const [geo, mat] of parts) {
    const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
    mesh.name = name;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  open.add(group);
}

function addLaptop(open, n, matrix) {
  const g = new THREE.Group();
  g.name = `laptop_${pad(n)}`;
  g.applyMatrix4(matrix);
  const base = new THREE.Mesh(GEO.lapBase, LAPTOP_BODY);
  base.position.set(0, 0.006, 0.02);
  base.castShadow = true;
  g.add(base);
  const lid = new THREE.Group();
  lid.position.set(0, 0.012, -0.09);
  lid.rotation.x = -1.05;
  const shell = new THREE.Mesh(GEO.lapLid, LAPTOP_LID);
  shell.position.y = 0.1;
  shell.castShadow = true;
  lid.add(shell);
  const scr = new THREE.Mesh(GEO.lapScreen, LAPTOP_SCREEN());
  scr.name = `laptop_screen_${pad(n)}`;
  scr.position.set(0, 0.1, 0.005);
  lid.add(scr);
  g.add(lid);
  open.add(g);
}
