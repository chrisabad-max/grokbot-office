import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore, normalizeStatus, botIdFor, normLook, LOOK_SHAPES, LOOK_ACCESSORIES, LIMITS } from '../state.js';
import { SHAPES, ACCESSORIES } from '../../web/scene/looks.js';
import { slugify } from '../util.js';

const T0 = Date.parse('2026-10-31T12:00:00+02:00');
const MIN = 60e3;

function make(extra = {}) {
  let now = T0;
  const store = new StateStore({ now: () => now, tz: 'Europe/Sofia', ...extra });
  const clock = { advance: (ms) => { now += ms; }, set: (ms) => { now = ms; }, get: () => now };
  const ev = (bot, status, step, extraRec = {}, atMs = now) => {
    store.apply({ t: new Date(atMs).toISOString(), bot, status, step, ...extraRec });
    store.commit();
  };
  return { store, clock, ev };
}

test('slugs: Latin, Cyrillic transliteration, fixed demo ids', () => {
  assert.equal(slugify('Banner & Visuals'), 'banner-visuals');
  assert.equal(slugify('  Grok Bot  '), 'grok-bot');
  assert.equal(slugify('Ёжик и Щука'), 'ezhik-i-shchuka');
  assert.equal(botIdFor('Тренды X: закладки и мега-охват'), 'trendy-x');
  assert.equal(botIdFor('X Writer'), 'x-writer');
  assert.equal(botIdFor('Codila X Researcher'), 'codila-x-researcher');
  assert.match(botIdFor('🔥🔥'), /^bot-/);
});

test('status synonyms and unknown handling', () => {
  assert.equal(normalizeStatus('waiting', false), 'waiting_user');
  assert.equal(normalizeStatus('failed', false), 'error');
  assert.equal(normalizeStatus('finished', false), 'done');
  assert.equal(normalizeStatus('Waiting User', false), 'waiting_user');
  assert.equal(normalizeStatus('whatever', true), 'working');
  assert.equal(normalizeStatus('whatever', false, 'error'), 'error');
  assert.equal(normalizeStatus(undefined, false), 'idle');
  assert.equal(normalizeStatus(42, true), 'working');
});

test('stuck: working with no event for > 30 min; version bumps on the timer alone', () => {
  const { store, clock, ev } = make();
  ev('X Writer', 'working', 'пишу драфт');
  assert.equal(store.snapshot().bots['x-writer'].effective_status, 'working');
  clock.advance(29 * MIN);
  store.tick();
  const v = store.version;
  assert.equal(store.snapshot().bots['x-writer'].effective_status, 'working');
  clock.advance(2 * MIN);
  assert.equal(store.tick(), true, 'tick reports a change');
  assert.equal(store.version, v + 1);
  const st = store.snapshot();
  assert.equal(st.bots['x-writer'].effective_status, 'stuck');
  assert.equal(st.bots['x-writer'].status, 'working');
  assert.equal(st.summary.stuck, 1);
  assert.equal(st.floors[0].counts.stuck, 1);
});

test('done is visible for 60 s, then idle', () => {
  const { store, clock, ev } = make();
  ev('X Writer', 'done', 'драфт готов');
  assert.equal(store.snapshot().bots['x-writer'].effective_status, 'done');
  clock.advance(59e3);
  assert.equal(store.snapshot().bots['x-writer'].effective_status, 'done');
  const v = store.version;
  clock.advance(2e3);
  const st = store.snapshot();
  assert.equal(st.bots['x-writer'].effective_status, 'idle');
  assert.equal(st.bots['x-writer'].status, 'done');
  assert.equal(store.version, v + 1);
});

