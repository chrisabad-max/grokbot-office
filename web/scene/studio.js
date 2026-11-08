// The studio look: a clean white product-shot backdrop and a soft, dark, premium aura around and under the building.
//
// How it is made (no sprites, no CSS glow, nothing drawn by hand):
//  1. The building is drawn once more as a flat white silhouette into a small target (every material replaced, so
//     glass counts as solid). That silhouette is the real shape of whatever is on screen right now: floors, the
//     elevator, the floors sliding away during a switch.
//  2. The silhouette is blurred at three scales (a tight contact shadow, a soft penumbra, a wide ambient fall-off),
//     each pushed a little downwards because the light comes from above, like a lit object on a paper sweep.
//  3. One final pass puts the building over the backdrop: a quiet radial fall-off from white to cool grey, the three
//     shadow layers multiplied in (not added), and dithering, so the long gradients never band.
// The aura only exists outside the silhouette, so clear glass keeps showing the white backdrop through it.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// All distances are CSS px at a 1080 px tall frame; they scale with the frame height and with the camera zoom
// (the aura belongs to the building, so it grows and shrinks with it).
export const STUDIO = {
  centre: [0.5, 0.45],                                    // where the light pools (fraction of the frame, y down)
  radii: [0.82, 0.78],                                    // ellipse the fall-off reaches its edge colour at
  stops: [[0, '#FFFFFF'], [0.5, '#F8F8FA'], [1, '#E6E7EB']],
  shadow: '#0B0C11',                                      // cool near-black, never pure black
  layers: [                                               // sigma (px), push down (px), strength at the silhouette edge
    { sigma: 4, down: 2, w: 0.40 },                       // contact: a thin dark seam that grounds the edge
    { sigma: 30, down: 22, w: 0.40 },                     // penumbra: the body of the aura
    { sigma: 120, down: 70, w: 0.34 },                    // ambient: the long, quiet tail
  ],
};

const srgb = (c) => { const k = new THREE.Color(); k.setStyle(c, THREE.LinearSRGBColorSpace); return new THREE.Vector3(k.r, k.g, k.b); };   // raw sRGB numbers, no decoding

// The same backdrop as CSS, for the moment before the first frame and for the page behind the canvas.
export function studioCss() {
  const [cx, cy] = STUDIO.centre, [rx, ry] = STUDIO.radii;
  const st = STUDIO.stops.map(([t, c]) => `${c} ${(t * 100).toFixed(1)}%`).join(', ');
  return `radial-gradient(ellipse ${rx * 100}% ${ry * 100}% at ${cx * 100}% ${cy * 100}%, ${st})`;
}

