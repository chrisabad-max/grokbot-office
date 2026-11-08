// Panel thumbnails (assets/blobs/lib/<shape>-<HEX>.png) from the SAME geometry the office draws: this script asks
// web/scene/blobgen.js (in headless Edge) for every shape in every app colour, saves each blob as a GLB, and
// build_blobs.py --lib-from renders them in the usual studio. No npm packages.
//
//   1. the office dev server must run (default http://localhost:8790, the page blobgen.html is used for its import map)
//   2. node assets/_src/blobs/export_lib.mjs [--url http://localhost:8790/scene/blobgen.html] [--out <dir>]
//   3. blender -b --factory-startup -P assets/_src/blobs/build_blobs.py -- --lib-from <dir>
//
// Keys: every look shape (web/scene/looks.js SHAPES) with no accessory, plus sphere_stem (the app's 14th avatar).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const URL_ = arg('--url', 'http://localhost:8790/scene/blobgen.html');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'blob-lib-glb')));
const EDGE = arg('--edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
fs.mkdirSync(OUT, { recursive: true });

const port = 9400 + Math.floor(Math.random() * 400);
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-lib-'));
const edge = spawn(EDGE, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `--user-data-dir=${udd}`,
  `--remote-debugging-port=${port}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
  await sleep(250);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* not up yet */ }
}
if (!wsUrl) throw new Error('Edge did not start');
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
};

await send('Page.navigate', { url: URL_ });
await sleep(4000);
const list = await evaluate(`(async () => {
  const { SHAPES } = await import('./looks.js');
  const { APP_COLORS } = await import('./blobgen.js');
  const keys = SHAPES.map((s) => [s, s, 'none']).concat([['sphere_stem', 'sphere', 'stem']]);
  return keys.flatMap(([key, shape, accessory]) => APP_COLORS.map((c) => ({ key, shape, accessory, color: c })));
})()`);
for (const it of list) {
  const b64 = await evaluate(`(async () => {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const { generateBlob } = await import('./blobgen.js');
    const blob = generateBlob(${JSON.stringify({ shape: it.shape, color: it.color, accessory: it.accessory, seed: 'lib' })});
    const buf = await new GLTFExporter().parseAsync(blob, { binary: true });
    let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  fs.writeFileSync(path.join(OUT, `${it.key}-${it.color.slice(1)}.glb`), Buffer.from(b64, 'base64'));
}
console.log(`${list.length} GLBs in ${OUT}`);
console.log(`next: blender -b --factory-startup -P assets/_src/blobs/build_blobs.py -- --lib-from "${OUT}"`);
ws.close();
edge.kill();
setTimeout(() => { try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* Edge still holds it */ } process.exit(0); }, 800);
