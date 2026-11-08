// Post chain: the scene (MSAA, half-float, alpha kept) -> tilt-shift "miniature" blur (sharp band around the active
// floor, soft toward the top and bottom edges; `?tiltshift=0` leaves it out) -> OutputPass (tone mapping + sRGB) ->
// the studio pass (studio.js: white backdrop + the building's soft shadow aura), which is what reaches the screen.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { StudioPass } from './studio.js';

const TiltShiftShader = {
  name: 'BotHQTiltShift',
  uniforms: {
    tDiffuse: { value: null },
    dir: { value: new THREE.Vector2(1, 0) },     // texel step (1/w, 0) or (0, 1/h)
    focus: { value: 0.5 },                      // uv.y of the sharp line
    band: { value: 0.24 },                       // half height of the fully sharp band (uv)
    falloff: { value: 0.5 },                   // uv distance over which the blur ramps up
    strength: { value: 1.5 },                   // blur radius in px at full effect
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 dir;
    uniform float focus, band, falloff, strength;
    varying vec2 vUv;
    void main() {
      float d = max( 0.0, abs( vUv.y - focus ) - band );
      float amt = smoothstep( 0.0, falloff, d );
      vec2 s = dir * strength * amt;
      vec4 c = texture2D( tDiffuse, vUv ) * 0.2270270270;
      c += texture2D( tDiffuse, vUv + s * 1.3846153846 ) * 0.3162162162;
      c += texture2D( tDiffuse, vUv - s * 1.3846153846 ) * 0.3162162162;
      c += texture2D( tDiffuse, vUv + s * 3.2307692308 ) * 0.0702702703;
      c += texture2D( tDiffuse, vUv - s * 3.2307692308 ) * 0.0702702703;
      gl_FragColor = c;
    }`,
};

export function tiltShiftEnabled() {
  return new URLSearchParams(location.search).get('tiltshift') !== '0';
}

export function createPost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  // MSAA only where the scene is drawn: the ping-pong partner is a plain half-float target (saves ~25% VRAM)
  composer.renderTarget2.dispose();
  composer.renderTarget2 = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType });
  composer.writeBuffer = composer.renderTarget2;
  composer.readBuffer = composer.renderTarget1;
  composer.addPass(new RenderPass(scene, camera));
  const h = new ShaderPass(TiltShiftShader);
  const v = new ShaderPass(TiltShiftShader);      // ShaderPass clones the uniforms, so each pass owns its own
  h.enabled = v.enabled = tiltShiftEnabled();
  composer.addPass(h);
  composer.addPass(v);
  composer.addPass(new OutputPass());
  const studio = new StudioPass(scene, camera);
  composer.addPass(studio);

  const api = {
    composer,
    setSize(w, hgt) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, hgt);
      const pxW = w * renderer.getPixelRatio(), pxH = hgt * renderer.getPixelRatio();
      h.uniforms.dir.value.set(1 / pxW, 0);
      v.uniforms.dir.value.set(0, 1 / pxH);
      this.base = 1.05 * renderer.getPixelRatio();
      h.uniforms.strength.value = v.uniforms.strength.value = this.base;
    },
    render(focusV, dt, intensity = 1) {
      h.uniforms.focus.value = v.uniforms.focus.value = focusV;
      h.uniforms.strength.value = v.uniforms.strength.value = this.base * intensity;
      composer.render(dt);
    },
  };
  api.setSize(size.x, size.y);
  return api;
}
