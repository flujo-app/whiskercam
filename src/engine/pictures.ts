import * as THREE from 'three';

/**
 * Loads the pictures that go onto surfaces and the baked light, with care for small devices.
 *
 * Version 1.0 asked for all of them (about three hundred) at once and at full size. A desktop copes; a phone
 * runs out of memory while unpacking them and the game never starts. So:
 *   - only a few are fetched and unpacked at a time,
 *   - on a phone each one is shrunk straight after unpacking, before it goes to the graphics chip,
 *   - the unpacked copy is thrown away as soon as the graphics chip has it,
 *   - a picture that fails twice is replaced by plain grey instead of stopping the game.
 */
export class Pictures {
  /** how many have been asked for, and how many are done (for the loading bar) */
  total = 0;
  done = 0;
  /** rough size of everything loaded so far on the graphics chip, in bytes */
  bytes = 0;
  /** addresses that could not be loaded */
  readonly failed: string[] = [];
  onProgress: (() => void) | null = null;

  private readonly waiting: (() => Promise<void>)[] = [];
  private running = 0;
  private idle: (() => void)[] = [];

  /**
   * @param scale    1 = full size; 0.5 = half the width and height (a quarter of the memory)
   * @param parallel how many pictures may be in the works at once
   */
  constructor(readonly scale = 1, readonly parallel = 8) {}

  /**
   * Fill `tex` with the picture at `url`. `tex` can be used at once; it is empty until the picture arrives.
   * `maxSide` caps the longer side in pixels (after scaling).
   */
  load(tex: THREE.Texture, url: string, maxSide = 4096): void {
    this.total++;
    this.waiting.push(async () => {
      let bmp: ImageBitmap | HTMLImageElement | null = null;
      for (let attempt = 0; attempt < 2 && !bmp; attempt++) {
        try {
          bmp = await this.fetchPicture(url, maxSide);
        } catch {
          bmp = null;
        }
      }
      if (!bmp) {
        this.failed.push(url);
        // one plain grey dot: the surface loses its pattern, the game goes on
        const data = new Uint8Array([128, 128, 128, 255]);
        const dot = new THREE.DataTexture(data, 1, 1);
        tex.image = dot.image;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.NearestFilter;
        tex.format = THREE.RGBAFormat;
        tex.needsUpdate = true;
        return;
      }
      const w = bmp.width;
      const h = bmp.height;
      tex.image = bmp;
      tex.needsUpdate = true;
      if ('close' in bmp) {
        const bitmap = bmp;
        // the graphics chip has its own copy now: free ours
        tex.onUpdate = () => {
          bitmap.close();
          tex.onUpdate = null as unknown as () => void;
        };
      }
      const channels = tex.format === THREE.RedFormat ? 1 : 4;
      this.bytes += w * h * channels * (tex.generateMipmaps ? 4 / 3 : 1);
    });
    this.pump();
  }

  private async fetchPicture(url: string, maxSide: number): Promise<ImageBitmap | HTMLImageElement> {
    if (typeof createImageBitmap !== 'function') {
      // very old browsers: the plain way, at full size
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(url));
        img.src = url;
      });
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const blob = await res.blob();
    const plain: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
    let bmp = await createImageBitmap(blob, plain);
    const longest = Math.max(bmp.width, bmp.height);
    const want = Math.min(maxSide, Math.max(64, Math.round(longest * this.scale)));
    if (longest > want) {
      const k = want / longest;
      const small = await createImageBitmap(bmp, {
        ...plain,
        resizeWidth: Math.max(1, Math.round(bmp.width * k)),
        resizeHeight: Math.max(1, Math.round(bmp.height * k)),
        resizeQuality: 'high',
      });
      bmp.close();
      bmp = small;
    }
    return bmp;
  }

  private pump(): void {
    while (this.running < this.parallel && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      void job().finally(() => {
        this.running--;
        this.done++;
        this.onProgress?.();
        this.pump();
        if (this.running === 0 && this.waiting.length === 0) {
          for (const f of this.idle.splice(0)) f();
        }
      });
    }
  }

  /** Resolves when every picture asked for so far has arrived (or been given up on). */
  ready(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }
}
