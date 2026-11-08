// Demo generator: appends realistic Russian journal events for the 15 demo bots.
// Usage: node server/demo.js [--journal path] [--fast] [--seed-only]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTime } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const G_COORD = 'Coordination';
const G_X = 'X content';
const G_PUB = 'Publishing';
const G_FIN = 'Finance';
const TASKS = {
  [G_COORD]: ['Weekly task plan', 'Sorting incoming ideas', 'Summary across all floors', 'Weekly limit check'],
  [G_X]: ['Thread on AI agents for Monday', 'Covers for a post series', 'Weekly reach report', 'Competitor post review', 'Quote picks for QT'],
  [G_PUB]: ['Friday Substack issue', 'X Ads campaign for November'],
  [G_FIN]: ['Monthly portfolio review', 'Team budget for November'],
};

export const DEMO_BOTS = [
  { name: 'Grok Bot', group: G_COORD, steps: ['R4: scanning X, 7 searches', 'handing out tasks by floor', 'checking the publishing queue', 'collecting the hourly summary', 'checking weekly limits'] },
  { name: 'Jevopus', group: G_COORD, steps: ['sorting incoming ideas', 'ranking tasks by priority', 'writing the plan for tomorrow', 'checking what is stuck and what is not'] },
  { name: 'X Writer', group: G_X, steps: ['drafting a post about Topaz', 'rewriting the thread hook', 'cutting the post to 280 characters', 'picking a title for the thread', 'tuning the tone for the audience'] },
  { name: 'Banner & Visuals', group: G_X, steps: ['drawing a thread cover', 'picking the banner palette', 'exporting a 1600x900 preview', 'retouching a product screenshot'] },
  { name: 'Analytics Analyst', group: G_X, steps: ['counting weekly reach', 'comparing CTR of two posts', 'charting engagement', 'finding the best time to post'] },
  { name: 'Competitor Watch', group: G_X, steps: ['watching 12 competitors', 'reading fresh competitor posts', 'saving formats that work', 'checking prices in their offers'] },
  { name: 'QT Scout', group: G_X, steps: ['looking for posts to quote', 'rating reach of candidates', 'picking the 5 best quotes', 'checking the author\'s reputation'] },
  { name: 'Ideas Sparring', group: G_X, steps: ['arguing with the long-thread idea', 'generating 10 angles for a topic', 'finding weak spots in an argument', 'collecting counterarguments'] },
  { name: 'Bookmarks Brain', group: G_X, steps: ['sorting bookmarks by topic', 'pulling quotes from saved posts', 'finding duplicate bookmarks', 'mapping topics'] },
  { name: 'Codila X Researcher', group: G_X, steps: ['reading 40 fresh posts', 'researching the AI tools niche', 'noting recurring pains', 'building a list of sources'] },
  { name: 'Trendy X', group: G_X, steps: ['trend scan: 3 new', 'counting bookmarks on top posts', 'matching trends with my topics', 'picking formats with huge reach'] },
  { name: 'Substack', group: G_PUB, steps: ['laying out the newsletter issue', 'checking links in the email', 'writing the preview text', 'scheduling the send for 18:00'] },
  { name: 'X Ads Manager', group: G_PUB, steps: ['checking the campaign budget', 'comparing bids by audience', 'pausing a weak ad', 'building the ads report'] },
  { name: 'Warren Buffett', group: G_FIN, steps: ['reading a quarterly report', 'estimating fair value', 'checking the multiples', 'writing an investment note'] },
  { name: 'Finance Team', group: G_FIN, steps: ['reconciling weekly income', 'reviewing subscriptions and costs', 'building the monthly P&L', 'preparing the cash-flow forecast'] },
];

const WAITING = ['publish it?', 'approve the budget?', 'which version do we pick?', 'confirm the text before sending', 'pick a cover: A or B'];
const ERRORS = ['X rate limit 429, retrying in 15 min', 'could not open the report file', 'timeout while loading an image', 'no access to the API'];
const DONE = ['done: report sent', 'draft ready', 'task closed', 'issue assembled'];
const IDLE = ['waiting for a new task', 'resting until the next run'];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function weighted(list) {
  let r = Math.random() * list.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of list) if ((r -= w) <= 0) return v;
  return list[0][0];
}

const NEXT = {
  idle: [['working', 6], ['idle', 2]],
  working: [['working', 12], ['done', 4], ['waiting_user', 2], ['error', 0.8], ['idle', 0.5]],
  done: [['idle', 3], ['working', 3]],
  waiting_user: [['working', 3], ['waiting_user', 3]],
  error: [['working', 3], ['idle', 1], ['error', 1]],
};

