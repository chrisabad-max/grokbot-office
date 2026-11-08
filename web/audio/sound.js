// Sound for the dashboard: a calm music loop (music-loop.m4a) and small effects made on the fly with Web Audio.
// Browsers allow sound only after a click or a key press, so nothing plays before the first one. The speaker button
// in the top bar switches the music and the effects separately; the choice is kept in localStorage. Everything fades
// out while the tab is hidden. The loop file is one 16-bar cycle plus 2 s that equal its own start, so each copy
// crossfades into the next without a seam (the music is made by assets/_src/audio/make_loop.py).
// Every effect is in the music's key (C major pentatonic), so they sit inside it instead of on top of it.

const PREFS_KEY = 'bothq.sound';
const LOOP_URL = new URL('./music-loop.m4a', import.meta.url).href;
const CYCLE = (16 * 4 * 60) / 84;          // the loop's period, s
const OVERLAP = 2;                          // s of the file past the period, crossfaded into the next copy
const MUSIC_GAIN = 0.4, FX_GAIN = 0.75, OUT_GAIN = 0.9;
const PENTA = [72, 74, 76, 79, 81, 84];     // C5 D5 E5 G5 A5 C6: each bot hops on its own note
const FLOOR_NOTES = [76, 79, 81, 84, 86, 88, 91, 93];

const ICON_ON = '<svg class="bhq-snd-on" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3.2 7.6h2.9L10 4.5v11L6.1 12.4H3.2z" fill="currentColor"/><path d="M13 7.3a3.9 3.9 0 0 1 0 5.4M15.3 5.1a7 7 0 0 1 0 9.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_OFF = '<svg class="bhq-snd-off" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3.2 7.6h2.9L10 4.5v11L6.1 12.4H3.2z" fill="currentColor"/><path d="M13.2 8l4 4m0-4l-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

let prefs = readPrefs();
let ctx = null, out = null, musicBus = null, fxBus = null, verbIn = null, noise = null;
let enabled = false, unlocked = false, ui = null;
const music = { buf: null, loading: null, next: 0, first: true, timer: 0, playing: false, srcs: new Set() };
const last = new Map();

/** for checks from the console: import('./audio/sound.js').then((m) => m.soundState()) */
export function soundState() {
  return { ctx: ctx?.state ?? 'none', unlocked, prefs: { ...prefs }, music: music.playing, loaded: !!music.buf, copies: music.srcs.size };
}

function readPrefs() {
  try { return { music: true, fx: true, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return { music: true, fx: true }; }
}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } }

/** turn the effects on or off from another page's own button (the landing's speaker); kept with the dashboard's choice */
export function setFx(on) { set('fx', on); }
export const fxOn = () => prefs.fx;

/** once per page: the speaker button (into `slot`), the gesture that unlocks audio, the tab-hidden fade.
 *  withMusic: false keeps the loop off (the landing has effects only) */
export function initSound({ slot, withMusic = true } = {}) {
  if (enabled) return;
  enabled = true;
  if (slot) buildButton(slot);
  const unlock = () => {
    // iPhone: play as media, so the silent switch doesn't mute the dashboard (Safari 16.4+)
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older Safari */ }
    if (!boot()) return;
    ctx.resume?.();
    if (unlocked) return;
    unlocked = true;
    for (const t of ['pointerdown', 'keydown', 'touchend']) removeEventListener(t, unlock, true);
    if (prefs.music && withMusic) startMusic();
  };
  for (const t of ['pointerdown', 'keydown', 'touchend']) addEventListener(t, unlock, true);
  document.addEventListener('visibilitychange', () => {
    if (!ctx || !unlocked) return;
    const now = ctx.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    if (document.hidden) {
      out.gain.linearRampToValueAtTime(0, now + 0.4);
      setTimeout(() => { if (document.hidden) ctx.suspend?.(); }, 500);
    } else {
      ctx.resume?.();
      out.gain.linearRampToValueAtTime(OUT_GAIN, now + 1.2);
    }
  });
  // panels and the phone sheet are plain buttons in the UI: listen for them here instead of wiring each one
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const toggle = el.closest('.bhq-dtoggle');
    if (toggle) return void queueMicrotask(() => sfx.panel(toggle.getAttribute('aria-expanded') === 'true'));
    const grab = el.closest('.bhq-sgrab');
    if (grab) return void queueMicrotask(() => sfx.zoom(grab.getAttribute('aria-expanded') === 'true' ? 'in' : 'out', 0.4));
    if (el.closest('.bhq-eye')) sfx.tick();
  });
  // a wheel gesture is many events: one whoosh per gesture, in its direction
  let wheelAt = 0;
  document.getElementById('scene')?.addEventListener('wheel', (e) => {
    const now = performance.now();
    if (now - wheelAt > 280) sfx.zoom(e.deltaY < 0 ? 'in' : 'out');
    wheelAt = now;
  }, { passive: true });
}

