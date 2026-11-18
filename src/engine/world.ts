import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { plainNumbers } from './geometry';
import { Pictures } from './pictures';
import { FLAT_MIX, Materials, type LightRef, type MatDesc, setProbe } from './materials';

export interface ChunkInfo {
  name: string;
  kind: 'ground' | 'struct' | 'foliage' | 'far';
  file: string;
  /** the same shapes with fewer triangles, for phones */
  lite?: string;
  sun?: string;
  irr?: string;
  res?: number;
  tile_origin?: [number, number];
  tile_size?: number;
  bounds: [[number, number, number], [number, number, number]];
}

export interface WorldInfo {
  name: string;
  sun: { dir: [number, number, number]; irradiance: [number, number, number] };
  sky: { file: string; range: number };
  sky_irradiance_up: [number, number, number];
  irr_range: number;
  chunks: ChunkInfo[];
  scatter?: Record<string, { file: string; lite?: string; plant?: boolean; matrices: number[] }>;
  props?: PropInfo;
  ground_light?: { file: string; x0: number; z0: number; w: number; h: number };
  estate?: { x0: number; z0: number; w: number; h: number };
  kinds?: { file: string; x0: number; z0: number; w: number; h: number };
  nav?: { nodes: [number, number][]; edges: [number, number][]; ring: number[]; home: number };
  rivals?: { name: string; coat: string; pos: [number, number]; facing: number; level: number; radius: number; turf: string }[];
  brother?: { name: string; coat: string; pos: [number, number]; facing: number };
  pigeons?: [number, number][];
  spawn: { pos: [number, number, number]; heading: number };
  /** every picture has a small copy in a folder "s" next to it (see pictures.ts) */
  small?: boolean;
}

/** Light at a spot on the ground, for things that move (read from the ground light picture). */
export interface GroundSample {
  /** sky + bounce light (brightness of a white surface), rgb */
  r: number;
  g: number;
  b: number;
  /** 0 = in shadow, 1 = in full sun */
  sun: number;
}

export class GroundLight {
  private data: Uint8ClampedArray | null = null;
  private w = 1;
  private h = 1;
  private x0 = 0;
  private z0 = 0;
  private sx = 1;
  private sz = 1;
  private range = 4;
  private fallback: [number, number, number] = [0.3, 0.4, 0.6];
  /** the way to the sun along the ground */
  private sunX = 0;
  private sunZ = 1;
  private near: GroundSample = { r: 0, g: 0, b: 0, sun: 0 };

  /** The height of ordinary ground. Roads lie a little below it, pavements and lawns at it. */
  static readonly GROUND = 0.14;

  load(
    img: HTMLImageElement,
    info: NonNullable<WorldInfo['ground_light']>,
    range: number,
    open: [number, number, number],
    sunDir: [number, number, number] = [0, 1, 1],
  ): void {
    const flat = Math.hypot(sunDir[0], sunDir[2]) || 1;
    this.sunX = sunDir[0] / flat;
    this.sunZ = sunDir[2] / flat;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    this.data = ctx.getImageData(0, 0, img.width, img.height).data;
    this.w = img.width / 2;
    this.h = img.height;
    this.x0 = info.x0;
    this.z0 = info.z0;
    this.sx = this.w / info.w;
    this.sz = this.h / info.h;
    this.range = range;
    this.fallback = open;
  }

  /**
   * The light at a spot. `y` is the height at which the thing stands.
   *
   * The picture holds the light that reaches the ground, and for a cat on the ground that is the whole
   * story: in the open it is bright, under a parked car it is nearly dark. A cat on the roof of that car is
   * another matter. It sits in the open, while the ground straight below it lies in the car's shade. So for
   * anything that stands above the ground, the light is taken from the ground round about instead: the
   * brightest of it for the sky's share (the dark spots are the thing it stands on), and the ground on the
   * sunny side for the sun's share (the shade on the far side is cast by the thing it stands on).
   */
  sample(x: number, z: number, out: GroundSample, y = 0): GroundSample {
    this.at(x, z, out);
    const lift = y - GroundLight.GROUND;
    if (lift <= 0.12 || !this.data) return out;
    const t = Math.min(1, (lift - 0.12) / 0.28);
    const w = t * t * (3 - 2 * t);
    const s = this.near;
    // the sky's share: this spot and a ring round it, each counting by the square of its brightness
    let l = out.r + out.g + out.b;
    let k = l * l + 1e-9;
    let r = out.r * k;
    let g = out.g * k;
    let b = out.b * k;
    let sum = k;
    const ring = Math.min(2.4, 0.55 + lift * 0.9);
    for (let i = 0; i < RING.length; i += 2) {
      this.at(x + RING[i] * ring, z + RING[i + 1] * ring, s);
      l = s.r + s.g + s.b;
      k = l * l + 1e-9;
      r += s.r * k;
      g += s.g * k;
      b += s.b * k;
      sum += k;
    }
    r /= sum;
    g /= sum;
    b /= sum;
    // the sun's share: three spots towards the sun, further out the higher the thing stands
    let lit = 0;
    let seen = 1e-6;
    for (let i = 0; i < 3; i++) {
      const d = Math.min(6, 0.6 + lift * (0.8 + 0.6 * i));
      this.at(x + this.sunX * d, z + this.sunZ * d, s);
      lit += s.sun * s.sun;
      seen += s.sun;
    }
    const sun = lit / seen;
    // on a roof the ground round about is the foot of the walls, darker than the roof itself: lean towards
    // the open sky up there
    const u = Math.min(1, Math.max(0, (lift - 1.9) / 0.7));
    const high = u * u * (3 - 2 * u) * 0.5;
    r += (Math.max(r, this.fallback[0]) - r) * high;
    g += (Math.max(g, this.fallback[1]) - g) * high;
    b += (Math.max(b, this.fallback[2]) - b) * high;
    out.r += (r - out.r) * w;
    out.g += (g - out.g) * w;
    out.b += (b - out.b) * w;
    out.sun += (sun - out.sun) * w;
    return out;
  }