export function createDemo({ journal, fast = false, tz = 'Europe/Sofia', now = Date.now, write } = {}) {
  const time = makeTime(tz);
  const emit = write || ((obj) => fs.appendFileSync(journal, JSON.stringify(obj) + '\n'));
  const bots = DEMO_BOTS.map((b) => ({ ...b, status: 'idle', task: null, silentUntil: 0 }));
  let timer = null;
  let usageTimer = null;
  let usageTotal = 37;
  const usageShare = new Map(DEMO_BOTS.map((b) => [b.name, rnd(0.2, 1.4)]));
  const startedAt = now();

  function line(bot, status, step, atMs = now()) {
    if (status === 'working' || status === 'waiting_user' || status === 'error') bot.task ||= pick(TASKS[bot.group] || TASKS[G_X]);
    const rec = { t: time.iso(atMs), bot: bot.name, group: bot.group, status, step: step.slice(0, 80) };
    if (bot.task && status !== 'idle') rec.task = bot.task;
    if (status === 'done' || status === 'idle') bot.task = null;
    rec.demo = true;
    bot.status = status;
    emit(rec);
  }

  function stepFor(bot, status) {
    switch (status) {
      case 'working': return pick(bot.steps);
      case 'waiting_user': return pick(WAITING);
      case 'error': return pick(ERRORS);
      case 'done': return pick(DONE);
      default: return pick(IDLE);
    }
  }

  function usageLine() {
    usageTotal = Math.min(99, usageTotal + rnd(0, 0.4));
    const sum = [...usageShare.values()].reduce((s, v) => s + v, 0);
    const botsPct = {};
    for (const [name, w] of usageShare) {
      usageShare.set(name, Math.max(0.05, w + rnd(-0.05, 0.12)));
      botsPct[name] = Math.round((usageTotal * w / sum) * 10) / 10;
    }
    emit({
      t: time.iso(now()), type: 'usage', period: 'week', resets_at: nextMonday(now(), time),
      total_used_pct: Math.round(usageTotal * 10) / 10, bots: botsPct,
      routines: { R1: Math.round(rnd(2, 7) * 10) / 10, R4: Math.round(rnd(3, 9) * 10) / 10 }, demo: true,
    });
  }

  /** Initial picture: some bots busy, one waiting, one stuck (backdated), a usage line, schedules. */
  function seed() {
    const t0 = now();
    usageLine();
    emit({ t: time.iso(t0), type: 'schedule', bot: 'Grok Bot', routine: 'R1', cron: '30 * * * *', last_run: time.iso(t0 - 22 * 60e3), demo: true });
    emit({ t: time.iso(t0), type: 'schedule', bot: 'Grok Bot', routine: 'R4', cron: '0 */2 * * *', last_run: time.iso(t0 - 75 * 60e3), demo: true });
    bots.forEach((bot, i) => {
      if (bot.name === 'Competitor Watch') {
        // silent for 45 minutes while "working": shows up as stuck
        line(bot, 'working', 'watching 12 competitors', t0 - 45 * 60e3);
        bot.silentUntil = startedAt + (fast ? 60e3 : 5 * 60e3);
        return;
      }
      const status = i % 5 === 3 ? 'idle' : i === 6 ? 'waiting_user' : i === 12 ? 'idle' : 'working';
      line(bot, status, stepFor(bot, status), t0 - Math.floor(rnd(2, 40)) * 1000);
    });
  }

  function tickOnce() {
    const t = now();
    const candidates = bots.filter((b) => b.silentUntil <= t);
    // busy bots speak more often than idle ones
    const pool = candidates.flatMap((b) => (b.status === 'working' ? [b, b, b] : [b]));
    const bot = pick(pool);
    const status = weighted(NEXT[bot.status] || NEXT.idle);
    line(bot, status, stepFor(bot, status));
  }

  function loop() {
    const [lo, hi] = fast ? [150, 600] : [1000, 4000];
    timer = setTimeout(() => {
      tickOnce();
      loop();
    }, rnd(lo, hi));
  }

  return {
    start({ seedFirst = true } = {}) {
      if (seedFirst) seed();
      loop();
      usageTimer = setInterval(usageLine, fast ? 5000 : 60000);
    },
    stop() {
      clearTimeout(timer);
      clearInterval(usageTimer);
    },
    seed, tickOnce, usageLine, bots,
  };
}

function nextMonday(ms, time) {
  const d = new Date(ms);
  const add = ((8 - d.getUTCDay()) % 7) || 7;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 0, 0, 0));
  return time.iso(target.getTime() - 2 * 3600e3);
}

function main() {
  const argv = process.argv.slice(2);
  let journal = path.join(ROOT, 'data', 'events.jsonl');
  let fast = false;
  let seedOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--journal') journal = path.resolve(argv[++i]);
    else if (argv[i] === '--fast') fast = true;
    else if (argv[i] === '--seed-only') seedOnly = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('node server/demo.js [--journal path] [--fast] [--seed-only]');
      return;
    } else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const demo = createDemo({ journal, fast, tz: process.env.BOTHQ_TZ || 'Europe/Sofia' });
  console.log(`demo generator -> ${journal}${fast ? ' (fast)' : ''}`);
  if (seedOnly) { demo.seed(); return; }
  demo.start();
  const stop = () => { demo.stop(); process.exit(0); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, stop);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