const QUAD_VS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`;

const BLUR_FS = /* glsl */`
  uniform sampler2D tMap;
  uniform vec2 texel;
  uniform float sigma;
  varying vec2 vUv;
  void main() {
    if ( sigma < 0.01 ) { gl_FragColor = vec4( texture2D( tMap, vUv ).r ); return; }
    float r = min( ceil( sigma * 3.0 ), 40.0 );
    float s = 0.0, ws = 0.0;
    for ( int i = -40; i <= 40; i++ ) {
      float f = float( i );
      if ( abs( f ) > r ) continue;
      float w = exp( -f * f / ( 2.0 * sigma * sigma ) );
      s += texture2D( tMap, vUv + texel * f ).r * w;
      ws += w;
    }
    gl_FragColor = vec4( s / ws );
  }`;

const COMPOSE_FS = /* glsl */`
  uniform sampler2D tDiffuse, tHold, tL0, tL1, tL2;
  uniform vec3 stop0, stop1, stop2, shadowC;
  uniform vec2 centre, radii, push[3];
  uniform vec3 layerW;
  uniform float stopMid;
  varying vec2 vUv;

  float hash( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }

  void main() {
    vec4 c = texture2D( tDiffuse, vUv );

    // backdrop: pool of light in the middle, cool grey toward the corners (piecewise linear = the CSS gradient)
    float d = length( ( vUv - vec2( centre.x, 1.0 - centre.y ) ) / radii );
    vec3 bg = d < stopMid ? mix( stop0, stop1, d / stopMid ) : mix( stop1, stop2, clamp( ( d - stopMid ) / ( 1.0 - stopMid ), 0.0, 1.0 ) );

    // aura: each layer is the blurred silhouette, sampled a little above so it falls below; 2x makes a straight edge = 1
    float a0 = min( 1.0, 2.0 * texture2D( tL0, vUv + push[0] ).r ) * layerW.x;
    float a1 = min( 1.0, 2.0 * texture2D( tL1, vUv + push[1] ).r ) * layerW.y;
    float a2 = min( 1.0, 2.0 * texture2D( tL2, vUv + push[2] ).r ) * layerW.z;
    float dens = 1.0 - ( 1.0 - a0 ) * ( 1.0 - a1 ) * ( 1.0 - a2 );
    dens *= 1.0 - smoothstep( 0.5, 0.9, texture2D( tHold, vUv ).r );    // nothing inside the silhouette: clear glass stays clear
    bg = mix( bg, shadowC, dens );

    vec3 rgb = c.rgb + bg * ( 1.0 - c.a );                              // c is premultiplied
    float n = hash( gl_FragCoord.xy ) + hash( gl_FragCoord.xy + 17.31 ) - 1.0;   // triangular dither, +-1 level
    gl_FragColor = vec4( rgb + n / 255.0, 1.0 );
  }`;

function target(w, h) {
  return new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
    type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
}

export class StudioPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = true;
    this.maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false });
    this.blurMat = new THREE.ShaderMaterial({ uniforms: { tMap: { value: null }, texel: { value: new THREE.Vector2() }, sigma: { value: 0 } }, vertexShader: QUAD_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false });
    const [L0, L1, L2] = STUDIO.layers;
    this.composeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tHold: { value: null }, tL0: { value: null }, tL1: { value: null }, tL2: { value: null },
        stop0: { value: srgb(STUDIO.stops[0][1]) }, stop1: { value: srgb(STUDIO.stops[1][1]) }, stop2: { value: srgb(STUDIO.stops[2][1]) },
        stopMid: { value: STUDIO.stops[1][0] },
        shadowC: { value: srgb(STUDIO.shadow) },
        centre: { value: new THREE.Vector2(...STUDIO.centre) }, radii: { value: new THREE.Vector2(...STUDIO.radii) },
        push: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
        layerW: { value: new THREE.Vector3(L0.w, L1.w, L2.w) },
      },
      vertexShader: QUAD_VS, fragmentShader: COMPOSE_FS, depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.blurMat);
    this.t = null;
    this.size = new THREE.Vector2(1, 1);
    this.setSize(1, 1);
  }

  // w, h = drawing-buffer pixels. Targets: silhouette + contact pair at 1/4, penumbra pair at 1/8, ambient at 1/32
  // (with a 1/16 step on the way down so every halving is an exact 2x2 average).
  setSize(w, h) {
    this.size.set(w, h);
    const t = this.t;
    if (t) Object.values(t).forEach((x) => x.dispose());
    const at = (k) => target(Math.round(w / k), Math.round(h / k));
    this.t = { mask: at(4), cA: at(4), cB: at(4), mA: at(8), mB: at(8), hA: at(16), wA: at(32), wB: at(32) };
  }

  blur(renderer, src, dst, dx, dy, sigma) {
    const u = this.blurMat.uniforms;
    u.tMap.value = src.texture;
    u.texel.value.set(dx / src.width, dy / src.height);
    u.sigma.value = sigma;
    renderer.setRenderTarget(dst);
    this.fsQuad.material = this.blurMat;
    this.fsQuad.render(renderer);
  }

  // The building as a flat silhouette, then three blurred copies of it.
  buildAura(renderer, unit) {
    const prev = { target: renderer.getRenderTarget(), auto: renderer.autoClear, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), shadow: renderer.shadowMap.enabled };
    const t = this.t;
    renderer.shadowMap.enabled = false;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(t.mask);
    const prevOverride = this.scene.overrideMaterial;
    this.scene.overrideMaterial = this.maskMat;
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;
    renderer.autoClear = false;

    const sig = STUDIO.layers.map((l, i) => Math.min(13, (l.sigma * unit) / [4, 8, 32][i]));   // in texels of that layer's target
    this.blur(renderer, t.mask, t.cB, 1, 0, sig[0]);              // contact
    this.blur(renderer, t.cB, t.cA, 0, 1, sig[0]);
    this.blur(renderer, t.mask, t.mB, 0, 0, 0);                   // 1/8, 1/16, 1/32 copies (bilinear = 2x2 average)
    this.blur(renderer, t.mB, t.hA, 0, 0, 0);
    this.blur(renderer, t.hA, t.wA, 0, 0, 0);
    this.blur(renderer, t.wA, t.wB, 1, 0, sig[2]);                // ambient
    this.blur(renderer, t.wB, t.wA, 0, 1, sig[2]);
    this.blur(renderer, t.mB, t.mA, 1, 0, sig[1]);                // penumbra
    this.blur(renderer, t.mA, t.mB, 0, 1, sig[1]);

    renderer.setRenderTarget(prev.target);
    renderer.autoClear = prev.auto;
    renderer.setClearColor(prev.color, prev.alpha);
    renderer.shadowMap.enabled = prev.shadow;
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.composeMat.uniforms, H = this.size.y;
    // CSS-px-at-1080p -> drawing-buffer px. The aura follows the zoom (it belongs to the building), but only part of the
    // way and a little lighter, so a close-up is not swallowed by the shadow of the walls just outside the frame.
    const zoom = Math.max(0.3, this.camera.zoom || 1), unit = (H / 1080) * Math.pow(zoom, 0.55);
    const soften = 1 / (1 + 0.35 * Math.max(0, zoom - 1));
    this.buildAura(renderer, unit);
    const t = this.t;
    u.tDiffuse.value = readBuffer.texture;
    u.tHold.value = u.tL0.value = t.cA.texture;                            // the silhouette, lightly blurred: where the building really is
    u.tL1.value = t.mB.texture;
    u.tL2.value = t.wA.texture;
    STUDIO.layers.forEach((l, i) => u.push.value[i].set(0, (l.down * unit) / H));
    u.layerW.value.set(STUDIO.layers[0].w, STUDIO.layers[1].w * soften, STUDIO.layers[2].w * soften);
    this.fsQuad.material = this.composeMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() {
    Object.values(this.t).forEach((x) => x.dispose());
    this.maskMat.dispose(); this.blurMat.dispose(); this.composeMat.dispose();
    this.fsQuad.dispose();
  }
}
