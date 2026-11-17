import * as THREE from 'three';
import { Audio } from '../engine/audio';
import { Grass } from '../engine/grass';
import { Input, type Controls } from '../engine/input';
import { LensRig } from '../engine/lens';
import { Physics } from '../engine/physics';
import { Post } from '../engine/post';
import { Recorder } from '../engine/recorder';
import { LiveShadows } from '../engine/shadows';
import { Sky } from '../engine/sky';
import { loadWorld, type LoadedWorld } from '../engine/world';
import { StandInCat, type CatVisual, type CatVisualFactory, type Coat } from './cats';
import { CatModel } from './furcat';
import { Nav } from './nav';
import { Pigeons } from './pigeons';
import { Player } from './player';
import { Props } from './props';
import { Session, type BrotherInfo, type RivalInfo } from './session';
import { QUALITY_LINES, QUALITY_SCALE, type Settings } from './settings';

export interface GameOptions {
  set: string;
  /** 0.5 .. 1.5: how finely the scene is drawn */
  quality: number;
  /** fixed picture size in pixels (tests); otherwise the window decides */
  size?: [number, number];
  /** frames are only produced on request (tests) */
  manual: boolean;
  /** phones and other small devices: less grass, fewer fur layers, plants drawn less far */
  lean?: boolean;
  onProgress?: (fraction: number, text: string) => void;
}

const STEP = 1 / 60;

export class Game {
  readonly scene = new THREE.Scene();
  readonly rig = new LensRig();
  readonly post: Post;
  readonly input: Input;
  world!: LoadedWorld;
  physics!: Physics;
  player!: Player;
  shadows!: LiveShadows;
  grass: Grass | null = null;
  props!: Props;
  pigeons!: Pigeons;
  session!: Session;
  /** how cats are drawn; swapped for the furry model once that is loaded */
  catFactory!: CatVisualFactory;
  catModel: CatModel | null = null;
  /** when set, the camera ignores the cat and sits here (test pictures, free look) */
  freeCam: { x: number; y: number; z: number; heading: number; pitch: number; roll: number } | null = null;
  time = 0;
  paused = false;
  /** most picture lines drawn, whatever the screen (set by the quality setting) */
  maxLines = 1600;
  /** 0.55 .. 1: lowered automatically when the graphics card cannot keep up */
  private governor = 1;
  private slowFrames = 0;
  private fastFrames = 0;
  readonly recorder: Recorder;
  readonly audio = new Audio(`${import.meta.env.BASE_URL}audio/`);
  /** called once per drawn frame, after the world has been updated */
  onFrame: ((dt: number, c: Controls) => void) | null = null;
  private acc = 0;
  private last = 0;
  private running = false;
  private readonly focus = new THREE.Vector3();
  /** the player's own cat: its chin and paws are in every picture, and it throws the shadow */
  playerCat: CatVisual | null = null;
  private playerCoat: Coat = 'ginger';
  private readonly collarNow = new THREE.Vector3();
  private readonly lightSample = { r: 0, g: 0, b: 0, sun: 1 };

  private constructor(readonly renderer: THREE.WebGLRenderer, readonly canvas: HTMLCanvasElement, readonly opts: GameOptions) {
    this.scene.add(this.rig.rig);
    this.post = new Post(renderer, this.rig);
    this.input = new Input(canvas);
    this.recorder = new Recorder(canvas);
  }