test('anything silent for more than 3 h becomes idle', () => {
  const { store, clock, ev } = make();
  ev('A', 'waiting_user', 'жду ответа');
  ev('B', 'error', 'упал');
  ev('C', 'working', 'делаю');
  clock.advance(3 * 3600e3 - MIN);
  let st = store.snapshot();
  assert.equal(st.bots.a.effective_status, 'waiting_user');
  assert.equal(st.bots.b.effective_status, 'error');
  assert.equal(st.bots.c.effective_status, 'stuck');
  clock.advance(2 * MIN);
  st = store.snapshot();
  for (const id of ['a', 'b', 'c']) assert.equal(st.bots[id].effective_status, 'idle');
  assert.equal(st.summary.idle, 3);
});

test('version only moves on real change', () => {
  const { store, clock, ev } = make();
  ev('A', 'working', 'x');
  const v = store.version;
  clock.advance(5e3);
  store.snapshot();
  store.tick();
  clock.advance(5e3);
  store.snapshot();
  assert.equal(store.version, v, 'time passing without a status change keeps the version');
  ev('A', 'working', 'y');
  assert.equal(store.version, v + 1);
  const pending = store.version;
  store.commit(); // nothing dirty
  assert.equal(store.version, pending);
});

test('floors: group -> floor, demo ids and order, free desks', () => {
  const { store, ev } = make();
  ev('Finance Team', 'idle', null, { group: 'Финансы' });
  ev('X Writer', 'working', 'x', { group: 'X-контент' });
  ev('Grok Bot', 'working', 'x', { group: 'Координация' });
  ev('Substack', 'idle', null, { group: 'Публикации' });
  ev('Loner', 'idle', null);
  ev('Newcomer', 'idle', null, { group: 'Новый отдел' });
  const st = store.snapshot();
  assert.deepEqual(st.floors.map((f) => f.id), ['coordination', 'x-content', 'publishing', 'finance', 'novyy-otdel', 'general']);
  assert.deepEqual(st.floors.map((f) => f.order), [1, 2, 3, 4, 5, 6]);
  assert.equal(st.floors[1].name, 'X content');
  assert.equal(st.floors[1].free_desks, 19);
  assert.equal(st.bots.loner.floor, 'general');
  assert.equal(st.floors.at(-1).name, 'Main floor');
  assert.equal(st.bots['finance-team'].floor, 'finance');
});

test('floor overflow: 21st bot goes to <id>-2, desks stable and 1..20', () => {
  const { store, ev } = make();
  for (let i = 1; i <= 25; i++) ev(`Bot ${String(i).padStart(2, '0')}`, 'idle', null, { group: 'Большой' });
  const st = store.snapshot();
  const [f1, f2] = st.floors;
  assert.equal(f1.id, 'bolshoy');
  assert.equal(f2.id, 'bolshoy-2');
  assert.equal(f2.name, 'Большой · 2');
  assert.equal(f1.bots.length, LIMITS.MAX_PER_FLOOR);
  assert.equal(f2.bots.length, 5);
  assert.equal(f1.free_desks, 0);
  assert.equal(f2.free_desks, 15);
  assert.equal(st.bots['bot-01'].desk, 1);
  assert.equal(st.bots['bot-20'].desk, 20);
  assert.equal(st.bots['bot-21'].floor, 'bolshoy-2');
  assert.equal(st.bots['bot-21'].desk, 1);
  assert.equal(st.bots['bot-25'].desk, 5);
  // desks stay put when more events arrive
  ev('Bot 03', 'working', 'again');
  assert.equal(store.snapshot().bots['bot-03'].desk, 3);
});

test('summary and floor counts add up', () => {
  const { store, ev } = make();
  ev('A', 'working', 's', { group: 'G' });
  ev('B', 'waiting', null, { group: 'G' });
  ev('C', 'failed', 'x', { group: 'G' });
  ev('D', 'finished', 'x', { group: 'G' });
  const st = store.snapshot();
  assert.deepEqual(st.summary, { working: 1, idle: 0, waiting_user: 1, error: 1, stuck: 0, done: 1, total: 4 });
  assert.deepEqual(st.floors[0].counts, { working: 1, idle: 0, waiting_user: 1, error: 1, stuck: 0, done: 1 });
});

