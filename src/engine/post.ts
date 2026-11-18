import * as THREE from 'three';
import type { LensRig } from './lens';
import {
  blurFragment,
  downFragment,
  finishFragment,
  fullscreenVertex,
  lensFragment,
  meterFragment,
  taaFragment,
  upFragment,
} from './shaders/post.glsl';

export interface LookSettings {
  /** how bright the picture should be on average (0.18 = photographic mid grey) */
  key: number;
  exposureBias: number;
  bloom: number;
  grain: number;
  sharpen: number;
  vignette: number;
  saturation: number;
  contrast: number;
  /** shutter time in seconds: how long the streaks are when moving */
  shutter: number;
  /** longest streak, as a fraction of the picture */
  maxBlur: number;
  /** seconds the automatic exposure needs to settle when the view gets brighter / darker */
  adaptBrighter: number;
  adaptDarker: number;
  fringe: number;
  /** closer than this many metres things go out of focus (small fixed-focus lens) */
  /** strength of the star and ghosts when the sun is in the picture */
  flare: number;
  focusNear: number;
  /** how soft: blur radius right at the lens, as a fraction of the picture width */
  nearBlur: number;
  /** smooth edges over time: how much of the past each frame keeps (0 = off, 0.9 = normal) */
  smoothing: number;
  /** the dimmest scene average the exposure still follows; darker places stay dim */
  darkest: number;
}

export const defaultLook: LookSettings = {
  key: 0.2,
  exposureBias: 1.0,
  bloom: 0.07,
  grain: 0.035,
  sharpen: 0.45,
  vignette: 0.32,
  saturation: 1.15,
  contrast: 1.3,
  shutter: 1 / 60,
  maxBlur: 0.09,
  adaptBrighter: 0.3,
  adaptDarker: 0.9,
  fringe: 0.004,
  flare: 1,
  focusNear: 0.17,
  nearBlur: 0.035,
  smoothing: 0.9,
  darkest: 0.004,
};

/** Eight well-spread positions inside a pixel (Halton 2, 3): where the views are nudged to, frame after frame. */
const JITTER: [number, number][] = [
  [0.5, 0.3333], [0.25, 0.6667], [0.75, 0.1111], [0.125, 0.4444],
  [0.625, 0.7778], [0.375, 0.2222], [0.875, 0.5556], [0.0625, 0.8889],
];

function pass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, glsl3 = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: fullscreenVertex,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    glslVersion: glsl3 ? THREE.GLSL3 : null,
  });
}

/** Everything between "the 3D scene is drawn" and "pixels on the screen". */
export class Post {
  readonly look: LookSettings = { ...defaultLook };

  private readonly quad: THREE.Mesh;
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private viewUp!: THREE.WebGLRenderTarget;
  private viewDown!: THREE.WebGLRenderTarget;
  private lensRT!: THREE.WebGLRenderTarget;
  private blurRT!: THREE.WebGLRenderTarget;
  private past: THREE.WebGLRenderTarget[] = [];
  private pastIndex = 0;
  private pastReset = true;
  private frame = 0;
  /** samples per pixel when drawing the two views (0 = no edge smoothing; set before setSize) */
  msaa = 4;
  /** phones: shorter streaks and a smaller glow chain, which is most of what the finishing costs there (set before setSize) */
  lean = false;
  private bloom: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private meter: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private meterIndex = 0;
  private meterReset = true;

  private readonly lensMat: THREE.ShaderMaterial;
  private readonly taaMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly meterMat: THREE.ShaderMaterial;
  private readonly finishMat: THREE.ShaderMaterial;

