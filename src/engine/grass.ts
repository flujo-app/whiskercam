import * as THREE from 'three';
import type { Globals } from './materials';

/**
 * Lawn grass: real blades, but only in a patch around the camera.
 *
 * The same few thousand tufts are reused forever: a tuft that falls out of the patch behind the
 * cat reappears ahead of it. Each tuft's look depends only on where on the map it stands, so the
 * lawn does not change as the patch moves. A small map of the estate says where lawns are.
 */

const vertex = /* glsl */ `
precision highp float;
attribute vec4 aBlade;   // side (-1 / +1, 0 at the tip), height along the blade 0..1, turn, size
attribute vec2 aCell;    // which tuft of the patch

uniform vec3 uCamPos;
uniform float uSpacing;
uniform float uPatch;       // patch edge length in metres
uniform float uHeight;
uniform float uTime;
uniform vec3 uWind;
uniform sampler2D uKinds;
uniform vec4 uKindsXform;
uniform sampler2D uGroundLight;
uniform vec4 uGroundXform;
uniform float uIrrRange;
uniform sampler2D uGroundY;  // unused placeholder for a height map; lawns are flat
uniform float uLawnY;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vT;
varying float vRand;
varying vec3 vIrr;
varying float vSun;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  // where this tuft currently lives: wrap its home cell into the patch around the camera
  vec2 home = aCell * uSpacing;
  vec2 wrapped = home + floor((uCamPos.xz - home) / uPatch + 0.5) * uPatch;
  vec2 cell = floor(wrapped / uSpacing + 0.5);
  float r1 = hash12(cell);
  float r2 = hash12(cell + 17.3);
  float r3 = hash12(cell + 41.7);
  vec2 root = wrapped + (vec2(r1, r2) - 0.5) * uSpacing + position.xz * (0.7 + 0.6 * r3);

  float lawn = texture2D(uKinds, root * uKindsXform.xy + uKindsXform.zw).r;
  float dist = length(root - uCamPos.xz);
  float fade = 1.0 - smoothstep(uPatch * 0.36, uPatch * 0.48, dist);
  float size = aBlade.w * (0.65 + 0.7 * r3) * step(0.5, lawn) * fade;
  // mown lawn with the odd longer blade and scruffier patches
  float patchy = 0.75 + 0.5 * hash12(floor(root * 0.9));
  float h = uHeight * size * patchy * (1.0 + 1.6 * step(0.965, r2));

  float t = aBlade.y;
  float turn = aBlade.z + r1 * 6.2831;
  vec2 dir = vec2(cos(turn), sin(turn));
  vec2 side = vec2(-dir.y, dir.x);
  float width = 0.0034 * (0.8 + 0.6 * r2) * (1.0 - t * 0.82) * step(1e-4, size);
  float lean = (0.25 + 0.6 * r3) * h;
  float phase = dot(root, vec2(0.71, 0.53));
  float gust = sin(uTime * 1.6 + phase) * 0.6 + sin(uTime * 3.7 + phase * 2.1) * 0.3 + sin(uTime * 7.9 + r1 * 40.0) * 0.12;
  vec2 bend = dir * lean * t * t + uWind.xy * (uWind.z * 6.0 * gust * h * 6.0) * t * t;

  vec3 wp = vec3(root.x, uLawnY, root.y);
  wp.xz += side * width * aBlade.x + bend;
  wp.y += h * t * (1.0 - 0.18 * t * (lean / max(h, 1e-4)));

  vec2 guv = clamp(root * uGroundXform.xy + uGroundXform.zw, 0.003, 0.997);
  vec3 e = texture2D(uGroundLight, vec2(guv.x * 0.5, guv.y)).rgb;
  vIrr = e * e * uIrrRange;
  vIrr = mix(vec3(dot(vIrr, vec3(0.3, 0.5, 0.2))), vIrr, 0.55);
  vSun = texture2D(uGroundLight, vec2(guv.x * 0.5 + 0.5, guv.y)).r;

  vWorldPos = wp;
  vNormal = normalize(vec3(dir.x * 0.5, 0.75 + 0.25 * t, dir.y * 0.5));
  vT = t;
  vRand = r3;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const fragment = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uRootColor;
uniform vec3 uTipColor;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vT;
varying float vRand;
varying vec3 vIrr;
varying float vSun;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 albedo = mix(uRootColor, uTipColor, vT);
  albedo *= 0.8 + 0.45 * vRand;
  albedo = mix(albedo, albedo.grb * vec3(1.1, 0.9, 0.7), step(0.9, vRand) * 0.5);  // a few dry, yellowish blades
  float ao = mix(0.35, 1.0, vT);             // dark down between the blades
  float wrap = clamp(dot(N, uSunDir) * 0.6 + 0.4, 0.0, 1.0);
  // light shining through from behind makes grass glow when you look towards the sun
  float through = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 3.0) * 0.9;
  vec3 color = albedo * (vIrr * ao + uSunColor / 3.14159 * vSun * (wrap + through) * mix(0.45, 1.0, vT));
  // a little sheen on the blade tips
  vec3 H = normalize(uSunDir + V);
  color += uSunColor * vSun * pow(max(dot(N, H), 0.0), 24.0) * 0.012 * vT;
  float dist = length(cameraPosition - vWorldPos);
  color = mix(color, uFogColor, 1.0 - exp(-dist * uFogDensity));
  gl_FragColor = vec4(color, 1.0);
}
`;