test('history keeps 20, feed keeps 100, newest first', () => {
  const { store, clock, ev } = make();
  for (let i = 0; i < 130; i++) {
    clock.advance(1000);
    ev(i % 2 ? 'A' : 'B', 'working', `step ${i}`);
  }
  const st = store.snapshot();
  assert.equal(st.feed.length, 100);
  assert.equal(st.feed[0].step, 'step 129');
  assert.equal(st.feed[0].bot, 'a');
  assert.equal(st.feed[0].name, 'A');
  assert.equal(st.bots.a.history.length, 20);
  assert.equal(st.bots.a.history[0].step, 'step 129');
  assert.equal(st.bots.a.history[19].step, 'step 91');
});

test('usage: share = bot pct / total, fuel fields and reset time', () => {
  const { store, ev } = make();
  ev('X Writer', 'working', 'x');
  ev('Other', 'idle', null);
  store.apply({ t: new Date(T0).toISOString(), type: 'usage', period: 'week', resets_at: '2026-11-03T00:00:00+02:00', total_used_pct: 37, bots: { 'X Writer': 4.1 }, routines: { R1: 5.3 } });
  store.commit();
  const st = store.snapshot();
  assert.equal(st.usage.total_used_pct, 37);
  assert.equal(st.usage.resets_at, '2026-11-03T00:00:00+02:00');
  assert.equal(st.usage.routines.R1, 5.3);
  assert.equal(st.bots['x-writer'].usage_pct, 4.1);
  assert.equal(st.bots['x-writer'].usage_share, 0.111);
  assert.equal(st.bots.other.usage_pct, null);
  assert.equal(st.bots.other.usage_share, null);
  // null fields keep previous values
  store.apply({ t: new Date(T0).toISOString(), type: 'usage', total_used_pct: null, bots: null });
  store.commit();
  assert.equal(store.snapshot().usage.total_used_pct, 37);
});

test('today: working minutes, events, tasks_done (deduped by task)', () => {
  const { store, clock, ev } = make();
  ev('A', 'working', 'one', { task: 't1' });
  clock.advance(10 * MIN);
  ev('A', 'working', 'two', { task: 't1' });
  clock.advance(5 * MIN);
  ev('A', 'done', 'ok', { task: 't1' });
  ev('A', 'done', 'ok again', { task: 't1' });
  clock.advance(MIN);
  ev('A', 'working', 'three', { task: 't2' });
  clock.advance(4 * MIN);
  let t = store.snapshot().bots.a.today;
  assert.equal(t.events, 5);
  assert.equal(t.tasks_done, 1);
  assert.equal(t.working_min, 15 + 4); // closed 15 min + open 4 min
  clock.advance(MIN);
  ev('A', 'done', 'ok', { task: 't2' });
  t = store.snapshot().bots.a.today;
  assert.equal(t.tasks_done, 2);
  assert.equal(t.working_min, 15 + 5);
});

test('garbage records are skipped, not fatal', () => {
  const { store } = make();
  store.apply({});
  store.apply({ bot: '' });
  store.apply({ bot: 'A', t: 'not a date', status: 'weird' });
  store.apply({ type: 'something-else' });
  store.apply({ type: 'schedule', bot: 'A' });
  store.commit();
  const st = store.snapshot();
  assert.equal(Object.keys(st.bots).length, 1);
  assert.equal(st.bots.a.status, 'idle');
  assert.ok(st.meta.skipped >= 3);
});