  /** The light that reaches the ground at a spot. */
  private at(x: number, z: number, out: GroundSample): GroundSample {
    if (!this.data) {
      [out.r, out.g, out.b] = this.fallback;
      out.sun = 1;
      return out;
    }
    const fx = Math.max(0, Math.min(this.w - 1.001, (x - this.x0) * this.sx - 0.5));
    const fz = Math.max(0, Math.min(this.h - 1.001, (z - this.z0) * this.sz - 0.5));
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const d = this.data;
    const stride = this.w * 2 * 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let s = 0;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const wgt = (i ? tx : 1 - tx) * (j ? tz : 1 - tz);
        const p = (iz + j) * stride + (ix + i) * 4;
        const q = p + this.w * 4;
        r += wgt * (d[p] / 255) ** 2;
        g += wgt * (d[p + 1] / 255) ** 2;
        b += wgt * (d[p + 2] / 255) ** 2;
        s += wgt * (d[q] / 255);
      }
    }
    out.r = r * this.range;
    out.g = g * this.range;
    out.b = b * this.range;
    out.sun = s;
    return out;
  }
}

/** twelve directions round the compass, as (x, z) pairs */
const RING = Array.from({ length: 24 }, (_, i) => (i % 2 ? Math.sin : Math.cos)((Math.floor(i / 2) / 12) * Math.PI * 2));

interface ScatterGroup {
  mesh: THREE.InstancedMesh;
  x: number;
  z: number;
}

export interface PropInfo {
  models: Record<string, { file: string; size: [number, number, number] }>;
  items: { key: string; pos: [number, number, number]; rot: number; scale: number; mass: number; kind: string }[];
}

export interface LoadedWorld {
  info: WorldInfo;
  group: THREE.Group;
  materials: Materials;
  groundLight: GroundLight;
  base: string;
  /** hide small plants that are further than `reach` metres from (x, z) */
  cull: (x: number, z: number, reach?: number) => void;
  /** the loader of surface and light pictures (how many, how much memory, what failed) */
  pictures: Pictures;
}

function lightTexture(pictures: Pictures | null, url: string, single: boolean, near = 0): THREE.Texture {
  const tex = new THREE.Texture();
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  if (single) tex.format = THREE.RedFormat;
  pictures?.load(tex, url, 4096, near);
  return tex;
}

/** Parts of parked cars, by the name of what they are made of. */
export const isCarPart = (name: string): boolean => /^(car_|veh_|glass_car|glass_lamp|chrome$|light_)/.test(name);

/**
 * One mesh out of many plain-coloured ones.
 *
 * A building is made of dozens of plain materials (frames, sills, rails, pipes, plates), a parked car of thirty,
 * and every one of them was a separate job for the graphics card in every chunk. Drawing them is not hard; telling
 * the card about each one is what costs, on a phone above all. Here they become one mesh per chunk: the colour,
 * roughness and metalness of each part travel with its corner points instead of with a material.
 */
