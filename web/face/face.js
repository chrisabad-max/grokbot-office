// Grok Bot Wallpaper: live eyes on the big sphere + the user's bots as live cards.
// The eyes follow the cursor (Lively forwards mouse moves to the wallpaper); with no cursor around they wander,
// blink, glance at whichever bot needs the user, and get sleepy when every bot is resting. Data: the user's channel,
// else /api/state (the journal server); with neither, only the bot and its sky, no cards. ?demo=1 animates the bundled
// demo state instead. At most 30 frames per second.

const STATUS = {
  working: { text: 'working', c: 'var(--working)' },
  waiting_user: { text: 'waiting for you', c: 'var(--waiting)' },
  error: { text: 'error', c: 'var(--error)' },
  stuck: { text: 'stuck', c: 'var(--stuck)' },
  done: { text: 'done', c: 'var(--done)' },
  idle: { text: 'resting', c: 'var(--idle)' },
};
const ORDER = ['waiting_user', 'error', 'stuck', 'working', 'done', 'idle'];
const SHAPES = ['sphere', 'rounded_square', 'pill', 'triangle', 'pentagon', 'hexagon', 'star4', 'star6', 'clover', 'rounded_cube', 'cone', 'trio', 'cloud', 'bubble', 'flower', 'drop'];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- the eyes: the original painted eyes as layers (assets/face/eyes.json), moved like Grok Bot's own animation ----------
// In the original the eyes are painted on a 3D ball: to look somewhere the ball turns, so the eyes slide over its
// surface and flatten toward its edge. Here the same ball is cut by the screen's bottom edge; each eye is turned with
// it and drawn with the exact projection of the turned surface under it; past the ball's edge it is hidden (.bot is
// clipped to the ball), so the eyes slide out of sight over the edge as in the original. Interest makes the eyes
// bigger, a big change of gaze comes with a blink. No squinting: the original never narrows its eyes.
const SPHERE = { w: 1369, h: 613 }, BALL = { x: 684.5, y: 684.58, r: 683.58 };   // the ball in sphere.png pixels
const VIEW = 0.8;                                         // the screen's distance in front of the ball, in radii
const TURN = { side: 0.55, up: 0.34, down: 0.3 };        // how far the ball turns, radians
// the original's blink, frame by frame at 30 fps (ms, how open): the pill shrinks along its length to a short dash,
// is gone for three frames, then grows back with a hair of overshoot
const BLINK = [[0, 1], [33, 0.7], [66, 0.14], [85, 0], [185, 0], [215, 0.45], [250, 0.92], [290, 1.04], [330, 1]];
const botEl = document.querySelector('.bot');
const eyes = [];
const gaze = { yaw: spring(0, 0.3), pitch: spring(0, 0.3), size: spring(1, 0.22) };
let rest = null;                                        // where the face looks in the approved picture
const pct = (v) => `${(v * 100).toFixed(3)}%`;
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
fetch('../assets/face/eyes.json').then((r) => r.json()).then((info) => {
  for (const name of ['l', 'r']) {
    const e = info[name], els = [...document.querySelectorAll(`.eye[data-eye="${name}"]`)];
    const white = document.querySelector(`.eye-w[data-eye="${name}"]`);   // the black bot's eye: the same, made light
    for (const el of [...els, white]) Object.assign(el.style, {
      left: pct(e.x / SPHERE.w), top: pct(e.y / SPHERE.h), width: pct(e.w / SPHERE.w), height: pct(e.h / SPHERE.h),
      transformOrigin: `${pct((e.cx - e.x) / e.w)} ${pct((e.cy - e.y) / e.h)}`,
    });
    const x = (e.cx - BALL.x) / BALL.r, y = (e.cy - BALL.y) / BALL.r;
    const p = [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
    const t1 = norm([p[2], 0, -p[0]]), t2 = cross(p, t1);           // the surface under the eye
    const det = t1[0] * t2[1] - t2[0] * t1[1];
    const th = ((e.axis || 0) * Math.PI) / 180, len = e.len || 230, wid = e.wid || 120;
    const u = [Math.sin(th), -Math.cos(th)], v = [Math.cos(th), Math.sin(th)];
    // the eye's outline with its soft light rim, as offsets from its centre in the painting's pixels
    const rim = Array.from({ length: 16 }, (_, i) => {
      const f = (Math.PI * 2 * i) / 16, r = wid / 2 + 14, a = Math.sign(Math.cos(f)) * (len - wid) / 2 + r * Math.cos(f), b = r * Math.sin(f);
      return [u[0] * a + v[0] * b, u[1] * a + v[1] * b];
    });
    eyes.push({
      els, white, p, t1, t2, inv: [t2[1] / det, -t2[0] / det, -t1[1] / det, t1[0] / det], rim,
      // the dark pill in the layer's own pixels: centre, length along its lean, width across it
      pill: { x: e.cx - e.x, y: e.cy - e.y, w: e.w, len, wid, u, v },
    });
  }
  const f = norm([0, 1, 2].map((i) => eyes[0].p[i] + eyes[1].p[i]));
  rest = { yaw: Math.atan2(f[0], f[2]), pitch: Math.atan2(f[1], Math.hypot(f[0], f[2])) };
});

function spring(x0, response = 0.28) {
  return { x: x0, v: 0, t: x0, w: (2 * Math.PI) / response };
}
function stepSpring(s, dt) {                             // critically damped, solved exactly: stable at any dt
  const c1 = s.x - s.t, c2 = s.v + s.w * c1, e = Math.exp(-s.w * dt);
  s.x = s.t + (c1 + c2 * dt) * e;
  s.v = (c2 - s.w * (c1 + c2 * dt)) * e;
}
function turn(v, yaw, pitch) {                           // the ball turned: down by pitch, then right by yaw
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const y = v[1] * cp + v[2] * sp, z = -v[1] * sp + v[2] * cp;
  return [v[0] * cy + z * sy, y, -v[0] * sy + z * cy];
}
function pose(e, yaw, pitch) {                           // where the eye sits on the turned ball, and its painting there
  const p = turn(e.p, yaw, pitch), a = turn(e.t1, yaw, pitch), b = turn(e.t2, yaw, pitch), [i0, i1, i2, i3] = e.inv;
  // the eye as painted -> the eye on the turned surface (its tangent plane, projected)
  return { p, m: [a[0] * i0 + b[0] * i2, a[1] * i0 + b[1] * i2, a[0] * i1 + b[0] * i3, a[1] * i1 + b[1] * i3] };
}

// The eyes never touch the ball's outline: a turn that would bring any part of an eye (at its biggest, rim included)
// closer to the edge than GAP is shortened along the same direction, so the gaze still points the same way.
const GAP = 0.08, BIGGEST = 1.2;
function clear(yaw, pitch) {
  for (const e of eyes) {
    const { p, m } = pose(e, yaw, pitch), k = BIGGEST / BALL.r;
    for (const [ox, oy] of e.rim) {
      if (Math.hypot(p[0] + (m[0] * ox + m[2] * oy) * k, p[1] + (m[1] * ox + m[3] * oy) * k) > 1 - GAP) return false;
    }
  }
  return true;
}
function keepClear(yaw, pitch) {
  if (clear(yaw, pitch)) return [yaw, pitch];
  let lo = 0, hi = 1;
  for (let i = 0; i < 12; i++) { const t = (lo + hi) / 2; if (clear(yaw * t, pitch * t)) lo = t; else hi = t; }
  return [yaw * lo, pitch * lo];
}

let target = null;               // a screen point to look at, or null = straight ahead (the approved pose)
let lastMove = -1e9, lastPointer = null, mood = 'calm', attention = false, glance = null;
let blinkAt = performance.now() + 500, blinkStart = -1e9, surprisedUntil = 0, happyUntil = 0;   // wakes with a blink, like the original

addEventListener('pointermove', (e) => {
  const now = performance.now();
  if (lastPointer) {
    const sp = Math.hypot(e.clientX - lastPointer.x, e.clientY - lastPointer.y) / Math.max(1, now - lastPointer.t) * 1000;
    if (sp > 4200 && !REDUCED) surprisedUntil = now + 650;     // a fast swipe: the eyes pop open for a moment
  }
  lastPointer = { x: e.clientX, y: e.clientY, t: now };
  lastMove = now;
  target = { x: e.clientX, y: e.clientY };
}, { passive: true });
addEventListener('pointerleave', () => { lastMove = -1e9; });

// ?look=0.2,0.15 pins a pretend cursor (fractions of the screen) and holds the pose still, for screenshots;
// &blink=66 also holds the blink at that moment (ms)
const params = new URLSearchParams(location.search), pinned = params.get('look');
const heldBlink = pinned && params.has('blink') ? Number(params.get('blink')) : null;
if (pinned) {
  const [fx, fy] = pinned.split(',').map(Number);
  blinkAt = Infinity;
  setInterval(() => { lastMove = performance.now(); target = { x: fx * innerWidth, y: fy * innerHeight }; }, 200);
}

function aim(now) {
  if (glance && now < glance.until) return glance;
  if (now - lastMove < 6000 && target) return target;
  // nobody around: the gaze wanders slowly between a few calm points
  if (!aim.next || now > aim.next) {
    aim.next = now + 2500 + Math.random() * 3500;
    aim.point = Math.random() < 0.3 ? null : { x: innerWidth * (0.1 + Math.random() * 0.8), y: innerHeight * (0.05 + Math.random() * 0.55) };
  }
  return aim.point;
}

function look(now) {
  const pt = aim(now);
  let yaw = 0, pitch = 0;
  if (pt && rest) {                                       // turn the face toward the point
    const r = botEl.getBoundingClientRect(), k = r.width / SPHERE.w;
    const X = (pt.x - r.left - BALL.x * k) / (BALL.r * k), Y = (pt.y - r.top - BALL.y * k) / (BALL.r * k);
    yaw = clamp(Math.atan2(X, VIEW) - rest.yaw, -TURN.side, TURN.side);
    pitch = clamp(Math.atan2(Y, Math.hypot(X, VIEW)) - rest.pitch, -TURN.up, TURN.down);
  }
  const sleepy = mood === 'sleepy' && now - lastMove > 6000;
  if (sleepy) { yaw *= 0.3; pitch = TURN.down * 0.6; }    // night, nobody around: the face sinks, the blinks slow down
  [yaw, pitch] = keepClear(yaw, pitch);
  const jump = Math.hypot(yaw - gaze.yaw.t, pitch - gaze.pitch.t) > 0.4;
  gaze.yaw.t = yaw; gaze.pitch.t = pitch;
  const keen = now < surprisedUntil || now < happyUntil || attention || (glance && now < glance.until);
  gaze.size.t = keen ? 1.2 : 1;
  // blinks every few seconds, sometimes twice; a big change of gaze comes with one
  if ((now > blinkAt || jump) && now - blinkStart > 600 && !REDUCED && !pinned) {
    blinkStart = now;
    dispatchEvent(new Event('gbw:blink'));                 // the landing page gives it a sound
    if (blinkAt !== Infinity) blinkAt = now + (Math.random() < 0.2 ? 420 : (sleepy ? 4000 : 2400) + Math.random() * 4200);
  }
}

function openness(now) {                                 // the blink curve at this moment
  const t = heldBlink ?? now - blinkStart;
  if (t >= BLINK[BLINK.length - 1][0]) return 1;
  const i = BLINK.findIndex(([ms]) => ms > t), [t0, v0] = BLINK[i - 1], [t1, v1] = BLINK[i];
  return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
}

// The blink as in the original: the pill gets shorter and stays a pill (round ends), shorter than it is wide it is a
// short dash across, then nothing. Our eyes are painted, so the pill is cut out by a capsule-shaped window of that
// length, centred on the eye and leaning with it; a little narrower than the eye while closed, so its ends are round.
function capsule(q, o, k) {
  if (o >= 0.999) return 'none';
  const W = (q.wid * 0.86 + (q.wid * 0.14 + 30) * Math.min(1, o) ** 3) * k, L = Math.max(0, o) * (q.len + 30) * k;
  if (L < 0.5) return 'polygon(0 0, 0 0, 0 0)';
  const [d, e] = L >= W ? [q.u, q.v] : [q.v, q.u], r = Math.min(W, L) / 2, h = Math.abs(L - W) / 2;
  const cx = q.x * k, cy = q.y * k, pts = [];
  for (const side of [1, -1]) {
    for (let i = 0; i <= 12; i++) {
      const f = -Math.PI / 2 + (Math.PI * i) / 12, a = side * (h + r * Math.cos(f)), b = side * r * Math.sin(f);
      pts.push(`${(cx + d[0] * a + e[0] * b).toFixed(1)}px ${(cy + d[1] * a + e[1] * b).toFixed(1)}px`);
    }
  }
  return `polygon(${pts.join(', ')})`;
}

function draw(now) {
  if (!rest) return;
  const R = BALL.r * (botEl.clientWidth / SPHERE.w), s = gaze.size.x, o = openness(now);
  for (const e of eyes) {
    const { p, m } = pose(e, gaze.yaw.x, gaze.pitch.x);
    const tf = `translate(${((p[0] - e.p[0]) * R).toFixed(2)}px, ${((p[1] - e.p[1]) * R).toFixed(2)}px) matrix(${m.map((v) => v.toFixed(4)).join(', ')}, 0, 0) scale(${s.toFixed(4)})`;
    const k = botEl.clientWidth / SPHERE.w, black = botColor === 'black';
    const clip = capsule(e.pill, o, k);
    if (tf + clip === e.drawn) continue;                 // nothing moved: no restyle, no repaint
    e.drawn = tf + clip;
    for (const el of black ? [e.white] : e.els) { el.style.transform = tf; el.style.clipPath = clip; }
  }
}

let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) { last = now; return; }
  acc += now - last; last = now;
  if (acc < 1000 / (lite ? 24 : 30)) return;             // 30 fps is plenty for a wallpaper, 24 on a weak computer
  const dt = Math.min(0.05, acc / 1000); acc = 0;
  look(now);
  for (const s of Object.values(gaze)) {
    if (REDUCED || pinned) { s.x = s.t; s.v = 0; } else stepSpring(s, dt);
  }
  draw(now);
}
requestAnimationFrame(frame);

