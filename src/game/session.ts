import * as THREE from 'three';
import type { Controls } from '../engine/input';
import type { Physics } from '../engine/physics';
import type { GroundLight } from '../engine/world';
import { Npc, restLook, type CatLook, type CatVisualFactory, type Coat } from './cats';
import { Duel, LEVELS, PLAYER_NERVE, type DuelEvent } from './duel';
import type { Nav } from './nav';
import { SPEED, type Player } from './player';
import type { Props } from './props';
import { Score } from './score';

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export type Phase = 'title' | 'intro' | 'play' | 'duel' | 'ending' | 'ended';

export interface RivalInfo {
  name: string;
  coat: Coat;
  pos: [number, number];
  facing: number;
  level: number;
  radius: number;
  turf: string;
}

export interface BrotherInfo {
  name: string;
  coat: Coat;
  pos: [number, number];
  facing: number;
}

/** A sound the game wants played (the audio system drains this list). */
export interface Sfx {
  name: string;
  /** where it happens; omitted = at the player */
  x?: number;
  z?: number;
  gain?: number;
  /** extra flavour: surface name for steps, kind of thing for knocks */
  detail?: string;
}

interface Rival {
  info: RivalInfo;
  npc: Npc;
  state: 'idle' | 'alert' | 'duel' | 'fled' | 'gone' | 'gloat';
  timer: number;
  beaten: boolean;
}

export const RUN_SECONDS = 180;

/** One run: from "the cat wakes up on the deck" to "the camera battery dies". */
export class Session {
  phase: Phase = 'title';
  /** seconds of battery left */
  battery = RUN_SECONDS;
  elapsed = 0;
  readonly score: Score;
  duel: Duel | null = null;
  duelRival: Rival | null = null;
  readonly brother: Npc;
  readonly rivals: Rival[] = [];
  readonly sfx: Sfx[] = [];
  /** the player's own cat, as the drawing code needs it (paws seen from the collar camera) */
  readonly playerLook: CatLook = restLook();
  /** short text for the middle of the screen (duel prompts, "follow Rocket") and how long it still shows */
  hint = '';
  hintFor = 0;
  /** screen flash strength 0..1 (taking a hit) */
  flash = 0;

  private brotherState: 'wait' | 'run' | 'tagged' = 'wait';
  private brotherTimer = 0;
  private chased = 0;
  private tired = 0;
  private tagCool = 0;
  private tags = 0;
  private chaseTick = 0;
  private meowIn = 3;
  private sprintFor = 0;
  private hedgeFor = 0;
  private hedgeCool = 0;
  private lowFor = 0;
  private lowCool = 0;
  private wasAir = 0;
  private duelEnd = 0;
  private retreat = 0;
  private endTimer = 0;
  private glide: { x: number; z: number; heading: number; t: number } | null = null;
  private swipeAnim: [number, number] = [0, 0];
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private warned = false;
  private meowCool = 0;
  private meowScore = 0;
  private answerIn = 0;

  constructor(
    private readonly player: Player,
    physics: Physics,
    private readonly nav: Nav,
    private readonly props: Props,
    light: GroundLight,
    makeCat: CatVisualFactory,
    scene: THREE.Scene,
    brother: BrotherInfo,
    rivals: RivalInfo[],
    private readonly rand: () => number = Math.random,
  ) {
    this.score = new Score(rand);
    const bv = makeCat(brother.coat, brother.name);
    scene.add(bv.root);
    this.brother = new Npc(brother.name, brother.coat, bv, physics, light);
    this.brother.place(brother.pos[0], brother.pos[1], brother.facing);
    this.brother.look.stance = 'sit';
    for (const info of rivals) {
      const v = makeCat(info.coat, info.name);
      scene.add(v.root);
      const npc = new Npc(info.name, info.coat, v, physics, light);
      npc.place(info.pos[0], info.pos[1], info.facing);
      npc.look.stance = 'sit';
      this.rivals.push({ info, npc, state: 'idle', timer: 0, beaten: false });
    }
    props.onKnock = (e) => {
      if (this.phase !== 'play' && this.phase !== 'duel') return;
      this.score.add('knock', e.prop.kind);
      const p = e.prop.group.position;
      this.sfx.push({ name: 'knock', x: p.x, z: p.z, detail: e.prop.kind, gain: clamp(e.speed / 3, 0.4, 1) });
    };
    player.onStep = (e) => this.sfx.push({ name: 'step', detail: e.surface, gain: e.force });
    player.onLand = (f) => this.sfx.push({ name: 'land', detail: player.surface, gain: f });
    player.onJump = () => this.sfx.push({ name: 'jump' });
  }

