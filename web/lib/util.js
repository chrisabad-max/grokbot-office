// Shared helpers: slugs (with Cyrillic transliteration), timezone-aware timestamps, colors.

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

/** Lowercase slug: Cyrillic transliterated, non-alphanumerics collapsed to "-", trimmed. */
export function slugify(input, maxLen = 48) {
  let s = String(input ?? '').normalize('NFC').toLowerCase();
  s = s.replace(/[а-яёіїєґ]/g, (c) => CYR[c] ?? '');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/g, '');
  return s;
}

/** FNV-1a 32-bit hash. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable vivid color (#RRGGBB) from a string. */
export function hashColor(str) {
  const h = hash32(String(str));
  const hue = (h * 137.508) % 360; // golden-angle spread
  const s = 0.72;
  const l = 0.52;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

export function cleanStr(v, max) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  // eslint-disable-next-line no-control-regex
  let s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!s) return null;
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

/**
 * Timezone helper. Produces ISO-8601 strings with the zone's UTC offset
 * (e.g. 2026-10-31T19:00:00+02:00) and day boundaries in that zone.
 */
export function makeTime(tz = 'Europe/Sofia') {
  let fmt;
  try {
    fmt = makeFormatter(tz);
  } catch {
    tz = 'UTC';
    fmt = makeFormatter(tz);
  }
  const memo = new Map();

  function parts(ms) {
    const o = {};
    for (const p of fmt.formatToParts(ms)) o[p.type] = p.value;
    return o;
  }

  function offsetOf(p) {
    const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(p.timeZoneName || '');
    if (!m) return '+00:00';
    return `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}`;
  }

  /** ms -> "YYYY-MM-DDTHH:mm:ss+hh:mm" in the configured zone. */
  function iso(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
    const key = Math.floor(ms / 1000);
    const hit = memo.get(key);
    if (hit) return hit;
    const p = parts(key * 1000);
    const hour = p.hour === '24' ? '00' : p.hour;
    const out = `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}${offsetOf(p)}`;
    if (memo.size > 4000) memo.clear();
    memo.set(key, out);
    return out;
  }

  let dayCache = { start: 0, end: 0, key: '' };

  /** Day info for ms: { key: "YYYY-MM-DD", start, end } (ms, local midnight to next midnight). */
  function day(ms) {
    if (ms >= dayCache.start && ms < dayCache.end) return dayCache;
    const p = parts(ms);
    const hour = p.hour === '24' ? 0 : Number(p.hour);
    const sinceMidnight = ((hour * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 + (((ms % 1000) + 1000) % 1000);
    const start = ms - sinceMidnight;
    // 36 h after local midnight is always inside the next local day (DST-safe).
    const next = start + 36 * 3600e3;
    const np = parts(next);
    const nh = np.hour === '24' ? 0 : Number(np.hour);
    const nSince = ((nh * 60 + Number(np.minute)) * 60 + Number(np.second)) * 1000;
    const end = next - nSince;
    dayCache = { start, end, key: `${p.year}-${p.month}-${p.day}` };
    return dayCache;
  }

  /** Local hour 0..23 for ms. */
  function hour(ms) {
    const h = parts(ms).hour;
    return h === '24' ? 0 : Number(h);
  }

  return { tz, iso, day, hour };
}

function makeFormatter(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
}

/** Parse a journal timestamp; returns ms or null. */
export function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // seconds vs milliseconds heuristic
    return v < 1e11 ? v * 1000 : v;
  }
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}