test('schedule lines are kept per bot', () => {
  const { store, ev } = make();
  ev('Grok Bot', 'working', 'x');
  store.apply({ type: 'schedule', bot: 'Grok Bot', routine: 'R1', cron: '30 * * * *', last_run: '2026-10-31T11:30:00+02:00' });
  store.apply({ type: 'schedule', bot: 'Grok Bot', routine: 'R4', cron: '0 */2 * * *' });
  store.commit();
  const s = store.snapshot().bots['grok-bot'].schedule;
  assert.equal(s.length, 2);
  assert.equal(s[0].routine, 'R1');
  assert.equal(s[0].last_run, '2026-10-31T11:30:00+02:00');
  assert.equal(s[1].last_run, null);
});

test('config overrides: bots.json (floor, chat_url, avatar, color) and floors.json mapping', () => {
  const { store, ev } = make();
  ev('X Writer', 'working', 'x', { group: 'X-контент' });
  ev('Jevopus', 'idle', null, { group: 'Координация' });
  store.setBotsConfig({
    'X Writer': { floor: 'Финансы', chat_url: 'grokbot://app/v1/agent?id=1', avatar: 'custom', color: '#abcdef' },
    Jevopus: { chat_url: 'javascript:alert(1)' },
  });
  store.setFloorsConfig({ floors: [{ id: 'ops', name: 'Операции' }], bots: { Jevopus: 'ops' } });
  store.commit();
  let st = store.snapshot();
  assert.equal(st.bots['x-writer'].floor, 'finance');
  assert.equal(st.bots['x-writer'].chat_url, 'grokbot://app/v1/agent?id=1');
  assert.equal(st.bots['x-writer'].avatar, 'custom');
  assert.equal(st.bots['x-writer'].color, '#ABCDEF');
  assert.equal(st.bots.jevopus.floor, 'ops');
  assert.equal(st.bots.jevopus.chat_url, null, 'dangerous schemes are dropped');
  assert.equal(st.floors[0].id, 'ops', 'configured floors come first');
  // flat floors.json form
  store.setBotsConfig(null);
  store.setFloorsConfig({ 'X Writer': 'ops' });
  st = store.snapshot();
  assert.equal(st.bots['x-writer'].floor, 'ops');
  assert.equal(st.bots.jevopus.floor, 'coordination');
  assert.equal(st.bots['x-writer'].color, '#2F6BFF', 'demo bots keep their avatar color');
});

