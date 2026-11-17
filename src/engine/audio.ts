/**
 * Sound. Real recordings where we have them (public/audio/, see credits.json), small
 * synthesised sounds for the rest: paw steps, the collar bell, wind in the microphone, beeps.
 * Everything is heard from the collar camera: things further away are quieter and duller.
 */

const FILES: Record<string, string[]> = {
  meow: ['cat_meow_1', 'cat_meow_2', 'cat_meow_3', 'cat_meow_4'],
  chirp: ['cat_chirp_1', 'cat_chirp_2'],
  growl: ['cat_growl_1', 'cat_growl_2'],
  hiss: ['cat_hiss_1', 'cat_hiss_2'],
  yowl: ['cat_yowl_1', 'cat_yowl_2'],
  bap: ['slap_1', 'slap_2', 'slap_3'],
  swipe: ['whoosh_1', 'whoosh_2'],
  rustle: ['rustle_1', 'rustle_2'],
  bell: ['bell_1', 'bell_2', 'bell_3'],
  knock_ceramic: ['knock_ceramic_1', 'knock_ceramic_2'],
  knock_can: ['knock_can_1', 'knock_can_2'],
  knock_plastic: ['knock_plastic_1'],
  knock_ball: ['knock_ball_1'],
  knock_metal: ['knock_metal_1'],
  knock_thud: ['knock_thud_1'],
  wings: ['wings_1'],
  purr: ['cat_purr'],
  ambience: ['amb_estate'],
};

const KNOCK_OF: Record<string, string> = {
  pot: 'knock_ceramic', vase: 'knock_ceramic', can: 'knock_can', bottle: 'knock_plastic', ball: 'knock_ball',
  lid: 'knock_metal', gnome: 'knock_thud', sign: 'knock_plastic', thing: 'knock_thud',
};

export interface PlayOptions {
  gain?: number;
  /** playback speed; 1 = as recorded */
  rate?: number;
  /** where it happens in the world; omitted = at the microphone */
  x?: number;
  z?: number;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private recordTap: MediaStreamAudioDestinationNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private noise: AudioBuffer | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private purrGain: GainNode | null = null;
  private ambGain: GainNode | null = null;
  private volume = 0.8;
  private lx = 0;
  private lz = 0;
  private lheading = 0;
  private loading: Promise<void> | null = null;
  private bellCool = 0;

  constructor(private readonly base: string) {}