  /** Begin a run (from the title screen or after "run it back"). */
  start(): void {
    this.phase = 'intro';
    this.battery = RUN_SECONDS;
    this.elapsed = 0;
    this.say(`Follow ${this.brother.name}`, 4);
    this.sfx.push({ name: 'meow', x: this.brother.x, z: this.brother.z });
    this.brotherTimer = 1.6;
  }

  private say(text: string, seconds: number): void {
    this.hint = text;
    this.hintFor = seconds;
  }

  get active(): boolean {
    return this.phase === 'intro' || this.phase === 'play' || this.phase === 'duel';
  }

  // ---------------------------------------------------------------- the brother

  private brotherRoute(length = 85): void {
    const from = this.nav.nearest(this.brother.x, this.brother.z);
    const route = this.nav.wander(from, length * (0.8 + this.rand() * 0.5), this.rand, [this.player.x, this.player.z]);
    this.brother.setPath(route);
    this.brotherState = 'run';
    this.chased = 0;
  }

  private updateBrother(dt: number): void {
    const b = this.brother;
    const p = this.player;
    const d = b.distanceTo(p.x, p.z);
    this.tagCool = Math.max(0, this.tagCool - dt);
    if (this.brotherState === 'wait') {
      b.look.stance = 'sit';
      b.speed = 0;
      b.face(p.x, p.z, dt, 4);
      this.brotherTimer -= dt;
      this.meowIn -= dt;
      if (d > 9 && this.meowIn <= 0) {
        this.meowIn = 4 + this.rand() * 4;
        this.sfx.push({ name: 'meow', x: b.x, z: b.z });
      }
      if (d < 3.4 || (this.phase === 'intro' && this.brotherTimer <= 0)) {
        if (this.phase === 'intro') {
          // first dash: out of the garden and onto the road, then look back
          const from = this.nav.nearest(b.x, b.z);
          const gate = this.nav.info.home - 3;
          b.setPath(this.nav.path(from, Math.max(0, gate)));
          this.brotherState = 'run';
          this.phase = 'play';
        } else {
          this.brotherRoute();
        }
        b.look.stance = 'move';
        this.sfx.push({ name: 'chirp', x: b.x, z: b.z });
      }
    } else if (this.brotherState === 'run') {
      this.tired = Math.max(0, this.tired - dt);
      if (d < 5.5) this.chased += dt;
      else this.chased = Math.max(0, this.chased - dt * 0.5);
      if (this.chased > 5.5 && this.tired <= 0) {
        this.tired = 2.8;       // glances back and loses a stride: the moment to catch him
        this.chased = 0;
      }
      const boost = 1 + this.tags * 0.04;
      let speed = 6.9 * boost;
      if (d < 5.5) speed = 8.5 * boost;
      if (this.tired > 0) speed = 6.3;
      if (d > 15) speed = 4.2;
      if (d > 24) speed = 0;
      b.look.headTurn = this.tired > 0 ? 0.8 : 0;
      const going = b.follow(this.nav, speed, dt);
      if (!going || (d > 24 && b.speed < 0.3)) {
        this.brotherState = 'wait';
        this.brotherTimer = 99;
        this.meowIn = 1.5;
      }
      // views for a proper chase
      if (d < 7.5 && Math.abs(p.speed) > 2.5) {
        this.chaseTick += dt;
        if (this.chaseTick >= 1) {
          this.chaseTick = 0;
          this.score.add('chase');
          if (this.rand() < 0.12) this.score.say('chase');
        }
      }
      if (d < 0.95 && this.tagCool <= 0 && Math.abs(p.speed) > 1.5) {
        this.tags++;
        this.tagCool = 4;
        this.score.add('tag');
        this.brotherState = 'tagged';
        this.brotherTimer = 0.9;
        b.look.flinch = 1;
        this.player.shake = 0.5;
        this.sfx.push({ name: 'tag' });
        this.say(`Tagged ${b.name}!`, 2);
      }
    } else {
      b.speed += (0 - b.speed) * (1 - Math.exp(-10 * dt));
      b.look.flinch = Math.max(0, b.look.flinch - dt * 1.5);
      this.brotherTimer -= dt;
      if (this.brotherTimer <= 0) {
        b.look.flinch = 0;
        this.brotherRoute(110);
        this.sfx.push({ name: 'chirp', x: b.x, z: b.z });
      }
    }
    b.sync(dt, p.camX, p.camZ);
  }

  // ---------------------------------------------------------------- rivals and duels

