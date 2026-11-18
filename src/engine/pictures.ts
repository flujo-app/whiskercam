import * as THREE from 'three';
import { patient } from './patient';

/**
 * Loads the pictures that go onto surfaces and the baked light, with care for small devices and slow lines.
 *
 * Version 1.0 asked for all of them (about three hundred) at once and at full size. A desktop copes; a phone
 * runs out of memory while unpacking them and the game never starts. So:
 *   - only a few are fetched and unpacked at a time,
 *   - on a phone each one is shrunk straight after unpacking, before it goes to the graphics chip,
 *   - the unpacked copy is thrown away as soon as the graphics chip has it,
 *   - a picture that fails twice is replaced by plain grey instead of stopping the game.
 *
 * And nobody waits for a hundred megabytes before the title screen: every picture has a small copy (a few
 * kilobytes, in a folder "s" next to it). Those are fetched first and the game starts on them; the full
 * pictures follow, the ones nearest to the start first, and take the place of the small ones as they arrive.
 */
export class Pictures {
  /** how many have been asked for, and how many are in (for the loading bar: the small copies when there are any) */
  total = 0;
  done = 0;
  /** rough size of everything loaded so far on the graphics chip, in bytes */
  bytes = 0;
  /** addresses that could not be loaded */
  readonly failed: string[] = [];
  onProgress: (() => void) | null = null;

  private readonly quick: (() => Promise<void>)[] = [];
  private readonly full: { near: number; job: () => Promise<void> }[] = [];
  private sorted = true;
  private running = 0;
  private quickLeft = 0;
  private fullLeft = 0;
  private idle: (() => void)[] = [];
  private sharp: (() => void)[] = [];
  /** the full pictures wait for the go-ahead: until then the line belongs to what the game cannot start without */
  private held: boolean;

  /**
   * @param scale    1 = full size; 0.5 = half the width and height (a quarter of the memory)
   * @param parallel how many pictures may be in the works at once
   * @param twoStep  small copies exist: start on those
   */
  constructor(readonly scale = 1, readonly parallel = 8, readonly twoStep = false) {
    this.held = twoStep;
  }

  /** Everything the game needs to start is in: fetch the full pictures now. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    this.pump();
  }

  /**
   * Fill `tex` with the picture at `url`. `tex` can be used at once; it is empty until the picture arrives.
   * `maxSide` caps the longer side in pixels (after scaling). `near` = how soon the full picture is wanted
   * (metres from where the game starts, or any number that sorts the same way).
   */
  load(tex: THREE.Texture, url: string, maxSide = 4096, near = 0): void {
    this.total++;
    if (this.twoStep) {
      this.quickLeft++;
      this.quick.push(async () => {
        try {
          const bmp = await this.fetchPicture(url.replace(/([^/]+)$/, 's/$1'), 4096, 1);
          this.put(tex, bmp, false);
        } catch {
          // no small copy: the surface stays plain until the full picture is in
        }
      });
    }
    this.fullLeft++;
    this.sorted = false;
    this.full.push({
      near,
      job: async () => {
        let bmp: ImageBitmap | HTMLImageElement | null = null;
        try {
          bmp = await patient(() => this.fetchPicture(url, maxSide, this.scale));
        } catch {
          bmp = null;
        }
        if (!bmp) {
          this.failed.push(url);
          if (tex.image) return; // the small copy stays
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
        this.put(tex, bmp, true);
      },
    });
    this.pump();
  }

  /** Hand a picture to a texture (replacing the small copy, if one is there). */
  private put(tex: THREE.Texture, bmp: ImageBitmap | HTMLImageElement, final: boolean): void {
    const channels = tex.format === THREE.RedFormat ? 1 : 4;
    const size = (w: number, h: number) => w * h * channels * (tex.generateMipmaps ? 4 / 3 : 1);
    if (tex.image) {
      // another size: the graphics chip must make room afresh (and the small copy no longer counts)
      this.bytes -= (tex.userData.bytes as number | undefined) ?? 0;
      tex.dispose();
    }
    tex.image = bmp;
    tex.needsUpdate = true;
    if ('close' in bmp) {
      const bitmap = bmp;
      // the graphics chip has its own copy now: free ours (the size is kept: it is asked for later)
      tex.onUpdate = () => {
        bitmap.close();
        tex.onUpdate = null as unknown as () => void;
      };
    }
    tex.userData.bytes = size(bmp.width, bmp.height);
    this.bytes += tex.userData.bytes as number;
    if (final) tex.userData.sharp = true;
  }

  private async fetchPicture(url: string, maxSide: number, scale: number): Promise<ImageBitmap | HTMLImageElement> {
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
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { final: res.status === 404 });
    const blob = await res.blob();
    const plain: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
    let bmp = await createImageBitmap(blob, plain);
    const longest = Math.max(bmp.width, bmp.height);
    const want = Math.min(maxSide, Math.max(64, Math.round(longest * scale)));
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
    while (this.running < this.parallel) {
      let job: (() => Promise<void>) | undefined;
      let quick = false;
      if (this.quick.length) {
        job = this.quick.shift();
        quick = true;
      } else if (!this.held && this.quickLeft === 0 && this.full.length) {
        // the full pictures wait until every small one is in, then go nearest first
        if (!this.sorted) {
          this.full.sort((a, b) => a.near - b.near);
          this.sorted = true;
        }
        job = this.full.shift()!.job;
      }
      if (!job) break;
      this.running++;
      void job().finally(() => {
        this.running--;
        if (quick) this.quickLeft--;
        else this.fullLeft--;
        if (quick === this.twoStep) {
          this.done++;
          this.onProgress?.();
        }
        if ((this.twoStep ? this.quickLeft : this.fullLeft) === 0) for (const f of this.idle.splice(0)) f();
        if (this.fullLeft === 0 && this.quickLeft === 0) for (const f of this.sharp.splice(0)) f();
        this.pump();
      });
    }
  }

  /** Resolves when the game can be drawn: every picture asked for so far is there, at least as its small copy. */
  ready(): Promise<void> {
    if ((this.twoStep ? this.quickLeft : this.fullLeft) === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  /** Resolves when every picture asked for so far is there in full. */
  whenSharp(): Promise<void> {
    if (this.fullLeft === 0 && this.quickLeft === 0) return Promise.resolve();
    return new Promise((resolve) => this.sharp.push(resolve));
  }

  /** how many full pictures are still on their way */
  get owed(): number {
    return this.fullLeft;
  }
}