function boot() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try { ctx = new AC({ latencyHint: 'interactive' }); } catch { return false; }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.25;
  out = ctx.createGain();
  out.gain.value = OUT_GAIN;
  out.connect(comp);
  comp.connect(ctx.destination);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(out);
  fxBus = ctx.createGain();
  fxBus.gain.value = prefs.fx ? FX_GAIN : 0;
  fxBus.connect(out);
  const verb = ctx.createConvolver();
  verb.buffer = impulse(2.2, 1.6);
  verbIn = ctx.createGain();
  verbIn.connect(verb);
  verb.connect(fxBus);
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return true;
}

/** a small room: decaying noise that gets darker as it fades, 12 ms before the first reflection */
function impulse(len, rt60) {
  const sr = ctx.sampleRate, n = Math.floor(len * sr), pre = Math.floor(0.012 * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let y = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const a = 1 - Math.exp((-2 * Math.PI * (500 + 7000 * Math.exp(-t * 1.8))) / sr);
      y += a * (Math.random() * 2 - 1 - y);
      d[i] = y * Math.exp((-6.91 * t) / rt60);
    }
  }
  return buf;
}

// ---------------------------------------------------------------- music

async function startMusic() {
  if (!ctx || music.playing) return;
  music.playing = true;
  try {
    music.buf ||= await (music.loading ||= fetch(LOOP_URL).then((r) => r.arrayBuffer())
      .then((b) => new Promise((res, rej) => ctx.decodeAudioData(b, res, rej))));
  } catch {
    music.playing = false;
    music.loading = null;
    return;
  }
  if (!music.playing) return;                               // switched off while it loaded
  const now = ctx.currentTime;
  musicBus.gain.cancelScheduledValues(now);
  musicBus.gain.setValueAtTime(musicBus.gain.value, now);
  musicBus.gain.linearRampToValueAtTime(MUSIC_GAIN, now + 3);
  music.next = now + 0.05;
  music.first = true;
  pump();
  clearInterval(music.timer);
  music.timer = setInterval(pump, 1000);
}

function pump() {
  while (music.playing && music.next < ctx.currentTime + 3) {
    const at = music.next, s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = music.buf;
    if (music.first) g.gain.setValueAtTime(1, at);
    else { g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(1, at + OVERLAP); }
    g.gain.setValueAtTime(1, at + CYCLE);
    g.gain.linearRampToValueAtTime(0, at + CYCLE + OVERLAP);
    s.connect(g);
    g.connect(musicBus);
    s.start(at);
    s.stop(at + CYCLE + OVERLAP);
    music.srcs.add(s);
    s.onended = () => music.srcs.delete(s);
    music.first = false;
    music.next += CYCLE;
  }
}

function stopMusic() {
  music.playing = false;
  clearInterval(music.timer);
  if (!ctx) return;
  const now = ctx.currentTime;
  musicBus.gain.cancelScheduledValues(now);
  musicBus.gain.setValueAtTime(musicBus.gain.value, now);
  musicBus.gain.linearRampToValueAtTime(0, now + 0.8);
  for (const s of music.srcs) { try { s.stop(now + 0.9); } catch { /* already stopped */ } }
  music.srcs.clear();
}

// ---------------------------------------------------------------- effects

const hz = (m) => 440 * 2 ** ((m - 69) / 12);

