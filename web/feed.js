// Bots-only mode: the office reads the user's bots straight from their channel. No server, no tunnel.
//
// FORK NOTES (Chris Abad's copy of grokbot-wallpaper by @0xCodila / Bodila51; see README "About this fork"):
//  - One mailbox only: ntfy.sh by default (#<topic>), or the one a link names (#<topic>@<host>). The author's relay
//    (relay.0xcodila.com) is never contacted, and there is no usage beacon / analytics ping.
//  - The LATEST roster, groups, looks and chat lines are authoritative: each replaces the previous one instead of being
//    merged into it. Bots missing from the newest roster (and their status lines) are not shown; teams missing from
//    the newest groups line are gone. A bot named "Phone with Bland" is never shown (it is not part of the team).
//  - The browser cache uses a new key (old caches are deleted) and keeps status lines for 12 h only. The latest
//    roster/looks/groups/chat/routines lines are cached on their own (one of each, at most 7 days old), so the office
//    keeps its teams overnight even after the mailbox's 12 h window has passed.
//
// Lines on the channel (one JSON object per message, at most 4 KB, anything else is dropped):
//   {"bot":"…","status":"working|idle|waiting_user|error|done","step":"…"}     a status change
//   {"roster":["Bot A","Bot B"]}                                                the team (latest replaces)
//   {"looks":{"Bot A":{"shape":"sphere","color":"#RRGGBB","accessory":"none"}}} how each bot's blob looks (latest replaces)
//   {"type":"usage","total_used_pct":37,"resets_at":"…","bots":{"Bot A":4.1}}  the weekly limit meter
//   {"groups":{"Bot A":"Content"}}                                            teams, one floor each (latest replaces)
//   {"chat":{"Bot A":"grokbot://app/v1/agent?id=…"}}                         each bot's chat (latest replaces)
//   {"routines":{"bot":"Bot A","items":[{"name":"…","schedule":"…","next_run":"ISO"}]}}   a bot's routines (per bot)
//   {"check":{"bots":["Bot A","Bot B"]}}                                     the setup bot starts a status check
import { StateStore, botIdFor } from './lib/state.js';
import { feedFromLink } from './lib/feedbase.js';

const MAX_LINE = 4096, KEEP = 600, TICK_MS = 30e3, DAY_MS = 24 * 3600e3;
const QUIET_MS = 20 * 60e3, CHECK_MS = 6 * 3600e3;    // a silent worker turns idle; a status check stays up this long
const LINE_AGE_MS = 12 * 3600e3;                       // cached status lines: 12 h, like the mailbox
const CFG_AGE_MS = 7 * DAY_MS;                         // cached latest roster/looks/groups/chat/routines: 7 days
const CACHE_NS = 'bothq.fork1';                        // new namespace: browsers start fresh
const EXCLUDED = new Set(['Phone with Bland'].map(botIdFor));   // never shown, whatever the feed says
const CFG_KINDS = ['roster', 'looks', 'groups', 'chat'];
// Fallback looks for the team, used only for a bot the latest looks line does not cover (a looks line always wins).
const DEFAULT_LOOKS = {
  'Peter · Chief Assistant': { shape: 'rounded_cube', color: '#1F3A5F', accessory: 'none' },
  'Philip · Email & Calendar': { shape: 'rounded_square', color: '#2D84F5', accessory: 'glasses' },
  'Thomas · Accountability Coach': { shape: 'triangle', color: '#D6408B', accessory: 'glasses' },   // raspberry
  'Matthew · Finance & Budget': { shape: 'hexagon', color: '#2E9E5B', accessory: 'glasses' },
  'Bartholomew · Graphic Designer': { shape: 'star6', color: '#F2B705', accessory: 'bow' },
  'Simon · Vocal Coach': { shape: 'pill', color: '#C0392B', accessory: 'antenna' },
  'Andrew · Developer & Builder': { shape: 'pentagon', color: '#6C5CE7', accessory: 'antenna' },
  'John · Spiritual Mentor': { shape: 'sphere', color: '#3BB6C9', accessory: 'none' },
  'James · Health & Fitness Coach': { shape: 'star4', color: '#FF7A00', accessory: 'none' },
};