// ---------- avatars: flat shapes with white eyes, from the bot's look (or a hash of its id) ----------
function hash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
function poly(n, r, rot = -90) {
  return Array.from({ length: n }, (_, i) => { const a = ((rot + (360 / n) * i) * Math.PI) / 180; return `${50 + r * Math.cos(a)},${52 + r * Math.sin(a)}`; }).join(' ');
}
function star(n, r1, r2) {
  return Array.from({ length: n * 2 }, (_, i) => { const a = ((-90 + (180 / n) * i) * Math.PI) / 180, r = i % 2 ? r2 : r1; return `${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`; }).join(' ');
}
function body(shape, c) {
  const round = (pts) => `<polygon points="${pts}" fill="${c}" stroke="${c}" stroke-width="16" stroke-linejoin="round"/>`;
  switch (shape) {
    case 'rounded_square': return `<rect x="9" y="9" width="82" height="82" rx="24" fill="${c}"/>`;
    case 'rounded_cube': return `<rect x="13" y="13" width="74" height="74" rx="22" fill="${c}" transform="rotate(-14 50 50)"/>`;
    case 'pill': return `<rect x="4" y="22" width="92" height="58" rx="29" fill="${c}"/>`;
    case 'triangle': return round('50,16 88,82 12,82');
    case 'cone': return round('50,12 84,84 16,84');
    case 'pentagon': return round(poly(5, 36));
    case 'hexagon': return round(poly(6, 36, 0));
    case 'star4': return round(star(4, 40, 17));
    case 'star6': return round(star(6, 38, 22));
    case 'clover': return [[50, 28], [72, 50], [50, 72], [28, 50]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="23" fill="${c}"/>`).join('') + `<circle cx="50" cy="50" r="22" fill="${c}"/>`;
    case 'trio': return `<circle cx="32" cy="62" r="24" fill="${c}"/><circle cx="68" cy="62" r="22" fill="${c}" opacity=".85"/><circle cx="52" cy="30" r="20" fill="${c}" opacity=".7"/>`;
    default: return `<circle cx="50" cy="50" r="46" fill="${c}"/>`;
  }
}
const THUMBS = new Set(['grok-bot', 'jevopus', 'x-writer', 'banner-visuals', 'analytics-analyst', 'competitor-watch', 'qt-scout',
  'ideas-sparring', 'bookmarks-brain', 'codila-x-researcher', 'trendy-x', 'substack', 'x-ads-manager', 'warren-buffett', 'finance-team']);
function face3d(bot, look) {
  const id = bot.avatar || bot.id;
  return THUMBS.has(id) ? `<img src="../assets/blobs/thumbs/${id}.png" alt="" draggable="false">` : libFace(bot, look);
}
// Any other bot: the pre-rendered 3D library (assets/blobs/lib, made by build_blobs.py --lib-from) = its shape in the
// nearest of the Grok Bot app's 11 colours; the flat avatar() takes over if the PNG fails to load.
function libFace(bot, look) {
  const PAL = ['000000', 'A06B39', 'FB2B3E', 'FD690F', 'F59312', '14C16F', '13B7A2', '1E86FC', '8F59F9', 'F93498', '959595']; // = ui.js LIB_COLORS
  let shape = SHAPES.includes(look?.shape) ? look.shape : SHAPES[hash(bot.id) % SHAPES.length];
  if (shape === 'sphere' && look?.accessory === 'stem') shape = 'sphere_stem';     // the app's 14th avatar
  const m = /^#([0-9a-f]{6})$/i.exec(look?.color || bot.color || '');
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  let hex = PAL[hash(bot.id + 'c') % PAL.length];
  if (m) {                                                           // nearest by the "redmean" weighted RGB distance
    const [r, g, b] = rgb(m[1]);
    let best = Infinity;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 28) { hex = (r + g + b) / 3 < 75 ? '000000' : '959595'; best = 0; }   // greys: the app's black or gray, never brown
    for (const p of PAL) {
      const [pr, pg, pb] = rgb(p), rm = (r + pr) / 2, d = (2 + rm / 256) * (r - pr) ** 2 + 4 * (g - pg) ** 2 + (3 - rm / 256) * (b - pb) ** 2;
      if (d < best) { best = d; hex = p; }
    }
  }
  return `<img src="../assets/blobs/lib/${shape}-${hex}.png" alt="" draggable="false" data-fb="${esc(avatar(bot, look))}" onerror="this.outerHTML=this.dataset.fb">`;
}
function avatar(bot, look) {
  const shape = look?.shape || SHAPES[hash(bot.id) % SHAPES.length];
  const c = look?.color || bot.color || '#8E8E93';
  const tilt = ((hash(bot.id + 't') % 30) - 15);
  const eye = 'fill="#fff"';
  const [r, g, bl] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const dark = 0.2126 * r + 0.7152 * g + 0.0722 * bl < 0.18;          // dark avatars get a faint rim on the dark glass
  return `<svg viewBox="0 0 100 100" aria-hidden="true"${dark ? ' class="is-dark"' : ''}>${body(shape, c)}<g transform="rotate(${tilt} 50 50)"><rect x="35" y="36" width="10" height="22" rx="5" ${eye}/><rect x="55" y="36" width="10" height="22" rx="5" ${eye}/></g></svg>`;
}

// ---------- the live cards: the team, a card for each bot that needs the user, everyone as 3D avatars ----------
const $ = (id) => document.getElementById(id);
const stack = $('w-stack'), team = $('team'), grid = $('bot-grid'), needs = $('bot-needs'), tip = $('tip');
const NEEDS = ['waiting_user', 'error', 'stuck'], NEEDS_FIRST = ['error', 'waiting_user', 'stuck'];
const TONE = { waiting_user: 'is-waiting', stuck: 'is-waiting', error: 'is-error' };
const ASKS = { waiting_user: 'needs your reply', stuck: 'stuck, take a look', error: 'error' };
let looks = {}, state = null, byId = {}, crew = '';

function statusOf(b) { return STATUS[b.effective_status || b.status] ? (b.effective_status || b.status) : 'idle'; }
const byName = (a, b) => String(a.name).localeCompare(String(b.name));

function render(st) {
  stack.hidden = false;                                  // the cards show once there is data (index.html starts them hidden)
  const bots = Object.values(st.bots || {});
  const counts = { working: 0, waiting_user: 0, error: 0, stuck: 0, done: 0, idle: 0 };
  for (const b of bots) counts[statusOf(b)]++;
  const waiting = counts.waiting_user + counts.stuck;
  countTo($('n-working'), counts.working);
  countTo($('n-waiting'), waiting);
  countTo($('n-error'), counts.error);
  countTo($('bot-total'), bots.length);
  $('l-working').textContent = 'working';
  $('l-waiting').textContent = 'waiting';
  $('l-error').textContent = counts.error === 1 ? 'error' : 'errors';
  $('row-waiting').classList.toggle('is-zero', !waiting);
  $('row-error').classList.toggle('is-zero', !counts.error);
  team.classList.toggle('is-working', counts.working > 0);           // green while anyone works, graphite at rest
  team.classList.toggle('is-idle', !counts.working);
  const pct = Math.max(0, Math.min(100, Math.round(st.usage?.total_used_pct ?? 0)));
  $('usage').textContent = `${pct}%`;
  team.style.setProperty('--p', (pct / 100).toFixed(3));
  team.querySelector('.meter').hidden = st.usage?.total_used_pct == null;   // no usage report (the bots' own channel): no slider

  byId = Object.fromEntries(bots.map((b) => [b.id, b]));
  // who needs the user: a card each, two at most, most urgent first; a card that stays keeps its element
  const top = bots.filter((b) => NEEDS.includes(statusOf(b)))                 // an error first: it blocks work
    .sort((a, b) => NEEDS_FIRST.indexOf(statusOf(a)) - NEEDS_FIRST.indexOf(statusOf(b)) || byName(a, b)).slice(0, 2);
  const keys = top.map((b) => `${b.id}:${statusOf(b)}`);
  for (const el of needs.querySelectorAll('.need:not(.is-leaving)')) {
    if (keys.includes(el.dataset.key)) continue;
    if (REDUCED) { el.remove(); continue; }
    el.classList.add('is-leaving');                       // folds away; the cards below rise into its place
    setTimeout(() => el.remove(), 420);
  }
  top.forEach((b, i) => {
    const s = statusOf(b), key = keys[i];
    let el = [...needs.children].find((n) => n.dataset.key === key && !n.classList.contains('is-leaving'));
    if (!el) {
      el = document.createElement('article');
      el.className = `card need ${TONE[s]}`;
      Object.assign(el.dataset, { key, id: b.id, s });
      el.innerHTML = `${face3d(b, b.look || looks[b.id])}<div class="need__words"><div class="need__title"></div><div class="need__sub"></div></div><span class="bokeh" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;
    }
    el.querySelector('.need__title').textContent = b.name;
    el.querySelector('.need__sub').textContent = b.step ? `${ASKS[s]} · ${b.step}` : ASKS[s];
    const live = needs.querySelectorAll('.need:not(.is-leaving)');
    if (live[i] !== el) needs.insertBefore(el, live[i] || null);
  });

  // everyone, in a stable order (avatars never shuffle on a wallpaper); only the status dot changes
  const sig = bots.map((b) => b.id).sort().join('|');
  if (sig !== crew) {
    crew = sig;
    grid.innerHTML = bots.slice().sort(byName).map((b) => `<button class="av" type="button" data-id="${esc(b.id)}">${face3d(b, b.look || looks[b.id])}<i class="orb"></i></button>`).join('');
  }
  for (const av of grid.children) {
    const b = byId[av.dataset.id], s = statusOf(b);
    if (av.dataset.s === s) continue;
    av.dataset.s = s;
    av.style.setProperty('--c', STATUS[s].c);
    av.setAttribute('aria-label', `${b.name}: ${STATUS[s].text}`);
  }
  placeAll();

  const busy = counts.working + counts.waiting_user + counts.error + counts.stuck;
  const hour = new Date().getHours();
  mood = busy === 0 && (hour >= 22 || hour < 7) ? 'sleepy' : 'calm';
  if (counts.done > (render.done ?? counts.done) && !REDUCED) happyUntil = performance.now() + 1200;   // a task just finished
  render.done = counts.done;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function countTo(el, to) {                               // numbers roll to their new value instead of jumping
  const from = Number(el.dataset.v ?? 0);
  if (from === to) return;
  el.dataset.v = to;
  const t0 = performance.now(), dur = REDUCED ? 0 : 700;
  const tick = (now) => {
    const k = dur ? Math.min(1, Math.max(0, (now - t0) / dur)) : 1, e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // a page that isn't painting (hidden, paused by the wallpaper host) never runs that tick: land on the number anyway
  setTimeout(() => { if (Number(el.dataset.v) === to) el.textContent = to; }, dur + 120);
}

// hover an avatar: its name, status and what it is doing now; while the cursor is on the cards, Grok Bot's eyes widen
stack.addEventListener('pointerover', (e) => {
  const av = e.target.closest('.av');
  if (!av || drag) return;
  const b = byId[av.dataset.id];
  if (!b) return;
  tip.innerHTML = `<b>${esc(b.name)}</b><span>${STATUS[statusOf(b)].text}</span>${b.step ? `<p>${esc(b.step)}</p>` : ''}`;
  tip.hidden = false;
  const r = av.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const x = Math.min(innerWidth - t.width - 8, Math.max(8, r.left + r.width / 2 - t.width / 2));
  const y = r.top - t.height - 8 > 8 ? r.top - t.height - 8 : r.bottom + 8;
  Object.assign(tip.style, { left: `${x}px`, top: `${y}px` });
});
stack.addEventListener('pointerout', (e) => { if (!e.relatedTarget?.closest?.('.av')) tip.hidden = true; });
stack.addEventListener('pointerenter', () => { attention = true; });
stack.addEventListener('pointerleave', () => { attention = false; });

// every ~20 s, if someone needs the user, Grok Bot looks at that bot for a moment
setInterval(() => {
  const el = needs.querySelector('.need:not(.is-leaving)');
  if (!el || drag || performance.now() - lastMove < 4000) return;
  const r = el.querySelector('img, svg').getBoundingClientRect();
  glance = { x: r.left + r.width / 2, y: r.top + r.height / 2, until: performance.now() + 1800 };
}, 20000);

// ---------- moving the cards: drag 1:1 from where you grabbed, edges attract, the spot is remembered ----------
const MARGIN = 20, SNAP = 28;
const widgets = [
  { el: stack, key: 'gbw.pos.stack', home: (w) => ({ x: innerWidth - w.width - u(MARGIN), y: u(MARGIN) }) },
];
let drag = null;
function u(px) { return px * Math.min(1.45, Math.max(1, innerWidth * 0.000525)); }
function readPos(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function writePos(key, v) { try { if (v) localStorage.setItem(key, JSON.stringify(v)); else localStorage.removeItem(key); } catch { /* private mode: not remembered */ } }
function put(w, p) {
  const x = Math.min(Math.max(0, p.x), innerWidth - w.el.offsetWidth), y = Math.min(Math.max(0, p.y), innerHeight - w.el.offsetHeight);
  Object.assign(w.el.style, { left: `${x}px`, top: `${y}px`, right: 'auto' });
  return { x, y };
}
function placeAll() {
  for (const w of widgets) {
    if (drag && drag.w === w) continue;
    const saved = readPos(w.key);
    put(w, saved ? { x: saved.fx * innerWidth, y: saved.fy * innerHeight } : w.home(w.el.getBoundingClientRect()));
  }
}
function settle(w, p) {
  w.el.classList.add('is-settling');
  const c = put(w, p);
  setTimeout(() => w.el.classList.remove('is-settling'), 460);
  return c;
}
for (const w of widgets) {
  w.el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = w.el.getBoundingClientRect();
    drag = { w, id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    w.el.setPointerCapture(e.pointerId);
    w.el.classList.add('is-dragging');
    tip.hidden = true;
    dispatchEvent(new Event('gbw:grab'));
  });
  w.el.addEventListener('pointermove', (e) => {
    if (!drag || drag.w !== w || e.pointerId !== drag.id) return;
    put(w, { x: e.clientX - drag.dx, y: e.clientY - drag.dy });
  });
  const end = () => {
    if (!drag || drag.w !== w) return;
    drag = null;
    w.el.classList.remove('is-dragging');
    dispatchEvent(new Event('gbw:drop'));
    // near an edge it settles at the margin, like a widget on a desktop
    let x = w.el.offsetLeft, y = w.el.offsetTop;
    const m = u(MARGIN), sn = u(SNAP), W = w.el.offsetWidth, H = w.el.offsetHeight;
    if (x < m + sn) x = m; else if (innerWidth - x - W < m + sn) x = innerWidth - W - m;
    if (y < m + sn) y = m; else if (innerHeight - y - H < m + sn) y = innerHeight - H - m;
    const c = settle(w, { x, y });
    writePos(w.key, { fx: c.x / innerWidth, fy: c.y / innerHeight });
  };
  w.el.addEventListener('pointerup', end);
  w.el.addEventListener('pointercancel', end);
  w.el.addEventListener('dblclick', () => { writePos(w.key, null); settle(w, w.home(w.el.getBoundingClientRect())); });
}
addEventListener('resize', placeAll);
document.fonts?.ready.then(placeAll);

// the column leans a few degrees toward the cursor, like a card held in the hand
const lean = widgets.map(() => ({ tx: spring(0, 0.45), ty: spring(0, 0.45) }));
let leanLast = performance.now();
(function tiltLoop(now) {
  requestAnimationFrame(tiltLoop);
  if (document.hidden || !lastPointer) { leanLast = now; return; }
  const dt = Math.min(0.05, Math.max(0, (now - leanLast) / 1000)); leanLast = now;
  widgets.forEach((w, i) => {
    const r = w.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = (lastPointer.x - cx) / (r.width / 2 + 160), dy = (lastPointer.y - cy) / (r.height / 2 + 160);
    const near = Math.max(0, 1 - Math.hypot(dx, dy) / 2.2);
    lean[i].ty.t = REDUCED ? 0 : Math.max(-1, Math.min(1, dx)) * 4 * near;
    lean[i].tx.t = REDUCED ? 0 : Math.max(-1, Math.min(1, -dy)) * 4 * near;
    stepSpring(lean[i].tx, dt); stepSpring(lean[i].ty, dt);
    const tilt = `${lean[i].tx.x.toFixed(2)}|${lean[i].ty.x.toFixed(2)}`;
    if (tilt === w.tilt) return;                         // at rest: leave the styles alone
    w.tilt = tilt;
    w.el.style.setProperty('--tx', `${lean[i].tx.x.toFixed(2)}deg`);
    w.el.style.setProperty('--ty', `${lean[i].ty.x.toFixed(2)}deg`);
  });
})(performance.now());

// ---------- the sky: the four moods of the approved picture, blended by the real time of day ----------
// Morning, day, evening and night anchor at the real sunrise and sunset of the day, where the viewer is (the time
// zone's city, or ?lat=..&lon=..), so evenings come early in winter and late in summer; in between, every colour,
// glow and the stars ease from one mood to the next (smoothstep), repainted every 20 s, so the light never jumps.
const MOODS = {
  night: { sky: ['#010F2E', '#051536', '#132856', '#29457D', '#41639C'], glow: '#9FB4E0', glowA: 0.22, rim: '#C9D6F2', rimA: 0.7, edgeA: 0, mul: '#8391B5', scr: '#000000', mist: 0, stars: 1, star1: 1 },
  dawn: { sky: ['#97B3F6', '#AFBBF4', '#E5D0E4', '#DDBDCB', '#DECADF'], glow: '#FFD3C8', glowA: 0.45, rim: '#FFE0D6', rimA: 0.85, edgeA: 0.75, mul: '#FFFFFF', scr: '#3F3045', mist: 0.55, stars: 0, star1: 0 },
  day: { sky: ['#88BAF9', '#9CC4FA', '#C4DBF9', '#E4E5F0', '#E2E6F3'], glow: '#FFFFFF', glowA: 0.35, rim: '#FFFFFF', rimA: 0.8, edgeA: 0.9, mul: '#FFFFFF', scr: '#24293B', mist: 0.35, stars: 0, star1: 0 },
  dusk: { sky: ['#102152', '#303563', '#9C696B', '#F99958', '#D27B5F'], glow: '#FFB070', glowA: 0.55, rim: '#FFD9A0', rimA: 0.95, edgeA: 0.15, mul: '#ADA9C2', scr: '#000000', mist: 0, stars: 0, star1: 0.9 },
};
const FIXED_DAY = [[0, 'night'], [300, 'night'], [405, 'dawn'], [570, 'day'], [990, 'day'], [1125, 'dusk'], [1245, 'night'], [1440, 'night']];
let heldTime = params.get('time');                       // ?time=18:45 shows that moment, for screenshots; grokBot.setTime
const PLACES = {                                         // a city per common time zone, for the sun's times
  'Europe/Sofia': [42.7, 23.3], 'Europe/Kiev': [50.45, 30.5], 'Europe/Kyiv': [50.45, 30.5], 'Europe/Moscow': [55.75, 37.6],
  'Europe/Warsaw': [52.2, 21], 'Europe/Berlin': [52.5, 13.4], 'Europe/Paris': [48.85, 2.35], 'Europe/London': [51.5, -0.1],
  'Europe/Madrid': [40.4, -3.7], 'Europe/Rome': [41.9, 12.5], 'Europe/Istanbul': [41, 29], 'Asia/Dubai': [25.2, 55.3],
  'Asia/Kolkata': [28.6, 77.2], 'Asia/Singapore': [1.35, 103.8], 'Asia/Tokyo': [35.7, 139.7], 'Australia/Sydney': [-33.9, 151.2],
  'America/New_York': [40.7, -74], 'America/Chicago': [41.9, -87.6], 'America/Denver': [39.7, -105], 'America/Los_Angeles': [34.05, -118.25],
  'America/Sao_Paulo': [-23.55, -46.6],
};
function wherePlace() {
  if (params.has('lat') && params.has('lon')) return [Number(params.get('lat')), Number(params.get('lon'))];
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return PLACES[zone] || [45, -new Date().getTimezoneOffset() / 4];   // unknown zone: mid latitudes, longitude from the offset
}
// sunrise and sunset in minutes after local midnight (the standard sunrise equation); null near the poles
function sunTimes(d, [lat, lon]) {
  const rad = Math.PI / 180, noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  const n = Math.round(noon / 864e5 + 2440587.5 - 2451545 + 0.0008), J = n - lon / 360;
  const M = (357.5291 + 0.98560028 * J) % 360, C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360, transit = 2451545 + J + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.4397 * rad));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  if (Math.abs(cosW) > 1) return null;
  const w = Math.acos(cosW) / rad / 360, local = (jd) => { const t = new Date((jd - 2440587.5) * 864e5); return t.getHours() * 60 + t.getMinutes(); };
  return [local(transit - w), local(transit + w)];
}
function dayPlan(d) {                                    // the anchors of today's sky
  const sun = sunTimes(d, wherePlace());
  if (!sun) return FIXED_DAY;
  const [rise, set] = sun, mid = (rise + set) / 2;
  const dayFrom = Math.min(rise + 130, mid), dayTo = Math.max(set - 110, mid);
  return [[0, 'night'], [Math.max(1, rise - 100), 'night'], [rise + 15, 'dawn'], [dayFrom, 'day'], [dayTo, 'day'],
    [set + 15, 'dusk'], [Math.min(1439, set + 110), 'night'], [1440, 'night']];
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixHex = (a, b, k) => `#${rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
function paintSky() {
  const d = new Date(), [hh, mm] = heldTime ? heldTime.split(':').map(Number) : [d.getHours(), d.getMinutes() + d.getSeconds() / 60];
  const min = (((hh * 60 + mm) % 1440) + 1440) % 1440, DAY = dayPlan(d);
  const i = DAY.findIndex(([m]) => m > min), [m0, from] = DAY[i - 1], [m1, to] = DAY[i];
  const t = (min - m0) / (m1 - m0), k = t * t * (3 - 2 * t), A = MOODS[from], B = MOODS[to];
  const css = document.documentElement.style, num = (key) => (A[key] + (B[key] - A[key]) * k).toFixed(3);
  A.sky.forEach((c, n) => css.setProperty(`--sky-${n}`, mixHex(c, B.sky[n], k)));
  for (const key of ['glow', 'rim', 'mul', 'scr']) css.setProperty(`--${key}`, mixHex(A[key], B[key], k));
  css.setProperty('--glow-a', num('glowA')); css.setProperty('--rim-a', num('rimA')); css.setProperty('--edge-a', num('edgeA'));
  for (const key of ['mist', 'stars', 'star1']) css.setProperty(`--${key}`, num(key));
}
paintSky();
setInterval(paintSky, 20000);

// grokBot.setTime('07:15') holds the sky at that moment, null gives it back to the clock. The page that embeds the
// wallpaper uses it to show morning, day, sunset or night at once, without a reload: the sky runs there in 0.6 s
// through the hours between, the short way round the clock (with reduced motion it simply is there).
let timeRun = 0;
function setTime(hhmm) {
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const d = new Date(), from = heldTime ? toMin(heldTime) : d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  cancelAnimationFrame(timeRun);
  if (!hhmm) { heldTime = null; paintSky(); return; }
  const delta = ((((toMin(hhmm) - from + 720) % 1440) + 1440) % 1440) - 720, start = performance.now(), DUR = 600;
  const at = (m) => { const t = ((m % 1440) + 1440) % 1440; return `${Math.floor(t / 60)}:${(t % 60).toFixed(2)}`; };
  const step = (now) => {
    const k = REDUCED ? 1 : Math.min(1, (now - start) / DUR), e = 1 - (1 - k) ** 3;
    heldTime = k < 1 ? at(from + delta * e) : hhmm;
    paintSky();
    if (k < 1) timeRun = requestAnimationFrame(step);
  };
  timeRun = requestAnimationFrame(step);
}

(function scatterStars() {                               // sparse, tiny, in the upper sky only; a few twinkle
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  document.querySelector('.stars').innerHTML = Array.from({ length: 46 }, () => {
    const x = 2 + rnd() * 96, y = 2 + rnd() * 40, s = rnd() < 0.15 ? 2.2 : 1 + rnd() * 0.8, o = 0.35 + rnd() * 0.6;
    return `<i${rnd() < 0.25 ? ' class="tw"' : ''} style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;width:${s.toFixed(1)}px;height:${s.toFixed(1)}px;opacity:${o.toFixed(2)};animation-delay:${(-rnd() * 5).toFixed(1)}s"></i>`;
  }).join('');
})();