  /** direction towards the sun (world); set by the game once the world is loaded */
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly sunLocal = new THREE.Vector3();
  private readonly prevRig = new THREE.Matrix4();
  private readonly prevRigInv = new THREE.Matrix4();
  private hasPrev = false;
  private width = 2;
  private height = 2;
  private time = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly rig: LensRig) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;

    this.lensMat = pass(
      lensFragment,
      {
        uColUp: { value: null },
        uColDown: { value: null },
        uDepthUp: { value: null },
        uDepthDown: { value: null },
        uTan: { value: rig.tan },
        uPitch: { value: rig.pitch },
        uFrame: { value: rig.frame },
        uSinHalfMax: { value: 0.65 },
        uNearFar: { value: new THREE.Vector2(0.02, 600) },
        uRigWorld: { value: new THREE.Matrix4() },
        uPrevRigInv: { value: new THREE.Matrix4() },
        uVelScale: { value: 1 },
        uFringe: { value: new THREE.Vector3(1.004, 1, 0.996) },
        uJitter: { value: new THREE.Vector2() },
      },
      true,
    );
    this.taaMat = pass(taaFragment, {
      uCurrent: { value: null },
      uHistory: { value: null },
      uVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uInvVelScale: { value: 0 },
      uKeep: { value: 0 },
    });
    this.blurMat = pass(blurFragment, {
      uColor: { value: null },
      uVelocity: { value: null },
      uMaxBlur: { value: 0.08 },
      uSeed: { value: 0 },
      uNearFar: { value: new THREE.Vector2(0.02, 600) },
      uFocusNear: { value: 0.16 },
      uNearBlur: { value: 0.03 },
      uAspect: { value: new THREE.Vector2(1, 1) },
    });
    this.downMat = pass(downFragment, {
      uTex: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 0 },
      uMeter: { value: null },
      uKey: { value: 0.18 },
    });
    this.upMat = pass(upFragment, {
      uTex: { value: null },
      uBase: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uMix: { value: 0.6 },
    });
    this.meterMat = pass(meterFragment, {
      uTex: { value: null },
      uPrev: { value: null },
      uBlendBrighter: { value: 1 },
      uBlendDarker: { value: 1 },
      uDarkest: { value: 0.02 },
    });
    this.finishMat = pass(finishFragment, {
      uColor: { value: null },
      uBloom: { value: null },
      uMeter: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uKey: { value: 0.18 },
      uExposureBias: { value: 1 },
      uBloomAmount: { value: 0.06 },
      uTime: { value: 0 },
      uGrain: { value: 0.03 },
      uSharpen: { value: 0.4 },
      uVignette: { value: 0.3 },
      uSaturation: { value: 1.2 },
      uContrast: { value: 1.08 },
      uWhiteBalance: { value: new THREE.Vector3(1, 1, 1) },
      uFrame: { value: rig.frame },
      uDepth: { value: null },
      uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
      uSunOn: { value: 0 },
      uFlare: { value: 1 },
    });

    const tiny = () =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
      });
    this.meter = [tiny(), tiny()];
  }

  /** (Re)create the render targets for an output of width x height pixels. */
  setSize(width: number, height: number, quality: number): void {
    this.width = width;
    this.height = height;
    this.rig.configure(width, height, quality);
    const { x: vw, y: vh } = this.rig.viewSize;
    for (const rt of [this.viewUp, this.viewDown, this.lensRT, this.blurRT, ...this.past, ...this.bloom, ...this.bloomUp]) rt?.dispose();

    const view = () => {
      const rt = new THREE.WebGLRenderTarget(vw, vh, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        samples: this.msaa,
      });
      rt.depthTexture = new THREE.DepthTexture(vw, vh, THREE.UnsignedIntType);
      rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
      return rt;
    };
    const full = () =>
      new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
    this.past = [full(), full()];
    this.pastReset = true;
    this.viewUp = view();
    this.viewDown = view();
    this.lensRT = new THREE.WebGLRenderTarget(width, height, {
      count: 2,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.blurRT = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    });
    this.bloom = [];
    this.bloomUp = [];
    const taps = this.lean ? 6 : 14;
    if (this.blurMat.defines?.TAPS !== taps) {
      this.blurMat.defines = { TAPS: taps };
      this.blurMat.needsUpdate = true;
    }
    let w = width;
    let h = height;
    for (let i = 0; i < (this.lean ? 3 : 5); i++) {
      w = Math.max(2, w >> 1);
      h = Math.max(2, h >> 1);
      const make = () =>
        new THREE.WebGLRenderTarget(w, h, {
          type: THREE.HalfFloatType,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
        });
      this.bloom.push(make());
      this.bloomUp.push(make());
    }
    this.meterReset = true;
    this.hasPrev = false;
  }

  /** Forget motion history (after a teleport or cut), so no streak is drawn across the jump. */
  cut(): void {
    this.hasPrev = false;
    this.meterReset = true;
    this.pastReset = true;
  }

  private draw(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, this.cam);
  }

  /** Draw one finished frame. `dt` = seconds since the previous frame. */
  render(scene: THREE.Scene, dt: number): void {
    const r = this.renderer;
    const rig = this.rig;
    const look = this.look;
    this.time += dt;
    rig.update();

    // 1. the scene, twice. Each frame both views are nudged by a different fraction of a pixel (step 2b
    // averages the frames); the nudge stands still while the game is paused.
    const smoothing = look.smoothing > 0;
    if (dt > 1e-5) this.frame++;
    const [jx, jy] = smoothing ? JITTER[this.frame % JITTER.length] : [0.5, 0.5];
    const { x: vw, y: vh } = rig.viewSize;
    for (const cam of [rig.up, rig.down]) {
      const e = cam.projectionMatrix.elements;
      e[8] = (-2 * (jx - 0.5)) / vw;
      e[9] = (-2 * (jy - 0.5)) / vh;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    r.setRenderTarget(this.viewUp);
    r.render(scene, rig.up);
    r.setRenderTarget(this.viewDown);
    r.render(scene, rig.down);

    // 2. bend into the fisheye picture, note how far everything moved
    const lu = this.lensMat.uniforms;
    lu.uColUp.value = this.viewUp.texture;
    lu.uColDown.value = this.viewDown.texture;
    lu.uDepthUp.value = this.viewUp.depthTexture;
    lu.uDepthDown.value = this.viewDown.depthTexture;
    lu.uSinHalfMax.value = rig.sinHalfMax;
    (lu.uNearFar.value as THREE.Vector2).set(rig.up.near, rig.up.far);
    (lu.uRigWorld.value as THREE.Matrix4).copy(rig.rig.matrixWorld);
    if (!this.hasPrev) this.prevRig.copy(rig.rig.matrixWorld);
    this.prevRigInv.copy(this.prevRig).invert();
    (lu.uPrevRigInv.value as THREE.Matrix4).copy(this.prevRigInv);
    lu.uVelScale.value = dt > 1e-5 ? Math.min(look.shutter / dt, 2.0) : 0;
    (lu.uFringe.value as THREE.Vector3).set(1 + look.fringe, 1, 1 - look.fringe);
    (lu.uJitter.value as THREE.Vector2).set((jx - 0.5) / vw, (jy - 0.5) / vh);
    const hadPrev = this.hasPrev;
    this.draw(this.lensMat, this.lensRT);
    this.prevRig.copy(rig.rig.matrixWorld);
    this.hasPrev = true;

    // 2b. average with the frames before (edge smoothing over time)
    let sharp: THREE.Texture = this.lensRT.textures[0];
    if (smoothing) {
      const tu = this.taaMat.uniforms;
      const from = this.past[this.pastIndex];
      const to = this.past[1 - this.pastIndex];
      const scale = lu.uVelScale.value as number;
      tu.uCurrent.value = this.lensRT.textures[0];
      tu.uHistory.value = from.texture;
      tu.uVelocity.value = this.lensRT.textures[1];
      (tu.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
      tu.uInvVelScale.value = scale > 1e-4 ? 1 / scale : 0;
      // while paused (no time passes) the picture stands still, so the past is simply kept
      tu.uKeep.value = this.pastReset || !hadPrev ? 0 : dt > 1e-5 ? look.smoothing : 0.98;
      this.draw(this.taaMat, to);
      this.pastIndex = 1 - this.pastIndex;
      this.pastReset = false;
      sharp = to.texture;
    }

    // 3. motion streaks
    const bu = this.blurMat.uniforms;
    bu.uColor.value = sharp;
    bu.uVelocity.value = this.lensRT.textures[1];
    bu.uMaxBlur.value = look.maxBlur;
    bu.uSeed.value = (this.time * 60) % 97;
    (bu.uNearFar.value as THREE.Vector2).set(rig.up.near, rig.up.far);
    bu.uFocusNear.value = look.focusNear;
    bu.uNearBlur.value = look.nearBlur;
    (bu.uAspect.value as THREE.Vector2).set(1, this.width / this.height);
    this.draw(this.blurMat, this.blurRT);

    // 4. glow
    const du = this.downMat.uniforms;
    let src: THREE.Texture = this.blurRT.texture;
    let sw = this.width;
    let sh = this.height;
    for (let i = 0; i < this.bloom.length; i++) {
      du.uTex.value = src;
      (du.uTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
      du.uThreshold.value = i === 0 ? 1.15 : 0;
      du.uMeter.value = this.meter[this.meterIndex].texture;
      du.uKey.value = look.key * look.exposureBias;
      this.draw(this.downMat, this.bloom[i]);
      src = this.bloom[i].texture;
      sw = this.bloom[i].width;
      sh = this.bloom[i].height;
    }
    const uu = this.upMat.uniforms;
    let small: THREE.Texture = this.bloom[this.bloom.length - 1].texture;
    for (let i = this.bloom.length - 2; i >= 0; i--) {
      uu.uTex.value = small;
      uu.uBase.value = this.bloom[i].texture;
      (uu.uTexel.value as THREE.Vector2).set(1 / this.bloom[i + 1].width, 1 / this.bloom[i + 1].height);
      this.draw(this.upMat, this.bloomUp[i]);
      small = this.bloomUp[i].texture;
    }

    // 5. automatic exposure
    const mu = this.meterMat.uniforms;
    const from = this.meter[this.meterIndex];
    const to = this.meter[1 - this.meterIndex];
    mu.uTex.value = this.blurRT.texture;
    mu.uPrev.value = from.texture;
    mu.uBlendBrighter.value = this.meterReset ? 1 : 1 - Math.exp(-dt / Math.max(look.adaptBrighter, 1e-3));
    mu.uBlendDarker.value = this.meterReset ? 1 : 1 - Math.exp(-dt / Math.max(look.adaptDarker, 1e-3));
    mu.uDarkest.value = look.darkest;
    this.draw(this.meterMat, to);
    this.meterIndex = 1 - this.meterIndex;
    this.meterReset = false;

    // 6. tone, colour, grain -> screen
    const fu = this.finishMat.uniforms;
    fu.uColor.value = this.blurRT.texture;
    fu.uBloom.value = small;
    fu.uMeter.value = to.texture;
    (fu.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    fu.uKey.value = look.key;
    fu.uExposureBias.value = look.exposureBias;
    fu.uBloomAmount.value = look.bloom;
    fu.uTime.value = this.time;
    fu.uGrain.value = look.grain;
    fu.uSharpen.value = look.sharpen;
    fu.uVignette.value = look.vignette;
    fu.uSaturation.value = look.saturation;
    fu.uContrast.value = look.contrast;
    fu.uDepth.value = this.lensRT.textures[1];
    fu.uFlare.value = look.flare;
    // where is the sun in the fisheye picture?
    const s = this.sunLocal.copy(this.sunDir).transformDirection(this.prevRigInv.copy(rig.rig.matrixWorld).invert());
    const theta = Math.acos(Math.max(-1, Math.min(1, -s.z)));
    const rr = Math.sin(theta / 2) / rig.sinHalfMax;
    const l = Math.hypot(s.x, s.y) || 1;
    (fu.uSunUv.value as THREE.Vector2).set(((s.x / l) * rr) / rig.frame.x * 0.5 + 0.5, ((s.y / l) * rr) / rig.frame.y * 0.5 + 0.5);
    fu.uSunOn.value = theta < 1.5 ? Math.min(1, (1.5 - theta) * 4) : 0;
    this.draw(this.finishMat, null);
  }

}