function ready(key, ms) {
  if (!ctx || !unlocked || !prefs.fx || ctx.state !== 'running' || document.hidden) return false;
  if (!key) return true;
  const now = performance.now();
  if (now - (last.get(key) || 0) < ms) return false;
  last.set(key, now);
  return true;
}

/** a sum node for one sound: dry to the effects bus, a share to the room, placed left or right */
function voice(pan = 0, room = 0.2) {
  const g = ctx.createGain();
  let node = g;
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    node = p;
  }
  node.connect(fxBus);
  if (room) {
    const s = ctx.createGain();
    s.gain.value = room;
    node.connect(s);
    s.connect(verbIn);
  }
  return g;
}

function env(param, t, peak, attack, decay) {
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function osc(type, f, t, dur, dest, peak, attack, decay) {
  const o = ctx.createOscillator(), a = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  env(a.gain, t, peak, attack, decay);
  o.connect(a);
  a.connect(dest);
  o.start(t);
  o.stop(t + dur);
  return o;
}

/** a small physical click: a snap of filtered noise, a glassy ping and a little body */
function click(t, gain = 0.45, pan = 0) {
  const v = voice(pan, 0.06);
  const n = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
  n.buffer = noise;
  bp.type = 'bandpass';
  bp.frequency.value = 3000 + Math.random() * 600;
  bp.Q.value = 1.3;
  env(ng.gain, t, gain, 0.001, 0.022);
  n.connect(bp);
  bp.connect(ng);
  ng.connect(v);
  n.start(t, Math.random() * 1.5);
  n.stop(t + 0.05);
  osc('sine', 2100 * (0.96 + Math.random() * 0.08), t, 0.04, v, gain * 0.3, 0.001, 0.02);
  osc('sine', 190, t, 0.07, v, gain * 0.45, 0.001, 0.035);
}

/** a round two-harmonic note that springs into pitch (up), or falls into it (down) */
function bloop(t, m, gain, pan = 0, down = false) {
  const f = hz(m), v = voice(pan, 0.28);
  for (const [mul, g] of [[1, gain], [2, gain * 0.22]]) {
    const o = osc('sine', f * mul * (down ? 1.35 : 0.55), t, 0.36, v, g, 0.003, 0.3);
    o.frequency.exponentialRampToValueAtTime(f * mul, t + 0.028);
  }
}

/** a bot's hop: a note whose pitch wobbles like a spring and settles */
function boing(t, m, gain, pan = 0) {
  const f = hz(m), v = voice(pan, 0.2), curve = new Float32Array(48);
  for (let i = 0; i < curve.length; i++) {
    const s = (i / (curve.length - 1)) * 0.36;
    curve[i] = f * (1 + 0.26 * Math.exp(-13 * s) * Math.sin(2 * Math.PI * 11 * s)) * (0.86 + 0.14 * (1 - Math.exp(-30 * s)));
  }
  const o = osc('sine', f, t, 0.4, v, gain, 0.002, 0.34);
  o.frequency.cancelScheduledValues(t);
  o.frequency.setValueCurveAtTime(curve, t, 0.36);
}

/** a soft bell: FM with a fading index, plus an octave */
function chime(t, m, gain, pan = 0.15) {
  const f = hz(m), v = voice(pan, 0.5);
  const car = osc('sine', f, t, 1.9, v, gain, 0.002, 1.6);
  const mod = ctx.createOscillator(), depth = ctx.createGain();
  mod.frequency.value = f * 3;
  depth.gain.setValueAtTime(f * 0.5, t);
  depth.gain.exponentialRampToValueAtTime(f * 0.01, t + 0.6);
  mod.connect(depth);
  depth.connect(car.frequency);
  mod.start(t);
  mod.stop(t + 1.9);
  osc('sine', f * 2, t, 0.7, v, gain * 0.18, 0.002, 0.5);
}

/** air that follows the camera: 'in' rises, 'out' falls, 'slide' is the elevator */
function whoosh(t, dir, dur = 0.55, gain = 0.3) {
  const v = voice(0, 0.2);
  const n = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), a = ctx.createGain();
  const [f0, f1] = dir === 'in' ? [450, 3600] : dir === 'out' ? [3200, 380] : [300, 1500];
  n.buffer = noise;
  n.loop = true;
  bp.type = 'bandpass';
  bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
  a.gain.setValueAtTime(0.0001, t);
  a.gain.linearRampToValueAtTime(gain, t + dur * (dir === 'in' ? 0.6 : 0.35));
  a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(bp);
  bp.connect(a);
  a.connect(v);
  n.start(t, Math.random());
  n.stop(t + dur + 0.05);
}