// ---------- weak computers: the same picture with fewer moving extras ----------
// Lite mode keeps what matters (the eyes, blinks, the sky, the cards' data) and stops the decorative loops: the bot's
// breathing, the light flowing inside the cards, twinkling stars. It turns on for few CPU threads or little memory,
// for ?lite=1, or when the first seconds run slowly; ?lite=0 forces the full version.
let lite = params.get('lite') === '1' || (params.get('lite') !== '0' && ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4));
document.documentElement.classList.toggle('lite', lite);
if (!lite && params.get('lite') !== '0') {
  const gaps = [];
  let prev = performance.now();
  requestAnimationFrame(function probe(now) {             // two seconds of frame timing, once, after the start
    gaps.push(now - prev); prev = now;
    if (gaps.length < 120) return void requestAnimationFrame(probe);
    gaps.sort((a, b) => a - b);
    if (!document.hidden && gaps[60] > 25) { lite = true; document.documentElement.classList.add('lite'); }   // under ~40 fps
  });
}

// ---------- white or black Grok Bot: the user's choice, remembered ----------
// Lively's settings call livelyPropertyListener, the Mac app calls grokBot.setBot, a link can say ?bot=black.
// The black bot is the same ball in glossy black (same volume and shading) with the same painted eyes made light;
// the eyes move, blink and keep clear of the edge exactly as the white bot's do.
let botColor = 'white';
const ballImg = botEl.querySelector('.ball');
function setBot(color) {
  botColor = color === 'black' ? 'black' : 'white';
  document.documentElement.dataset.bot = botColor;
  ballImg.src = `../assets/face/${botColor === 'black' ? 'sphere-black' : 'sphere'}.png`;
  for (const e of eyes) e.drawn = '';                    // redraw the eyes in their new form
  try { localStorage.setItem('gbw.bot', botColor); } catch { /* private mode: not remembered */ }
}
setBot(params.get('bot') || (() => { try { return localStorage.getItem('gbw.bot'); } catch { return null; } })() || 'white');
window.grokBot = { setBot, setTime };
window.livelyPropertyListener = (name, value) => {
  if (name === 'botColor') setBot(Number(value) === 1 ? 'black' : 'white');
  if (name === 'feed') {                                 // the user's bots channel, typed into Lively's settings
    const typed = String(value ?? '').trim(), got = channelOf(typed);
    if (typed && !got) return;                           // no channel in it: keep the one we have
    const next = got ? got[0] : '';                      // a pasted link becomes just its channel
    // Lively sends every setting on load, an empty box included: that must not drop a channel the link already carries
    if (next === (HASH?.[0] || FEED || '') || (!next && HASH)) return;
    try { if (next) localStorage.setItem('gbw.feed', next); else localStorage.removeItem('gbw.feed'); } catch { /* not remembered */ }
    // keep the query (the local server's ?key=); the channel goes in the hash, never sent to a server
    location.replace(location.pathname + location.search + (next ? `#${encodeURIComponent(next).replace(/%40/g, '@')}` : ''));
    if (next) location.reload();                         // a hash change alone doesn't reload the page
  }
};