  private beginDuel(r: Rival): void {
    this.phase = 'duel';
    this.duelRival = r;
    r.state = 'duel';
    this.duel = new Duel(LEVELS[r.info.level] ?? LEVELS[1], this.rand);
    this.player.control = 0;
    this.player.speed = 0;
    // stand nose to nose: a little in front of the rival, facing it
    const h = Math.atan2(this.player.x - r.npc.x, -(this.player.z - r.npc.z));
    const gx = r.npc.x + Math.sin(h) * 0.62;
    const gz = r.npc.z - Math.cos(h) * 0.62;
    this.glide = { x: gx, z: gz, heading: (h / DEG + 180 + 360) % 360, t: 0 };
    r.npc.look.stance = 'fight';
    r.npc.look.puff = 1;
    this.score.say('duelStart');
    this.say(`${r.info.name} guards ${r.info.turf}`, 2.2);
    this.sfx.push({ name: 'hiss', x: r.npc.x, z: r.npc.z });
  }

  private onDuelEvent(e: DuelEvent, r: Rival): void {
    const look = r.npc.look;
    switch (e.type) {
      case 'slap':
        this.swipeAnim[e.side < 0 ? 0 : 1] = 1;
        this.sfx.push({ name: 'swipe' });
        break;
      case 'windup':
        this.sfx.push({ name: 'growl', x: r.npc.x, z: r.npc.z, gain: 0.7 });
        break;
      case 'rivalHit':
        this.score.add(e.counter ? 'counter' : 'slap');
        look.flinch = 1;
        this.player.shake = Math.max(this.player.shake, 0.35);
        this.sfx.push({ name: 'bap', gain: e.clean ? 1 : 0.8 });
        break;
      case 'blocked':
        this.sfx.push({ name: 'block' });
        this.player.shake = Math.max(this.player.shake, 0.15);
        break;
      case 'whiff':
        break;
      case 'dodge':
        this.sfx.push({ name: 'swipe', gain: 0.5 });
        break;
      case 'dodged':
        this.score.add('dodge');
        this.sfx.push({ name: 'swipe', x: r.npc.x, z: r.npc.z });
        break;
      case 'playerHit':
        this.player.shake = 1;
        this.flash = 1;
        this.score.say('playerHit');
        this.sfx.push({ name: 'bap', gain: 1 });
        this.sfx.push({ name: 'yowl', gain: 0.8 });
        break;
      case 'won':
        this.score.add('turf', undefined, r.info.level);
        if (e.flawless) this.score.add('flawless');
        r.beaten = true;
        this.duelEnd = 1.1;
        this.say(`${r.info.turf[0].toUpperCase()}${r.info.turf.slice(1)}: yours now`, 3);
        this.sfx.push({ name: 'yowl', x: r.npc.x, z: r.npc.z });
        this.sfx.push({ name: 'win' });
        break;
      case 'lost':
        this.score.add('lostDuel');
        this.duelEnd = 0.9;
        this.say('Ow. Back off for now', 2.5);
        this.sfx.push({ name: 'lose' });
        break;
      default:
        break;
    }
  }

  private updateDuel(dt: number, c: Controls): void {
    const duel = this.duel!;
    const r = this.duelRival!;
    const p = this.player;
    if (this.glide) {
      const g = this.glide;
      g.t = Math.min(1, g.t + dt / 0.35);
      const k = 1 - Math.exp(-14 * dt);
      p.glide(p.x + (g.x - p.x) * k, p.z + (g.z - p.z) * k);
      let dh = ((g.heading - p.heading + 540) % 360) - 180;
      dh *= k;
      p.heading = (p.heading + dh + 360) % 360;
      if (g.t >= 1) this.glide = null;
    }
    r.npc.face(p.x, p.z, dt, 10);
    duel.update(dt, { slapLeft: c.pawLeft, slapRight: c.pawRight, dodge: c.dodge || c.move < -0.6 || c.jump });
    for (const e of duel.drain()) this.onDuelEvent(e, r);

    // how the rival looks in each state
    const look = r.npc.look;
    const lerp = (a: number, b: number, k: number) => a + (b - a) * (1 - Math.exp(-k * dt));
    let raise = 0;
    if (duel.rivalState === 'windup' || duel.rivalState === 'feint') raise = 0.65;
    if (duel.rivalState === 'strike') raise = 1;
    // the rival's left paw is on the right of the player's picture
    look.pawLeft = lerp(look.pawLeft, duel.rivalSide < 0 ? raise : 0, raise > look.pawLeft ? 16 : 9);
    look.pawRight = lerp(look.pawRight, duel.rivalSide > 0 ? raise : 0, raise > look.pawRight ? 16 : 9);
    look.flinch = Math.max(0, look.flinch - dt * 2.4);
    look.puff = lerp(look.puff, duel.over === 'won' ? 0 : 1, 3);

    // how the fight moves the camera
    const dodging = duel.playerState === 'dodge' ? Math.sin(Math.min(1, duel.playerT / 0.6) * Math.PI) : 0;
    const flinching = duel.playerState === 'flinch' ? 1 - duel.playerT / 0.4 : 0;
    p.pullBack = lerp(p.pullBack, dodging * 0.24 + flinching * 0.1, 22);
    p.tiltUp = lerp(p.tiltUp, 9, 6);

    if (duel.over) {
      this.duelEnd -= dt;
      if (duel.over === 'won' && r.state === 'duel') {
        // the loser bolts
        r.state = 'fled';
        const from = this.nav.nearest(r.npc.x, r.npc.z);
        r.npc.setPath(this.nav.wander(from, 45, this.rand, [p.x, p.z]));
        look.stance = 'move';
      }
      if (this.duelEnd <= 0) this.endDuel(duel.over === 'won');
    }
  }