/** a muted low note for errors: a triangle through a closing low-pass */
function knock(t, m, gain) {
  const v = voice(0, 0.25), lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800, t);
  lp.frequency.exponentialRampToValueAtTime(400, t + 0.3);
  lp.connect(v);
  osc('triangle', hz(m), t, 0.5, lp, gain, 0.004, 0.42);
}

function noteFor(id) {
  let h = 2166136261;
  for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return PENTA[(h >>> 0) % PENTA.length];
}

export const sfx = {
  tick() { if (ready('tick', 40)) click(ctx.currentTime, 0.35); },
  /** the cursor reached a bot: it hops, on its own note */
  hover(id) {
    if (!id || !ready('hover:' + id, 450) || !ready('hover', 70)) return;
    boing(ctx.currentTime + 0.01, noteFor(id), 0.16, (Math.random() - 0.5) * 0.5);
  },
  /** a bot's card opens (two notes up) or closes (two notes down) */
  select(open) {
    if (!ready('select', 120)) return;
    const t = ctx.currentTime + 0.01;
    if (open) { click(t, 0.4); bloop(t + 0.02, 79, 0.2, 0.3); bloop(t + 0.09, 88, 0.17, 0.3); }
    else { bloop(t, 88, 0.12, 0.3, true); bloop(t + 0.07, 79, 0.1, 0.3, true); }
  },
  /** the elevator: a click, the slide, a soft mechanism, then a chime on arrival (higher floors ring higher) */
  floor(index = 0) {
    if (!ready('floor', 150)) return;
    const t = ctx.currentTime + 0.01;
    click(t, 0.4, -0.4);
    whoosh(t + 0.01, 'slide', 0.42, 0.22);
    osc('sine', 95, t + 0.02, 0.25, voice(0, 0), 0.22, 0.003, 0.16).frequency.exponentialRampToValueAtTime(70, t + 0.2);
    chime(t + 0.16, FLOOR_NOTES[Math.max(0, Math.min(FLOOR_NOTES.length - 1, index))], 0.12);
  },
  zoom(dir, dur = 0.55) { if (ready('zoom', 200)) whoosh(ctx.currentTime + 0.005, dir === 'in' ? 'in' : 'out', dur, 0.2); },
  panel(open) {
    if (!ready('panel', 120)) return;
    const t = ctx.currentTime + 0.01;
    click(t, 0.35, -0.35);
    bloop(t + 0.01, open ? 84 : 79, 0.13, -0.35, !open);
  },
  /** a bot changed status: waiting for you (ding-dong), an error (two low knocks), done (a rising arpeggio) */
  status(kind) {
    if (!ready('status', 2500) || !ready('status:' + kind, 6000)) return;
    const t = ctx.currentTime + 0.02;
    if (kind === 'waiting_user') { chime(t, 88, 0.14); chime(t + 0.2, 84, 0.13); }
    else if (kind === 'error') { knock(t, 69, 0.16); knock(t + 0.17, 65, 0.15); }
    else if (kind === 'done') { chime(t, 84, 0.08, 0.2); chime(t + 0.08, 88, 0.08, 0.25); chime(t + 0.16, 91, 0.08, 0.3); }
  },

  // the landing: its switches, buttons and the wallpaper's blink (face.js tells the page with gbw:blink)
  /** a switch moved to option i of n: a click and a note that falls as the options go on (morning to night, white to black) */
  pick(i = 0, n = 2) {
    if (!ready('pick', 60)) return;
    const t = ctx.currentTime + 0.005, m = [84, 81, 79, 76][Math.round((i / Math.max(1, n - 1)) * 3)];
    click(t, 0.32, 0.25);
    bloop(t + 0.012, m, 0.13, 0.25);
  },
  /** a download or a button that leads somewhere: a click and a soft bell, then its fifth */
  press() {
    if (!ready('press', 150)) return;
    const t = ctx.currentTime + 0.005;
    click(t, 0.4);
    chime(t + 0.02, 84, 0.08, 0);
    chime(t + 0.09, 91, 0.05, 0.1);
  },
  /** the prompt is on the clipboard: a click and three notes up */
  copied() {
    if (!ready('copied', 300)) return;
    const t = ctx.currentTime + 0.005;
    click(t, 0.38);
    chime(t + 0.03, 84, 0.08, 0.1); chime(t + 0.1, 88, 0.08, 0.15); chime(t + 0.17, 91, 0.08, 0.2);
  },
  /** a link to a part of the page: a click and the page sliding down */
  nav() {
    if (!ready('nav', 150)) return;
    const t = ctx.currentTime + 0.005;
    click(t, 0.3);
    whoosh(t + 0.02, 'out', 0.6, 0.14);
  },
  /** a card picked up (a small lift) or put down (a soft landing) */
  grab() { if (ready('grab', 80)) { const t = ctx.currentTime + 0.005; click(t, 0.3); bloop(t + 0.01, 79, 0.1, 0); } },
  drop() {
    if (!ready('drop', 80)) return;
    const t = ctx.currentTime + 0.005;
    click(t, 0.22);
    osc('sine', 150, t, 0.16, voice(0, 0.1), 0.2, 0.003, 0.11).frequency.exponentialRampToValueAtTime(95, t + 0.1);
  },
  /** the eyes shut (a low tap that falls) and open (a lighter one that rises), in step with face.js's BLINK curve */
  blink() {
    if (!ready('blink', 300)) return;
    const t = ctx.currentTime + 0.005, v = voice(0, 0.22);
    osc('sine', hz(81), t, 0.1, v, 0.08, 0.002, 0.07).frequency.exponentialRampToValueAtTime(hz(76), t + 0.06);
    osc('sine', hz(88), t + 0.19, 0.12, v, 0.05, 0.004, 0.08).frequency.exponentialRampToValueAtTime(hz(93), t + 0.25);
  },
};

