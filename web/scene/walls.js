// Live wall screen ("Today · <floor>") and task board, drawn on canvases that texture the meshes
// `wall_screen` and `task_board` of the open floor (CONTRACT v2.5). Redrawn only when the data changes (≤ 1/s).
import * as THREE from 'three';

const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
const STATUS = { working: '#34C759', waiting_user: '#FF9F0A', error: '#FF3B30', stuck: '#FF9500', done: '#0A84FF', idle: '#A1A1A6' };
const RANK = { waiting_user: 0, error: 0, stuck: 0, working: 1, done: 2, idle: 3 };
const TSK_ID = /^tsk-\d+$/i;

let fontsReady = false;
const fontsPromise = (async () => {
  try {
    if (document.fonts) {
      await Promise.race([
        Promise.all([
          document.fonts.load('600 24px Inter', 'Today Tasks 0123456789'),
          document.fonts.load('500 24px Inter', 'Working events'),
          document.fonts.load('700 24px Inter', '0123456789'),
        ]).then(() => document.fonts.ready),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    }
  } catch { /* system-ui fallback */ }
  fontsReady = true;
})();

export function taskTitle(bot) {
  const t = (bot.task || '').trim();
  if (t && !TSK_ID.test(t)) return t;
  return (bot.step || '').trim();
}

function sofiaHour(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hour12: false }).format(d);
    return Number(h) % 24;
  } catch { return new Date().getHours(); }
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return { c, g: c.getContext('2d'), tex };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wrapText(g, text, maxW, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (g.measureText(test).width <= maxW || !line) line = test;
    else { lines.push(line); line = words[i]; }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && (words.join(' ') !== lines.join(' '))) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && g.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.replace(/[\s,.;:]+$/, '')}…`;
  }
  return lines;
}

export class WallDisplays {
  constructor(wallScreen, taskBoard) {
    this.screen = wallScreen ? { mesh: wallScreen, ...makeCanvas(1536, 864), S: 1.6, W: 960, H: 540 } : null;
    this.board = taskBoard ? { mesh: taskBoard, ...makeCanvas(1800, 900), S: 1.8, W: 1000, H: 500 } : null;
    for (const d of [this.screen, this.board]) {
      if (!d) continue;
      d.mat = new THREE.MeshBasicMaterial({ map: d.tex, name: d.mesh.name });
      d.mesh.material = d.mat;
      d.drawn = null;
    }
    if (this.screen) this.screen.mat.toneMapped = false;
    this.sig = '';
    this.data = null;
    this.accent = null;                                    // the floor's accent (floorstyle.js): a dot before its name
    this.lastDraw = -1e9;
    this.dirty = false;
    this.fontsAtDraw = false;
  }

  get materials() { return [this.screen?.mat, this.board?.mat].filter(Boolean); }

  // data: { floorName, bots: [...], hour }
  setData(data) {
    const sig = this.signature(data);
    this.data = data;
    if (sig !== this.sig) { this.sig = sig; this.dirty = true; }
  }

  setAccent(hex) {
    if (hex === this.accent) return;
    this.accent = hex;
    this.dirty = true;
    this.lastDraw = -1e9;                                  // a floor switch: redraw on the next tick
  }

  // "<lead> ● <name>": the dot in the floor's accent instead of the middle dot. Returns the x where the name starts.
  accentDot(g, lead, x, y, dotY, size) {
    g.fillText(lead, x, y);
    const lw = g.measureText(lead).width;
    g.fillStyle = this.accent;
    g.beginPath(); g.arc(x + lw + size * 1.3, dotY, size * 0.42, 0, 7); g.fill();
    return x + lw + size * 2.6;
  }

  signature(d) {
    const parts = [d.floorName, d.hour, d.now];
    for (const b of d.bots) parts.push(b.id, b.effective_status || b.status, taskTitle(b), b.color, b.today?.events, b.today?.tasks_done, b.today?.working_min, (b.today?.hourly || []).join(','));
    return parts.join('|');
  }

  // night: 0..1; called every frame (cheap), redraws only when dirty and ≥ 1 s since the last draw
  tick(nowMs, night) {
    if (this.data && (this.dirty || (!this.fontsAtDraw && fontsReady)) && nowMs - this.lastDraw > 1000) {
      this.lastDraw = nowMs;
      this.dirty = false;
      this.fontsAtDraw = fontsReady;
      if (this.screen) this.drawScreen(this.data);
      if (this.board) this.drawBoard(this.data);
    }
    if (this.screen) {
      const k = 0.86 * (1 - 0.84 * night);                // dim glass by day, a near-black screen at night
      this.screen.mat.color.setRGB(k, k, k);
    }
    if (this.board) {
      const k = 1 - 0.46 * night;
      this.board.mat.color.setRGB(k, k * 0.97, k * 0.93);
    }
  }

  // ---------------- wall screen: dark UI, green bars ----------------

  drawScreen(d) {
    const { g, tex, S, W, H } = this.screen;
    g.setTransform(S, 0, 0, S, 0, 0);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#14171C'); bg.addColorStop(1, '#0B0D10');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W * 0.2, 0, 0, W * 0.2, 0, W * 0.7);
    glow.addColorStop(0, 'rgba(52,199,89,0.10)'); glow.addColorStop(1, 'rgba(52,199,89,0)');
    g.fillStyle = glow; g.fillRect(0, 0, W, H);

    const bots = d.bots;
    const working = bots.filter((b) => (b.effective_status || b.status) === 'working').length;
    const events = sum(bots, (b) => b.today?.events);
    const done = sum(bots, (b) => b.today?.tasks_done);
    const hours = sum(bots, (b) => b.today?.working_min) / 60;
    const hourly = new Array(24).fill(0);
    for (const b of bots) for (let i = 0; i < 24; i++) hourly[i] += Number(b.today?.hourly?.[i]) || 0;

    g.textBaseline = 'alphabetic';
    g.fillStyle = '#8E8E93'; g.font = `500 32px ${FONT}`;
    let nx;
    if (this.accent) nx = this.accentDot(g, 'Today', 44, 62, 51, 20);
    else { g.fillText('Today · ', 44, 62); nx = 44 + g.measureText('Today · ').width; }
    g.fillStyle = '#F5F5F7'; g.font = `650 40px ${FONT}`;
    g.fillText(ellipsize(g, d.floorName || '', 744 - nx), nx, 62);
    // live dot
    g.fillStyle = '#34C759'; g.beginPath(); g.arc(W - 52, 50, 7, 0, 7); g.fill();
    g.fillStyle = 'rgba(52,199,89,0.25)'; g.beginPath(); g.arc(W - 52, 50, 14, 0, 7); g.fill();

    const tiles = [
      [`${working} of ${bots.length}`, 'working now'],
      [String(events), 'events today'],
      [String(done), 'tasks done'],
      [hours.toFixed(1), 'hours worked'],
    ];
    const tw = 205, gap = 14, x0 = 44, y0 = 100;
    tiles.forEach(([val, label], i) => {
      const x = x0 + i * (tw + gap);
      g.fillStyle = 'rgba(255,255,255,0.065)'; roundRect(g, x, y0, tw, 108, 18); g.fill();
      g.fillStyle = i === 0 ? '#34C759' : '#F5F5F7'; g.font = `700 42px ${FONT}`;
      g.fillText(val, x + 20, y0 + 55);
      g.fillStyle = '#8E8E93'; g.font = `500 17px ${FONT}`;
      g.fillText(label, x + 20, y0 + 86);
    });

    // 24-bar hourly chart, current hour highlighted
    const cx = 44, cw = W - 88, cy = 250, ch = 220;
    g.fillStyle = '#8E8E93'; g.font = `500 17px ${FONT}`;
    g.fillText('Events by hour', cx, cy - 4);
    const max = Math.max(1, ...hourly);
    const slot = cw / 24, bw = slot * 0.62;
    for (let i = 0; i < 24; i++) {
      const x = cx + i * slot + (slot - bw) / 2;
      const hgt = hourly[i] > 0 ? Math.max(8, (hourly[i] / max) * (ch - 20)) : 6;
      const y = cy + ch - hgt;
      const now = i === d.hour;
      g.save();
      if (now) { g.shadowColor = 'rgba(52,199,89,0.85)'; g.shadowBlur = 18; }
      g.fillStyle = now ? '#34C759' : i > d.hour ? 'rgba(255,255,255,0.08)' : hourly[i] > 0 ? 'rgba(52,199,89,0.55)' : 'rgba(255,255,255,0.10)';
      roundRect(g, x, y, bw, hgt, Math.min(5, bw / 2)); g.fill();
      g.restore();
    }
    g.fillStyle = '#6E6E73'; g.font = `500 15px ${FONT}`;
    g.textAlign = 'center';
    for (const h of [0, 6, 12, 18]) g.fillText(String(h).padStart(2, '0'), cx + h * slot + slot / 2, cy + ch + 26);
    g.fillText('24', cx + 23 * slot + slot / 2 + 4, cy + ch + 26);
    g.textAlign = 'left';
    tex.needsUpdate = true;
  }

  // ---------------- task board: light, white cards ----------------

  drawBoard(d) {
    const { g, tex, S, W, H } = this.board;
    g.setTransform(S, 0, 0, S, 0, 0);
    g.fillStyle = '#F1F0EC'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#FAF9F6'; g.fillRect(0, 0, W, 68);
    g.fillStyle = '#E3E0D9'; g.fillRect(0, 68, W, 2);

    g.fillStyle = '#1D1D1F'; g.font = `700 34px ${FONT}`;
    let nx;
    if (this.accent) nx = this.accentDot(g, 'Tasks', 36, 49, 37, 20);
    else { g.fillText('Tasks', 36, 49); nx = 36 + g.measureText('Tasks ').width; }
    g.fillStyle = '#6E6E73'; g.font = `600 26px ${FONT}`;
    g.fillText(`${this.accent ? '' : '· '}${ellipsize(g, d.floorName || '', 420)}`, nx, 49);

    const sorted = [...d.bots].sort((a, b) => (RANK[a.effective_status || a.status] ?? 3) - (RANK[b.effective_status || b.status] ?? 3) || String(a.name).localeCompare(String(b.name)));
    const shown = sorted.slice(0, 8), extra = sorted.length - shown.length;
    if (extra > 0) {
      g.textAlign = 'right'; g.fillStyle = '#515154'; g.font = `700 28px ${FONT}`;
      g.fillText(`+${extra}`, W - 36, 49);
      g.textAlign = 'left';
    }
    if (!shown.length) {
      g.fillStyle = '#8E8E93'; g.font = `600 28px ${FONT}`;
      g.fillText('Nobody on this floor yet', 36, 160);
    }

    const cols = 4, pad = 30, gap = 16, top = 90;
    const cw = (W - pad * 2 - gap * (cols - 1)) / cols, chh = (H - top - 28 - gap) / 2;
    shown.forEach((b, i) => {
      const x = pad + (i % cols) * (cw + gap), y = top + Math.floor(i / cols) * (chh + gap);
      const st = b.effective_status || b.status;
      g.save();
      g.shadowColor = 'rgba(40,36,30,0.18)'; g.shadowBlur = 14; g.shadowOffsetY = 3;
      g.fillStyle = '#FFFFFF'; roundRect(g, x, y, cw, chh, 14); g.fill();
      g.restore();
      g.fillStyle = b.color || '#A1A1A6';
      roundRect(g, x + 10, y + 12, 9, chh - 24, 4.5); g.fill();
      g.fillStyle = STATUS[st] || STATUS.idle;
      g.beginPath(); g.arc(x + cw - 22, y + 26, 8, 0, 7); g.fill();
      g.fillStyle = '#1D1D1F'; g.font = `700 25px ${FONT}`;
      g.fillText(ellipsize(g, b.name || '', cw - 76), x + 32, y + 36);
      g.fillStyle = '#3A3A3C'; g.font = `600 21px ${FONT}`;
      const lines = wrapText(g, taskTitle(b) || '—', cw - 52, 3);
      lines.forEach((ln, k) => g.fillText(ln, x + 32, y + 72 + k * 28));
    });
    tex.needsUpdate = true;
  }
}

function sum(list, fn) {
  let s = 0;
  for (const b of list) s += Number(fn(b)) || 0;
  return s;
}

function ellipsize(g, text, maxW) {
  let t = String(text);
  if (g.measureText(t).width <= maxW) return t;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

export { sofiaHour, fontsPromise };