  private endDuel(won: boolean): void {
    const r = this.duelRival!;
    this.duel = null;
    this.duelRival = null;
    this.phase = 'play';
    this.player.control = 1;
    if (!won) {
      r.state = 'gloat';
      r.timer = 7;
      r.npc.look.stance = 'sit';
      r.npc.look.pawLeft = r.npc.look.pawRight = 0;
      this.retreat = 0.9;
      this.battery = Math.max(3, this.battery - 6);
    }
  }

  private updateRivals(dt: number): void {
    const p = this.player;
    for (const r of this.rivals) {
      const d = r.npc.distanceTo(p.x, p.z);
      r.timer = Math.max(0, r.timer - dt);
      const look = r.npc.look;
      switch (r.state) {
        case 'idle':
          look.stance = 'sit';
          look.puff = Math.max(0, look.puff - dt);
          look.headTurn = Math.sin(this.elapsed * 0.4 + r.info.level) * 0.5;
          if (d < 5) {
            r.state = 'alert';
            this.sfx.push({ name: 'growl', x: r.npc.x, z: r.npc.z });
          }
          break;
        case 'alert':
          look.stance = 'stand';
          look.headTurn = 0;
          look.puff = Math.min(1, look.puff + dt * 2);
          r.npc.face(p.x, p.z, dt, 5);
          if (d > 6.5) r.state = 'idle';
          else if (d < 2.3 && this.phase === 'play' && p.body.grounded) this.beginDuel(r);
          break;
        case 'gloat':
          look.puff = Math.max(0, look.puff - dt);
          r.npc.face(p.x, p.z, dt, 3);
          if (r.timer <= 0) r.state = 'idle';
          break;
        case 'fled':
          look.puff = Math.max(0, look.puff - dt * 2);
          if (!r.npc.follow(this.nav, 8.2, dt)) {
            r.state = 'gone';
            look.stance = 'sit';
          }
          break;
        default:
          break;
      }
      if (r.state !== 'duel') {
        look.pawLeft = Math.max(0, look.pawLeft - dt * 4);
        look.pawRight = Math.max(0, look.pawRight - dt * 4);
        look.flinch = Math.max(0, look.flinch - dt * 2);
      }
      r.npc.sync(dt, p.camX, p.camZ);
    }
  }

  // ---------------------------------------------------------------- mischief

  private updateMischief(dt: number, c: Controls): void {
    const p = this.player;
    // a paw swipe outside a fight sends loose things flying
    if (this.phase === 'play' && (c.pawLeft || c.pawRight)) {
      const side = c.pawLeft ? -1 : 1;
      this.swipeAnim[side < 0 ? 0 : 1] = 1;
      const h = p.heading * DEG;
      const dir = this.tmpA.set(Math.sin(h) + Math.cos(h) * 0.35 * -side, 0, -Math.cos(h) + Math.sin(h) * 0.35 * -side).normalize();
      const origin = this.tmpB.set(p.x + Math.sin(h) * 0.16, p.y + 0.08, p.z - Math.cos(h) * 0.16);
      const hits = this.props.swipe(origin, dir, 0.4, 1 + Math.abs(p.speed) * 0.1);
      this.sfx.push({ name: hits ? 'bap' : 'swipe', gain: hits ? 0.7 : 0.6 });
    }
    // flat-out sprint
    if (Math.abs(p.speed) > SPEED.run * 0.88) this.sprintFor += dt;
    else this.sprintFor = 0;
    if (this.sprintFor > 4.5) {
      this.sprintFor = -6;
      this.score.add('zoomies');
    }
    // through a hedge
    this.hedgeCool = Math.max(0, this.hedgeCool - dt);
    if (p.inHedge) {
      if (this.hedgeFor === 0) this.sfx.push({ name: 'rustle' });
      this.hedgeFor += dt;
    } else {
      if (this.hedgeFor > 0.35 && this.hedgeCool <= 0) {
        this.score.add('hedge');
        this.hedgeCool = 6;
      }
      this.hedgeFor = 0;
    }
    // squeezing under something low
    this.lowCool = Math.max(0, this.lowCool - dt);
    if (p.crouch > 0.6 && Math.abs(p.speed) > 0.4) this.lowFor += dt;
    else {
      if (this.lowFor > 0.7 && this.lowCool <= 0) {
        this.score.add('undercar');
        this.lowCool = 8;
      }
      this.lowFor = 0;
    }
    // a leap
    if (p.airborne) this.wasAir = Math.max(this.wasAir, p.airTime);
    else {
      if (this.wasAir > 0.55) this.score.add('jump');
      this.wasAir = 0;
    }
  }