export interface KindsInfo {
  file: string;
  x0: number;
  z0: number;
  w: number;
  h: number;
}

export class Grass {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private kinds: Uint8ClampedArray | null = null;
  private kw = 1;
  private kh = 1;
  private info: KindsInfo | null = null;

  /** `patch` = edge length of the grassy square around the camera, `spacing` = distance between tufts. */
  constructor(globals: Globals, patch = 11, spacing = 0.095, bladesPerTuft = 7) {
    const n = Math.floor(patch / spacing);
    const realPatch = n * spacing;
    const verts = bladesPerTuft * 5;
    const pos = new Float32Array(verts * 3);
    const blade = new Float32Array(verts * 4);
    const index: number[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let b = 0; b < bladesPerTuft; b++) {
      const ox = (rnd() - 0.5) * spacing * 1.1;
      const oz = (rnd() - 0.5) * spacing * 1.1;
      const turn = rnd() * Math.PI * 2;
      const size = 0.6 + rnd() * 0.6;
      const rows: [number, number][] = [[-1, 0], [1, 0], [-1, 0.5], [1, 0.5], [0, 1]];
      for (let k = 0; k < 5; k++) {
        const v = b * 5 + k;
        pos.set([ox, 0, oz], v * 3);
        blade.set([rows[k][0], rows[k][1], turn, size], v * 4);
      }
      const o = b * 5;
      index.push(o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aBlade', new THREE.BufferAttribute(blade, 4));
    geo.setIndex(index);
    const cells = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cells.set([i, j], (j * n + i) * 2);
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    geo.instanceCount = n * n;

    this.mat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      side: THREE.DoubleSide,
      uniforms: {
        uCamPos: { value: new THREE.Vector3() },
        uSpacing: { value: spacing },
        uPatch: { value: realPatch },
        uHeight: { value: 0.075 },
        uLawnY: { value: 0.11 },
        uTime: globals.uTime,
        uWind: globals.uWind,
        uKinds: { value: null },
        uKindsXform: { value: new THREE.Vector4(1, 1, 0, 0) },
        uGroundLight: globals.uGroundLight,
        uGroundXform: globals.uGroundXform,
        uIrrRange: globals.uIrrRange,
        uGroundY: { value: null },
        uSunDir: globals.uSunDir,
        uSunColor: globals.uSunColor,
        uFogColor: globals.uFogColor,
        uFogDensity: globals.uFogDensity,
        uRootColor: { value: new THREE.Color(0.02, 0.045, 0.012) },
        uTipColor: { value: new THREE.Color(0.072, 0.122, 0.032) },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'grass';
    this.mesh.visible = false;
  }

  async load(url: string, info: KindsInfo): Promise<void> {
    const img = await new THREE.ImageLoader().loadAsync(url);
    const tex = new THREE.Texture(img);
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.mat.uniforms.uKinds.value = tex;
    (this.mat.uniforms.uKindsXform.value as THREE.Vector4).set(1 / info.w, 1 / info.h, -info.x0 / info.w, -info.z0 / info.h);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    this.kinds = ctx.getImageData(0, 0, img.width, img.height).data;
    this.kw = img.width;
    this.kh = img.height;
    this.info = info;
  }

  /** 'lawn', 'bed' or '' at a spot on the map. */
  kindAt(x: number, z: number): string {
    if (!this.kinds || !this.info) return '';
    const i = Math.floor(((x - this.info.x0) / this.info.w) * this.kw);
    const j = Math.floor(((z - this.info.z0) / this.info.h) * this.kh);
    if (i < 0 || j < 0 || i >= this.kw || j >= this.kh) return '';
    const p = (j * this.kw + i) * 4;
    if (this.kinds[p] > 127) return 'lawn';
    if (this.kinds[p + 1] > 127) return 'bed';
    return '';
  }

  /** Follow the camera; the patch is hidden when no lawn is anywhere near (saves drawing it for nothing). */
  update(cam: THREE.Vector3): void {
    (this.mat.uniforms.uCamPos.value as THREE.Vector3).copy(cam);
    const reach = (this.mat.uniforms.uPatch.value as number) * 0.5;
    let near = false;
    for (let a = 0; a < 8 && !near; a++) {
      for (const f of [0.15, 0.5, 0.95]) {
        const x = cam.x + Math.cos((a * Math.PI) / 4) * reach * f;
        const z = cam.z + Math.sin((a * Math.PI) / 4) * reach * f;
        if (this.kindAt(x, z) === 'lawn') {
          near = true;
          break;
        }
      }
    }
    this.mesh.visible = near || this.kindAt(cam.x, cam.z) === 'lawn';
  }
}
