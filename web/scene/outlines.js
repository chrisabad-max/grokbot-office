// 2D outlines of the blob avatars: pure math, no imports, so blobgen.js (browser) and the fitting / test scripts (Node)
// share one definition. Every outline is a closed CCW point list around the origin, star-shaped from it (the body is
// built as a polar radius function r(theta) around that origin, see blobgen.js Slab).
//
// Kinds:
//   sup      superellipse a, b, n
//   poly     regular n-gon (R, rotation) with corner radius rr, optional y squash sy
//   star     k-pointed soft star: r = rin + (1-rin) * ((1 + cos(k (t - tip))) / 2)^p
//   hull     convex hull of circles [[x, y, r], ...]: rounded polygons with their own corner radii, pills, drops
//   fourier  r(t) = c0 + sum_n (c[2n-1] cos nt + c[2n] sin nt): organic outlines traced from the app's icons
// Optional on any kind: rotate (deg, CCW), sy (y squash, poly only).

const rad = (d) => (d * Math.PI) / 180;
const lerp = (a, b, t) => a + (b - a) * t;

function sup(a, b, n, N = 720) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N, c = Math.cos(t), s = Math.sin(t);
    const r = (Math.abs(c / a) ** n + Math.abs(s / b) ** n) ** (-1 / n);
    pts.push([r * c, r * s]);
  }
  return pts;
}

function regPoly(n, R, rotDeg) {
  const pts = [];
  for (let k = 0; k < n; k++) pts.push([R * Math.cos(rad(rotDeg + (360 * k) / n)), R * Math.sin(rad(rotDeg + (360 * k) / n))]);
  return pts;
}

/** convex CCW core polygon offset by rr -> rounded polygon */
function roundedPoly(core, rr, arc = 24) {
  const n = core.length, nor = [];
  for (let i = 0; i < n; i++) {
    const e = [core[(i + 1) % n][0] - core[i][0], core[(i + 1) % n][1] - core[i][1]];
    const l = Math.hypot(e[0], e[1]);
    nor.push([e[1] / l, -e[0] / l]);
  }
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = nor[(i + n - 1) % n];
    const a0 = Math.atan2(p[1], p[0]);
    let a1 = Math.atan2(nor[i][1], nor[i][0]);
    while (a1 < a0) a1 += 2 * Math.PI;
    for (let k = 0; k < arc; k++) {
      const t = lerp(a0, a1, k / (arc - 1));
      pts.push([core[i][0] + rr * Math.cos(t), core[i][1] + rr * Math.sin(t)]);
    }
  }
  return pts;
}

function star(k, rin, p, tipDeg, N = 1440) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    const g = ((1 + Math.cos(k * (t - rad(tipDeg)))) / 2) ** p;
    const r = rin + (1 - rin) * g;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

/** convex hull (CCW) of circles sampled finely: straight sides, each corner rounded by its own circle */
function hull(circles, S = 96) {
  const pts = [];
  for (const [x, y, r] of circles) for (let i = 0; i < S; i++) { const t = (2 * Math.PI * i) / S; pts.push([x + r * Math.cos(t), y + r * Math.sin(t)]); }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

function fourier(c, N = 720) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    let r = c[0];
    for (let n = 1; 2 * n - 1 < c.length; n++) r += c[2 * n - 1] * Math.cos(n * t) + (c[2 * n] ?? 0) * Math.sin(n * t);
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

function rotPts(pts, deg) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

export function makeOutline(o) {
  let pts;
  if (o.kind === 'sup') pts = sup(o.a, o.b, o.n);
  else if (o.kind === 'star') pts = star(o.k, o.rin, o.p, o.tip);
  else if (o.kind === 'poly') {
    pts = roundedPoly(regPoly(o.n, o.R - o.rr, o.rot ?? 90), o.rr);
    if (o.sy) pts = pts.map(([x, y]) => [x, y * o.sy]);
  } else if (o.kind === 'hull') pts = hull(o.circles);
  else if (o.kind === 'fourier') pts = fourier(o.c);
  else throw new Error(`outline ${o.kind}`);
  return o.rotate ? rotPts(pts, o.rotate) : pts;
}

/** radius of a star-shaped closed polyline along N rays from `centre` */
export function toPolar(pts, N, centre = [0, 0]) {
  const M = pts.length, out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * i) / N, dx = Math.cos(th), dy = Math.sin(th);
    let best = 0;
    for (let k = 0; k < M; k++) {
      const Px = pts[k][0] - centre[0], Py = pts[k][1] - centre[1];
      const q = pts[(k + 1) % M];
      const ex = q[0] - centre[0] - Px, ey = q[1] - centre[1] - Py;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (Px * ey - Py * ex) / den, s = (Px * dy - Py * dx) / den;
      if (s >= -1e-9 && s <= 1 + 1e-9 && t > best) best = t;
    }
    out[i] = best;
  }
  return out;
}

export function csmooth(a, passes = 1) {
  const N = a.length;
  let cur = Float64Array.from(a);
  for (let p = 0; p < passes; p++) {
    const nxt = new Float64Array(N);
    for (let i = 0; i < N; i++) nxt[i] = 0.25 * cur[(i + N - 1) % N] + 0.5 * cur[i] + 0.25 * cur[(i + 1) % N];
    cur = nxt;
  }
  return cur;
}

/** area centroid of a closed polygon */
export function centroid(pts) {
  let A = 0, x = 0, y = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length], a = x0 * y1 - x1 * y0;
    A += a; x += (x0 + x1) * a; y += (y0 + y1) * a;
  }
  return [x / (3 * A), y / (3 * A)];
}
