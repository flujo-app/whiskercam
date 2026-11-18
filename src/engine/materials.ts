import * as THREE from 'three';
import { Pictures } from './pictures';
import { worldFragment, worldVertex } from './shaders/world.glsl';

/** How a material is described in materials.json (written by the Blender pipeline). */
export interface MatDesc {
  kind: 'tile' | 'unique' | 'flat' | 'glass' | 'paint' | 'leaf' | 'roadpaint';
  diff?: string;
  nor?: string;
  arm?: string;
  size?: number;
  color?: number[];
  rough?: number;
  metal?: number;
  paint?: number[];
  paint_wear?: number;
  wear?: number;
  tint?: number[];
  alpha?: string;
  /** which scanned surface this is (Poly Haven id), when it is one */
  ph?: string;
  /** dissolve near the camera: [gone inside, solid beyond] in metres */
  fade?: [number, number];
  /** how dirty sheltered spots get, 0..1 (built surfaces only; default 0.85) */
  grime?: number;
  /** glass you can see through: the share of light it lets pass (car windows, lamp covers) */
  clear?: number;
  /** stands for many plain-coloured materials at once: colour and gloss come with the mesh (see mergeFlats) */
  mix?: boolean;
}

/** The one material that draws all plain-coloured parts of a chunk in one go. */
export const FLAT_MIX = 'flat_mix';

/**
 * An all-round picture of one place, in which nearby shiny surfaces look up their reflection
 * (made and kept up to date by reflections.ts). Every material that uses it shares these four values.
 */
export interface ProbeRef {
  id: string;
  uProbe: THREE.IUniform;
  uProbePos: THREE.IUniform;
  uProbeLod: THREE.IUniform;
  uProbeOn: THREE.IUniform;
}

/** Baked light for one chunk. */
export interface LightRef {
  id: string;
  sun: THREE.Texture;
  irr: THREE.Texture;
  /** set for ground tiles: light map is addressed by world position */
  planar?: { x0: number; z0: number; size: number };
}

const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
white.needsUpdate = true;
const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
flatNormal.needsUpdate = true;
const blackCube = new THREE.CubeTexture();

/** Uniforms every surface shares (one object, referenced by all materials). */
export function makeGlobals() {
  return {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(10, 9.4, 8.5) },
    uSkyUp: { value: new THREE.Color(0.25, 0.34, 0.54) },
    uEnvMap: { value: blackCube as THREE.Texture },
    uEnvMaxLod: { value: 0 },
    uEnvIntensity: { value: 1 },
    uFogColor: { value: new THREE.Color(0.6, 0.75, 1.0) },
    uFogDensity: { value: 0.0012 },
    uIrrRange: { value: 4 },
    uShadeColour: { value: 0.55 },
    uShadowNear: { value: white as THREE.Texture },
    uShadowFar: { value: white as THREE.Texture },
    uShadowNearMat: { value: new THREE.Matrix4() },
    uShadowFarMat: { value: new THREE.Matrix4() },
    uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
    uShadowOn: { value: 0 },
    uGroundLight: { value: white as THREE.Texture },
    uGroundXform: { value: new THREE.Vector4(1, 1, 0, 0) },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector3(0.8, 0.6, 0.012) },
    // the car that is left out while a reflection picture is taken from inside it (see world.glsl.ts)
    uHideBox: { value: new THREE.Vector4(0, 0, 0, 0) },
    uHideDir: { value: new THREE.Vector4(1, 0, 1, 1) },
    uHideY: { value: new THREE.Vector2(0, 0) },
    // the true mirror image of the glass wall the cat is standing in front of
    uMirror: { value: white as THREE.Texture },
    uMirrorMat: { value: new THREE.Matrix4() },
    uMirrorPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
    uMirrorOn: { value: 0 },
  };
}
export type Globals = ReturnType<typeof makeGlobals>;

export class Materials {
  readonly globals: Globals;
  private readonly cache = new Map<string, THREE.ShaderMaterial>();
  private readonly textures = new Map<string, THREE.Texture>();
  readonly pictures: Pictures;

  constructor(
    private readonly base: string,
    private readonly descs: Record<string, MatDesc>,
    private readonly maxAnisotropy: number,
    globals?: Globals,
    pictures?: Pictures,
  ) {
    this.globals = globals ?? makeGlobals();
    this.pictures = pictures ?? new Pictures();
    this.descs[FLAT_MIX] ??= { kind: 'flat', color: [1, 1, 1], rough: 1, metal: 1, mix: true };
  }

  /** Resolves when every picture requested so far has arrived. */
  async ready(): Promise<void> {
    await this.pictures.ready();
  }

  /** how soon the full surface pictures are wanted, compared with the baked light (which is sorted by distance in metres) */
  static readonly SURFACE_NEAR = 12;

