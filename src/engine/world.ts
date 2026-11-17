import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Materials, type LightRef, type MatDesc } from './materials';

export interface ChunkInfo {
  name: string;
  kind: 'ground' | 'struct';
  file: string;
  sun: string;
  irr: string;
  res: number;
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
  spawn: { pos: [number, number, number]; heading: number };
}

export interface LoadedWorld {
  info: WorldInfo;
  group: THREE.Group;
  materials: Materials;
  base: string;
}

function lightTexture(loader: THREE.TextureLoader, url: string, single: boolean, pending: Promise<unknown>[]): THREE.Texture {
  const tex = new THREE.Texture();
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  if (single) tex.format = THREE.RedFormat;
  pending.push(
    loader.loadAsync(url).then((loaded) => {
      tex.image = loaded.image;
      tex.needsUpdate = true;
    }),
  );
  return tex;
}

/** Load a packed world (public/assets/<set>/). */
export async function loadWorld(
  set: string,
  maxAnisotropy: number,
  onProgress?: (done: number, total: number) => void,
): Promise<LoadedWorld> {
  const root = `${import.meta.env.BASE_URL}assets/`;
  const base = `${root}${set}/`;
  const [info, descs] = await Promise.all([
    fetch(`${base}world.json`).then((r) => r.json() as Promise<WorldInfo>),
    fetch(`${base}materials.json`).then((r) => r.json() as Promise<Record<string, MatDesc>>),
  ]);
  const materials = new Materials(root, descs, maxAnisotropy);
  const g = materials.globals;
  g.uSunDir.value.fromArray(info.sun.dir).normalize();
  g.uSunColor.value.fromArray(info.sun.irradiance);
  g.uSkyUp.value.fromArray(info.sky_irradiance_up).multiplyScalar(1 / Math.PI);
  g.uIrrRange.value = info.irr_range;

  const gltf = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const group = new THREE.Group();
  group.name = 'world';
  const pending: Promise<unknown>[] = [];
  let done = 0;
  const total = info.chunks.length;

  await Promise.all(
    info.chunks.map(async (chunk) => {
      const light: LightRef = {
        id: chunk.name,
        sun: lightTexture(texLoader, base + chunk.sun, true, pending),
        irr: lightTexture(texLoader, base + chunk.irr, false, pending),
      };
      if (chunk.kind === 'ground' && chunk.tile_origin && chunk.tile_size) {
        light.planar = { x0: chunk.tile_origin[0], z0: chunk.tile_origin[1], size: chunk.tile_size };
      }
      const data = await gltf.loadAsync(base + chunk.file);
      data.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const name = (mesh.material as THREE.Material).name;
        const mat = materials.get(name, light);
        if (light.planar) (mat.uniforms.uLmSunSize.value as THREE.Vector2).setScalar(chunk.res);
        else (mat.uniforms.uLmSunSize.value as THREE.Vector2).setScalar(chunk.res);
        mesh.material = mat;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        if (mat.transparent) mesh.renderOrder = 2;
      });
      data.scene.name = chunk.name;
      group.add(data.scene);
      done++;
      onProgress?.(done, total);
    }),
  );
  await Promise.all(pending);
  await materials.ready();
  group.updateMatrixWorld(true);
  return { info, group, materials, base };
}
