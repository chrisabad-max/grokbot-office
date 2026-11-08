import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../journal.js';

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bothq-journal-'));
  const file = path.join(dir, 'events.jsonl');
  const got = [];
  const infos = [];
  const j = new Journal(file, { ...opts, onRecords: (r, info) => { got.push(...r); infos.push(info); } });
  const cleanup = () => { j.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, file, got, infos, j, cleanup };
}

test('partial last line is buffered until its newline arrives', () => {
  const { file, got, j, cleanup } = setup();
  try {
    fs.writeFileSync(file, '{"bot":"A","status":"working"}\n{"bot":"B","sta');
    j.start({ watch: false });
    assert.equal(got.length, 1);
    fs.appendFileSync(file, 'tus":"idle"}');
    j.poll();
    assert.equal(got.length, 1, 'still incomplete');
    fs.appendFileSync(file, '\n{"bot":"C"}\n');
    j.poll();
    assert.deepEqual(got.map((r) => r.bot), ['A', 'B', 'C']);
    assert.equal(got[1].status, 'idle');
    assert.equal(j.stats.parse_errors, 0);
  } finally { cleanup(); }
});

test('multi-byte UTF-8 split across reads survives', () => {
  const { file, got, j, cleanup } = setup();
  try {
    const bytes = Buffer.from('{"bot":"Тренды","step":"привет мир"}\n');
    const cut = bytes.indexOf(Buffer.from('р')) + 1; // in the middle of a 2-byte char
    fs.writeFileSync(file, bytes.subarray(0, cut));
    j.start({ watch: false });
    fs.appendFileSync(file, bytes.subarray(cut));
    j.poll();
    assert.equal(got.length, 1);
    assert.equal(got[0].bot, 'Тренды');
    assert.equal(got[0].step, 'привет мир');
  } finally { cleanup(); }
});

test('garbage: non-JSON, non-objects, blank lines, CRLF, BOM', () => {
  const { file, got, j, cleanup } = setup();
  try {
    fs.writeFileSync(file, [
      'this is not json',
      '{"broken": ',
      '[1,2,3]',
      '42',
      '',
      '   ',
      '﻿{"bot":"A"}\r',
      '{"bot":"B"}',
      '',
    ].join('\n'));
    j.start({ watch: false });
    assert.deepEqual(got.map((r) => r.bot), ['A', 'B']);
    assert.equal(j.stats.parse_errors, 4);
  } finally { cleanup(); }
});

test('lines over 4 KB are ignored, also when they arrive in pieces', () => {
  const { file, got, j, cleanup } = setup();
  try {
    const big = JSON.stringify({ bot: 'BIG', step: 'x'.repeat(5000) });
    fs.writeFileSync(file, `{"bot":"A"}\n${big}\n{"bot":"B"}\n`);
    j.start({ watch: false });
    assert.deepEqual(got.map((r) => r.bot), ['A', 'B']);
    assert.equal(j.stats.too_long, 1);

    fs.appendFileSync(file, big.slice(0, 3000));
    j.poll();
    fs.appendFileSync(file, big.slice(3000, 4500));
    j.poll();
    fs.appendFileSync(file, big.slice(4500) + '\n{"bot":"C"}\n');
    j.poll();
    assert.deepEqual(got.map((r) => r.bot), ['A', 'B', 'C']);
    assert.equal(j.stats.too_long, 2, 'counted once per oversized line');
  } finally { cleanup(); }
});

test('truncation (size < offset) re-reads from the start and flags replay', () => {
  const { file, got, infos, j, cleanup } = setup();
  try {
    fs.writeFileSync(file, '{"bot":"A","n":1}\n{"bot":"A","n":2}\n{"bot":"A","n":3}\n');
    j.start({ watch: false });
    assert.equal(got.length, 3);
    fs.writeFileSync(file, '{"bot":"Z","n":9}\n');
    j.poll();
    assert.equal(got.length, 4);
    assert.equal(got[3].bot, 'Z');
    assert.equal(j.stats.truncations, 1);
    assert.equal(infos.at(-1).replay, true);
    fs.appendFileSync(file, '{"bot":"Y"}\n');
    j.poll();
    assert.equal(got.at(-1).bot, 'Y');
    assert.equal(infos.at(-1).replay, false);
  } finally { cleanup(); }
});

test('rotation (inode change): old file is drained, new file read from 0', () => {
  const { file, dir, got, j, cleanup } = setup();
  try {
    fs.writeFileSync(file, '{"bot":"A"}\n');
    j.start({ watch: false });
    assert.equal(got.length, 1);
    fs.appendFileSync(file, '{"bot":"A2"}\n'); // written just before the rotation
    fs.renameSync(file, path.join(dir, 'events.jsonl.1'));
    fs.writeFileSync(file, '{"bot":"B"}\n{"bot":"C"}\n');
    j.poll();
    assert.deepEqual(got.map((r) => r.bot), ['A', 'A2', 'B', 'C']);
    assert.equal(j.stats.rotations, 1);
  } finally { cleanup(); }
});

test('file appears after start; deleted and recreated', () => {
  const { file, got, j, cleanup } = setup();
  try {
    j.start({ watch: false });
    assert.equal(got.length, 0);
    fs.writeFileSync(file, '{"bot":"A"}\n');
    j.poll();
    assert.equal(got.length, 1);
    fs.rmSync(file);
    j.poll();
    fs.writeFileSync(file, '{"bot":"B"}\n');
    j.poll();
    assert.deepEqual(got.map((r) => r.bot), ['A', 'B']);
  } finally { cleanup(); }
});

test('startup reads only the tail and drops the cut first line', () => {
  const { file, got, j, cleanup } = setup({ tailBytes: 60 });
  try {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ bot: `bot${i}`, n: i }));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    j.start({ watch: false });
    assert.ok(got.length >= 2 && got.length < 10, `got ${got.length}`);
    assert.equal(got.at(-1).bot, 'bot9');
    for (const r of got) assert.ok(r.bot, 'no half-parsed record');
    assert.equal(j.stats.parse_errors, 0);
  } finally { cleanup(); }
});

test('startup tail starting exactly on a line boundary keeps that line', () => {
  const { file, got, j, cleanup } = setup();
  try {
    const l1 = '{"bot":"A"}\n';
    const l2 = '{"bot":"B"}\n';
    fs.writeFileSync(file, l1 + l2);
    j.tailBytes = Buffer.byteLength(l2);
    j.start({ watch: false });
    assert.deepEqual(got.map((r) => r.bot), ['B']);
  } finally { cleanup(); }
});

test('fs.watch picks up appended lines quickly', async () => {
  const { file, got, j, cleanup } = setup({ pollMs: 5000 }); // poll too slow to help: the watcher must do it
  try {
    fs.writeFileSync(file, '');
    j.start();
    const t0 = Date.now();
    fs.appendFileSync(file, '{"bot":"W"}\n');
    while (!got.length && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 5));
    assert.equal(got.length, 1, 'watcher delivered the line');
    assert.ok(Date.now() - t0 < 1000);
  } finally { cleanup(); }
});