  /** Must be called from a click or key press: browsers only allow sound after one. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      const squash = ctx.createDynamicsCompressor();
      squash.threshold.value = -14;
      squash.ratio.value = 5;
      master.connect(squash);
      squash.connect(ctx.destination);
      try {
        this.recordTap = ctx.createMediaStreamDestination();
        squash.connect(this.recordTap);
      } catch {
        this.recordTap = null;
      }
      this.master = master;
      // one second of noise, reused for steps, wind and whooshes
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = noise;
      this.startWind();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.loading) this.loading = this.loadAll();
    await this.loading;
  }

  /** Sound track for the clip recorder (null until sound is unlocked). */
  get stream(): MediaStream | null {
    return this.recordTap?.stream ?? null;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  suspend(on: boolean): void {
    if (!this.ctx) return;
    if (on && this.ctx.state === 'running') void this.ctx.suspend();
    if (!on && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private async loadAll(): Promise<void> {
    const ctx = this.ctx!;
    const names = [...new Set(Object.values(FILES).flat())];
    await Promise.all(
      names.map(async (name) => {
        try {
          const res = await fetch(`${this.base}${name}.mp3`);
          if (!res.ok) return;
          this.buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {
          // a missing recording just means the built-in fallback is used
        }
      }),
    );
    // the recordings loop without a seam at exactly these lengths (the MP3 files carry a sliver of silence after it)
    this.startLoop('ambience', 0.55, 80.0, (g) => (this.ambGain = g));
    this.startLoop('purr', 0, 4.65, (g) => (this.purrGain = g));
  }

  private startLoop(key: string, gain: number, length: number, keep: (g: GainNode) => void): void {
    const ctx = this.ctx!;
    const buf = this.buffers.get(FILES[key][0]);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (buf.duration > length) {
      src.loopStart = 0;
      src.loopEnd = length;
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.master!);
    src.start();
    keep(g);
  }

  private startWind(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(this.master!);
    src.start();
    this.windGain = g;
    this.windFilter = f;
  }

  /** Where the microphone is and what the cat is doing. Call every frame. */
  update(x: number, z: number, heading: number, speed: number, idleSeconds: number, dt: number): void {
    this.lx = x;
    this.lz = z;
    this.lheading = heading;
    this.bellCool = Math.max(0, this.bellCool - dt);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // wind over the microphone rises with speed
    const s = Math.min(1, Math.abs(speed) / 8);
    this.windGain?.gain.setTargetAtTime(0.02 + s * s * 0.5, t, 0.12);
    this.windFilter?.frequency.setTargetAtTime(180 + s * 520, t, 0.12);
    // a cat that has sat still in peace for a while starts to purr
    this.purrGain?.gain.setTargetAtTime(idleSeconds > 4 ? 0.5 : 0, t, 0.6);
    this.ambGain?.gain.setTargetAtTime(0.55 - s * 0.2, t, 0.3);
  }

  private spatial(opts: PlayOptions): { gain: number; pan: number; dull: number } {
    if (opts.x === undefined || opts.z === undefined) return { gain: 1, pan: 0, dull: 0 };
    const dx = opts.x - this.lx;
    const dz = opts.z - this.lz;
    const d = Math.hypot(dx, dz);
    const h = (this.lheading * Math.PI) / 180;
    // right of the camera = positive pan
    const right = dx * Math.cos(h) + dz * Math.sin(h);
    return { gain: 1 / (1 + (d / 4) ** 2), pan: d > 0.3 ? Math.max(-0.9, Math.min(0.9, right / d)) : 0, dull: Math.min(1, d / 30) };
  }

  /** Play a recording by key (see FILES). Returns false when none is loaded. */
  play(key: string, opts: PlayOptions = {}): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.master) return false;
    const names = FILES[key];
    const loaded = names?.filter((n) => this.buffers.has(n));
    if (!loaded || !loaded.length) return false;
    const buf = this.buffers.get(loaded[Math.floor(Math.random() * loaded.length)])!;
    const sp = this.spatial(opts);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (opts.rate ?? 1) * (0.94 + Math.random() * 0.12);
    const g = ctx.createGain();
    g.gain.value = (opts.gain ?? 1) * sp.gain;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 16000 - sp.dull * 13000;
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.pan;
    src.connect(f);
    f.connect(g);
    g.connect(pan);
    pan.connect(this.master);
    src.start();
    return true;
  }

  /** A burst of filtered noise: the body of steps, thumps and whooshes. */
  private burst(freq: number, q: number, seconds: number, gain: number, type: BiquadFilterType = 'bandpass', sweepTo?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loopStart = Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + seconds);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t, Math.random() * 0.4, seconds + 0.02);
  }

