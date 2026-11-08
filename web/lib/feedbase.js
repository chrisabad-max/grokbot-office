// The one address the bots post to and the office reads: FEED_BASE + topic. The setup prompt (PROMPT.md) builds the same
// address and the wallpaper (face/face.js) and the landing default to it too; server/test/feedbase.test.js keeps them all
// equal, so change it here and there together. A link can name another mailbox (a relay, a self-hosted ntfy):
//   #<topic>@<host or https URL>     ?feed=<host or https URL>     #<topic>&ntfy=<https URL> (older links)
// Pure: runs in the browser and in Node (tests).
export const FEED_BASE = 'https://ntfy.sh/';

const TOPIC = /^[A-Za-z0-9_-]{6,64}$/;

/** 'relay.example.com' | 'https://relay.example.com/x' -> 'https://relay.example.com/x/'; null if not https (or localhost). */
export function feedBase(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* keep it as typed */ }
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
  } catch { return null; }
}

/** A page's location ({ hash, search }) -> { topic, base } or null. ?feed= holds a base; a bare topic there is an older
 *  wallpaper link (?feed=<topic>) and still names the topic. */
export function feedFromLink({ hash = '', search = '' } = {}) {
  const q = new URLSearchParams(search).get('feed');
  const qBase = q && /[./:]/.test(q) ? feedBase(q) : null;
  const m = /^#([A-Za-z0-9_-]{6,64})(?:@([^&#]+)|&ntfy=([^&#]+))?$/.exec(hash);
  const topic = m ? m[1] : q && TOPIC.test(q) ? q : null;
  if (!topic) return null;
  const base = (m && (feedBase(m[2] ?? m[3]))) || qBase || FEED_BASE;
  return { topic, base, url: base + topic };
}

/** The link form of a base for #<topic>@…: the host (and path) without https://, or '' for the default. */
export function baseTag(base) {
  return !base || base === FEED_BASE ? '' : base.replace(/^https:\/\//, '').replace(/\/$/, '');
}
