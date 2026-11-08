// Re-encodes the office's baked JPEG textures (embedded in assets/office/office.glb, plus assets/office/night/*.jpg)
// with ffmpeg at -q:v 3. Blender writes them at quality 88-90 without optimised tables: the same pixels come out at
// about 40 % of the bytes, ~50 dB PSNR against Blender's file (invisible on soft baked light). Run it after every
// build_building.py export:   node assets/_src/office/shrink_textures.mjs
// Needs ffmpeg on PATH, nothing else. A texture is only replaced when it gets at least 10 % smaller, so a second run
// changes nothing (no generation loss from repeated runs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OFFICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../office');
const GAIN = 0.9;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-'));

function reencode(jpeg) {
  const a = path.join(tmp, 'in.jpg'), b = path.join(tmp, 'out.jpg');
  fs.writeFileSync(a, jpeg);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', a, '-q:v', '3', b]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
  const out = fs.readFileSync(b);
  return out.length < jpeg.length * GAIN ? out : null;
}

function shrinkGlb(file) {
  const src = fs.readFileSync(file);
  const jsonLen = src.readUInt32LE(12);
  const j = JSON.parse(src.subarray(20, 20 + jsonLen).toString('utf8'));
  const binAt = 20 + jsonLen + 8;
  const bin = src.subarray(binAt, binAt + src.readUInt32LE(20 + jsonLen));
  const parts = [];
  let offset = 0, changed = 0;
  j.bufferViews = j.bufferViews.map((v, i) => {
    let data = bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    const img = (j.images || []).find((im) => im.bufferView === i);
    if (img && img.mimeType === 'image/jpeg') {
      const out = reencode(data);
      if (out) { console.log(`  ${img.name}: ${data.length} -> ${out.length}`); data = out; changed++; }
    }
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
    const nv = { ...v, byteOffset: offset, byteLength: data.length };
    if (!offset) delete nv.byteOffset;
    parts.push(data);
    offset += data.length;
    return nv;
  });
  if (!changed) { console.log(`${path.basename(file)}: nothing to shrink`); return; }
  parts.push(Buffer.alloc((4 - (offset % 4)) % 4));
  const binOut = Buffer.concat(parts);
  j.buffers = [{ ...j.buffers[0], byteLength: binOut.length }];
  let json = Buffer.from(JSON.stringify(j), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + json.length + 8 + binOut.length, 8);
  head.writeUInt32LE(json.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binOut.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  const out = Buffer.concat([head, json, binHead, binOut]);
  fs.writeFileSync(file, out);
  console.log(`${path.basename(file)}: ${src.length} -> ${out.length} bytes`);
}

shrinkGlb(path.join(OFFICE, 'office.glb'));
const night = path.join(OFFICE, 'night');
for (const name of fs.existsSync(night) ? fs.readdirSync(night).filter((n) => n.endsWith('.jpg')) : []) {
  const f = path.join(night, name), src = fs.readFileSync(f), out = reencode(src);
  if (out) { fs.writeFileSync(f, out); console.log(`night/${name}: ${src.length} -> ${out.length}`); }
  else console.log(`night/${name}: nothing to shrink`);
}
fs.rmSync(tmp, { recursive: true, force: true });
