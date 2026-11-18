import * as THREE from 'three';
import { FLAT_MIX, type Globals, type Materials, type ProbeRef } from './materials';
import type { Physics } from './physics';
import { fullscreenVertex } from './shaders/post.glsl';
import type { Sky } from './sky';
import { isCarPart, type LoadedWorld } from './world';

/**
 * Real reflections.
 *
 * Shiny things mirror what is around them, and what is around a parked car is not the open sky: it is the
 * house behind you, the tree, the next car, the kerb. Following every mirror ray through the scene is far
 * too slow, so the game does what a photographer would: it takes an all-round picture ("probe") from the
 * middle of every parked car and in front of every house wall, once, when the estate has loaded. A shiny
 * surface then looks its reflection up in the nearest of these pictures.
 *
 * Two things make that look right instead of roughly right:
 *  - Every picture also stores how far away each thing in it is. A surface that is not exactly where the
 *    picture was taken uses that to work out where its own mirror ray ends up (see probeDir in world.glsl.ts),
 *    so the reflection of the kerb sits where the kerb is.
 *  - The picture of the car nearest to the cat is kept up to date: every frame the cats and everything else
 *    that moves are drawn into it again, on top of the picture of what stands still.
 *
 * And right in front of a glass wall the game draws a true mirror image (the scene seen from behind the
 * glass), so a cat can see itself in a door.
 */

/** Everything that stands still is on this layer as well: the pictures taken at loading time show only that. */
export const STILL_LAYER = 2;
/** Everything that moves (cats, pigeons, pots and balls) is on this one: drawn into the picture that is kept up to date. */
export const MOVING_LAYER = 3;

/** The car a picture is taken from the inside of, which must not be in that picture. */
export interface HideBox {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  halfLength: number;
  halfWidth: number;
  y0: number;
  y1: number;
}

/** One all-round picture and the values the materials that use it share. */
export class Probe implements ProbeRef {
  readonly uProbe: THREE.IUniform<THREE.Texture>;
  readonly uProbePos = { value: new THREE.Vector3() };
  readonly uProbeLod = { value: 0 };
  readonly uProbeOn = { value: 0 };
  readonly target: THREE.WebGLCubeRenderTarget;
  /** how many of its six sides have been taken (in the round that is under way) */
  faces = 0;
  /** all six sides have been taken at least once */
  taken = false;

  constructor(readonly id: string, x: number, y: number, z: number, readonly size: number, readonly kind: 'car' | 'wall', readonly hide: HideBox | null) {
    this.target = cubeTarget(size);
    this.uProbe = { value: this.target.texture };
    this.uProbePos.value.set(x, y, z);
    this.uProbeLod.value = Math.log2(size);
  }

}

function cubeTarget(size: number): THREE.WebGLCubeRenderTarget {
  const t = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  t.texture.name = 'probe';
  return t;
}

// The six views, turned so that a picture point is looked up with the plain direction towards it.
const LOOK: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const UP: [number, number, number][] = [[0, -1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, -1, 0]];

const copyFragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uNearFar;
varying vec2 vUv;
void main() {
  vec3 c = clamp(texture2D(tColor, vUv).rgb, 0.0, 30000.0);
  float d = texture2D(tDepth, vUv).r;
  float n = uNearFar.x;
  float f = uNearFar.y;
  float along = n * f / (f - d * (f - n));          // distance along the view direction
  vec2 p = vUv * 2.0 - 1.0;                          // the view is 90 degrees wide
  gl_FragColor = vec4(c, min(along * sqrt(1.0 + dot(p, p)), 3000.0));
}
`;

// Puts the picture of what stands still back (colour, and how far away everything is), so that only the
// things that move have to be drawn again.
const restoreFragment = /* glsl */ `
precision highp float;
uniform samplerCube tProbe;
uniform mat3 uFace;
uniform vec2 uNearFar;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec4 s = textureLod(tProbe, uFace * vec3(p, -1.0), 0.0);
  float along = max(s.a / sqrt(1.0 + dot(p, p)), uNearFar.x);
  gl_FragDepth = clamp(uNearFar.y * (along - uNearFar.x) / (along * (uNearFar.y - uNearFar.x)), 0.0, 1.0);
  gl_FragColor = vec4(s.rgb, 1.0);
}
`;

export class Reflections {
  readonly probes: Probe[] = [];
  /** called before / after a picture is taken at (x, z): the game hides what must not be in it */
  before: ((x: number, z: number, live: boolean) => void) | null = null;
  after: (() => void) | null = null;

  private readonly cam = new THREE.PerspectiveCamera(90, 1, 0.05, 600);
  private readonly flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly copy: THREE.ShaderMaterial;
  private readonly restore: THREE.ShaderMaterial;
  private readonly quadScene = new THREE.Scene();
  private readonly shots = new Map<number, THREE.WebGLRenderTarget>();
  private owed: Probe[] = [];

  /** the probe that is kept up to date while the cat is near it, and the picture it is drawn into */
  private hero: Probe | null = null;
  private heroTarget: THREE.WebGLCubeRenderTarget | null = null;
  private heroFace = 0;
  private heroRound = false;

  // the true mirror image of the glass wall in front of the cat
  private mirror: THREE.WebGLRenderTarget | null = null;
  private readonly mirrorCam = new THREE.PerspectiveCamera(110, 1, 0.05, 600);
  private readonly mirrorMat = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly globals: Globals,
    private readonly sky: Sky,
  ) {
    this.copy = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: copyFragment,
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uNearFar: { value: new THREE.Vector2(0.05, 600) } },
      depthTest: false,
      depthWrite: false,
    });
    this.restore = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: restoreFragment,
      uniforms: { tProbe: { value: null }, uFace: { value: new THREE.Matrix3() }, uNearFar: { value: new THREE.Vector2(0.05, 600) } },
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copy);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  add(id: string, x: number, y: number, z: number, size: number, kind: 'car' | 'wall', hide: HideBox | null = null): Probe {
    const p = new Probe(id, x, y, z, size, kind, hide);
    this.probes.push(p);
    this.owed.push(p);
    return p;
  }

  /** Take the pictures nearest to (x, z) first. */
  prioritise(x: number, z: number): void {
    const d = (p: Probe) => Math.hypot(p.uProbePos.value.x - x, p.uProbePos.value.z - z);
    this.owed.sort((a, b) => d(a) - d(b));
  }

  /** Take up to `views` of the pictures that are still owed (a picture has six). Returns how many views are left. */
  work(views: number): number {
    while (views > 0 && this.owed.length) {
      const p = this.owed[0];
      this.view(p, p.faces, p.target, false);
      p.faces++;
      views--;
      if (p.faces >= 6) {
        p.taken = true;
        p.uProbeOn.value = 1;
        this.owed.shift();
      }
    }
    return this.owed.reduce((n, p) => n + 6 - p.faces, 0);
  }

  /** Take every picture again (the surroundings look different now: the full surface pictures have arrived). */
  retake(): void {
    for (const p of this.probes) p.faces = 0;
    this.owed = [...this.probes];
  }

  /** Keep this probe's picture up to date from now on (null = none). */
  follow(p: Probe | null): void {
    if (p === this.hero) return;
    if (this.hero) this.hero.uProbe.value = this.hero.target.texture;
    this.hero = p && p.taken ? p : null;
    this.heroFace = 0;
    this.heroRound = false;
  }

  /** Once per drawn frame: `views` more sides of the picture that is kept up to date (it has six). */
  tick(views = 2): void {
    const p = this.hero;
    if (!p) return;
    this.heroTarget ??= cubeTarget(p.size);
    for (let i = 0; i < views; i++) {
      this.view(p, this.heroFace, this.heroTarget, true);
      if (++this.heroFace === 6) {
        this.heroFace = 0;
        if (!this.heroRound) {
          // all six sides are of this place now: start using it
          this.heroRound = true;
          p.uProbe.value = this.heroTarget.texture;
        }
      }
    }
  }

  /** How far (x, y, z) is from a probe: from the car's body for a car, from the spot the picture was taken otherwise. */
  distance(p: Probe, x: number, y: number, z: number): number {
    return p.hide ? boxDistance(p.hide, x, z) : this.tmp.set(x, y, z).distanceTo(p.uProbePos.value);
  }

  /** The nearest taken probe of a kind within `reach` metres of a point, or null. */
  nearest(x: number, y: number, z: number, kind: 'car' | 'wall', reach: number): Probe | null {
    let best: Probe | null = null;
    let bestD = reach;
    for (const p of this.probes) {
      if (p.kind !== kind || !p.taken) continue;
      const d = this.distance(p, x, y, z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private shot(size: number): THREE.WebGLRenderTarget {
    let rt = this.shots.get(size);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(size, size, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        samples: 4,
      });
      rt.depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
      rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
      this.shots.set(size, rt);
    }
    return rt;
  }

  /** One of the six views of a probe, into side `face` of `target`. */
  private view(p: Probe, face: number, target: THREE.WebGLCubeRenderTarget, live: boolean): void {
    const r = this.renderer;
    const g = this.globals;
    const at = p.uProbePos.value;
    const cam = this.cam;
    cam.position.copy(at);
    cam.up.fromArray(UP[face]);
    cam.lookAt(at.x + LOOK[face][0], at.y + LOOK[face][1], at.z + LOOK[face][2]);
    cam.layers.mask = live ? 1 << MOVING_LAYER : 1 << STILL_LAYER;
    cam.updateMatrixWorld(true);
    const keep = r.getRenderTarget();
    const shot = this.shot(target.width);
    r.setRenderTarget(shot);
    if (live) {
      // what stands still is already in this probe's own picture: put it back, then draw only what moves
      const ru = this.restore.uniforms;
      ru.tProbe.value = p.target.texture;
      (ru.uFace.value as THREE.Matrix3).setFromMatrix4(cam.matrixWorld);
      (ru.uNearFar.value as THREE.Vector2).set(cam.near, cam.far);
      this.quad.material = this.restore;
      r.render(this.quadScene, this.flat);
      const auto = r.autoClear;
      r.autoClear = false;
      r.render(this.scene, cam);
      r.autoClear = auto;
    } else {
      this.before?.(at.x, at.z, live);
      if (p.hide) {
        const h = p.hide;
        g.uHideBox.value.set(h.x, 0, h.z, 1);
        g.uHideDir.value.set(h.dirX, h.dirZ, h.halfLength, h.halfWidth);
        g.uHideY.value.set(h.y0, h.y1);
      }
      this.sky.sunDisc = false;
      r.render(this.scene, cam);
      this.sky.sunDisc = true;
      g.uHideBox.value.w = 0;
      this.after?.();
    }
    const u = this.copy.uniforms;
    u.tColor.value = shot.texture;
    u.tDepth.value = shot.depthTexture;
    (u.uNearFar.value as THREE.Vector2).set(cam.near, cam.far);
    this.quad.material = this.copy;
    r.setRenderTarget(target, face);
    r.render(this.quadScene, this.flat);
    r.setRenderTarget(keep);
  }

  /**
   * The true mirror image of an upright glass wall, as seen from `eye`: the scene drawn from the point behind
   * the wall where the mirrored eye is, looking out through the glass (and through no more of the wall than
   * the glass covers, so most of the estate is left out of the drawing). Pass null to switch it off.
   */
  setMirror(eye: THREE.Vector3 | null, wall: GlassWall | null = null, strength = 1): void {
    const g = this.globals;
    if (!eye || !wall || strength <= 0) {
      g.uMirrorOn.value = 0;
      return;
    }
    const { nx, nz, offset } = wall;
    const away = eye.x * nx + eye.z * nz - offset; // how far in front of the wall the eye is
    if (away < 0.06) {
      g.uMirrorOn.value = 0;
      return;
    }
    if (!this.mirror) {
      this.mirror = new THREE.WebGLRenderTarget(768, 768, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        samples: 4,
      });
      g.uMirror.value = this.mirror.texture;
    }
    const cam = this.mirrorCam;
    cam.position.set(eye.x - 2 * away * nx, eye.y, eye.z - 2 * away * nz);
    cam.up.set(0, 1, 0);
    cam.lookAt(cam.position.x + nx, cam.position.y, cam.position.z + nz);
    // Everything between the mirrored eye and the wall is the building itself: start drawing at the wall.
    // The picture covers the glass and no more (at most 62 degrees to any side).
    const te = eye.z * nx - eye.x * nz;
    const wide = away * 1.88;
    const left = Math.max(wall.t0 - 0.06 - te, -wide);
    const right = Math.min(wall.t1 + 0.06 - te, wide);
    const bottom = Math.max(wall.y0 - 0.06 - eye.y, -wide);
    const top = Math.min(wall.y1 + 0.06 - eye.y, wide);
    if (right - left < 0.02 || top - bottom < 0.02) {
      g.uMirrorOn.value = 0;
      return;
    }
    cam.near = away;
    cam.far = 600;
    cam.projectionMatrix.makePerspective(left, right, top, bottom, away, 600);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.layers.mask = 1 | (1 << STILL_LAYER) | (1 << MOVING_LAYER);
    cam.updateMatrixWorld(true);
    this.before?.(eye.x, eye.z, true);
    this.sky.sunDisc = false;
    const r = this.renderer;
    const keep = r.getRenderTarget();
    r.setRenderTarget(this.mirror);
    r.render(this.scene, cam);
    r.setRenderTarget(keep);
    this.sky.sunDisc = true;
    this.after?.();
    this.mirrorMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    g.uMirrorMat.value.copy(this.mirrorMat);
    g.uMirrorPlane.value.set(nx, 0, nz, offset);
    g.uMirrorOn.value = Math.min(1, strength);
  }

  /** Put an object and everything in it that is drawn in the game's own picture on the layer of things that move. */
  static moving(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (o.layers.isEnabled(0)) o.layers.enable(MOVING_LAYER);
    });
  }
}

function boxDistance(h: HideBox, x: number, z: number): number {
  const qx = x - h.x;
  const qz = z - h.z;
  const along = Math.abs(qx * h.dirX + qz * h.dirZ) - h.halfLength;
  const across = Math.abs(qz * h.dirX - qx * h.dirZ) - h.halfWidth;
  return Math.hypot(Math.max(along, 0), Math.max(across, 0));
}

// ------------------------------------------------------------------------------------------------------
// Deciding where the pictures are taken, and which surface uses which

/** A glass wall the cat can stand in front of (for the true mirror image). */
export interface GlassWall {
  nx: number;
  nz: number;
  offset: number;
  /** extent along the wall (t = z * nx - x * nz) and in height, of the glass that is low enough to matter */
  t0: number;
  t1: number;
  y0: number;
  y1: number;
}

export interface ReflectionPlan {
  cars: number;
  walls: number;
  meshes: number;
  glassWalls: GlassWall[];
}

interface Cut {
  /** triangle corner numbers per group */
  groups: Map<number, number[]>;
  rest: number[];
}

const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vc = new THREE.Vector3();
const vn = new THREE.Vector3();

/**
 * Sort the triangles of a mesh into groups; `pick` gets a triangle's middle, its facing and the number of its
 * first corner point, and returns a group (or -1).
 */
function cut(mesh: THREE.Mesh, pick: (cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, corner: number) => number): Cut {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const index = geo.index;
  const n = index ? index.count : pos.count;
  const groups = new Map<number, number[]>();
  const rest: number[] = [];
  const m = mesh.matrixWorld;
  for (let i = 0; i < n; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    va.fromBufferAttribute(pos, i0).applyMatrix4(m);
    vb.fromBufferAttribute(pos, i1).applyMatrix4(m);
    vc.fromBufferAttribute(pos, i2).applyMatrix4(m);
    vn.subVectors(vb, va).cross(vc.sub(va)).normalize();
    vc.add(va); // (vc was made relative to va for the cross product)
    const k = pick((va.x + vb.x + vc.x) / 3, (va.y + vb.y + vc.y) / 3, (va.z + vb.z + vc.z) / 3, vn.x, vn.y, vn.z, i0);
    let list = rest;
    if (k >= 0) {
      list = groups.get(k) ?? [];
      if (!list.length) groups.set(k, list);
    }
    list.push(i0, i1, i2);
  }
  return { groups, rest };
}

/** A mesh made of some of another mesh's triangles (the corner points themselves are shared, not copied). */
function part(mesh: THREE.Mesh, corners: number[], material: THREE.Material, name: string): THREE.Mesh {
  const src = mesh.geometry;
  const geo = new THREE.BufferGeometry();
  for (const [key, attr] of Object.entries(src.attributes)) geo.setAttribute(key, attr);
  const pos = src.attributes.position;
  geo.setIndex(pos.count > 65535 ? new THREE.BufferAttribute(new Uint32Array(corners), 1) : new THREE.BufferAttribute(new Uint16Array(corners), 1));
  // bounds of these triangles only, so that the part is skipped when it is out of the picture
  const box = new THREE.Box3();
  for (const i of corners) box.expandByPoint(va.fromBufferAttribute(pos, i));
  geo.boundingBox = box;
  geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  const out = new THREE.Mesh(geo, material);
  out.name = name;
  out.matrixAutoUpdate = false;
  out.matrix.copy(mesh.matrix);
  out.layers.mask = mesh.layers.mask;
  out.renderOrder = material.transparent ? 3 : mesh.renderOrder;
  mesh.parent?.add(out);
  out.updateMatrixWorld(true);
  return out;
}

/** Leave only these triangles in a mesh. */
function keep(mesh: THREE.Mesh, corners: number[]): void {
  if (!corners.length) {
    mesh.visible = false;
    return;
  }
  const src = mesh.geometry;
  const geo = new THREE.BufferGeometry();
  for (const [key, attr] of Object.entries(src.attributes)) geo.setAttribute(key, attr);
  geo.setIndex(src.attributes.position.count > 65535 ? new THREE.BufferAttribute(new Uint32Array(corners), 1) : new THREE.BufferAttribute(new Uint16Array(corners), 1));
  geo.boundingBox = src.boundingBox;
  geo.boundingSphere = src.boundingSphere;
  mesh.geometry = geo;
}

/**
 * Put a probe in every parked car and in front of every house wall with glass in it, and hand the shiny
 * surfaces near each one a material that looks its reflections up there.
 * `carSize` / `wallSize` = picture size in pixels per side (0 = no probes of that kind).
 */
export function planReflections(
  world: LoadedWorld,
  physics: Physics,
  refl: Reflections,
  carSize: number,
  wallSize: number,
): ReflectionPlan {
  const mats: Materials = world.materials;
  const plan: ReflectionPlan = { cars: 0, walls: 0, meshes: 0, glassWalls: [] };
  world.group.traverse((o) => o.layers.enable(STILL_LAYER));

  // the building and prop meshes, by what they are made of
  const struct = new Set(world.info.chunks.filter((c) => c.kind === 'struct').map((c) => c.name));
  const meshes: THREE.Mesh[] = [];
  for (const chunk of world.group.children) {
    if (!struct.has(chunk.name)) continue;
    chunk.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) meshes.push(mesh);
    });
  }
  const desc = (mesh: THREE.Mesh) => mats.describe((mesh.material as THREE.Material).name);
  // A chunk's plain-coloured parts are one mesh (see mergeFlats in world.ts): what a triangle is made of is
  // read from its corner points. Returns [metalness, roughness, part of a car?].
  const mixed = (mesh: THREE.Mesh) => (mesh.material as THREE.Material).name === FLAT_MIX;
  const made = (mesh: THREE.Mesh, corner: number): [number, number, boolean] => {
    const extra = mesh.geometry.attributes.aExtra;
    return [extra.getX(corner), mesh.geometry.attributes.aTint.getW(corner), extra.getY(corner) > 0.5];
  };

  // ---- parked cars: how big each one is (from its painted body), then a probe in the middle of each
  type Car = HideBox & { probe: Probe | null; found: boolean };
  const cars: Car[] = ((world.info as { poi?: [string, number, number, number, number][] }).poi ?? [])
    .filter((p) => p[0] === 'car')
    .map(([, x, z, nx, nz]) => ({ x, z, dirX: nx, dirZ: nz, halfLength: 0, halfWidth: 0, y0: 1e9, y1: -1e9, probe: null, found: false }));
  if (carSize > 0 && cars.length) {
    const lo = cars.map(() => [1e9, 1e9]);
    const hi = cars.map(() => [-1e9, -1e9]);
    for (const mesh of meshes) {
      if (desc(mesh)?.kind !== 'paint') continue;
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        va.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        let best = -1;
        let bestD = 3.6;
        cars.forEach((c, k) => {
          const d = Math.hypot(va.x - c.x, va.z - c.z);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        });
        if (best < 0) continue;
        const c = cars[best];
        const along = (va.x - c.x) * c.dirX + (va.z - c.z) * c.dirZ;
        const across = (va.z - c.z) * c.dirX - (va.x - c.x) * c.dirZ;
        lo[best][0] = Math.min(lo[best][0], along);
        hi[best][0] = Math.max(hi[best][0], along);
        lo[best][1] = Math.min(lo[best][1], across);
        hi[best][1] = Math.max(hi[best][1], across);
        c.y1 = Math.max(c.y1, va.y);
        c.found = true;
      }
    }
    cars.forEach((c, k) => {
      if (!c.found) return;
      // centre the box on the body, a hand's width of margin all round (mirrors, bumpers)
      const ma = (lo[k][0] + hi[k][0]) / 2;
      const mc = (lo[k][1] + hi[k][1]) / 2;
      c.x += c.dirX * ma - c.dirZ * mc;
      c.z += c.dirZ * ma + c.dirX * mc;
      c.halfLength = (hi[k][0] - lo[k][0]) / 2 + 0.1;
      c.halfWidth = (hi[k][1] - lo[k][1]) / 2 + 0.14;
      // the ground it stands on: looked up just beside it, on both sides
      let ground = 1e9;
      for (const s of [-1, 1]) {
        const gx = c.x - c.dirZ * s * (c.halfWidth + 0.2);
        const gz = c.z + c.dirX * s * (c.halfWidth + 0.2);
        const hit = physics.groundBelow(gx, c.y1 + 0.5, gz, c.y1 + 2);
        if (hit) ground = Math.min(ground, hit.y);
      }
      if (ground > 1e8) ground = 0;
      c.y0 = ground + 0.012;
      const top = c.y1;
      c.y1 = top + 0.15;
      c.probe = refl.add(`car${k}`, c.x, ground + (top - ground) * 0.6, c.z, carSize, 'car', c);
      plan.cars++;
    });
    // every shiny part of a car looks its reflections up in that car's probe
    for (const mesh of meshes.slice()) {
      const name = (mesh.material as THREE.Material).name;
      const d = desc(mesh);
      const mix = mixed(mesh);
      if (!d || !(mix || isCarPart(name))) continue;
      const shiny = mix || d.kind === 'paint' || d.kind === 'glass' || ((d.metal ?? 0) >= 0.6 && (d.rough ?? 1) <= 0.34);
      if (!shiny) continue;
      const c = cut(mesh, (cx, cy, cz, _nx, _ny, _nz, corner) => {
        if (mix) {
          // chrome, mirrors, lamp bowls, polished wheels
          const [metal, rough, onCar] = made(mesh, corner);
          if (!onCar || metal < 0.59 || rough > 0.345) return -1;
        }
        for (let k = 0; k < cars.length; k++) {
          const car = cars[k];
          if (car.probe && cy > car.y0 - 0.1 && cy < car.y1 && boxDistance(car, cx, cz) <= 0) return k;
        }
        return -1;
      });
      if (!c.groups.size) continue;
      for (const [k, corners] of c.groups) {
        part(mesh, corners, mats.reflecting(mesh.material as THREE.ShaderMaterial, cars[k].probe!), `${name}:car${k}`);
        plan.meshes++;
      }
      keep(mesh, c.rest);
    }
  }

  // ---- house walls with glass in them: one probe in front of each stretch of wall
  if (wallSize > 0) {
    interface Wall {
      nx: number;
      nz: number;
      offset: number;
      t0: number;
      t1: number;
      y0: number;
      y1: number;
      /** the glass a cat could see itself in: extent along the wall and in height, and where exactly the panes are */
      low: [number, number, number, number];
      lowSum: number;
      lowCount: number;
      probe: Probe | null;
    }
    const walls = new Map<string, Wall>();
    const SEG = 14;
    const wallKey = (cx: number, cz: number, nx: number, nz: number): string => {
      const ax = Math.abs(nx) > Math.abs(nz);
      const sx = ax ? Math.sign(nx) : 0;
      const sz = ax ? 0 : Math.sign(nz);
      const offset = Math.round((cx * sx + cz * sz) * 2) / 2;
      const t = cz * sx - cx * sz;
      return `${sx},${sz},${offset},${Math.floor(t / SEG)}`;
    };
    const glass = meshes.filter((m) => {
      const d = desc(m);
      return d?.kind === 'glass' && !d.clear && !isCarPart((m.material as THREE.Material).name);
    });
    const cuts = new Map<THREE.Mesh, Cut>();
    const keys: string[] = [];
    for (const mesh of glass) {
      const c = cut(mesh, (cx, cy, cz, nx, ny, nz) => {
        if (Math.abs(ny) > 0.5) return -1;
        const key = wallKey(cx, cz, nx, nz);
        let w = walls.get(key);
        if (!w) {
          const [sx, sz, offset] = key.split(',').map(Number);
          w = { nx: sx, nz: sz, offset, t0: 1e9, t1: -1e9, y0: 1e9, y1: -1e9, low: [1e9, -1e9, 1e9, -1e9], lowSum: 0, lowCount: 0, probe: null };
          walls.set(key, w);
          keys.push(key);
        }
        const t = cz * w.nx - cx * w.nz;
        w.t0 = Math.min(w.t0, t);
        w.t1 = Math.max(w.t1, t);
        w.y0 = Math.min(w.y0, cy);
        w.y1 = Math.max(w.y1, cy);
        if (cy < 3.2) {
          // glass low enough for a cat to see itself in
          w.low[0] = Math.min(w.low[0], t);
          w.low[1] = Math.max(w.low[1], t);
          w.low[2] = Math.min(w.low[2], cy);
          w.low[3] = Math.max(w.low[3], cy);
          w.lowSum += cx * w.nx + cz * w.nz;
          w.lowCount++;
        }
        return keys.indexOf(key);
      });
      cuts.set(mesh, c);
    }
    for (const [key, w] of walls) {
      // Stand in front of the middle of the stretch, where the view is most open: tried at several distances
      // from the wall and several heights (a hedge or a tree right in front of the wall would fill the picture).
      const tm = (w.t0 + w.t1) / 2;
      const wx = w.nx * w.offset - w.nz * tm;
      const wz = w.nz * w.offset + w.nx * tm;
      const yLow = Math.min(Math.max(2.0, w.y0 + 0.2), w.y1);
      let best: [number, number, number] = [wx + w.nx * 0.6, yLow, wz + w.nz * 0.6];
      let bestOpen = -1;
      for (const y of [yLow, yLow + 0.9, yLow + 1.8]) {
        for (const out of [3.6, 2.7, 1.9, 1.2, 0.7]) {
          const px = wx + w.nx * out;
          const pz = wz + w.nz * out;
          // it must be in the open and see the wall it serves
          if (physics.insideSolid(px, y, pz) || physics.insideSoft(px, y, pz, 0.25)) continue;
          if (physics.rayDistance(px, y, pz, -w.nx, 0, -w.nz, out - 0.2) < out - 0.2) continue;
          let open = 0;
          for (const [a, b, c] of [[1, 0, 0], [0.7, 0, 0.7], [0.7, 0, -0.7], [0.8, 0.6, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
            // (a = away from the wall, b = up, c = along the wall)
            const dx = w.nx * a - w.nz * c;
            const dz = w.nz * a + w.nx * c;
            open += Math.min(physics.rayDistance(px, y, pz, dx, b, dz, 14), 14);
          }
          open -= (y - yLow) * 4; // the lower the better, other things being equal
          if (open > bestOpen) {
            bestOpen = open;
            best = [px, y, pz];
          }
        }
      }
      w.probe = refl.add(`wall${key}`, best[0], best[1], best[2], wallSize, 'wall');
      plan.walls++;
      // (glass a cat cannot see into from the ground, or a strip of cellar windows, is not worth a mirror image)
      if (w.lowCount && w.low[3] - w.low[2] > 0.7 && w.low[2] < 1.0) {
        const offset = w.lowSum / w.lowCount;
        // stretches of the same wall make one mirror
        const same = plan.glassWalls.find((o) => o.nx === w.nx && o.nz === w.nz && Math.abs(o.offset - offset) < 0.15);
        if (same) {
          same.t0 = Math.min(same.t0, w.low[0]);
          same.t1 = Math.max(same.t1, w.low[1]);
          same.y0 = Math.min(same.y0, w.low[2]);
          same.y1 = Math.max(same.y1, w.low[3]);
        } else plan.glassWalls.push({ nx: w.nx, nz: w.nz, offset, t0: w.low[0], t1: w.low[1], y0: w.low[2], y1: w.low[3] });
      }
    }
    for (const [mesh, c] of cuts) {
      if (!c.groups.size) continue;
      const name = (mesh.material as THREE.Material).name;
      for (const [k, corners] of c.groups) {
        part(mesh, corners, mats.reflecting(mesh.material as THREE.ShaderMaterial, walls.get(keys[k])!.probe!), `${name}:${keys[k]}`);
        plan.meshes++;
      }
      keep(mesh, c.rest);
    }
    // bare metal near the ground (door plates, letterboxes, handrails, sills) mirrors the street as well
    const wallProbes = [...walls.values()].map((w) => w.probe!);
    for (const mesh of meshes.slice()) {
      const name = (mesh.material as THREE.Material).name;
      const d = desc(mesh);
      const mix = mixed(mesh);
      if (!d || d.kind !== 'flat' || isCarPart(name) || (!mix && ((d.metal ?? 0) < 0.8 || (d.rough ?? 1) > 0.42))) continue;
      const c = cut(mesh, (cx, cy, cz, _nx, _ny, _nz, corner) => {
        if (cy > 3.4) return -1;
        if (mix) {
          const [metal, rough, onCar] = made(mesh, corner);
          if (onCar || metal < 0.79 || rough > 0.425) return -1;
        }
        let best = -1;
        let bestD = 9;
        for (let k = 0; k < wallProbes.length; k++) {
          const p = wallProbes[k].uProbePos.value;
          const dd = Math.hypot(cx - p.x, cz - p.z);
          if (dd < bestD) {
            bestD = dd;
            best = k;
          }
        }
        return best;
      });
      if (!c.groups.size) continue;
      for (const [k, corners] of c.groups) {
        part(mesh, corners, mats.reflecting(mesh.material as THREE.ShaderMaterial, wallProbes[k]), `${name}:${wallProbes[k].id}`);
        plan.meshes++;
      }
      keep(mesh, c.rest);
    }
  }
  return plan;
}
