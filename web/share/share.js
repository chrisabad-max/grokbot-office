// Share card: a 1600x900 PNG of the user's own office, ready to post on X. The share button in the top bar (ui.js)
// loads this module on first use and calls toggleShare().
//
// The image: the current floor with its bots, framed like a product shot on the white studio (scene.js captureScene),
// a caption under it: the brand mark and "Grok Bot Dashboard" on the left, one quiet line of numbers on the right.
// Nothing private: no tags, names, steps or tasks (captureScene keeps them out of the frame), no topic, no link.
//
// The card: a graphite surface under the button with the preview and the actions.
//   phone (coarse pointer + Web Share with files): Share… (the system sheet, straight to the X app), Download
//   desktop: Copy image (image/png), Download, Post on X (copies the image, then opens the X composer: just paste)
// Esc, a click outside or the button again close it.
import { captureScene } from '../scene/scene.js';
import { sfx } from '../audio/sound.js';

const W = 1600, H = 900;
const SUPERSAMPLE = 1.5;                               // desktop only: phones render at 1x (GPU memory)
const MARK_SRC = new URL('../../assets/brand/logo-mark.png', import.meta.url).href;
const FILE_NAME = 'grok-bot-office.png';
const POST_TEXT = 'My Grok Bot office';
const INK = '#16171A', GREY = '#7A7B82', WORKING = '#34C759';
const BRAND_FONT = '"Nunito", ui-rounded, system-ui, sans-serif';
const TEXT_FONT = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

let C = null;                                          // the card, built once
let job = 0;

/** Open the card under `anchor` (or close it when it is open). state: what ui.js last rendered. */
export function toggleShare({ anchor, state }) {
  if (C && !C.root.hidden) return close();
  if (!C) build();
  C.anchor = anchor;
  C.state = state;
  open();
}

/* ------------------------------------------------------------------ the image */

/** The share PNG as a Blob, or null while the office is still loading. */
export async function makeShareImage(state) {
  const shot = captureScene({ width: W, height: H, scale: coarse() ? 1 : SUPERSAMPLE, box: { x: 0.06, y: 0.055, w: 0.88, h: 0.75 } });
  if (!shot) return null;
  const [mark] = await Promise.all([loadImage(MARK_SRC).catch(() => null), fonts()]);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(shot, 0, 0);
  caption(g, mark, stats(state));
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

// The caption row, 64 px from the edges: mark + wordmark on the left, the numbers on the right, on one centre line.
function caption(g, mark, parts) {
  const m = 64, s = 56, cy = H - m - s / 2;
  if (mark) {
    g.save();
    roundRect(g, m, cy - s / 2, s, s, 14);
    g.clip();
    g.drawImage(mark, m, cy - s / 2, s, s);
    g.restore();
  }
  g.textBaseline = 'alphabetic';
  g.fillStyle = INK;
  g.font = `900 34px ${BRAND_FONT}`;
  track(g, -0.3);
  g.fillText('Grok Bot Dashboard', mark ? m + s + 18 : m, cy + capHalf(g));

  // "18 bots · 4 teams · ● 6 working now": the numbers in ink, the words in grey, right-aligned
  track(g, 0);
  const runs = [];
  parts.forEach((p, i) => {
    if (i) runs.push({ t: '   ·   ', f: `500 26px ${TEXT_FONT}`, c: GREY });
    if (p.dot) runs.push({ dot: true });
    runs.push({ t: String(p.n), f: `650 26px ${TEXT_FONT}`, c: INK }, { t: ` ${p.word}`, f: `500 26px ${TEXT_FONT}`, c: GREY });
  });
  const DOT = 10, DOT_GAP = 10;
  let total = 0;
  for (const r of runs) { if (r.dot) total += DOT + DOT_GAP; else { g.font = r.f; r.w = g.measureText(r.t).width; total += r.w; } }
  g.font = `650 26px ${TEXT_FONT}`;
  const base = cy + capHalf(g);
  let x = W - m - total;
  for (const r of runs) {
    if (r.dot) {
      g.fillStyle = WORKING;
      g.beginPath(); g.arc(x + DOT / 2, cy, DOT / 2, 0, Math.PI * 2); g.fill();
      x += DOT + DOT_GAP;
      continue;
    }
    g.font = r.f; g.fillStyle = r.c;
    g.fillText(r.t, x, base);
    x += r.w;
  }
}

function stats(state) {
  const bots = Object.values(state?.bots || {});
  const teams = (state?.floors || []).length;
  const working = bots.filter((b) => (b.effective_status || b.status) === 'working').length;
  const parts = [{ n: bots.length, word: bots.length === 1 ? 'bot' : 'bots' }];
  if (teams > 1) parts.push({ n: teams, word: 'teams' });
  if (working) parts.push({ n: working, word: 'working now', dot: true });
  return parts;
}

// half the cap height of the current font: baseline = centre line + this
function capHalf(g) {
  const k = g.measureText('H');
  return (k.actualBoundingBoxAscent - k.actualBoundingBoxDescent) / 2;
}

function track(g, px) { if ('letterSpacing' in g) g.letterSpacing = `${px}px`; }

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// the page links Nunito and Inter; make sure the weights the caption uses are in before it is drawn
function fonts() {
  if (!document.fonts?.load) return Promise.resolve();
  const want = [`900 34px ${BRAND_FONT}`, `500 26px ${TEXT_FONT}`, `650 26px ${TEXT_FONT}`];
  return Promise.race([
    Promise.all(want.map((f) => document.fonts.load(f, 'Grok Bot Dashboard 0123456789 teams working now'))),
    new Promise((r) => setTimeout(r, 2000)),
  ]).catch(() => {});
}

/* ------------------------------------------------------------------ the card */

function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c != null && c !== false) n.append(c);
  return n;
}

