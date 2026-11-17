import * as THREE from 'three';
import { Audio } from '../engine/audio';
import { Grass } from '../engine/grass';
import { Input, type Controls } from '../engine/input';
import { LensRig } from '../engine/lens';
import { Physics } from '../engine/physics';
import { Post } from '../engine/post';
import { Recorder } from '../engine/recorder';
import { LiveShadows, SHADOW_LAYER } from '../engine/shadows';
import { Sky } from '../engine/sky';
import { loadWorld, type LoadedWorld } from '../engine/world';
import { StandInCat, type CatVisualFactory, type Coat } from './cats';
import { Nav } from './nav';
import { Player } from './player';
import { Props } from './props';
import { Session, type BrotherInfo, type RivalInfo } from './session';
import { QUALITY_SCALE, type Settings } from './settings';

export interface GameOptions {
  set: string;
  /** 0.5 .. 1.5: how finely the scene is drawn */
  quality: number;
  /** fixed picture size in pixels (tests); otherwise the window decides */
  size?: [number, number];
  /** frames are only produced on request (tests) */
  manual: boolean;
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
  session!: Session;
  /** how cats are drawn; swapped for the furry model once that is loaded */
  catFactory!: CatVisualFactory;
  /** when set, the camera ignores the cat and sits here (test pictures, free look) */
  freeCam: { x: number; y: number; z: number; heading: number; pitch: number; roll: number } | null = null;
  time = 0;
  paused = false;
  readonly recorder: Recorder;
  readonly audio = new Audio(`${import.meta.env.BASE_URL}audio/`);
  /** called once per drawn frame, after the world has been updated */
  onFrame: ((dt: number, c: Controls) => void) | null = null;
  private acc = 0;
  private last = 0;
  private running = false;
  private readonly focus = new THREE.Vector3();
  private standIn!: THREE.Group;

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
    if (game.world.info.kinds) {
      game.grass = new Grass(game.world.materials.globals);
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
    game.addStandIn();
    game.catFactory = (coat: Coat, name: string) => new StandInCat(game.world.materials, coat, name);
    game.newSession();
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
    if (Math.abs(q - this.opts.quality) > 1e-3 && !this.opts.size) {
      this.opts.quality = q;
      this.layout();
    }
    this.input.mouseSensitivity = 0.11 * s.sensitivity;
    this.input.touchSensitivity = 0.28 * s.sensitivity;
    this.player.motion = s.motion;
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
    this.newSession();
    this.post.cut();
  }
  /** A rough cat shape that only exists in the shadow pass, until the real cat model is loaded. */
  private addStandIn(): void {
    const mat = new THREE.MeshBasicMaterial();
    const g = new THREE.Group();
    const bodyGeo = new THREE.CapsuleGeometry(0.06, 0.26, 4, 10);
    bodyGeo.rotateX(Math.PI / 2);
    const body = new THREE.Mesh(bodyGeo, mat);
    body.position.set(0, 0.17, 0.12);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), mat);
    head.position.set(0, 0.215, -0.1);
    const earGeo = new THREE.ConeGeometry(0.022, 0.05, 6);
    const earL = new THREE.Mesh(earGeo, mat);
    earL.position.set(-0.032, 0.268, -0.095);
    const earR = new THREE.Mesh(earGeo, mat);
    earR.position.set(0.032, 0.268, -0.095);
    const tailGeo = new THREE.CylinderGeometry(0.012, 0.016, 0.26, 6);
    tailGeo.rotateX(Math.PI / 2.4);
    const tail = new THREE.Mesh(tailGeo, mat);
    tail.position.set(0, 0.2, 0.38);
    g.add(body, head, earL, earR, tail);
    for (const [x, z] of [[-0.04, -0.02], [0.04, -0.02], [-0.045, 0.26], [0.045, 0.26]] as const) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.014, 0.16, 6), mat);
      leg.position.set(x, 0.08, z);
      g.add(leg);
    }
    g.traverse((o) => o.layers.set(SHADOW_LAYER));
    this.standIn = g;
    this.scene.add(g);
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
    }
    const pw = Math.max(2, Math.round(w * dpr));
    const ph = Math.max(2, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.renderer.setSize(pw, ph, false);
    this.post.setSize(pw, ph, this.opts.quality);
  }

  /** One fixed step of the world. */
  update(c: Controls): void {
    this.time += STEP;
    this.player.update(STEP, c);
    this.physics.step();
    this.props.update(STEP);
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
    this.standIn.position.set(p.x, p.y, p.z);
    this.standIn.rotation.y = -THREE.MathUtils.degToRad(p.heading);
    this.grass?.update(this.rig.rig.position);
    this.world.cull(this.rig.rig.position.x, this.rig.rig.position.z);
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

  start(): void {
    if (this.running || this.opts.manual) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.acc += dt;
      const c = this.input.poll();
      const pausePressed = c.pause;
      if (this.paused) this.acc = 0;
      let steps = 0;
      while (this.acc >= STEP && steps < 5) {
        this.update(c);
        // one-shot inputs must not repeat when several steps run in one frame
        c.jump = c.pawLeft = c.pawRight = c.dodge = c.pause = false;
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