// ---------- the user's own bots: their channel on ntfy.sh ----------
// A link with #<channel> (or the older ?feed=<channel>), remembered after that, connects the wallpaper to the user's
// bots; the hash never reaches GitHub Pages, and &ntfy=<https server> picks a self-hosted ntfy. Every bot posts one
// line per status change, {"bot":"…","status":"…","step":"…"}, plus roster, looks and usage lines (README), to the
// channel with plain curl; nothing else runs on the bots' box. The page reads the last 12 hours, then listens live.
// The mailbox is FEED_BASE unless the link names another: #<channel>@<host>, ?feed=<host> or &ntfy=<https server>.
const FEED_BASE = 'https://ntfy.sh/';                    // = FEED_BASE in office/lib/feedbase.js (a test keeps them equal)
const RELAY = 'https://relay.0xcodila.com';              // our relay: bots set up with the current prompt post there
const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
// The channel out of whatever holds it: the channel itself (gbw-…, maybe @<server>), or a whole dashboard or wallpaper
// link with it after # (Grok Bot replies with the dashboard link, and people paste that into Lively's box as it is).
// The same rule as the Mac app's Settings.channel(from:).
const CHANNEL = /^([A-Za-z0-9_-]{6,64})(?:@([^&#\s]+)|&ntfy=([^&#\s]+))?$/;
function channelOf(raw) {
  let s = String(raw ?? '').trim();
  try { s = decodeURIComponent(s); } catch { /* keep it as typed */ }
  const found = CHANNEL.exec(s.slice(s.lastIndexOf('#') + 1));
  if (found) return found;
  const bare = /gbw-[A-Za-z0-9_-]{6,64}/.exec(s);
  return bare && CHANNEL.exec(bare[0]);
}
const HASH = channelOf(location.hash);
function httpsServer(raw) {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === 'https:' || u.hostname === 'localhost' ? (u.origin + u.pathname).replace(/\/+$/, '') : null;
  } catch { return null; }
}
const QFEED = params.get('feed') || '', QBASE = /[./:]/.test(QFEED) ? QFEED : '';   // a bare ?feed=<channel> is an older link
const FEED = HASH?.[1] || (QBASE ? '' : QFEED) || channelOf(stored('gbw.feed'))?.[1] || null;
const NTFY = httpsServer(decodeURIComponent(HASH?.[2] || HASH?.[3] || '') || QBASE || params.get('ntfy') || '') || stored('gbw.ntfy') || FEED_BASE.replace(/\/$/, '');
if ((HASH || QFEED) && FEED) { try { localStorage.setItem('gbw.feed', FEED); localStorage.setItem('gbw.ntfy', NTFY); } catch { /* private mode: not remembered */ } }
const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};
const SLUG_ALIASES = { 'trendy-x-zakladki-i-mega-okhvat': 'trendy-x' };   // as the server names them (server/state.js)
const WORDS = {
  working: 'working', running: 'working', busy: 'working', active: 'working', in_progress: 'working', started: 'working',
  waiting_user: 'waiting_user', waiting: 'waiting_user', needs_user: 'waiting_user', waiting_for_user: 'waiting_user',
  error: 'error', failed: 'error', fail: 'error', failure: 'error', stuck: 'stuck',
  done: 'done', finished: 'done', complete: 'done', completed: 'done', success: 'done',
  idle: 'idle', resting: 'idle', sleeping: 'idle', paused: 'idle', stopped: 'idle',
};
function botId(name) {
  const s = String(name).normalize('NFC').toLowerCase().replace(/[а-яёіїєґ]/g, (c) => CYR[c] ?? '').normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return SLUG_ALIASES[s] || s || `bot-${hash(String(name)).toString(36)}`;
}
function applyLine(text, time) {                         // a status, roster, looks or usage line; false if none
  if (typeof text !== 'string' || text.length > 4096) return false;
  let ev;
  try { ev = JSON.parse(text); } catch { return false; }
  const at = new Date((Number(time) || Date.now() / 1000) * 1000).toISOString();
  if (ev?.looks && typeof ev.looks === 'object' && !Array.isArray(ev.looks)) {   // how each bot looks: its avatar
    for (const [name, look] of Object.entries(ev.looks).slice(0, 400)) if (look && typeof look === 'object') looks[botId(name)] = look;
    crew = '';                                           // rebuild the avatars
    return true;
  }
  if (ev?.type === 'usage') {                            // the weekly limit: the slider shows only once one arrives
    if (Number.isFinite(Number(ev.total_used_pct))) state.usage = { total_used_pct: Number(ev.total_used_pct) };
    return true;
  }
  if (Array.isArray(ev?.roster)) {                       // {"roster":[names]}: every bot shows up, resting until it posts
    for (const raw of ev.roster.slice(0, 200)) {
      const name = String(raw ?? '').trim().slice(0, 60), id = name && botId(name);
      if (id && !state.bots[id]) state.bots[id] = { id, name, step: '', status: 'idle', effective_status: 'idle', last_event: at };
    }
    return true;
  }
  const name = String(ev?.bot ?? '').trim().slice(0, 60);
  if (!name) return false;
  const id = botId(name), b = state.bots[id] || (state.bots[id] = { id, name });
  const word = String(ev.status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  b.name = name;
  b.step = String(ev.step ?? '').slice(0, 80);
  b.status = b.effective_status = WORDS[word] || (b.step ? 'working' : 'idle');
  b.last_event = at;
  return true;
}
// the channel keeps 12 hours, the wallpaper remembers every bot it has seen: a quiet bot stays on screen, resting
const MEMORY_KEY = `gbw.bots.${FEED}`;
function remember() { try { localStorage.setItem(MEMORY_KEY, JSON.stringify({ bots: state.bots, looks, usage: state.usage })); } catch { /* not remembered */ } }
function settleQuiet() {                                 // a finished task rests after 30 min, a silent one after 3 h
  const now = Date.now();
  let changed = false;
  for (const b of Object.values(state.bots)) {
    const quiet = now - Date.parse(b.last_event);
    if ((b.status === 'done' && quiet > 30 * 60e3) || (b.status === 'working' && quiet > 3 * 3600e3)) { b.status = b.effective_status = 'idle'; changed = true; }
  }
  return changed;
}
async function connectFeed() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(MEMORY_KEY)) || {}; } catch { /* nothing remembered yet */ }
  if (!saved.bots) saved = { bots: saved };              // the first version remembered the bots alone
  looks = saved.looks || {};
  state = { bots: saved.bots, usage: saved.usage ?? null };
  // the usual mailbox (ntfy.sh) means "read both", like the office: bots on the first prompt post to ntfy.sh, bots on
  // the current one to our relay; a link that names another server reads only that one
  const boxes = (NTFY === FEED_BASE.replace(/\/$/, '') ? [RELAY, NTFY] : [NTFY]).map((s) => `${s}/${encodeURIComponent(FEED)}`);
  const seen = new Set();
  const fresh = (m) => { const k = `${m.time} ${m.message}`; return !seen.has(k) && !!seen.add(k); };   // a line in both boxes counts once
  const rows = [];
  await Promise.all(boxes.map(async (base) => {
    try {
      const text = await (await fetch(`${base}/json?poll=1&since=12h`, { cache: 'no-store' })).text();
      for (const line of text.split('\n')) {
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.event === 'message') rows.push(m);
      }
    } catch { /* offline or down: the other box and what is remembered still show the bots */ }
  }));
  rows.sort((a, b) => a.time - b.time);
  for (const m of rows) if (fresh(m)) applyLine(m.message, m.time);
  settleQuiet();
  remember();
  render(state);
  const take = (data) => {
    try { const m = JSON.parse(data); if (m.event === 'message' && fresh(m) && applyLine(m.message, m.time)) { remember(); render(state); } } catch { /* keepalive or junk */ }
  };
  for (const base of boxes) {
    if (!base.startsWith(RELAY)) { new EventSource(`${base}/sse`).onmessage = (e) => take(e.data); continue; }
    // the relay: a WebSocket its server sleeps through ("ping" is answered without waking it); reconnect with backoff
    let wait = 1e3, heard = Date.now();
    (function open() {
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
      const ping = setInterval(() => {
        if (Date.now() - heard > 150e3) ws.close();
        else if (ws.readyState === 1) ws.send('ping');
      }, 60e3);
      ws.onopen = () => { wait = 1e3; heard = Date.now(); };
      ws.onmessage = (e) => { heard = Date.now(); if (e.data !== 'pong') take(e.data); };
      ws.onclose = () => { clearInterval(ping); setTimeout(open, wait); wait = Math.min(wait * 2, 60e3); };
    })();
  }
  setInterval(() => { if (settleQuiet()) { remember(); render(state); } }, 60e3);
}