function mergeFlats(meshes: THREE.Mesh[], descs: Record<string, MatDesc>): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const m of meshes) {
    nv += m.geometry.attributes.position.count;
    ni += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Int8Array(nv * 4);
  const uv1 = new Uint16Array(nv * 2);
  const tint = new Uint8Array(nv * 4);
  const extra = new Uint8Array(nv * 4);
  const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let v0 = 0;
  let i0 = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const l = g.attributes.uv1;
    const name = (m.material as THREE.Material).name;
    const d = descs[name];
    const c = d.color ?? [0.5, 0.5, 0.5];
    const t = [Math.sqrt(c[0]), Math.sqrt(c[1]), Math.sqrt(c[2]), d.rough ?? 0.6].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
    const metal = Math.round(Math.max(0, Math.min(1, d.metal ?? 0)) * 255);
    const car = isCarPart(name) ? 255 : 0;
    m.updateMatrixWorld(true);
    nm.getNormalMatrix(m.matrixWorld);
    for (let i = 0; i < p.count; i++) {
      const k = v0 + i;
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      pos[k * 3] = v.x;
      pos[k * 3 + 1] = v.y;
      pos[k * 3 + 2] = v.z;
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      nor[k * 4] = Math.round(v.x * 127);
      nor[k * 4 + 1] = Math.round(v.y * 127);
      nor[k * 4 + 2] = Math.round(v.z * 127);
      if (l) {
        uv1[k * 2] = Math.round(Math.max(0, Math.min(1, l.getX(i))) * 65535);
        uv1[k * 2 + 1] = Math.round(Math.max(0, Math.min(1, l.getY(i))) * 65535);
      }
      tint[k * 4] = t[0];
      tint[k * 4 + 1] = t[1];
      tint[k * 4 + 2] = t[2];
      tint[k * 4 + 3] = t[3];
      extra[k * 4] = metal;
      extra[k * 4 + 1] = car;
    }
    const idx = g.index;
    const count = idx ? idx.count : p.count;
    for (let i = 0; i < count; i++) index[i0 + i] = v0 + (idx ? idx.getX(i) : i);
    v0 += p.count;
    i0 += count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 4, true));
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2, true));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 4, true));
  geo.setAttribute('aExtra', new THREE.BufferAttribute(extra, 4, true));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export interface WorldOptions {
  /** 1 = pictures at full size; smaller on phones (0.5 = a quarter of the memory) */
  pictureScale?: number;
  /** how many pictures to fetch and unpack at once */
  parallel?: number;
  /** phones: load the simplified copies of buildings, cars and trees where there are any */
  lite?: boolean;
}