  // ---------------------------------------------------------------- per step

  update(dt: number, c: Controls): void {
    this.hintFor = Math.max(0, this.hintFor - dt);
    this.flash = Math.max(0, this.flash - dt * 3.5);
    for (let i = 0; i < 2; i++) this.swipeAnim[i] = Math.max(0, this.swipeAnim[i] - dt * 4.5);
    const pl = this.playerLook;
    pl.pawLeft = Math.sin(Math.min(1, this.swipeAnim[0]) * Math.PI);
    pl.pawRight = Math.sin(Math.min(1, this.swipeAnim[1]) * Math.PI);
    pl.speed = Math.abs(this.player.speed);
    pl.phase = this.player.phase;
    pl.stance = this.phase === 'duel' ? 'fight' : this.player.crouch > 0.5 ? 'crouch' : pl.speed > 0.15 ? 'move' : 'stand';

    if (!this.active) {
      if (this.phase === 'ending') {
        this.endTimer -= dt;
        if (this.endTimer <= 0) this.phase = 'ended';
      }
      // on the title screen the other cats still sit about and look alive
      this.brother.sync(dt, this.player.camX, this.player.camZ);
      for (const r of this.rivals) r.npc.sync(dt, this.player.camX, this.player.camZ);
      return;
    }

    this.elapsed += dt;
    this.score.update(dt);
    // a meow on demand; the brother answers when he is close enough to hear it
    this.meowCool = Math.max(0, this.meowCool - dt);
    this.meowScore = Math.max(0, this.meowScore - dt);
    if (c.meow && this.meowCool <= 0 && this.phase === 'play') {
      const p = this.player;
      this.meowCool = 1.1;
      this.sfx.push({ name: 'meow', x: p.x, z: p.z });
      if (this.meowScore <= 0) {
        this.score.add('meow');
        this.meowScore = 15;
      }
      if (Math.hypot(this.brother.x - p.x, this.brother.z - p.z) < 14) this.answerIn = 0.6;
    }
    if (this.answerIn > 0) {
      this.answerIn -= dt;
      if (this.answerIn <= 0) this.sfx.push({ name: 'chirp', x: this.brother.x, z: this.brother.z });
    }
    if (this.phase === 'duel') {
      this.battery -= dt * 0.5;
      this.updateDuel(dt, c);
    } else {
      if (this.phase === 'play') this.battery -= dt;
      const p = this.player;
      p.pullBack += (0 - p.pullBack) * (1 - Math.exp(-10 * dt));
      p.tiltUp += (0 - p.tiltUp) * (1 - Math.exp(-5 * dt));
      if (this.retreat > 0) {
        // lost a fight: scramble backwards for a moment
        this.retreat -= dt;
        p.speed = -2.6;
        p.control = this.retreat > 0 ? 0 : 1;
      }
      this.updateMischief(dt, c);
    }
    this.updateBrother(dt);
    this.updateRivals(dt);

    if (this.battery < 20 && !this.warned) {
      this.warned = true;
      this.say('Battery low', 2.5);
      this.score.say('battery');
      this.sfx.push({ name: 'beep' });
    }
    if (this.battery <= 0 && this.phase === 'play') {
      this.battery = 0;
      this.phase = 'ending';
      this.endTimer = 1.8;
      this.player.control = 0;
      this.sfx.push({ name: 'shutdown' });
    }
  }

  get playerNerve(): number {
    return this.duel ? this.duel.playerNerve / PLAYER_NERVE : 1;
  }

  get rivalNerve(): number {
    return this.duel ? Math.max(0, this.duel.rivalNerve) / this.duel.rivalNerveMax : 1;
  }
}