const coarse = () => matchMedia('(pointer: coarse)').matches;
const canCopy = () => !!(navigator.clipboard?.write && window.ClipboardItem);

function build() {
  const close_ = h('button', { class: 'bhq-shr-x', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' });
  close_.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  const img = h('img', { alt: 'Your office, ready to post', draggable: 'false' });
  const wait = h('span', { class: 'bhq-shr-wait', text: 'Framing your office…' });
  const pic = h('div', { class: 'bhq-shr-img' }, img, wait);
  const btn = (label, cls = '') => h('button', { class: `bhq-shr-btn ${cls}`.trim(), type: 'button', text: label, disabled: true });
  const share = btn('Share…', 'bhq-shr-btn--main');
  const copy = btn('Copy image');
  const save = btn('Download');
  const post = btn('Post on X', 'bhq-shr-btn--main');
  const acts = h('div', { class: 'bhq-shr-acts' });
  const note = h('p', { class: 'bhq-shr-note', role: 'status', 'aria-live': 'polite' });
  const root = h('div', { class: 'bhq-shr bhq-surface', role: 'dialog', 'aria-label': 'Share your office', tabindex: '-1', hidden: true },
    h('div', { class: 'bhq-shr-head' }, h('b', { class: 'bhq-shr-title', text: 'Share your office' }), close_),
    pic, acts, note);
  document.body.append(root);
  C = { root, img, pic, wait, acts, note, share, copy, save, post, blob: null, url: null, file: null, anchor: null, state: null };

  close_.addEventListener('click', () => close());
  share.addEventListener('click', onShare);
  copy.addEventListener('click', onCopy);
  save.addEventListener('click', onSave);
  post.addEventListener('click', onPost);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || root.hidden) return;
    e.preventDefault();
    e.stopPropagation();                                 // the bot card stays as it is (app.js and ui.js close it on Esc)
    close();
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (root.hidden || root.contains(e.target) || C.anchor?.contains(e.target)) return;
    close();
  }, true);
  addEventListener('resize', () => { if (!root.hidden) place(); });
}