/** Load a packed world (public/assets/<set>/). */
export async function loadWorld(
  set: string,
  maxAnisotropy: number,
  onProgress?: (done: number, total: number) => void,
  options: WorldOptions = {},
): Promise<LoadedWorld> {
  const root = `${import.meta.env.BASE_URL}assets/`;
  const base = `${root}${set}/`;
  const [info, descs] = await Promise.all([
    fetch(`${base}world.json`).then((r) => r.json() as Promise<WorldInfo>),
    fetch(`${base}materials.json`).then((r) => r.json() as Promise<Record<string, MatDesc>>),
  ]);
  const pictures = new Pictures(options.pictureScale ?? 1, options.parallel ?? 8, info.small === true);
  const materials = new Materials(root, descs, maxAnisotropy, undefined, pictures);
  const g = materials.globals;
  g.uSunDir.value.fromArray(info.sun.dir).normalize();
  g.uSunColor.value.fromArray(info.sun.irradiance);
  g.uSkyUp.value.fromArray(info.sky_irradiance_up).multiplyScalar(1 / Math.PI);
  g.uIrrRange.value = info.irr_range;

  const gltf = new GLTFLoader();
  gltf.setMeshoptDecoder(MeshoptDecoder);
  const group = new THREE.Group();
  group.name = 'world';
  const pending: Promise<unknown>[] = [];
  const scatter = Object.entries(info.scatter ?? {});
  let done = 0;
  const total = info.chunks.length + scatter.length;
  // the bar counts shapes and pictures together (about 80 shapes and 300 pictures)
  const report = () => onProgress?.(done + pictures.done, total + Math.max(pictures.total, 250));
  const tick = () => {
    done++;
    report();
  };
  pictures.onProgress = report;

  // light picture of the whole ground: for weeds on the GPU and for moving things on the CPU
  const groundLight = new GroundLight();
  if (info.ground_light) {
    const gl = info.ground_light;
    const tex = lightTexture(null, base + gl.file, false);
    pending.push(
      new THREE.ImageLoader().loadAsync(base + gl.file).then((img) => {
        tex.image = img;
        tex.needsUpdate = true;
        const open = info.sky_irradiance_up.map((v) => v / Math.PI) as [number, number, number];
        groundLight.load(img, gl, info.irr_range, open, info.sun.dir as [number, number, number]);
      }),
    );
    g.uGroundLight.value = tex;
    g.uGroundXform.value.set(1 / gl.w, 1 / gl.h, -gl.x0 / gl.w, -gl.z0 / gl.h);
  }

  // far-away scenery has no baked light: plain sun and open sky, the same for every block
  const farMats = new Map<string, THREE.ShaderMaterial>();
  const farMaterial = (name: string): THREE.ShaderMaterial => {
    let m = farMats.get(name);
    if (!m) {
      m = materials.fresh(name);
      const [r, g, b] = info.sky_irradiance_up.map((v) => v / Math.PI);
      setProbe(m, { r, g, b, sun: 1 }, materials.globals, 0.2);
      farMats.set(name, m);
    }
    return m;
  };

  const chunkJobs = info.chunks.map(async (chunk) => {
    let light: LightRef | null = null;
    if (chunk.sun && chunk.irr) {
      // (full pictures come in nearest first: how far is this chunk from where the game starts?)
      const [lo, hi] = chunk.bounds;
      const [sx, , sz] = info.spawn.pos;
      const near = Math.hypot(Math.max(lo[0] - sx, 0, sx - hi[0]), Math.max(lo[2] - sz, 0, sz - hi[2]));
      light = {
        id: chunk.name,
        sun: lightTexture(pictures, base + chunk.sun, true, near),
        irr: lightTexture(pictures, base + chunk.irr, false, near),
      };
      if (chunk.kind === 'ground' && chunk.tile_origin && chunk.tile_size) {
        light.planar = { x0: chunk.tile_origin[0], z0: chunk.tile_origin[1], size: chunk.tile_size };
      }
    }
    const data = await gltf.loadAsync(base + ((options.lite && chunk.lite) || chunk.file));
    plainNumbers(data.scene);
    data.scene.updateMatrixWorld(true);
    const flats: THREE.Mesh[] = [];
    data.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as THREE.Material).name;
      const d = descs[name];
      // plain-coloured parts of buildings and cars are drawn together (see mergeFlats)
      if (chunk.kind === 'struct' && light && d && d.kind === 'flat' && !d.diff && !d.alpha && !d.fade && mesh.geometry.attributes.normal) {
        flats.push(mesh);
        return;
      }
      const mat = chunk.kind === 'far' ? farMaterial(name) : materials.get(name, light, { mode: 'vertex' });
      if (light) (mat.uniforms.uLmSunSize.value as THREE.Vector2).setScalar(chunk.res ?? 1024);
      mesh.material = mat;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (mat.transparent) mesh.renderOrder = 2;
    });
    if (flats.length) {
      const mat = materials.get(FLAT_MIX, light, { mode: 'vertex' });
      (mat.uniforms.uLmSunSize.value as THREE.Vector2).setScalar(chunk.res ?? 1024);
      const all = new THREE.Mesh(mergeFlats(flats, descs), mat);
      all.name = FLAT_MIX;
      all.matrixAutoUpdate = false;
      for (const m of flats) {
        m.removeFromParent();
        m.geometry.dispose();
      }
      data.scene.add(all);
    }
    data.scene.name = chunk.name;
    group.add(data.scene);
    tick();
  });

  const scatterGroups: ScatterGroup[] = [];
  const scatterJobs = scatter.map(async ([key, model]) => {
    const data = await gltf.loadAsync(base + ((options.lite && model.lite) || model.file));
    plainNumbers(data.scene);
    const count = model.matrices.length / 16;
    const plant = model.plant !== false;
    // bucket the copies into map squares: squares outside the picture are skipped, and so are far-away plants
    const CELL = 16;
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(model.matrices[i * 16 + 12] / CELL);
      const cz = Math.floor(model.matrices[i * 16 + 14] / CELL);
      const k = `${cx},${cz}`;
      let list = buckets.get(k);
      if (!list) buckets.set(k, (list = []));
      list.push(i);
    }
    const m = new THREE.Matrix4();
    data.scene.updateMatrixWorld(true);
    data.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as THREE.Material).name;
      const mat = materials.get(name, null, { mode: 'ground', plant });
      for (const [k, list] of buckets) {
        const inst = new THREE.InstancedMesh(mesh.geometry, mat, list.length);
        let sx = 0;
        let sz = 0;
        list.forEach((i, n) => {
          m.fromArray(model.matrices, i * 16).multiply(mesh.matrixWorld);
          inst.setMatrixAt(n, m);
          sx += model.matrices[i * 16 + 12];
          sz += model.matrices[i * 16 + 14];
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        inst.name = `scatter:${key}:${k}`;
        inst.matrixAutoUpdate = false;
        group.add(inst);
        if (plant) scatterGroups.push({ mesh: inst, x: sx / list.length, z: sz / list.length });
      }
    });
    tick();
  });
  await Promise.all([...chunkJobs, ...scatterJobs]);
  await Promise.all(pending);
  await materials.ready();
  group.updateMatrixWorld(true);
  const cull = (x: number, z: number, reach = 38) => {
    for (const g of scatterGroups) g.mesh.visible = Math.hypot(g.x - x, g.z - z) < reach;
  };
  return { info, group, materials, groundLight, base, cull, pictures };
}