// ---------------------------------------------------------------- the speaker button

function buildButton(slot) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bhq-snd bhq-surface';
  btn.setAttribute('aria-label', 'Sound');
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = ICON_ON + ICON_OFF;
  const pop = document.createElement('div');
  pop.className = 'bhq-snd-pop bhq-surface';
  pop.setAttribute('role', 'group');
  pop.setAttribute('aria-label', 'Sound');
  pop.hidden = true;
  const rows = {};
  for (const [key, label] of [['music', 'Music'], ['fx', 'Sounds']]) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bhq-snd-row';
    row.setAttribute('role', 'switch');
    row.innerHTML = `<span>${label}</span><i class="bhq-snd-sw" aria-hidden="true"></i>`;
    row.addEventListener('click', () => set(key, !prefs[key]));
    rows[key] = row;
    pop.append(row);
  }
  slot.prepend(btn);
  document.body.append(pop);

  const place = () => {
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 8)}px`;
    pop.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
  };
  const show = (on) => {
    if (on) place();
    pop.hidden = !on;
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  btn.addEventListener('click', () => show(pop.hidden));
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) show(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });
  addEventListener('resize', () => { if (!pop.hidden) place(); });
  ui = { btn, rows };
  paint();
}

function paint() {
  if (!ui) return;
  ui.btn.classList.toggle('is-off', !prefs.music && !prefs.fx);
  for (const k of ['music', 'fx']) ui.rows[k].setAttribute('aria-checked', prefs[k] ? 'true' : 'false');
}

function set(key, on) {
  prefs[key] = on;
  savePrefs();
  paint();
  if (!ctx) return;
  if (key === 'music') { if (on) startMusic(); else stopMusic(); }
  if (key === 'fx') {
    const now = ctx.currentTime;
    fxBus.gain.cancelScheduledValues(now);
    fxBus.gain.setValueAtTime(fxBus.gain.value, now);
    fxBus.gain.linearRampToValueAtTime(on ? FX_GAIN : 0, now + 0.15);
    if (on) setTimeout(() => sfx.tick(), 180);
  }
}