function open() {
  const { root } = C;
  const phone = coarse() && typeof navigator.canShare === 'function';
  root.classList.toggle('bhq-shr--phone', innerWidth <= 600);
  C.acts.replaceChildren(...(phone ? [C.share, C.save] : canCopy() ? [C.copy, C.save, C.post] : [C.save, C.post]));
  setNote(phone ? '' : canCopy() ? `Post on X copies the image: paste it with ${MAC ? '⌘V' : 'Ctrl V'}.` : '');
  for (const b of [C.share, C.copy, C.save, C.post]) b.disabled = true;
  C.pic.classList.remove('is-ready');
  C.wait.hidden = false;
  C.wait.textContent = 'Framing your office…';
  root.hidden = false;
  place();
  C.anchor?.setAttribute('aria-expanded', 'true');
  root.focus({ preventScroll: true });
  sfx.tick();

  // let the card paint first: the render takes a moment
  const id = ++job;
  requestAnimationFrame(() => setTimeout(async () => {
    if (id !== job || root.hidden) return;
    let blob = null;
    try { blob = await makeShareImage(C.state); } catch (err) { console.warn('[share]', err); }
    if (id !== job) return;
    if (!blob) { C.wait.textContent = 'The office is still loading. Try again in a moment.'; return; }
    if (C.url) URL.revokeObjectURL(C.url);
    C.blob = blob;
    C.url = URL.createObjectURL(blob);
    C.img.onload = () => { if (id === job) { C.pic.classList.add('is-ready'); C.wait.hidden = true; } };
    C.img.src = C.url;
    const file = new File([blob], FILE_NAME, { type: 'image/png' });
    C.file = file;
    if (phone && !navigator.canShare({ files: [file] })) C.acts.replaceChildren(...(canCopy() ? [C.copy, C.save, C.post] : [C.save, C.post]));
    for (const b of [C.share, C.copy, C.save, C.post]) b.disabled = false;
  }, 0));
}

function close() {
  if (!C || C.root.hidden) return;
  job++;
  const hadFocus = C.root.contains(document.activeElement);
  C.root.hidden = true;
  C.anchor?.setAttribute('aria-expanded', 'false');
  if (hadFocus) C.anchor?.focus({ preventScroll: true });
}

// under the button, right edges aligned (desktop); full width with a 12 px gutter on phones (share.css)
function place() {
  const r = C.anchor?.getBoundingClientRect();
  if (!r) return;
  C.root.style.top = `${Math.round(r.bottom + 10)}px`;
  C.root.style.right = C.root.classList.contains('bhq-shr--phone') ? '' : `${Math.max(12, Math.round(innerWidth - r.right))}px`;
}

function setNote(text) { C.note.textContent = text; C.note.hidden = !text; }

async function copyBlob() {
  if (!C.blob || !canCopy()) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': C.blob })]);
    return true;
  } catch (err) {
    console.warn('[share] copy failed', err);
    return false;
  }
}

async function onCopy() {
  const ok = await copyBlob();
  setNote(ok ? 'Copied. Paste it anywhere.' : 'Copying is blocked here. Use Download instead.');
  if (ok) sfx.tick();
}

function onSave() {
  if (!C.url) return;
  const a = h('a', { href: C.url, download: FILE_NAME });
  document.body.append(a);
  a.click();
  a.remove();
}

async function onPost() {
  // the composer cannot take an image from a link: copy it first, then the user just pastes it into the post
  const ok = await Promise.race([copyBlob(), new Promise((r) => setTimeout(() => r(false), 1500))]);
  // no link: the site's front page is not the dashboard's, and the page's own address carries the user's topic
  const q = new URLSearchParams({ text: POST_TEXT });
  window.open(`https://x.com/intent/post?${q}`, '_blank', 'noopener');
  setNote(ok ? `Image copied. In the post, paste it with ${MAC ? '⌘V' : 'Ctrl V'}.` : 'Download the image, then add it to your post.');
}

async function onShare() {
  if (!C.file) return;
  try {
    await navigator.share({ files: [C.file], text: POST_TEXT });
  } catch (err) {
    if (err?.name !== 'AbortError') setNote('Sharing did not work here. Use Download instead.');
  }
}
