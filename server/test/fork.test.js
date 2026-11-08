// Fork: roster entries seat a bot but are not events; feed.js keeps only the latest roster/groups and hides Phone with Bland.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../../web/lib/state.js';

test('fork: a roster entry is not an event (events today, history, feed stay empty)', () => {
  const s = new StateStore({ quietIdleMs: 20 * 60e3 });
  s.apply({ bot: 'A', status: 'idle', step: '', listed: true });
  const st = s.snapshot();
  assert.equal(st.bots.a.today.events, 0);
  assert.equal(st.bots.a.history.length, 0);
  assert.equal(st.feed.length, 0);
  assert.equal(st.bots.a.last_seen, null);
  s.apply({ bot: 'A', status: 'working', step: 'x' });
  assert.equal(s.snapshot().bots.a.today.events, 1);
});

test('fork: feed.js – latest roster/groups win, Phone with Bland hidden, only one mailbox', async () => {
  const now = Date.now() / 1000;
  const msgs = [
    { roster: ['A · One', 'B · Two', 'Phone with Bland'] },
    { groups: { 'A · One': 'Ops', 'B · Two': 'Ops', 'Phone with Bland': 'Ops' } },
    { bot: 'Phone with Bland', status: 'working', step: 'calling' },
    { bot: 'Stranger', status: 'working', step: 'not on the roster' },
    { roster: ['A · One', 'B · Two'] },
    { groups: { 'A · One': 'The Twelve', 'B · Two': 'The Twelve' } },
    { bot: 'A · One', status: 'working', step: 'busy' },
    { chat: { 'A · One': 'javascript:alert(1)', 'B · Two': 'grokbot://app/v1/agent?id=1' } },
  ].map((m, i) => JSON.stringify({ id: `m${i}`, time: Math.floor(now) - 100 + i, event: 'message', message: JSON.stringify(m) })).join('\n');
  const urls = [];
  const mem = new Map([['bothq.feed.old', '[]']]);
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k),
    key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
  globalThis.fetch = async (u) => { urls.push(u); return { text: async () => msgs }; };
  globalThis.EventSource = class { constructor(u) { urls.push(u); } };
  const { connectFeed, feedFromHash } = await import('../../web/feed.js');
  // connectFeed keeps a 30s refresh timer; unref it so this file's tests can exit.
  const realSetInterval = globalThis.setInterval, realSetTimeout = globalThis.setTimeout;
  const unref = (id) => { id?.unref?.(); return id; };
  globalThis.setInterval = (...args) => unref(realSetInterval(...args));
  globalThis.setTimeout = (...args) => unref(realSetTimeout(...args));
  let state;
  try {
    await connectFeed(feedFromHash('#testtopic1'), (s) => { state = s; });
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(Object.keys(state.bots).sort(), ['a-one', 'b-two']);
  assert.deepEqual(state.floors.map((f) => f.name), ['The Twelve']);
  assert.equal(state.bots['a-one'].effective_status, 'working');
  assert.equal(state.bots['a-one'].chat_url, null);
  assert.equal(state.bots['b-two'].chat_url, 'grokbot://app/v1/agent?id=1');
  assert.ok(urls.every((u) => u.startsWith('https://ntfy.sh/testtopic1/')), urls.join(' '));
  assert.ok(!mem.has('bothq.feed.old'));
  assert.ok([...mem.keys()].every((k) => k.startsWith('bothq.fork1.')));
});
