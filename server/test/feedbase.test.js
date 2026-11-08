import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEED_BASE, feedBase, feedFromLink, baseTag } from '../../web/lib/feedbase.js';
import { StateStore } from '../state.js';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('feed links: one default base, @host, ?feed=, the older &ntfy=', () => {
  assert.equal(FEED_BASE, 'https://ntfy.sh/');
  assert.deepEqual(feedFromLink({ hash: '#gbw-abcdef123' }), { topic: 'gbw-abcdef123', base: FEED_BASE, url: 'https://ntfy.sh/gbw-abcdef123' });
  assert.equal(feedFromLink({ hash: '#gbw-abcdef123@relay.0xcodila.com' }).url, 'https://relay.0xcodila.com/gbw-abcdef123');
  assert.equal(feedFromLink({ hash: '#gbw-abcdef123@https://my.host/ntfy/' }).base, 'https://my.host/ntfy/');
  assert.equal(feedFromLink({ hash: '#gbw-abcdef123&ntfy=https%3A%2F%2Fntfy.example.org' }).base, 'https://ntfy.example.org/');
  assert.equal(feedFromLink({ hash: '#gbw-abcdef123', search: '?feed=relay.0xcodila.com' }).base, 'https://relay.0xcodila.com/');
  assert.deepEqual(feedFromLink({ search: '?feed=gbw-abcdef123' }), { topic: 'gbw-abcdef123', base: FEED_BASE, url: 'https://ntfy.sh/gbw-abcdef123' });
  assert.equal(feedFromLink({ hash: '#gbw-abcdef123@http://evil.example' }).base, FEED_BASE);   // not https: ignored
  assert.equal(feedFromLink({ hash: '#short' }), null);
  assert.equal(feedFromLink({ search: '?feed=relay.0xcodila.com' }), null);                     // a base without a topic
  assert.equal(feedBase('http://localhost:8799'), 'http://localhost:8799/');
  assert.equal(baseTag(FEED_BASE), '');
  assert.equal(baseTag('https://relay.0xcodila.com/'), 'relay.0xcodila.com');
});

// step 1 of a prompt prints FEED = <base> + topic, built from string pieces so it has no link
const feedPrinted = (md) => [...md.matchAll(/print\(((?:'[^']*'\+)+)t\)/g)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join(''))[0];
const statusRule = (md) => md.split(/\r?\n/).find((l) => l.startsWith('STATUS RULE, '));   // a Windows checkout has CRLF

test('prompts: the posted one feeds ntfy.sh (FEED_BASE), the current one our relay with the status rule', () => {
  assert.equal(feedPrinted(read('PROMPT.md')), FEED_BASE, 'PROMPT.md (the posted prompt) prints FEED_BASE + topic');
  const current = read('relay/PROMPT-relay.md');
  assert.equal(feedPrinted(current), 'https://relay.0xcodila.com/', 'relay/PROMPT-relay.md prints the relay + topic');
  assert.ok(statusRule(current), 'relay/PROMPT-relay.md has the STATUS RULE line');
  assert.equal(statusRule(read('relay/RELIABLE.md')), statusRule(current), 'relay/RELIABLE.md writes the same rule');
  assert.equal(statusRule(read('PROMPT.md')), statusRule(current), 'PROMPT.md writes the same rule into each bot');
  assert.equal(/const FEED_BASE = '([^']+)'/.exec(read('web/face/face.js'))?.[1], FEED_BASE, 'the wallpaper keeps a copy of FEED_BASE');
});

const T0 = Date.parse('2026-11-02T09:00:00+02:00');
const MIN = 60e3;
function make() {
  let now = T0;
  const store = new StateStore({ now: () => now, tz: 'Europe/Sofia', quietIdleMs: 20 * MIN });
  return { store, at: (ms) => { now = ms; }, iso: (ms) => new Date(ms).toISOString() };
}

test('office fallbacks: a silent worker turns idle after 20 min, last_seen ignores roster entries', () => {
  const { store, at, iso } = make();
  store.apply({ t: iso(T0), bot: 'Nova', status: 'idle', step: '', listed: true });   // the roster line
  let st = store.snapshot();
  assert.equal(st.bots.nova.last_seen, null);
  store.apply({ t: iso(T0 + MIN), bot: 'Nova', status: 'working', step: 'Drafting' });
  at(T0 + 15 * MIN);
  st = store.snapshot();
  assert.equal(st.bots.nova.effective_status, 'working');
  assert.equal(Date.parse(st.bots.nova.last_seen), T0 + MIN);
  at(T0 + 22 * MIN);
  st = store.snapshot();
  assert.equal(st.bots.nova.effective_status, 'idle');
  assert.equal(st.summary.stuck, 0);
  assert.equal(st.bots.nova.today.working_min, 20);
});

test('office fallbacks: usage rose without a status line -> worked (unreported) until it speaks', () => {
  const { store, at, iso } = make();
  for (const n of ['Nova', 'Pixel']) store.apply({ t: iso(T0), bot: n, status: 'idle', step: '', listed: true });
  store.apply({ t: iso(T0), type: 'usage', total_used_pct: 10, bots: { Nova: 3, Pixel: 2 } });
  store.apply({ t: iso(T0 + 60 * MIN), bot: 'Pixel', status: 'working', step: 'Rendering' });
  at(T0 + 240 * MIN);
  store.apply({ t: iso(T0 + 240 * MIN), type: 'usage', total_used_pct: 14, bots: { Nova: 5, Pixel: 4 } });
  let st = store.snapshot();
  assert.deepEqual(st.bots.nova.unreported, { from: store.time.iso(T0), to: store.time.iso(T0 + 240 * MIN) });
  assert.equal(st.bots.pixel.unreported, null);                    // it posted in that window
  store.apply({ t: iso(T0 + 250 * MIN), bot: 'Nova', status: 'idle', step: '' });
  at(T0 + 251 * MIN);
  st = store.snapshot();
  assert.equal(st.bots.nova.unreported, null);                     // it has spoken since
});
