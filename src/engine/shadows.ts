import * as THREE from 'three';
import type { Globals } from './materials';

/** Objects on this layer cast a live shadow (cats, loose props). */
export const SHADOW_LAYER = 1;

/**
 * Shadows of things that move. The world's own shadows are baked; this only adds the
 * cat's shadow and those of other moving things, drawn from the sun's point of view into two
 * depth pictures: a sharp one around the player and a wide, softer one for everything else.
 */
export class LiveShadows {
  private readonly near: THREE.WebGLRenderTarget;
  private readonly far: THREE.WebGLRenderTarget;
  private readonly camNear = new THREE.OrthographicCamera(-3.2, 3.2, 3.2, -3.2, 0.5, 80);
  private readonly camFar = new THREE.OrthographicCamera(-26, 26, 26, -26, 0.5, 120);
  private readonly depthMat = new THREE.MeshDepthMaterial();
  private readonly tmp = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly view = new THREE.Matrix4();

  constructor(private readonly globals: Globals, size = 2048) {
    const make = () => {
      const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      rt.depthTexture = new THREE.DepthTexture(size, size);
      rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
      return rt;
    };
    this.near = make();
    this.far = make();
    this.depthMat.colorWrite = false;
    this.depthMat.side = THREE.DoubleSide;
    this.camNear.layers.set(SHADOW_LAYER);
    this.camFar.layers.set(SHADOW_LAYER);
    globals.uShadowNear.value = this.near.depthTexture!;
    globals.uShadowFar.value = this.far.depthTexture!;
    globals.uShadowTexel.value.set(1 / size, 1 / size);
    globals.uShadowOn.value = 1;
  }

  private aim(cam: THREE.OrthographicCamera, focus: THREE.Vector3, sun: THREE.Vector3, size: number, mat: THREE.Matrix4): void {
    // light-space axes; snap the focus to whole texels so the shadow edge does not crawl when moving
    this.right.set(sun.z, 0, -sun.x).normalize();
    this.up.crossVectors(sun, this.right).normalize();
    const texel = (cam.right - cam.left) / size;
    const fx = Math.round(focus.dot(this.right) / texel) * texel;
    const fy = Math.round(focus.dot(this.up) / texel) * texel;
    const fz = focus.dot(sun);
    this.tmp.set(0, 0, 0).addScaledVector(this.right, fx).addScaledVector(this.up, fy).addScaledVector(sun, fz + 40);
    cam.position.copy(this.tmp);
    this.view.makeBasis(this.right, this.up, sun);
    cam.quaternion.setFromRotationMatrix(this.view);
    cam.updateMatrixWorld(true);
    mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  /** Redraw both shadow pictures around `focus` (the player). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, focus: THREE.Vector3): void {
    const g = this.globals;
    const sun = g.uSunDir.value;
    this.aim(this.camNear, focus, sun, this.near.width, g.uShadowNearMat.value);
    this.aim(this.camFar, focus, sun, this.far.width, g.uShadowFarMat.value);
    const keep = scene.overrideMaterial;
    scene.overrideMaterial = this.depthMat;
    renderer.setRenderTarget(this.near);
    renderer.clear();
    renderer.render(scene, this.camNear);
    renderer.setRenderTarget(this.far);
    renderer.clear();
    renderer.render(scene, this.camFar);
    scene.overrideMaterial = keep;
    renderer.setRenderTarget(null);
  }
}
