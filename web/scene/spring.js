// Critically damped springs (damping ratio 1.0, "response" = Apple-style period in seconds).
// Analytic step, so it is stable at any dt and can be re-targeted mid-flight without a jump.
export const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Spring {
  constructor(value = 0, response = 0.5) {
    this.x = value;
    this.v = 0;
    this.target = value;
    this.response = response;
    this.delay = 0;
    this.pending = null;
  }

  // Re-target from the current position and velocity (never jumps). Optional delay in seconds.
  to(target, delay = 0) {
    if (delay > 0) { this.pending = target; this.delay = delay; } else { this.target = target; this.pending = null; }
    return this;
  }

  snap(value) {
    this.x = this.target = value;
    this.v = 0;
    this.pending = null;
    return this;
  }

  step(dt) {
    if (this.pending !== null) {
      this.delay -= dt;
      if (this.delay <= 0) { this.target = this.pending; this.pending = null; }
    }
    const response = REDUCED ? Math.min(this.response, 0.12) : this.response;
    const w = (2 * Math.PI) / Math.max(response, 0.02);
    const d = this.x - this.target;
    const t1 = this.v + w * d;
    const e = Math.exp(-w * dt);
    this.x = this.target + (d + t1 * dt) * e;
    this.v = (this.v - w * t1 * dt) * e;
    if (Math.abs(this.x - this.target) < 1e-5 && Math.abs(this.v) < 1e-5) { this.x = this.target; this.v = 0; }
    return this.x;
  }

  get settled() { return this.x === this.target && this.v === 0 && this.pending === null; }
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