export const isExcluded = (name) => typeof name === 'string' && EXCLUDED.has(botIdFor(name.trim()));

/** The page's hash and query -> { topic, servers: [one mailbox, no trailing slash] }, or null without a topic. */
export function feedFromHash(hash, search = '') {
  const f = feedFromLink({ hash: hash || '', search });
  if (!f) return null;
  return { topic: f.topic, servers: [f.base.replace(/\/$/, '')] };
}

/** Rebuild from cache + the mailbox's last 12 h, then follow it live. Calls onState(state) on every change. */
export async function connectFeed({ topic, servers }, onState) {
  const server = servers[0];
  const base = `${server}/${encodeURIComponent(topic)}`;
  const linesKey = `${CACHE_NS}.lines.${server}.${topic}`, cfgKey = `${CACHE_NS}.cfg.${server}.${topic}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Sofia';
  let store = null;
  let lines = [];                                        // status / usage / check lines (and anything else), oldest first
  const latest = { routines: {} };                       // kind -> { time, rec }; routines: bot id -> { time, rec }
  let roster = null;                                     // Set of bot ids from the latest roster, or null if none yet
  let check = null;                                      // the latest status check: { ms, names }
  let lastId = null, saveTimer = 0;
  const seen = new Set();

  dropOldCaches();
  const cachedCfg = readJSON(cfgKey, {}) || {};
  for (const k of CFG_KINDS) if (cachedCfg[k]?.rec && Date.now() - cachedCfg[k].time * 1000 < CFG_AGE_MS) latest[k] = cachedCfg[k];
  for (const [id, r] of Object.entries(cachedCfg.routines || {})) if (r?.rec && Date.now() - r.time * 1000 < CFG_AGE_MS) latest.routines[id] = r;
  const cut0 = Date.now() / 1000 - LINE_AGE_MS / 1000;
  const incoming = (readJSON(linesKey, []) || []).filter((l) => l && typeof l.id === 'string' && l.time >= cut0);
  try {
    const text = await (await fetch(`${base}/json?poll=1&since=12h`, { cache: 'no-store' })).text();
    for (const row of text.split('\n')) {
      if (!row) continue;
      try {
        const m = JSON.parse(row);
        if (m?.event === 'message' && typeof m.id === 'string') incoming.push({ id: m.id, time: Number(m.time) || 0, message: m.message });
      } catch { /* junk row */ }
    }
  } catch { /* offline or down: the cache still shows the office */ }
  incoming.sort((a, b) => a.time - b.time);              // stable: lines of one second keep the mailbox's order
  for (const l of incoming) if (fresh(l)) { lastId = l.id; route(l); }
  rebuild();
  save();
  publish();

  follow();
  setInterval(() => { const v = store.version, s = store.snapshot(); if (store.version !== v) onState(extras(s)); }, TICK_MS);

  function readJSON(key, dflt) {
    try { return JSON.parse(localStorage.getItem(key)) ?? dflt; } catch { return dflt; }
  }
  function dropOldCaches() {                             // the original office's caches (merged, unbounded): gone
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('bothq.feed.')) localStorage.removeItem(k);
      }
    } catch { /* private mode */ }
  }
  function fresh(l) {                                    // once per mailbox id, and once per (time, text)
    const a = `id ${l.id}`, b = `${l.time} ${l.message}`;
    if (seen.has(a) || seen.has(b)) return false;
    seen.add(a).add(b);
    return true;
  }
  function parse(message) {
    if (typeof message !== 'string' || message.length > MAX_LINE) return null;
    try {
      const rec = JSON.parse(message);
      return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
    } catch { return null; }
  }
  function kindOf(rec) {
    if (Array.isArray(rec.roster)) return 'roster';
    for (const k of ['looks', 'groups', 'chat', 'routines', 'check']) if (isMap(rec[k])) return k;
    return 'line';
  }
  /** One new message: config kinds replace the latest of their kind; everything else joins `lines`. Returns its kind. */
  function route(l) {
    const rec = parse(l.message);
    if (!rec) return null;
    const kind = kindOf(rec);
    if (CFG_KINDS.includes(kind)) {
      if (!latest[kind] || l.time >= latest[kind].time) latest[kind] = { time: l.time, rec };
    } else if (kind === 'routines') {
      const name = typeof rec.routines.bot === 'string' ? rec.routines.bot.trim().slice(0, 80) : '';
      if (name && Array.isArray(rec.routines.items)) {
        const id = botIdFor(name);
        if (!latest.routines[id] || l.time >= latest.routines[id].time) latest.routines[id] = { time: l.time, rec };
      }
    } else {
      lines.push(l);
    }
    return kind;
  }
  function allowed(name) {
    if (typeof name !== 'string' || !name.trim() || isExcluded(name)) return false;
    return !roster || roster.has(botIdFor(name.trim()));
  }
  function nameMap(obj) {                                // a {name: value} map without excluded / unlisted bots
    const out = {};
    if (isMap(obj)) for (const [name, v] of Object.entries(obj).slice(0, 400)) if (allowed(name)) out[name] = v;
    return out;
  }
  /** The office from scratch: latest roster/looks/groups/chat, then every kept line in time order. */
  function rebuild() {
    const cut = Date.now() / 1000 - LINE_AGE_MS / 1000;
    lines = lines.filter((l) => l.time >= cut).slice(-KEEP);
    store = new StateStore({ tz, quietIdleMs: QUIET_MS, hasAvatar: () => false });   // no GLB probe: every bot is generated from its look
    const names = (latest.roster?.rec.roster || []).filter((n) => typeof n === 'string' && n.trim() && !isExcluded(n))
      .slice(0, 400).map((n) => n.trim());
    roster = names.length ? new Set(names.map(botIdFor)) : null;
    const cfg = {};
    const looks = { ...nameMap(DEFAULT_LOOKS), ...nameMap(latest.looks?.rec.looks) };
    for (const [name, look] of Object.entries(looks)) (cfg[name] ||= {}).look = look;
    for (const [name, team] of Object.entries(nameMap(latest.groups?.rec.groups))) {
      if (typeof team === 'string' && team.trim()) (cfg[name] ||= {}).floor = team.trim().slice(0, 40);
    }
    for (const [name, url] of Object.entries(nameMap(latest.chat?.rec.chat))) {   // only app deep links and web pages
      if (typeof url === 'string' && /^(grokbot|https):\/\//i.test(url.trim())) (cfg[name] ||= {}).chat_url = url.trim();
    }
    store.setBotsConfig(cfg);
    for (const name of names) store.apply({ bot: name, status: 'idle', step: '', listed: true }, { replay: true });
    check = null;
    for (const l of lines) apply(l, true);
    store.commit();
  }
  /** A status / usage / check line into the store. Returns true if the office may have changed. */
  function apply({ message, time }, replay) {
    const rec = parse(message);
    if (!rec) return false;
    const t = typeof rec.t === 'string' ? rec.t : new Date(time * 1000).toISOString();
    if (isMap(rec.check)) {                              // the setup bot asks every bot for a status line: who answers?
      const names = (Array.isArray(rec.check.bots) ? rec.check.bots : []).filter((n) => allowed(n))
        .slice(0, 400).map((n) => n.trim().slice(0, 80));
      if (!names.length) return false;
      const ms = Number.isFinite(Date.parse(t)) ? Date.parse(t) : time * 1000;
      if (!check || ms >= check.ms) check = { ms, names };
      return true;
    }
    if (typeof rec.type === 'string' && rec.type.toLowerCase() === 'usage') {
      store.apply({ ...rec, t, bots: isMap(rec.bots) ? nameMap(rec.bots) : rec.bots }, { replay });
      return true;
    }
    if (typeof rec.type === 'string') { store.apply({ ...rec, t }, { replay }); return true; }   // schedule etc.
    if (!allowed(rec.bot)) return false;                 // not on the latest roster (or excluded): not shown
    store.apply({ ...rec, t, listed: false }, { replay });
    return true;
  }
  function take(m) {                                     // a live message: true if the office changed
    if (m?.event !== 'message' || typeof m.id !== 'string') return false;
    lastId = m.id;
    const l = { id: m.id, time: Number(m.time) || Date.now() / 1000, message: m.message };
    if (!fresh(l)) return false;
    const kind = route(l);
    if (!kind) return false;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 2000);
    if (CFG_KINDS.includes(kind)) { rebuild(); return true; }
    if (kind === 'routines') return true;
    if (lines.length > KEEP * 1.5) lines = lines.slice(-KEEP);
    return apply(l, false);
  }
  function follow() {                                    // ntfy's event stream; on (re)connect fetch what was missed
    const live = new EventSource(`${base}/sse`);
    live.onopen = () => catchUp();
    live.onmessage = (e) => { try { if (take(JSON.parse(e.data))) publish(); } catch { /* keepalive or junk */ } };
  }
  async function catchUp() {
    try {
      const text = await (await fetch(`${base}/json?poll=1&since=${lastId ?? '12h'}`, { cache: 'no-store' })).text();
      let changed = false;
      for (const row of text.split('\n')) {
        if (!row) continue;
        try { if (take(JSON.parse(row))) changed = true; } catch { /* junk row */ }
      }
      if (changed) publish();
    } catch { /* the stream retries by itself */ }
  }
  function extras(s) {                                   // the panels' data on top of the server-shaped state
    const since = Date.now() - DAY_MS, finished = [];
    for (let i = lines.length - 1; i >= 0 && finished.length < 100; i--) {
      const l = lines[i];
      if (l.time * 1000 < since) break;
      if (typeof l.message !== 'string' || !l.message.includes('"done"')) continue;
      const rec = parse(l.message);
      if (rec?.status !== 'done' || !allowed(rec.bot)) continue;
      finished.push({ t: typeof rec.t === 'string' ? rec.t : new Date(l.time * 1000).toISOString(), bot: botIdFor(rec.bot), name: rec.bot.slice(0, 80), step: String(rec.step ?? '').slice(0, 80) });
    }
    s.finished = finished;
    const routines = [];
    for (const { rec } of Object.values(latest.routines)) {
      const name = rec.routines.bot.trim().slice(0, 80);
      if (!allowed(name)) continue;
      for (const r of rec.routines.items.slice(0, 50).filter(isMap)) {
        const routine = String(r.name ?? '').slice(0, 80);
        if (!routine) continue;
        routines.push({ bot: botIdFor(name), name, routine, schedule: String(r.schedule ?? '').slice(0, 80),
          next_run: Number.isFinite(Date.parse(r.next_run)) ? new Date(r.next_run).toISOString() : null });
      }
    }
    s.routines = routines.sort((a, b) => (a.next_run ? Date.parse(a.next_run) : Infinity) - (b.next_run ? Date.parse(b.next_run) : Infinity));
    s.check = check && Date.now() - check.ms < CHECK_MS ? {
      t: new Date(check.ms).toISOString(),
      bots: check.names.map((name) => {                  // answered = a status line of its own at or after the check
        const id = botIdFor(name), seenAt = Date.parse(s.bots[id]?.last_seen ?? '');
        return { id, name, at: seenAt >= check.ms ? new Date(seenAt).toISOString() : null };
      }),
    } : null;
    return s;
  }
  function publish() { store.commit(); onState(extras(store.snapshot())); }
  function save() {
    const cut = Date.now() / 1000 - LINE_AGE_MS / 1000;
    try {
      localStorage.setItem(linesKey, JSON.stringify(lines.filter((l) => l.time >= cut).slice(-KEEP)));
      const cfg = { routines: latest.routines };
      for (const k of CFG_KINDS) if (latest[k]) cfg[k] = latest[k];
      localStorage.setItem(cfgKey, JSON.stringify(cfg));
    } catch { /* private mode: not cached */ }
  }
}

function isMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
