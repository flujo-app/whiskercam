import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { plainNumbers } from './geometry';
import { Pictures } from './pictures';
import { Materials, type LightRef, type MatDesc, setProbe } from './materials';

export interface ChunkInfo {
  name: string;
  kind: 'ground' | 'struct' | 'foliage' | 'far';
  file: string;
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
  scatter?: Record<string, { file: string; plant?: boolean; matrices: number[] }>;
  props?: PropInfo;
  ground_light?: { file: string; x0: number; z0: number; w: number; h: number };
  estate?: { x0: number; z0: number; w: number; h: number };
  kinds?: { file: string; x0: number; z0: number; w: number; h: number };
  nav?: { nodes: [number, number][]; edges: [number, number][]; ring: number[]; home: number };
  rivals?: { name: string; coat: string; pos: [number, number]; facing: number; level: number; radius: number; turf: string }[];
  brother?: { name: string; coat: string; pos: [number, number]; facing: number };
  pigeons?: [number, number][];
  spawn: { pos: [number, number, number]; heading: number };
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

  load(img: HTMLImageElement, info: NonNullable<WorldInfo['ground_light']>, range: number, open: [number, number, number]): void {
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

  sample(x: number, z: number, out: GroundSample): GroundSample {
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

function lightTexture(pictures: Pictures | null, url: string, single: boolean): THREE.Texture {
  const tex = new THREE.Texture();
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  if (single) tex.format = THREE.RedFormat;
  pictures?.load(tex, url);
  return tex;
}

export interface WorldOptions {
  /** 1 = pictures at full size; smaller on phones (0.5 = a quarter of the memory) */
  pictureScale?: number;
  /** how many pictures to fetch and unpack at once */
  parallel?: number;
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
  const pictures = new Pictures(options.pictureScale ?? 1, options.parallel ?? 8);
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
        groundLight.load(img, gl, info.irr_range, open);
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
      light = {
        id: chunk.name,
        sun: lightTexture(pictures, base + chunk.sun, true),
        irr: lightTexture(pictures, base + chunk.irr, false),
      };
      if (chunk.kind === 'ground' && chunk.tile_origin && chunk.tile_size) {
        light.planar = { x0: chunk.tile_origin[0], z0: chunk.tile_origin[1], size: chunk.tile_size };
      }
    }
    const data = await gltf.loadAsync(base + chunk.file);
    plainNumbers(data.scene);
    data.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as THREE.Material).name;
      const mat = chunk.kind === 'far' ? farMaterial(name) : materials.get(name, light, { mode: 'vertex' });
      if (light) (mat.uniforms.uLmSunSize.value as THREE.Vector2).setScalar(chunk.res ?? 1024);
      mesh.material = mat;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (mat.transparent) mesh.renderOrder = 2;
    });
    data.scene.name = chunk.name;
    group.add(data.scene);
    tick();
  });

  const scatterGroups: ScatterGroup[] = [];
  const scatterJobs = scatter.map(async ([key, model]) => {
    const data = await gltf.loadAsync(base + model.file);
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