  private tone(freq: number, seconds: number, gain: number, type: OscillatorType = 'sine', slideTo?: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + seconds + 0.05);
  }

  /** A paw on the ground. Cat steps are nearly silent; these are soft pats shaped by the surface. */
  step(surface: string, force: number): void {
    const f = 0.25 + force * 0.75;
    switch (surface) {
      case 'grass':
        this.burst(3400, 0.7, 0.07, 0.05 * f);
        break;
      case 'hedge':
        this.burst(4200, 0.6, 0.09, 0.09 * f);
        break;
      case 'soil':
        this.burst(900, 0.8, 0.05, 0.06 * f);
        break;
      case 'wood':
        this.burst(330, 2.2, 0.06, 0.16 * f);
        break;
      case 'gravel':
        this.burst(2600, 1.2, 0.08, 0.11 * f);
        break;
      case 'metal':
        this.burst(1500, 6, 0.09, 0.1 * f);
        break;
      default:
        this.burst(700 + Math.random() * 300, 1.1, 0.04, 0.085 * f);
    }
    // the collar bell tinkles when the cat really moves
    if (force > 0.45 && this.bellCool <= 0 && Math.random() < 0.55) {
      this.bellCool = 0.16;
      if (!this.play('bell', { gain: 0.35 + force * 0.3 })) {
        const base = 3100 + Math.random() * 500;
        this.tone(base, 0.22, 0.03 * f);
        this.tone(base * 1.48, 0.16, 0.018 * f);
        this.tone(base * 2.21, 0.1, 0.009 * f);
      }
    }
  }

  /** Play a game event by name (see Session.sfx). */
  event(name: string, opts: PlayOptions & { detail?: string } = {}): void {
    if (!this.ctx) return;
    const g = opts.gain ?? 1;
    switch (name) {
      case 'step':
        this.step(opts.detail ?? 'asphalt', g);
        break;
      case 'land':
        this.burst(180, 1.2, 0.12, 0.3 * g, 'lowpass');
        this.step(opts.detail ?? 'asphalt', 1);
        break;
      case 'jump':
        this.burst(900, 0.8, 0.09, 0.07, 'bandpass', 2400);
        break;
      case 'knock': {
        const key = KNOCK_OF[opts.detail ?? 'thing'] ?? 'knock_thud';
        if (!this.play(key, opts)) {
          this.burst(1800, 3, 0.18, 0.35 * g);
          this.tone(520 + Math.random() * 400, 0.16, 0.12 * g, 'triangle');
        }
        break;
      }
      case 'bap':
        if (!this.play('bap', opts)) this.burst(420, 1.4, 0.07, 0.4 * g, 'lowpass');
        break;
      case 'block':
        if (!this.play('bap', { ...opts, rate: 1.5, gain: g * 0.6 })) this.burst(900, 2, 0.05, 0.25 * g);
        break;
      case 'swipe':
        if (!this.play('swipe', opts)) this.burst(700, 0.9, 0.16, 0.16 * g, 'bandpass', 3200);
        break;
      case 'rustle':
        if (!this.play('rustle', opts)) this.burst(3600, 0.6, 0.35, 0.16 * g);
        break;
      case 'meow':
      case 'chirp':
      case 'growl':
      case 'hiss':
      case 'yowl':
        if (!this.play(name, opts)) {
          // stand-in voice until a recording is there: a short sliding tone
          const f0 = name === 'growl' ? 140 : name === 'hiss' ? 0 : 620;
          if (f0) this.tone(f0, name === 'growl' ? 0.7 : 0.35, 0.12 * g, 'sawtooth', f0 * (name === 'meow' ? 0.7 : 1.3));
          else this.burst(5200, 0.5, 0.6, 0.25 * g);
        }
        break;
      case 'wings':
        if (!this.play('wings', opts)) for (let i = 0; i < 6; i++) setTimeout(() => this.burst(1400, 1.5, 0.05, 0.12 * g), i * 70);
        break;
      case 'tag':
        this.play('chirp', { gain: 0.8 });
        this.tone(880, 0.12, 0.08, 'triangle');
        this.tone(1320, 0.18, 0.08, 'triangle', undefined, 0.09);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.28, 0.07, 'triangle', undefined, i * 0.085));
        break;
      case 'lose':
        this.tone(330, 0.5, 0.08, 'triangle', 196);
        break;
      case 'beep':
        this.tone(1760, 0.09, 0.06, 'square');
        this.tone(1760, 0.09, 0.06, 'square', undefined, 0.18);
        break;
      case 'shutdown':
        this.tone(880, 0.6, 0.08, 'square', 110);
        break;
      case 'record':
        this.tone(1320, 0.08, 0.06, 'square');
        break;
      default:
        break;
    }
  }
}
