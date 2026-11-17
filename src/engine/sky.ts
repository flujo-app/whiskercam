import * as THREE from 'three';
import type { Globals } from './materials';
import { skyFragment, skyVertex } from './shaders/post.glsl';

/** The sky dome plus the reflection map made from the same picture. */
export class Sky {
  readonly mesh: THREE.Mesh;
  private pmrem: THREE.WebGLRenderTarget | null = null;

  constructor(private readonly globals: Globals) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        uSky: { value: null },
        uSkyRange: { value: 1 },
        uSunDir: globals.uSunDir,
        uSunColor: globals.uSunColor,
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // after the solid world, so hidden sky pixels are skipped
    this.mesh.name = 'sky';
  }

  /** `url` is the sqrt-encoded equirect sky picture, `range` its brightness scale. */
  async load(renderer: THREE.WebGLRenderer, url: string, range: number): Promise<void> {
    const img = await new THREE.ImageLoader().loadAsync(url);
    const tex = new THREE.Texture(img);
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uSky.value = tex;
    u.uSkyRange.value = range;

    // reflection map: decode the picture to real brightness values, then let three.js blur it per roughness
    const w = 512;
    const h = 256;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint16Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4; // picture row 0 is the zenith, texture row 0 is straight down
      const dst = y * w * 4;
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          const v = px[src + x * 4 + c] / 255;
          data[dst + x * 4 + c] = THREE.DataUtils.toHalfFloat(v * v * range);
        }
        data[dst + x * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
      }
    }
    const equirect = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    equirect.colorSpace = THREE.LinearSRGBColorSpace;
    equirect.minFilter = equirect.magFilter = THREE.LinearFilter;
    equirect.wrapS = THREE.RepeatWrapping;
    equirect.needsUpdate = true;
    const gen = new THREE.PMREMGenerator(renderer);
    this.pmrem?.dispose();
    this.pmrem = gen.fromEquirectangular(equirect);
    gen.dispose();
    equirect.dispose();
    this.globals.uEnvMap.value = this.pmrem.texture;
    this.globals.uEnvMaxLod.value = Math.max(0, this.pmrem.texture.mipmaps.length - 1);

    // haze colour = the sky near the horizon, a little above it
    const row = Math.floor(h * 0.47) * w * 4;
    const fog = new THREE.Color(0, 0, 0);
    for (let x = 0; x < w; x += 8) {
      fog.r += (px[row + x * 4] / 255) ** 2;
      fog.g += (px[row + x * 4 + 1] / 255) ** 2;
      fog.b += (px[row + x * 4 + 2] / 255) ** 2;
    }
    fog.multiplyScalar((range * 8) / w);
    this.globals.uFogColor.value.copy(fog);
  }
}