  static async create(canvas: HTMLCanvasElement, opts: GameOptions): Promise<Game> {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: opts.manual,
    });
    renderer.setClearColor(0x000000, 1);
    renderer.info.autoReset = false;
    const game = new Game(renderer, canvas, opts);
    game.layout();
    addEventListener('resize', () => game.layout());

    const say = opts.onProgress ?? (() => {});
    say(0.02, 'Waking the cat');
    const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    game.world = await loadWorld(opts.set, maxAniso, (done, total) => say(0.05 + (0.75 * done) / total, 'Unrolling the estate'));
    say(0.82, 'Checking the camera');
    const sky = new Sky(game.world.materials.globals);
    await sky.load(renderer, game.world.base + game.world.info.sky.file, game.world.info.sky.range);
    game.scene.add(game.world.group, sky.mesh);
    game.post.sunDir.copy(game.world.materials.globals.uSunDir.value);
    if (game.world.info.kinds) {
      game.grass = opts.lean ? new Grass(game.world.materials.globals, 8, 0.125, 6) : new Grass(game.world.materials.globals);
      await game.grass.load(game.world.base + game.world.info.kinds.file, game.world.info.kinds);
      game.scene.add(game.grass.mesh);
    }
    say(0.9, 'Sharpening claws');
    game.physics = await Physics.create(game.world.base);
    game.shadows = new LiveShadows(game.world.materials.globals);
    game.props = await Props.create(game.world, game.physics, game.scene);
    game.player = new Player(game.physics);
    const [sx, sy, sz] = game.world.info.spawn.pos;
    game.player.place(sx, sy, sz, game.world.info.spawn.heading);
    game.catFactory = (coat: Coat, name: string) => new StandInCat(game.world.materials, coat, name);
    try {
      const coats: Coat[] = ['tabby', 'ginger', 'black', 'white', 'grey', 'tux'];
      const model = await CatModel.load(`${import.meta.env.BASE_URL}assets/cats/`, game.world.materials, coats);
      if (opts.lean) model.shells = 10;
      game.catModel = model;
      game.catFactory = (coat: Coat, name: string) => model.make(coat, name);
    } catch (err) {
      console.warn('cat model not available, using stand-ins', err);
    }
    game.newSession();
    game.setPlayerCoat('ginger');
    // pigeons: on the square, by the bike racks, in front of the gate (they move on when scared off)
    const spots = (game.world.info.pigeons ?? [[10.5, 2.5], [33, -27], [-44, -1.5]]).map(([x, z]): [number, number, number] => {
      const ground = game.physics.groundBelow(x, 3, z, 6);
      return [x, ground ? ground.y : 0, z];
    });
    game.pigeons = new Pigeons(game.scene, game.world.materials, game.world.groundLight, spots);
    game.pigeons.onScatter = (x, z) => {
      if (!game.session.active) return;
      game.session.score.add('pigeons');
      game.session.sfx.push({ name: 'wings', x, z });
    };
    say(1, 'Ready');
    return game;
  }

  /** Fresh cats, fresh score: a new run waiting on the title screen. */
  newSession(): void {
    const info = this.world.info;
    const nav = new Nav(info.nav ?? { nodes: [[0, 0]], edges: [], ring: [0], home: 0 });
    const brother = (info.brother ?? { name: 'Rocket', coat: 'tabby', pos: [this.player.x + 1, this.player.z - 1], facing: 0 }) as BrotherInfo;
    if (this.session) {
      this.scene.remove(this.session.brother.visual.root);
      for (const r of this.session.rivals) this.scene.remove(r.npc.visual.root);
    }
    this.session = new Session(this.player, this.physics, nav, this.props, this.world.groundLight, this.catFactory, this.scene, brother, (info.rivals ?? []) as RivalInfo[]);
  }

  /** Take over the player's choices (called at start and whenever a setting changes). */
  applySettings(s: Settings): void {
    const q = QUALITY_SCALE[s.quality] ?? 1;
    const lines = QUALITY_LINES[s.quality] ?? 1600;
    if ((Math.abs(q - this.opts.quality) > 1e-3 || lines !== this.maxLines) && !this.opts.size) {
      this.opts.quality = q;
      this.maxLines = lines;
      this.governor = 1;
      this.layout();
    }
    this.input.mouseSensitivity = 0.11 * s.sensitivity;
    this.input.touchSensitivity = 0.28 * s.sensitivity;
    this.player.motion = s.motion;
    this.setPlayerCoat(s.coat);
    this.audio.setVolume(s.volume);
  }

  /** Leave the title screen: the cat can move, the battery starts to drain. */
  beginRun(s: Settings): void {
    this.paused = false;
    this.session.start();
    this.post.cut();
    if (this.opts.manual) return;
    // sound may only start from a click; the clip recorder waits for it so the file gets a sound track
    void this.audio.unlock().then(() => {
      this.audio.setVolume(s.volume);
      this.audio.event('record');
      if (s.record) this.recorder.start(this.audio.stream);
    });
  }

  /** Everything back to the start: cat on the deck, pots on their ledges, no score. */
  resetRun(): void {
    this.recorder.discard();
    const [sx, sy, sz] = this.world.info.spawn.pos;
    this.player.place(sx, sy, sz, this.world.info.spawn.heading);
    this.player.control = 1;
    this.player.pullBack = 0;
    this.player.tiltUp = 0;
    this.props.reset();
    this.pigeons.reset();
    this.newSession();
    this.post.cut();
  }
  /** (Re)create the player's cat in the chosen coat. */
  setPlayerCoat(coat: Coat): void {
    if (this.playerCat && coat === this.playerCoat) return;
    if (this.playerCat) this.scene.remove(this.playerCat.root);
    this.playerCoat = coat;
    this.playerCat = this.catFactory(coat, 'player');
    this.scene.add(this.playerCat.root);
  }

  /** The picture is always upright (9:16 at most), like the phone clip it imitates. */
  layout(): void {
    let w: number;
    let h: number;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.opts.size) {
      [w, h] = this.opts.size;
      dpr = 1;
    } else {
      h = window.innerHeight;
      w = Math.min(window.innerWidth, Math.round((h * 9) / 16));
      // a phone clip does not need more than this many lines; big screens just show it larger
      dpr = Math.min(dpr, this.maxLines / h);
    }
    const pw = Math.max(2, Math.round(w * dpr));
    const ph = Math.max(2, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.renderer.setSize(pw, ph, false);
    this.post.setSize(pw, ph, this.opts.quality * this.governor);
  }

  /** One fixed step of the world. */
  update(c: Controls): void {
    this.time += STEP;
    this.player.update(STEP, c);
    this.physics.step();
    this.props.update(STEP);
    this.pigeons.update(STEP, this.player.x, this.player.z, this.player.speed);
    this.session.update(STEP, c);
    for (const s of this.session.sfx.splice(0, this.session.sfx.length)) this.audio.event(s.name, s);
    this.audio.update(this.player.camX, this.player.camZ, this.player.camHeading, this.player.speed, this.session.active ? this.player.idle : 0, STEP);
    const g = this.world.materials.globals;
    g.uTime.value = this.time;
  }

  /** Draw the current state. `dt` = seconds of game time since the last picture. */
  render(dt: number): void {
    const p = this.player;
    if (this.freeCam) {
      const f = this.freeCam;
      this.rig.setPose(f.x, f.y, f.z, f.heading, f.pitch, f.roll);
      this.focus.set(f.x, f.y, f.z);
    } else {
      p.apply(this.rig);
      this.focus.set(p.x, p.y, p.z);
    }
    const cat = this.playerCat;
    if (cat) {
      // hang the cat on the camera: its collar sits where the lens is, its paws stay on the ground
      const yaw = -THREE.MathUtils.degToRad(p.heading);
      const c = cat.collarAt;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      cat.root.position.set(p.camX - (c.x * cos + c.z * sin), p.y, p.camZ - (-c.x * sin + c.z * cos));
      cat.root.rotation.y = yaw;
      const look = this.session.playerLook;
      cat.setLight(this.world.groundLight.sample(p.x, p.z, this.lightSample));
      if (cat.collarWorld) {
        // the furry cat: pose it, measure where its collar ended up, and hang that point exactly on the lens.
        // The chin and whiskers then sit in the same place in the picture whatever the body does.
        look.headLow = 0;
        cat.update(look, dt);
        const at = cat.collarWorld(this.collarNow);
        cat.root.position.x += p.camX - at.x;
        cat.root.position.y += p.camY - at.y;
        cat.root.position.z += p.camZ - at.z;
      } else {
        look.headLow = c.y - (p.camY - p.y);
        cat.update(look, dt);
      }
    }
    this.grass?.update(this.rig.rig.position);
    this.world.cull(this.rig.rig.position.x, this.rig.rig.position.z, this.opts.lean ? 27 : 38);
    this.renderer.info.reset();
    this.shadows.render(this.renderer, this.scene, this.focus);
    this.post.render(this.scene, dt);
  }

  /** Run `seconds` of game time with fixed controls and draw every frame (tests and attract mode). */
  sim(c: Partial<Controls>, seconds: number): void {
    const controls: Controls = { ...this.input.state, move: 0, turn: 0, yaw: 0, pitch: 0, sprint: false, jump: false, pawLeft: false, pawRight: false, dodge: false, pause: false, any: false, ...c };
    const steps = Math.max(1, Math.round(seconds / STEP));
    for (let i = 0; i < steps; i++) {
      this.update(controls);
      controls.jump = false;
      controls.yaw = 0;
      this.render(STEP);
    }
  }

  /** Like sim, but asks `decide` for the controls every step (the self-playing bot). */
  simWith(decide: (dt: number) => Controls, seconds: number, drawEvery = 1): void {
    const steps = Math.max(1, Math.round(seconds / STEP));
    for (let i = 0; i < steps; i++) {
      this.update(decide(STEP));
      if (i % drawEvery === 0) this.render(STEP * drawEvery);
    }
  }

  start(): void {
    if (this.running || this.opts.manual) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      // keep it smooth: if frames keep coming late, draw fewer pixels; if there is room, go back up
      if (!this.paused && dt > 0.021) this.slowFrames++;
      else if (dt < 0.0125) this.fastFrames++;
      if (this.slowFrames > 45 && this.governor > 0.56) {
        this.governor = Math.max(0.55, this.governor - 0.12);
        this.slowFrames = this.fastFrames = 0;
        this.layout();
      } else if (this.fastFrames > 900 && this.governor < 1) {
        this.governor = Math.min(1, this.governor + 0.12);
        this.slowFrames = this.fastFrames = 0;
        this.layout();
      }
      if (this.slowFrames + this.fastFrames > 1200) this.slowFrames = this.fastFrames = 0;
      this.acc += dt;
      const c = this.input.poll();
      const pausePressed = c.pause;
      if (this.paused) this.acc = 0;
      let steps = 0;
      while (this.acc >= STEP && steps < 5) {
        this.update(c);
        // one-shot inputs must not repeat when several steps run in one frame
        c.jump = c.pawLeft = c.pawRight = c.dodge = c.pause = c.meow = false;
        c.yaw = 0;
        c.pitch = 0;
        this.acc -= STEP;
        steps++;
      }
      if (steps === 5) this.acc = 0;
      this.render(this.paused ? 0 : dt);
      c.pause = pausePressed;
      this.onFrame?.(dt, c);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }
}