// ---------- data: the live server, else nothing (only the bot); the bundled demo with ?demo=1 ----------
async function poll() {
  let res;
  try {
    res = await fetch('../api/state', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return;                                 // no Bot HQ server behind this page (GitHub Pages): no cards
    state = await res.json();
    render(state);
    setTimeout(poll, 2000);
  } catch {
    if (!res) setTimeout(poll, 10e3);                    // no answer at all: the local server is starting, try again
  }
}
async function startDemo() {
  state = await (await fetch('../data/demo-state.json')).json();
  render(state);
  const steps = ['working', 'working', 'working', 'done', 'idle', 'waiting_user', 'error'];
  setInterval(() => {
    const bots = Object.values(state.bots);
    const b = bots[Math.floor(Math.random() * bots.length)];
    b.effective_status = b.status = steps[Math.floor(Math.random() * steps.length)];
    b.last_event = new Date().toISOString();
    render(state);
  }, 3500);
}
if (FEED) connectFeed();
else if (params.get('demo') === '1') {                   // made-up bots, only when a link asks for them
  fetch('../data/demo-looks.json').then((r) => (r.ok ? r.json() : {})).then((j) => { looks = j.looks || j || {}; if (state) { crew = ''; needs.innerHTML = ''; render(state); } }).catch(() => {});
  startDemo();
} else poll();
