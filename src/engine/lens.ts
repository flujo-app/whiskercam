import * as THREE from 'three';

/**
 * The collar camera.
 *
 * A real action-camera lens sees far more than a normal 3D camera can draw in one go
 * (about 140 degrees top to bottom). So the scene is drawn twice from the same spot, once
 * tilted up and once tilted down, and the two pictures are bent into one fisheye image
 * afterwards (see post.ts / lensFragment).
 */
export class LensRig {
  /** Position and direction of the lens. Move this; the two view cameras follow. */
  readonly rig = new THREE.Object3D();
  readonly up = new THREE.PerspectiveCamera(90, 1, 0.02, 600);
  readonly down = new THREE.PerspectiveCamera(90, 1, 0.02, 600);
  readonly pitch = THREE.MathUtils.degToRad(45);

  /** half picture size in "half diagonal = 1" units */
  readonly frame = new THREE.Vector2();
  /** half-size of each view at distance 1 */
  readonly tan = new THREE.Vector2(1, 1);
  sinHalfMax = 0.65;
  /** pixel size of one view */
  readonly viewSize = new THREE.Vector2(512, 512);

  constructor(public diagonalFovDeg = 164) {
    this.rig.rotation.order = 'YXZ';
    this.up.rotation.x = this.pitch;
    this.down.rotation.x = -this.pitch;
    this.rig.add(this.up, this.down);
  }

  /** Set the output picture size (pixels) and how finely the two views are drawn. */
  configure(width: number, height: number, quality = 1): void {
    const diag = Math.hypot(width, height);
    this.frame.set(width / diag, height / diag);
    const thetaMax = THREE.MathUtils.degToRad(this.diagonalFovDeg / 2);
    this.sinHalfMax = Math.sin(thetaMax / 2);

    // how wide must each view be to cover its half of the fisheye picture?
    let tx = 0;
    let ty = 0;
    const n = 40;
    const c = Math.cos(this.pitch);
    const s = Math.sin(this.pitch);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const px = ((i / n) * 2 - 1) * this.frame.x;
        const py = (j / n) * this.frame.y; // upper half; the lower half mirrors it
        const r = Math.hypot(px, py);
        const theta = 2 * Math.asin(Math.min(r * this.sinHalfMax, 0.9995));
        const dx = r > 1e-6 ? (px / r) * Math.sin(theta) : 0;
        const dy = r > 1e-6 ? (py / r) * Math.sin(theta) : 0;
        const dz = -Math.cos(theta);
        const ly = c * dy + s * dz;
        const lz = -s * dy + c * dz;
        if (-lz < 1e-3) continue;
        tx = Math.max(tx, Math.abs(dx / -lz));
        ty = Math.max(ty, Math.abs(ly / -lz));
      }
    }
    tx *= 1.04;
    ty *= 1.04;
    this.tan.set(tx, ty);
    for (const cam of [this.up, this.down]) {
      cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(ty));
      cam.aspect = tx / ty;
      cam.updateProjectionMatrix();
    }
    const vh = Math.round(0.73 * diag * quality * ty);
    this.viewSize.set(Math.round((vh * tx) / ty), vh);
  }

  /** heading: 0 = north (-Z), clockwise seen from above. pitch: up is positive. Degrees. */
  setPose(x: number, y: number, z: number, headingDeg: number, pitchDeg: number, rollDeg = 0): void {
    this.rig.position.set(x, y, z);
    this.rig.rotation.set(
      THREE.MathUtils.degToRad(pitchDeg),
      -THREE.MathUtils.degToRad(headingDeg),
      THREE.MathUtils.degToRad(rollDeg),
    );
  }

  update(): void {
    this.rig.updateMatrixWorld(true);
  }
}
