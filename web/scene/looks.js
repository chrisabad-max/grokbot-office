// Closed vocabularies for generated blob avatars (docs/AVATARS.md). Pure data, no imports:
// blobgen.js (browser) and the server-side tests share these lists, so they cannot drift apart silently.

// The Grok Bot app's avatar picker, left to right, top to bottom (its 14th avatar is sphere + accessory stem),
// then three older ids the app no longer shows, kept so that old looks still work.
export const APP_SHAPES = [
  'sphere', 'cloud', 'rounded_square', 'star4', 'clover',
  'bubble', 'flower', 'drop', 'pill', 'triangle',
  'pentagon', 'star6', 'hexagon',
];
export const SHAPES = [...APP_SHAPES, 'rounded_cube', 'cone', 'trio'];

export const ACCESSORIES = ['none', 'glasses', 'stem', 'antenna', 'bow'];

const HEX6 = /^#?[0-9a-f]{6}$/i;                    // Grok Bot sometimes writes the colour without its '#'

/** 'Rounded Cube' / 'rounded-cube' -> 'rounded_cube'; anything outside the enum -> null. */
export function normShape(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return SHAPES.includes(s) ? s : null;
}

/** Unknown / missing accessory -> 'none'. */
export function normAccessory(v) {
  if (typeof v !== 'string') return 'none';
  const s = v.trim().toLowerCase();
  return ACCESSORIES.includes(s) ? s : 'none';
}

/** '#rrggbb' or 'rrggbb' -> '#RRGGBB'; anything else (3-digit hex, names, rgb()) -> null. */
export function normColor(v) {
  return typeof v === 'string' && HEX6.test(v.trim()) ? `#${v.trim().replace('#', '').toUpperCase()}` : null;
}

/** FNV-1a 32-bit. */
export function hash32(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The shape a bot gets when nothing describes it: stable per id, always one the app has. */
export function hashShape(id) {
  return APP_SHAPES[(hash32(`shape:${id}`) >>> 4) % APP_SHAPES.length];
}
