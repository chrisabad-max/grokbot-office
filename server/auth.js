// Password auth: credentials on disk, HMAC session cookie, login rate limit, login page.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COOKIE = 'bothq_session';
export const SESSION_TTL_MS = 30 * 24 * 3600e3;

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes

function generatePassword() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

function writeSecret(file, content) {
  fs.writeFileSync(file, content + '\n', { mode: 0o600 });
}

/**
 * Password: env BOTHQ_PASSWORD, else data/password.txt (generated once).
 * Secret: data/secret.key (generated once).
 */
export function loadCredentials({ dataDir, env = process.env }) {
  fs.mkdirSync(dataDir, { recursive: true });
  let password = (env.BOTHQ_PASSWORD || '').trim();
  let generated = false;
  let source = 'env BOTHQ_PASSWORD';
  if (!password) {
    const pf = path.join(dataDir, 'password.txt');
    source = pf;
    try {
      password = fs.readFileSync(pf, 'utf8').trim();
    } catch { /* not there yet */ }
    if (!password) {
      password = generatePassword();
      writeSecret(pf, password);
      generated = true;
    }
  }
  const sf = path.join(dataDir, 'secret.key');
  let secret = '';
  try {
    secret = fs.readFileSync(sf, 'utf8').trim();
  } catch { /* not there yet */ }
  if (secret.length < 32) {
    secret = crypto.randomBytes(32).toString('hex');
    writeSecret(sf, secret);
  }
  return { password, secret, generated, source };
}

/**
 * View-only key for wallpaper links (Lively cannot type a password): data/view-key.txt, random hex, generated once.
 * A request for any page with ?key=<this key> gets the normal session cookie (see Auth.checkViewKey + server.js).
 * Anything already in the file that is shorter than 32 chars or not URL-safe is replaced.
 */
export function loadViewKey({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'view-key.txt');
  let key = '';
  try {
    key = fs.readFileSync(file, 'utf8').trim();
  } catch { /* not there yet */ }
  let generated = false;
  if (key.length < 32 || key.length > 200 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    key = crypto.randomBytes(24).toString('hex'); // 48 hex chars
    writeSecret(file, key);
    generated = true;
  }
  return { key, generated, file };
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export class Auth {
  constructor({ password, secret, viewKey = '', now = Date.now }) {
    this.pwDigest = sha(password);
    this.viewDigest = viewKey ? sha(viewKey) : null; // null = view keys disabled
    // Changing the password invalidates every existing session.
    this.key = crypto.createHmac('sha256', secret).update(password).digest();
    this.now = now;
    this.fails = new Map(); // ip -> number[] (failure timestamps)
    this.maxFails = 6;
    this.windowMs = 10 * 60e3;
  }

  checkPassword(input) {
    return crypto.timingSafeEqual(sha(String(input ?? '').trim()), this.pwDigest);
  }

  /** Constant-time check of a wallpaper view key (digests, so length differences do not leak either). */
  checkViewKey(input) {
    if (!this.viewDigest || typeof input !== 'string' || !input) return false;
    return crypto.timingSafeEqual(sha(input.trim()), this.viewDigest);
  }

  issue(ttlMs = SESSION_TTL_MS) {
    const payload = `${this.now() + ttlMs}.${crypto.randomBytes(8).toString('hex')}`;
    return `${payload}.${this.sign(payload)}`;
  }

  sign(payload) {
    return b64u(crypto.createHmac('sha256', this.key).update(payload).digest());
  }

  verify(token) {
    if (typeof token !== 'string' || token.length > 200) return false;
    const i = token.lastIndexOf('.');
    if (i < 1) return false;
    const payload = token.slice(0, i);
    const sig = Buffer.from(token.slice(i + 1));
    const want = Buffer.from(this.sign(payload));
    if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return false;
    const exp = Number(payload.split('.')[0]);
    return Number.isFinite(exp) && exp > this.now();
  }

  tokenFromRequest(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
    }
    return null;
  }

  isAuthed(req) {
    return this.verify(this.tokenFromRequest(req));
  }

  /** Returns {ok:true} or {ok:false, retryAfter:seconds}. */
  rateCheck(ip) {
    const now = this.now();
    const list = (this.fails.get(ip) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.fails.set(ip, list); else this.fails.delete(ip);
    if (list.length >= this.maxFails) {
      return { ok: false, retryAfter: Math.ceil((list[0] + this.windowMs - now) / 1000) };
    }
    return { ok: true };
  }

  recordFail(ip) {
    const list = this.fails.get(ip) || [];
    list.push(this.now());
    this.fails.set(ip, list);
    if (this.fails.size > 5000) this.fails.clear(); // memory guard
  }

  recordSuccess(ip) {
    this.fails.delete(ip);
  }
}

export function sessionCookie(token, { secure, maxAgeSec = SESSION_TTL_MS / 1000 }) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function clearCookie({ secure }) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Only same-origin absolute paths are allowed as a post-login target. */
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  if (next.startsWith('/login') || next.startsWith('/logout')) return '/';
  return next.slice(0, 500);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function loginPage({ error = '', next = '/' } = {}) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<title>Grok Bot Wallpaper — вход</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#F6F1EA;--paper:#FFFFFF;--ink:#141414;--muted:#6E6A64;--line:#E7E0D6;--shade:#EFE8DE;--error:#EF4444;--working:#22C55E;
  --shadow:0 1px 2px rgba(20,20,20,.06),0 8px 24px rgba(20,20,20,.06)}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.5 "Manrope",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  display:grid;place-items:center;padding:16px}
main{width:100%;max-width:380px;background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:32px 28px 28px}
.blob{position:relative;width:52px;height:52px;border-radius:38% 42% 40% 44%/44% 38% 46% 40%;background:#FF6A13;transform:rotate(-8deg);
  box-shadow:inset -6px -8px 14px rgba(0,0,0,.14),inset 5px 6px 10px rgba(255,255,255,.35);margin-bottom:18px}
.blob i{position:absolute;top:17px;width:8px;height:15px;border-radius:50%;background:#fff}
.blob i:first-child{left:14px}.blob i:last-child{right:14px}
h1{margin:0 0 4px;font-weight:800;font-size:24px;letter-spacing:-.01em}
p{margin:0 0 22px;color:var(--muted)}
label{display:block;font-weight:600;font-size:13px;margin-bottom:6px}
input[type=password]{width:100%;height:46px;padding:0 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);
  font:600 16px "Manrope",system-ui,sans-serif;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
input[type=password]:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(20,20,20,.08)}
button{margin-top:14px;width:100%;height:46px;border:0;border-radius:999px;background:var(--ink);color:#fff;font:800 15px "Manrope",system-ui,sans-serif;
  cursor:pointer;transition:transform .12s,opacity .15s}
button:hover{opacity:.88}button:active{transform:scale(.98)}
button:focus-visible{outline:3px solid rgba(20,20,20,.25);outline-offset:2px}
.err{margin:0 0 14px;padding:9px 14px;border-radius:999px;background:#FDECEC;color:#B42318;font-weight:600;font-size:13px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<main>
  <div class="blob" aria-hidden="true"><i></i><i></i></div>
  <h1>Grok Bot Wallpaper</h1>
  <p>Введи пароль, чтобы войти в офис.</p>
  ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/login" autocomplete="on">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="pw">Пароль</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Войти</button>
  </form>
</main>
</body>
</html>
`;
}