test('colors: stable hash for unknown bots', () => {
  const a = make();
  const b = make();
  a.ev('Brand New Bot', 'idle', null);
  b.ev('Brand New Bot', 'idle', null);
  const ca = a.store.snapshot().bots['brand-new-bot'].color;
  assert.match(ca, /^#[0-9A-F]{6}$/);
  assert.equal(ca, b.store.snapshot().bots['brand-new-bot'].color);
});

test('replay of already seen events is dropped, newer ones are applied', () => {
  const { store, clock } = make();
  const t1 = new Date(T0 - 5 * MIN).toISOString();
  const t2 = new Date(T0 - 1 * MIN).toISOString();
  store.applyBatch([{ t: t1, bot: 'A', status: 'working', step: 'one' }, { t: t2, bot: 'A', status: 'working', step: 'two' }]);
  store.commit();
  const v = store.version;
  store.applyBatch([{ t: t1, bot: 'A', status: 'working', step: 'one' }, { t: t2, bot: 'A', status: 'working', step: 'two' }], { replay: true });
  store.commit();
  assert.equal(store.version, v);
  assert.equal(store.snapshot().bots.a.history.length, 2);
  store.applyBatch([{ t: new Date(clock.get()).toISOString(), bot: 'A', status: 'done', step: 'three' }], { replay: true });
  store.commit();
  assert.equal(store.snapshot().bots.a.history.length, 3);
});

test('timestamps come out in the configured zone with offset', () => {
  const { store, ev } = make();
  ev('A', 'working', 'x');
  const st = store.snapshot();
  assert.equal(st.now, '2026-10-31T12:00:00+02:00');
  assert.equal(st.bots.a.last_event, '2026-10-31T12:00:00+02:00');
  assert.equal(st.feed[0].t, '2026-10-31T12:00:00+02:00');
});

test('demo flag: forced, or taken from the latest event', () => {
  const a = make({ demo: true });
  assert.equal(a.store.snapshot().demo, true);
  const b = make();
  b.ev('A', 'working', 'x', { demo: true });
  assert.equal(b.store.snapshot().demo, true);
  b.ev('A', 'working', 'y');
  assert.equal(b.store.snapshot().demo, false);
});

test('look: bots.json look reaches bots[id].look, validated field by field', () => {
  const { store, ev } = make();
  ev('Sky Bot', 'idle', null);
  ev('Odd Bot', 'idle', null);
  ev('Bad Bot', 'idle', null);
  ev('Plain Bot', 'idle', null);
  store.setBotsConfig({
    'Sky Bot': { look: { shape: 'hexagon', color: '#1e86fc', accessory: 'glasses' } },
    'Odd Bot': { look: { shape: 'banana', color: 'red', accessory: 'hat' } },        // nothing usable
    'Bad Bot': { look: { shape: 'Rounded Cube', color: '#abc', accessory: 'BOW' } }, // shape ok (normalised), 3-digit colour refused
    'Plain Bot': { floor: 'Финансы' },
  });
  store.commit();
  const b = store.snapshot().bots;
  assert.deepEqual(b['sky-bot'].look, { shape: 'hexagon', color: '#1E86FC', accessory: 'glasses' });
  assert.equal(b['sky-bot'].color, '#1E86FC', 'the bot colour follows look.color when no explicit colour is set');
  assert.equal(b['odd-bot'].look, null, 'unknown shape + unusable colour carries no information');
  assert.deepEqual(b['bad-bot'].look, { shape: 'rounded_cube', color: null, accessory: 'bow' });
  assert.match(b['bad-bot'].color, /^#[0-9A-F]{6}$/, 'falls back to the hashed colour');
  assert.equal(b['plain-bot'].look, null);
  // an explicit colour wins over look.color for the bot colour; the look itself is untouched
  store.setBotsConfig({ 'Sky Bot': { color: '#111111', look: { shape: 'star4', color: '#FF0000' } } });
  const sky = store.snapshot().bots['sky-bot'];
  assert.equal(sky.color, '#111111');
  assert.deepEqual(sky.look, { shape: 'star4', color: '#FF0000', accessory: 'none' });
});

test('look: normLook edge cases', () => {
  assert.equal(normLook(null), null);
  assert.equal(normLook('hexagon'), null);
  assert.equal(normLook([]), null);
  assert.equal(normLook({}), null);
  assert.equal(normLook({ accessory: 'bow' }), null);
  assert.deepEqual(normLook({ shape: 'banana', color: '#00ff00' }), { shape: null, color: '#00FF00', accessory: 'none' });
  assert.deepEqual(normLook({ shape: ' STAR-4 '.replace('-', ''), color: ' #0c0c0e ' }), { shape: 'star4', color: '#0C0C0E', accessory: 'none' });
  assert.equal(normLook({ shape: 'sphere', color: 'javascript:alert(1)' }).color, null);
  assert.equal(normLook({ shape: 'pill', color: '2d9cdb' }).color, '#2D9CDB', 'the leading # is optional');
  assert.equal(normLook({ shape: 'pill', color: '#2d9cdbff' }).color, null);
  assert.equal(normLook({ shape: 42, color: 42 }), null);
});

test('look: the server vocabulary matches the one the browser uses', () => {
  assert.deepEqual(LOOK_SHAPES, SHAPES);
  assert.deepEqual(LOOK_ACCESSORIES, ACCESSORIES);
  assert.equal(SHAPES.length, 16, '13 app shapes + rounded_cube, cone, trio');
  for (const sh of ['cloud', 'bubble', 'flower', 'drop']) assert.ok(SHAPES.includes(sh), sh);
  for (const sh of SHAPES) assert.equal(normLook({ shape: sh }).shape, sh);
});