  texture(url: string, srgb: boolean, repeat = true): THREE.Texture {
    const key = `${url}|${srgb}|${repeat}`;
    let tex = this.textures.get(key);
    if (!tex) {
      tex = new THREE.Texture();
      const t = tex;
      t.flipY = false;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.anisotropy = repeat ? this.maxAnisotropy : 1;
      t.minFilter = repeat ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      t.generateMipmaps = repeat;
      this.textures.set(key, t);
      this.pictures.load(t, this.base + url, 4096, Materials.SURFACE_NEAR);
    }
    return tex;
  }

  /**
   * Material `name`, lit by the given baked light map. Without one, `mode` says where light comes from:
   * 'vertex' (baked into the mesh), 'ground' (the ground light picture) or 'probe' (set per object).
   */
  get(
    name: string,
    light: LightRef | null,
    opts: { mode?: 'probe' | 'ground' | 'vertex'; plant?: boolean; reflect?: ProbeRef } = {},
  ): THREE.ShaderMaterial {
    const mode = opts.mode ?? 'probe';
    const plant = opts.plant ?? true;
    const key = `${name}|${light?.id ?? mode}|${plant ? 'p' : 's'}|${opts.reflect?.id ?? ''}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const mat = this.build(name, light, mode, plant, opts.reflect);
    this.cache.set(key, mat);
    return mat;
  }

  /** The same material, looking its reflections up in `probe`. */
  reflecting(mat: THREE.ShaderMaterial, probe: ProbeRef): THREE.ShaderMaterial {
    const made = (mat.userData as { made?: { light: LightRef | null; mode: 'probe' | 'ground' | 'vertex'; plant: boolean } }).made;
    if (!made) return mat;
    const copy = this.get(mat.name, made.light, { mode: made.mode, plant: made.plant, reflect: probe });
    // values set per chunk after the material was made
    (copy.uniforms.uLmSunSize.value as THREE.Vector2).copy(mat.uniforms.uLmSunSize.value as THREE.Vector2);
    return copy;
  }

  /** What a material is made of (kind, colour, gloss), as described by the pipeline. */
  describe(name: string): MatDesc | undefined {
    return this.descs[name];
  }

  /** A material of its own for one moving object (its light values are set per object, see setProbe). */
  fresh(name: string): THREE.ShaderMaterial {
    return this.build(name, null, 'probe', false);
  }

  /** A material of its own made from an ad-hoc description (stand-ins, effects). Lit per object like `fresh`. */
  custom(name: string, desc: MatDesc): THREE.ShaderMaterial {
    this.descs[name] = desc;
    return this.build(name, null, 'probe', false);
  }

  private build(
    name: string,
    light: LightRef | null,
    mode: 'probe' | 'ground' | 'vertex',
    plant: boolean,
    reflect?: ProbeRef,
  ): THREE.ShaderMaterial {
    const d: MatDesc = this.descs[name] ?? { kind: 'flat', color: [0.5, 0.5, 0.5], rough: 0.7 };
    const defines: Record<string, string | number> = {};
    const g = this.globals;
    const u: Record<string, THREE.IUniform> = {
      ...g,
      uMapDiff: { value: white },
      uMapNor: { value: flatNormal },
      uMapArm: { value: white },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uRough: { value: 1 },
      uMetal: { value: 1 },
      uNormalScale: { value: 1 },
      uDetail: { value: 0.75 },
      uAlphaTest: { value: 0.5 },
      uUvScale: { value: new THREE.Vector2(1, 1) },
      uLmXform: { value: new THREE.Vector4(1, 1, 0, 0) },
      uLmSun: { value: white },
      uLmIrr: { value: white },
      uLmSunSize: { value: new THREE.Vector2(1024, 1024) },
      uProbeIrrUp: { value: new THREE.Color(0.3, 0.4, 0.6) },
      uProbeIrrDown: { value: new THREE.Color(0.2, 0.18, 0.15) },
      uProbeSun: { value: 1 },
      uPaintColor: { value: new THREE.Color(1, 1, 1) },
      uPaintWear: { value: 0.5 },
    };

    if (light) {
      u.uLmSun.value = light.sun;
      u.uLmIrr.value = light.irr;
      if (light.planar) {
        defines.LM_PLANAR = 1;
        const { x0, z0, size } = light.planar;
        (u.uLmXform.value as THREE.Vector4).set(1 / size, 1 / size, -x0 / size, -z0 / size);
      } else {
        defines.LM_UV = 1;
      }
    } else if (mode === 'vertex') {
      defines.LM_VERTEX = 1;
    } else if (mode === 'ground') {
      defines.LM_GROUND = 1;
    } else {
      defines.LM_PROBE = 1;
    }

    let transparent = false;
    let side: THREE.Side = THREE.FrontSide;
    const hasMaps = !!d.diff;
    if (hasMaps) {
      defines.USE_MAP = 1;
      u.uMapDiff.value = this.texture(d.diff!, true);
      if (d.nor) u.uMapNor.value = this.texture(d.nor, false);
      if (d.arm) u.uMapArm.value = this.texture(d.arm, false);
      else {
        u.uRough.value = d.rough ?? 0.7;
        u.uMetal.value = d.metal ?? 0;
      }
    } else {
      const c = d.color ?? [0.5, 0.5, 0.5];
      (u.uColor.value as THREE.Color).setRGB(c[0], c[1], c[2]);
      u.uRough.value = d.rough ?? 0.6;
      u.uMetal.value = d.metal ?? 0;
    }
    if (d.tint) (u.uColor.value as THREE.Color).setRGB(d.tint[0], d.tint[1], d.tint[2]);
    if (d.mix) defines.FLAT_MIX = 1;

    if (reflect) {
      defines.PROBE = 1;
      u.uProbe = reflect.uProbe;
      u.uProbePos = reflect.uProbePos;
      u.uProbeLod = reflect.uProbeLod;
      u.uProbeOn = reflect.uProbeOn;
    }
    let premultiplied = false;
    switch (d.kind) {
      case 'glass':
        defines.GLASS = 1;
        u.uClear = { value: d.clear ?? 0 };
        if (d.clear) {
          // car windows and lamp covers: what is behind them is drawn first, the pane goes on top
          defines.CLEAR = 1;
          transparent = true;
          premultiplied = true;
        }
        break;
      case 'tile':
        (u.uUvScale.value as THREE.Vector2).setScalar(1 / (d.size ?? 2));
        defines.DETAIL = 1;
        defines.MACRO = 1;
        if (d.paint) {
          defines.PAINT = 1;
          (u.uPaintColor.value as THREE.Color).setRGB(d.paint[0], d.paint[1], d.paint[2]);
          u.uPaintWear.value = d.paint_wear ?? 0.45;
        }
        break;
      case 'paint':
        defines.COAT = 1;
        break;
      case 'leaf':
        defines.ALPHATEST = 1;
        defines.TRANSLUCENT = 1;
        defines.KEEP_NORMAL = 1; // cards are lit with the hedge's outward direction on both faces
        (u.uColor.value as THREE.Color).setRGB(0.78, 0.8, 0.72); // sunlit leaves photograph darker than they scan
        defines.WIND = 1;
        defines.WIND_HEIGHT_SCALE = '0.6';
        side = THREE.DoubleSide;
        break;
      case 'roadpaint':
        defines.PAINT = 1;
        defines.DECAL = 1;
        (u.uPaintColor.value as THREE.Color).setRGB(d.color![0], d.color![1], d.color![2]);
        u.uPaintWear.value = d.wear ?? 0.5;
        transparent = true;
        break;
      default:
        break;
    }
    if (mode === 'ground' && d.kind === 'unique' && plant) {
      // small scanned plants: thin leaves seen from both sides, moving a little in the wind
      defines.TRANSLUCENT = 1;
      defines.WIND = 1;
      defines.WIND_HEIGHT_SCALE = '4.0';
      side = THREE.DoubleSide;
    }
    if (d.alpha === 'clip') {
      defines.ALPHATEST = 1;
      side = THREE.DoubleSide;
    }
    if (d.fade) {
      defines.NEAR_FADE = 1;
      u.uFade = { value: new THREE.Vector2(d.fade[0], d.fade[1]) };
    }
    // built surfaces get grimy where they are sheltered (needs baked light; not for lawn and soil)
    if (light && d.kind === 'tile' && !/grass|forrest|leaf|mud|dirt|chips|bark/.test(d.ph ?? '')) {
      defines.GRIME = 1;
      u.uGrime = { value: d.grime ?? 0.85 };
    }

    const mat = new THREE.ShaderMaterial({
      name,
      uniforms: u,
      defines,
      vertexShader: worldVertex,
      fragmentShader: worldFragment,
      side,
      transparent,
      depthWrite: !transparent,
    });
    mat.userData.made = { light, mode, plant };
    mat.premultipliedAlpha = premultiplied;
    // soft cut-out edges where the picture is drawn with edge smoothing (see world.glsl.ts)
    if (defines.ALPHATEST) mat.alphaToCoverage = true;
    if (d.kind === 'roadpaint') {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -2;
      mat.polygonOffsetUnits = -4;
    }
    return mat;
  }
}

/** Light values for one moving object, from a sample of the ground light picture. */
export function setProbe(
  mat: THREE.ShaderMaterial,
  sample: { r: number; g: number; b: number; sun: number },
  globals: Globals,
  groundAlbedo = 0.16,
): void {
  const up = mat.uniforms.uProbeIrrUp.value as THREE.Color;
  const down = mat.uniforms.uProbeIrrDown.value as THREE.Color;
  up.setRGB(sample.r, sample.g, sample.b);
  // light thrown back up by the ground: what lights a belly, a chin, the underside of a pot
  const sun = globals.uSunColor.value;
  const el = Math.max(0.05, globals.uSunDir.value.y);
  const k = (sample.sun * el) / Math.PI;
  down.setRGB(
    groundAlbedo * (sample.r + sun.r * k),
    groundAlbedo * (sample.g + sun.g * k),
    groundAlbedo * (sample.b + sun.b * k),
  );
  mat.uniforms.uProbeSun.value = sample.sun;
}
