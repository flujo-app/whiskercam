import * as THREE from 'three';
import { Audio } from '../engine/audio';
import { Grass } from '../engine/grass';
import { Input, type Controls } from '../engine/input';
import { LensRig } from '../engine/lens';
import { Physics } from '../engine/physics';
import { Post } from '../engine/post';
import { Recorder } from '../engine/recorder';
import { planReflections, Reflections, STILL_LAYER, type GlassWall, type Probe } from '../engine/reflections';

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
  /** real reflections: 0 = shiny things mirror the sky only, 1 = cars and walls, 2 = and kept up to date near the cat (default by device) */
  reflections?: number;
  /** samples per pixel for edge smoothing (default 4, 0 on phones) */
  msaa?: number;
  /** size of surface and light pictures: 1 = full, 0.5 = half the width and height (default by device) */
  pictureScale?: number;
  onProgress?: (fraction: number, text: string) => void;
}

const STEP = 1 / 60;

/**
 * Smaller pictures for devices that cannot keep up: how finely the views are drawn, and whether edges get
 * their extra samples. A step down is only ever kept when the game demonstrably runs faster for it (see
 * `Game.pace`). Many phones are held back by the amount of geometry, not by the number of points drawn; on
 * those a smaller picture is just a worse picture.
 */
const SIZES = [
  { scale: 1, smooth: true },
  { scale: 0.85, smooth: true },
  { scale: 0.72, smooth: false },
] as const;
/** frames slower than this on average (seconds) count as "cannot keep up": under about 47 pictures a second */
const SLOW = 0.0215;

