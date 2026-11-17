import * as THREE from 'three';
import type { LensRig } from './lens';
import {
  blurFragment,
  downFragment,
  finishFragment,
  fullscreenVertex,
  lensFragment,
  meterFragment,
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
}

export const defaultLook: LookSettings = {
  key: 0.2,
  exposureBias: 1.0,
  bloom: 0.07,
  grain: 0.035,
  sharpen: 0.45,
  vignette: 0.32,
  saturation: 1.22,
  contrast: 1.1,
  shutter: 1 / 60,
  maxBlur: 0.09,
  adaptBrighter: 0.3,
  adaptDarker: 0.9,
  fringe: 0.004,
};

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
  private bloom: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private meter: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private meterIndex = 0;
  private meterReset = true;

  private readonly lensMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly meterMat: THREE.ShaderMaterial;
  private readonly finishMat: THREE.ShaderMaterial;

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
      },
      true,
    );
    this.blurMat = pass(blurFragment, {
      uColor: { value: null },
      uVelocity: { value: null },
      uMaxBlur: { value: 0.08 },
      uSeed: { value: 0 },
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
    for (const rt of [this.viewUp, this.viewDown, this.lensRT, this.blurRT, ...this.bloom, ...this.bloomUp]) rt?.dispose();

    const view = () => {
      const rt = new THREE.WebGLRenderTarget(vw, vh, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
      });
      rt.depthTexture = new THREE.DepthTexture(vw, vh);
      rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
      return rt;
    };
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
    let w = width;
    let h = height;
    for (let i = 0; i < 5; i++) {
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

    // 1. the scene, twice
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
    this.draw(this.lensMat, this.lensRT);
    this.prevRig.copy(rig.rig.matrixWorld);
    this.hasPrev = true;

    // 3. motion streaks
    const bu = this.blurMat.uniforms;
    bu.uColor.value = this.lensRT.textures[0];
    bu.uVelocity.value = this.lensRT.textures[1];
    bu.uMaxBlur.value = look.maxBlur;
    bu.uSeed.value = (this.time * 60) % 97;
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
    this.draw(this.finishMat, null);
  }

}