export class Game {
  readonly scene = new THREE.Scene();
  readonly rig = new LensRig();
  readonly post: Post;
  readonly input: Input;
  world!: LoadedWorld;
  physics!: Physics;
  player!: Player;
  shadows!: LiveShadows;
  /** the all-round pictures that shiny things look their reflections up in (null where the device goes without) */
  reflections: Reflections | null = null;
  private glassWalls: GlassWall[] = [];
  private readonly eye = new THREE.Vector3();
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
  /** which of SIZES is in use */
  private sizeStep = 0;
  /** samples per pixel for edge smoothing at full size */
  private readonly msaa: number;
  /** the stretch of frames being timed: total seconds, how many, and how many still to let pass first */
  private readonly span = { sum: 0, n: 0, skip: 90 };
  private slowSpans = 0;
  /** a change that is being tried out, with the frame time before it */
  private trial: { what: 'small' | 'middle' | 'thrifty'; before: number } | null = null;
  private sizeSettled = false;
  private thriftSettled = false;
  /** the grass, half the fur and the far plants are left out (only where that makes the game faster) */
  thrifty = false;
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
    // phones: no extra samples per pixel (they cost four times the memory for the two views), the smoothing
    // over time does the edges there
    this.msaa = opts.msaa ?? (opts.lean ? 0 : 4);
    this.post.msaa = this.msaa;
    this.post.lean = !!opts.lean;
    this.input = new Input(canvas);
    this.recorder = new Recorder(canvas, !!opts.lean);
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
    // phones: pictures at half size or less (a quarter of the memory or less), three at a time
    const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 4;
    const pictureScale = opts.pictureScale ?? (opts.lean ? (memory <= 4 ? 0.35 : 0.5) : 1);
    game.world = await loadWorld(opts.set, maxAniso, (done, total) => say(0.05 + (0.75 * done) / total, 'Unrolling the estate'), {
      pictureScale,
      parallel: opts.lean ? 3 : 8,
      lite: opts.lean,
    });
    // (Play starts on small copies of the pictures; the full ones are fetched once everything else is in,
    // see the end of this function. Tests wait for the real thing.)
    if (opts.manual) {
      game.world.pictures.release();
      await game.world.pictures.whenSharp();
    }
    if (game.world.pictures.failed.length) console.warn('pictures that did not load:', game.world.pictures.failed);
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
    game.shadows = new LiveShadows(game.world.materials.globals, opts.lean ? 1024 : 2048);
    game.props = await Props.create(game.world, game.physics, game.scene);
    game.player = new Player(game.physics);
    const [sx, sy, sz] = game.world.info.spawn.pos;
    game.player.place(sx, sy, sz, game.world.info.spawn.heading);
    game.catFactory = (coat: Coat, name: string) => new StandInCat(game.world.materials, coat, name);
    try {
      const coats: Coat[] = ['tabby', 'ginger', 'black', 'white', 'grey', 'tux'];
      const model = await CatModel.load(`${import.meta.env.BASE_URL}assets/cats/`, game.world.materials, coats);
      if (opts.lean) {
        model.shells = 8;
        model.lean = true;
      }
      game.catModel = model;
      game.catFactory = (coat: Coat, name: string) => model.make(coat, name);
    } catch (err) {
      console.warn('cat model not available, using stand-ins', err);
    }
    game.newSession();
    game.setPlayerCoat('ginger');
    // real reflections on cars and windows
    const level = opts.reflections ?? (opts.lean ? 0 : 2);
    if (level > 0) {
      const refl = new Reflections(renderer, game.scene, game.world.materials.globals, sky);
      const plan = planReflections(game.world, game.physics, refl, level > 1 ? 256 : 128, level > 1 ? 128 : 64);
      sky.mesh.layers.enable(STILL_LAYER);
      for (const p of game.props.items) Reflections.moving(p.group);
      if (game.playerCat) Reflections.moving(game.playerCat.root);
      Reflections.moving(game.session.brother.visual.root);
      for (const r of game.session.rivals) Reflections.moving(r.npc.visual.root);
      game.glassWalls = level > 1 ? plan.glassWalls : [];
      refl.before = (x, z, live) => {
        game.world.cull(x, z, 30);
        if (game.grass && !live) game.grass.mesh.visible = false;
      };
      refl.after = () => {
        if (game.grass) game.grass.mesh.visible = !game.thrifty;
      };
      refl.prioritise(sx, sz);
      game.reflections = refl;
      // once the full pictures are in, the surroundings are worth a second look
      if (game.world.pictures.owed > 0) {
        void game.world.pictures.whenSharp().then(() => {
          refl.retake();
          refl.prioritise(game.player.x, game.player.z);
        });
      }
      game.reflectLevel = level;
      // in tests every picture is taken before the first frame; in play they come in over the first second or two
      if (opts.manual) refl.work(1e9);
      console.info(`reflections: ${plan.cars} cars, ${plan.walls} walls, ${plan.meshes} shiny parts`);
    }
    // pigeons: on the square, by the bike racks, in front of the gate (they move on when scared off)
    const spots = (game.world.info.pigeons ?? [[10.5, 2.5], [33, -27], [-44, -1.5]]).map(([x, z]): [number, number, number] => {
      const ground = game.physics.groundBelow(x, 3, z, 6);
      return [x, ground ? ground.y : 0, z];
    });
    game.pigeons = new Pigeons(game.scene, game.world.materials, game.world.groundLight, spots);
    if (game.reflections) for (const bird of game.pigeons.roots) Reflections.moving(bird);
    game.pigeons.onScatter = (x, z) => {
      if (!game.session.active) return;
      game.session.score.add('pigeons');
      game.session.sfx.push({ name: 'wings', x, z });
    };
    say(1, 'Ready');
    game.world.pictures.release();
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
    if (this.reflections) {
      Reflections.moving(this.session.brother.visual.root);
      for (const r of this.session.rivals) Reflections.moving(r.npc.visual.root);
    }
  }

  /** Take over the player's choices (called at start and whenever a setting changes). */
  applySettings(s: Settings): void {
    const q = QUALITY_SCALE[s.quality] ?? 1;
    const lines = QUALITY_LINES[s.quality] ?? 1600;
    if ((Math.abs(q - this.opts.quality) > 1e-3 || lines !== this.maxLines) && !this.opts.size) {
      this.opts.quality = q;
      this.maxLines = lines;
      // another picture setting: start from its full size and find out afresh what this device manages
      this.sizeStep = 0;
      this.sizeSettled = false;
      this.trial = null;
      this.slowSpans = 0;
      this.span.skip = 60;
      this.layout();
    }
    this.input.mouseSensitivity = 0.11 * s.sensitivity;
    this.input.touchSensitivity = 0.28 * s.sensitivity;
    // "Faster" keeps the reflections but stops redrawing them while playing
    if (this.reflections && this.opts.reflections === undefined) this.reflectLevel = s.quality === 0 ? 1 : 2;
    this.player.motion = s.motion;
    // a steadier camera also smears less when it turns
    this.post.look.shutter = (0.6 + 0.4 * s.motion) / 60;
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
    this.playerCat.setOwn?.(true);
    this.scene.add(this.playerCat.root);
    if (this.reflections) Reflections.moving(this.playerCat.root);
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
      dpr = Math.min(dpr, ((this.opts.lean ? 0.9 : 1) * this.maxLines) / h);
    }
    const pw = Math.max(2, Math.round(w * dpr));
    const ph = Math.max(2, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.renderer.setSize(pw, ph, false);
    // (the two views behind the fisheye picture hold twice its pixels at full quality; a phone draws them a
    // little smaller, which on its small screen still leaves every point of the picture its own point of a view)
    const size = SIZES[this.sizeStep];
    this.post.msaa = size.smooth ? this.msaa : 0;
    this.post.setSize(pw, ph, this.opts.quality * size.scale * (this.opts.lean ? 0.8 : 1));
  }

  private resize(step: number): void {
    this.sizeStep = step;
    this.span.skip = 24;
    this.layout();
  }

  private setThrifty(on: boolean): void {
    this.thrifty = on;
    if (this.grass) this.grass.mesh.visible = !on;
    if (this.catModel) this.catModel.thrift = on ? 0.5 : 1;
    this.span.skip = 12;
  }

  /**
   * Keep the game smooth, without ever paying for it with a worse picture that buys nothing.
   *
   * Frame times are averaged over stretches of fifty frames. When two stretches in a row are slow, the game
   * tries the smallest picture for one stretch. Only if that is clearly faster does a smaller picture stay
   * (the middle size if that is as fast, the smallest otherwise); if not, the full picture comes back for
   * good and the same test is made with leaving out grass, fur and far plants.
   */
  private pace(dt: number): void {
    if (this.paused || this.opts.size || document.hidden) return;
    const s = this.span;
    // pictures still arriving and reflections still being taken make frames late by themselves: wait for calm
    if (this.world.pictures.owed > 0 || (this.reflections?.pending ?? 0) > 0) s.skip = Math.max(s.skip, 45);
    // (a very long frame is the tab coming back from the background, not a slow device)
    if (dt > 0.25) s.skip = Math.max(s.skip, 30);
    if (s.skip > 0) {
      s.skip--;
      s.sum = s.n = 0;
      return;
    }
    s.sum += dt;
    if (++s.n < 50) return;
    const avg = s.sum / s.n;
    s.sum = s.n = 0;
    const t = this.trial;
    if (t) {
      this.trial = null;
      if (t.what === 'small') {
        if (avg < t.before * 0.88) {
          // fewer points do make it faster here: is the middle size as fast?
          this.trial = { what: 'middle', before: avg };
          this.resize(1);
        } else {
          this.sizeSettled = true;
          this.resize(0);
        }
      } else if (t.what === 'middle') {
        this.sizeSettled = true;
        if (avg > t.before * 1.1) this.resize(2);
      } else {
        this.thriftSettled = true;
        if (avg > t.before * 0.9) this.setThrifty(false);
      }
      return;
    }
    if (avg <= SLOW) {
      this.slowSpans = 0;
      return;
    }
    if (++this.slowSpans < 2) return;
    this.slowSpans = 0;
    if (!this.sizeSettled) {
      this.trial = { what: 'small', before: avg };
      this.resize(SIZES.length - 1);
    } else if (!this.thriftSettled) {
      this.trial = { what: 'thrifty', before: avg };
      this.setThrifty(true);
    }
  }

  private reflectLevel = 0;
  private followed: Probe | null = null;
  private readonly ahead = new THREE.Vector3();

  /** Phones: a cat behind the lens is not drawn at all (its fur is thousands of triangles; nothing mirrors it there). */
  private skipCatsBehind(): void {
    const rig = this.rig.rig;
    const f = this.ahead.set(0, 0, -1).applyQuaternion(rig.quaternion);
    const check = (root: THREE.Object3D) => {
      if (!root.visible) return;
      const dx = root.position.x - rig.position.x;
      const dy = root.position.y - rig.position.y;
      const dz = root.position.z - rig.position.z;
      const d = Math.hypot(dx, dy, dz);
      // (the lens sees a little more than a half-sphere; a cat is half a metre long)
      if (d > 1.5 && (dx * f.x + dy * f.y + dz * f.z) / d < -0.3) root.visible = false;
    };
    check(this.session.brother.visual.root);
    for (const r of this.session.rivals) check(r.npc.visual.root);
  }

  /** Keep the reflections near the cat up to date: the nearest car's picture, and the glass wall it is in front of. */
  private updateReflections(): void {
    const refl = this.reflections;
    if (!refl) return;
    // pictures still owed from loading: a few views per frame (each probe needs six); fewer once a run is on
    refl.work(this.opts.manual ? 1e9 : this.session.active ? 2 : 8);
    if (this.reflectLevel < 2) {
      if (this.followed) {
        this.followed = null;
        refl.follow(null);
      }
      refl.setMirror(null);
      this.session.atMirror = false;
      return;
    }
    const eye = this.eye.copy(this.rig.rig.position);
    // the car next to the cat: the cats and everything else that moves are drawn into its picture again
    const near = refl.nearest(eye.x, eye.y, eye.z, 'car', 6);
    const cur = this.followed;
    // (stay with the one we have until another is clearly nearer, so two cars do not take turns)
    const curAway = cur ? refl.distance(cur, eye.x, eye.y, eye.z) : 1e9;
    if (near !== cur && (curAway > 7.5 || (near && refl.distance(near, eye.x, eye.y, eye.z) < curAway - 0.8))) {
      this.followed = near;
      refl.follow(near);
    }
    refl.tick(2);
    // the glass wall the lens is in front of and turned towards: a true mirror image
    let best: GlassWall | null = null;
    let bestAway = 3.6;
    const h = THREE.MathUtils.degToRad(this.freeCam ? this.freeCam.heading : this.player.camHeading);
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    for (const w of this.glassWalls) {
      const away = eye.x * w.nx + eye.z * w.nz - w.offset;
      if (away < 0.06 || away >= bestAway) continue;
      if (fx * w.nx + fz * w.nz > 0.35) continue; // turned away from it
      const t = eye.z * w.nx - eye.x * w.nz;
      if (t < w.t0 - 1.5 - away || t > w.t1 + 1.5 + away || eye.y > w.y1 + 2) continue;
      best = w;
      bestAway = away;
    }
    // (it comes in gently as the cat walks up, so the looked-up reflection does not jump to the true one)
    refl.setMirror(best ? eye : null, best, (3.6 - bestAway) / 0.9);
    // close to glass that reaches down to its own height, and looking at it: the cat can see itself
    this.session.atMirror = !!best && !this.freeCam && bestAway < 1.7 && best.y0 < eye.y + 0.2 && fx * best.nx + fz * best.nz < -0.55;
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
      cat.setLight(this.world.groundLight.sample(p.x, p.z, this.lightSample, p.y));
      cat.setDetail?.(0);
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
    if (!this.thrifty) this.grass?.update(this.rig.rig.position);
    this.renderer.info.reset();
    this.rig.update();
    if (this.opts.lean) this.skipCatsBehind();
    this.updateReflections();
    this.world.cull(this.rig.rig.position.x, this.rig.rig.position.z, this.thrifty ? 16 : this.opts.lean ? 27 : 38);
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
      // (never a longer step than a slow frame: the cat's springs take small steps through whatever they are given)
      if (i % drawEvery === 0) this.render(Math.min(STEP * drawEvery, 0.1));
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
      this.pace(dt);
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
