import type { Controls } from '../engine/input';
import type { LensRig } from '../engine/lens';
import { CharacterBody, GRAVITY, type Physics } from '../engine/physics';

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));
const ease = (t: number): number => t * t * (3 - 2 * t);

export const SPEED = { walk: 1.3, trot: 3.3, run: 7.6, back: 0.9, crouch: 1.5, hedge: 1.1 } as const;

/** How the cat jumps and climbs. Heights in metres, times in seconds. */
export const JUMP = {
  /** take-off speed of a pounce, the leap of a cat that is on the move: low (about 0.43 m), long and quick */
  pounce: 4.5,
  /** take-off speed from a standstill, when the button is held: about 0.85 m straight up */
  speed: 6.4,
  /** the most it puts into a leap, and only when it sees something to land on: about 1.6 m (a van roof) */
  most: 8.7,
  /** letting go of the button early drops the upward speed to this: a short hop */
  cutTo: 2.2,
  /** seconds the cat gathers itself before the paws leave the ground */
  squat: 0.05,
  /** a jump still works this long after running off an edge ... */
  coyote: 0.11,
  /** ... and a press this long before landing is remembered */
  buffer: 0.14,
  /** highest thing the cat simply walks up (kerbs, stairs) */
  step: 0.26,
  /** highest thing it hops onto by itself when it keeps pushing against it */
  hop: 0.58,
  /** how far above its paws the front paws can catch an edge in mid-air */
  reach: 0.52,
} as const;

/** Breath, in seconds: how long a full bar lasts sprinting or climbing, and how long it takes to come back. */
export const STAMINA = { sprint: 10, climb: 7, hang: 22, trot: 7, rest: 4.5 } as const;

/** Nearest the lens is allowed to come to a surface in front of it (metres). */
/** where a jumping cat reaches for wood: degrees to either side of straight ahead */
const CLAW_FAN = [0, 25, -25, 48, -48];
/** how far to either side the climbing cat feels for the trunk, in metres */
const CLIMB_FEEL = 0.03;
const LENS_CLEAR = 0.1;
/** the lens never comes nearer than this to any surface (the camera cannot draw anything closer than 2 cm) */
const LENS_MIN = 0.04;

export interface StepEvent {
  /** 0 = front left, 1 = front right, 2 = hind left, 3 = hind right */
  foot: number;
  surface: string;
  /** 0..1, how hard the paw came down */
  force: number;
}

interface Mantle {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  t: number;
  len: number;
  /** nothing to walk on beyond the landing spot (a fence top, the fork of a tree) */
  narrow: boolean;
}

/**
 * The player's cat: how it moves and what that does to the collar camera.
 * The camera hangs under the chin, so every stride shows up in the picture.
 */
export class Player {
  readonly body: CharacterBody;
  heading = 0; // degrees, 0 = north, clockwise
  speed = 0; // metres per second along the heading
  /** stride cycle, 0..1 */
  phase = 0;
  /** 0 = standing tall, 1 = flat on the belly */
  crouch = 0;
  surface = 'asphalt';
  inHedge = false;
  airborne = false;
  /** true while the front paws have an edge and the cat is pulling itself up */
  mantling = false;
  /** seconds since the scramble began, and how long it takes in all */
  mantleT = 0;
  mantleLen = 0;
  /** true while it clings to a tree trunk or a wooden fence */
  climbing = false;
  /** metres per second up the trunk (negative = backing down, 0 = hanging on) */
  climbRate = 0;
  /** climbing cycle 0..1: one front paw reaches up at 0, the other at 0.5 */
  climbPhase = 0;
  /** seconds spent on this climb */
  climbT = 0;
  /** how much of the input is obeyed (0 while a duel or cut-scene has the cat) */
  control = 1;
  /** 0..1: breath. Sprinting, climbing and slapping use it up; it comes back when the cat takes it easy. */
  stamina = 1;
  /** ran itself out of breath: no sprinting until some has come back */
  winded = false;
  /** true while it is actually sprinting (for the picture and the sound) */
  sprinting = false;
  onStep: ((e: StepEvent) => void) | null = null;
  onLand: ((force: number) => void) | null = null;
  onJump: (() => void) | null = null;
  /** the front paws caught an edge (height climbed in metres) */
  onMantle: ((rise: number) => void) | null = null;
  /** ran or jumped into something it could not get onto (0..1 how hard) */
  onBump: ((force: number) => void) | null = null;
  /** dug its claws into something climbable */
  onClimb: (() => void) | null = null;
  /** a front paw took a new hold while climbing */
  onClaw: (() => void) | null = null;
  /** got onto the top of what it was climbing (metres above where the climb began) */
  onClimbed: ((height: number) => void) | null = null;

  /** extra camera motion set from outside (duels): metres pulled back, degrees tilted up, shake strength 0..1 */
  pullBack = 0;
  tiltUp = 0;
  shake = 0;
  /**
   * 0..1: how much of the stride bob and shake reaches the camera (comfort setting). 0.5 is a camera that
   * steadies itself the way current action cameras do; 1 is the raw, rattling collar camera.
   */
  motion = 0.5;
  /** seconds in the air during the current jump (0 on the ground) */
  airTime = 0;

  /** camera pose (what the lens rig is set to) */
  camX = 0;
  camY = 0;
  camZ = 0;
  camHeading = 0;
  camPitch = -6;
  camRoll = 0;

  private lookPitch = 0;
  private lookYaw = 0;
  private yawRate = 0;
  private lean = 0;
  private land = 0; // dip after a landing, decays
  private landVel = 0;
  /** seconds the cat has been standing still */
  idle = 0;
  private lastFoot = -1;
  private safeTimer = 0;
  private readonly safe = { x: 0, y: 0, z: 0 };
  private fallSpeed = 0;
  private time = 0;

  // jumping
  private jumpBuffer = 0;
  private coyote = 0;
  private jumping = false;
  private jumpAge = 0;
  private autoHop = false;
  private pushing = 0; // seconds spent pushing against something low enough to hop onto
  private bumped = false;
  private mantle: Mantle | null = null;
  private headroom = 1;
  // camera smoothing
  private feetShown = 0; // paw height as the camera sees it: follows the real one, but glides over steps
  private feetVel = 0;
  private wasRealJump = false;
  private airPitch = 0;
  private aheadNow = 0.07;
  private climbPitch = 0;

  constructor(private readonly physics: Physics) {
    this.body = new CharacterBody(physics);
  }

  place(x: number, y: number, z: number, heading: number): void {
    const ground = this.physics.groundBelow(x, y + 1.5, z, 6);
    this.body.teleport(x, ground ? ground.y : y, z);
    this.safe.x = x;
    this.safe.y = ground ? ground.y : y;
    this.safe.z = z;
    this.heading = heading;
    this.speed = 0;
    this.lookPitch = 0;
    this.lookYaw = 0;
    this.mantle = null;
    this.mantling = false;
    this.climb = null;
    this.climbing = false;
    this.jumping = false;
    this.jumpBuffer = 0;
    this.airPitch = 0;
    this.perchHold = 0;
    this.brace = null;
    this.face = null;
    this.stamina = 1;
    this.winded = false;
    this.feetShown = this.body.feetY;
    this.updateCamera(0, 0);
  }

  /** Slide to a spot without walking there (lining up for a duel). Keeps the paws on the ground. */
  glide(x: number, z: number): void {
    const ground = this.physics.groundBelow(x, this.body.y + 0.5, z, 2);
    this.body.teleport(x, ground ? ground.y : this.body.feetY, z);
  }

  get x(): number {
    return this.body.x;
  }
  get y(): number {
    return this.body.feetY;
  }
  get z(): number {
    return this.body.z;
  }

  /** stride length in metres at the current speed (longer bounds when faster) */
  private strideLength(v: number): number {
    return 0.34 + 0.165 * v;
  }

  update(dt: number, c: Controls): void {
    this.time += dt;
    const k = this.control;
    const body = this.body;

    // ---- steering
    const turnRate = lerp(185, 120, clamp(Math.abs(this.speed) / SPEED.run, 0, 1));
    const yawDelta = (c.yaw + c.turn * turnRate * dt) * k;
    this.heading = (this.heading + yawDelta + 360) % 360;
    this.yawRate = smooth(this.yawRate, dt > 0 ? yawDelta / dt : 0, 12, dt);
    if (this.face !== null) {
      // turning to face what the paws are on (unless the player is steering: then they have the say)
      const d = ((this.face - this.heading + 540) % 360) - 180;
      if (Math.abs(yawDelta) > 0.25 || Math.abs(d) < 0.8) this.face = null;
      else this.heading = (this.heading + d * (1 - Math.exp(-14 * dt)) + 360) % 360;
    }
    this.lookPitch = clamp(this.lookPitch + c.pitch * k, -28, 38);
    if (Math.abs(this.speed) > 0.5) this.lookPitch = smooth(this.lookPitch, 0, 1.2, dt);

    if (this.mantle) {
      this.updateMantle(dt);
      this.updateCamera(dt, Math.abs(this.speed));
      return;
    }
    if (this.climb) {
      this.updateClimb(dt, c);
      this.updateCamera(dt, 0);
      return;
    }

    // ---- how fast do we want to go
    this.headroom = body.headroom(0.5);
    const clear = body.radius * 2 + this.headroom; // free height from the ground up
    const wantCrouch = clamp((0.27 - clear) / 0.12, 0, 1);
    this.crouch = smooth(this.crouch, wantCrouch, wantCrouch > this.crouch ? 16 : 6, dt);
    this.inHedge = this.physics.insideSoft(body.x, body.y + 0.05, body.z, 0.09);
    let target = 0;
    const canSprint = c.sprint && !this.winded && this.crouch < 0.3 && !this.inHedge;
    if (this.perchHold > 0) {
      // just scrambled up onto something narrow: a moment to let go of the stick before the cat walks on
      this.perchHold = c.move < 0.2 ? 0 : this.perchHold - dt;
    } else if (c.move > 0.05) target = (canSprint ? SPEED.run : SPEED.trot) * c.move;
    else if (c.move < -0.05) target = -SPEED.back * -c.move;
    target *= k;
    // breath: about ten seconds of flat-out sprinting, back in six or seven of trotting (quicker standing still)
    if (k > 0.5) {
      this.sprinting = canSprint && c.move > 0.5 && this.speed > SPEED.trot + 0.4;
      if (this.sprinting) this.stamina -= dt / STAMINA.sprint;
      else this.stamina += dt / (Math.abs(this.speed) < 0.3 ? STAMINA.rest : STAMINA.trot);
      this.stamina = clamp(this.stamina, 0, 1);
      if (this.stamina <= 0) this.winded = true;
      else if (this.winded && this.stamina > 0.35) this.winded = false;
    } else {
      this.sprinting = false;
    }
    if (this.crouch > 0.3) target = clamp(target, -SPEED.back, SPEED.crouch);
    if (this.inHedge) target = clamp(target, -SPEED.back, SPEED.hedge);
    // less say over the speed in mid-air, and a leap keeps its pace while the stick stays forward
    const slowing = Math.abs(target) < Math.abs(this.speed);
    const accel = (slowing ? 16 : 10) * (body.grounded ? 1 : slowing && c.move > 0.3 ? 0.12 : 0.45);
    const dv = target - this.speed;
    this.speed += clamp(dv, -accel * dt, accel * dt);

    const h = this.heading * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);

    // ---- jumping: a press shortly before landing is remembered, and one just after running off an edge still counts
    this.jumpBuffer = c.jump ? JUMP.buffer : Math.max(0, this.jumpBuffer - dt);
    this.coyote = body.grounded ? JUMP.coyote : Math.max(0, this.coyote - dt);
    if (this.squat > 0) {
      // gathered: off it goes (unless the ground has gone from under it meanwhile)
      this.squat -= dt;
      if (this.squat <= 0) {
        this.squat = 0;
        if (this.coyote > 0 && k > 0.5 && this.headroom > 0.2) this.leap(fx, fz, c.move);
      }
    } else if (this.jumpBuffer > 0 && this.coyote > 0 && k > 0.5 && this.headroom > 0.2) {
      // the cat gathers itself for an instant first: the lens dips as the body sinks onto the hind legs
      this.squat = JUMP.squat;
      this.jumpBuffer = 0;
      this.landVel -= 0.8;
    }
    if (this.jumping) {
      this.jumpAge += dt;
      // letting go early makes it a short hop
      if (!this.autoHop && !c.jumpHeld && this.jumpAge > 0.05) body.cutJump(JUMP.cutTo);
      if (body.vy <= 0 || body.grounded) this.jumping = false;
    }

    // ---- move through the world
    const wasGrounded = body.grounded;
    if (!wasGrounded) this.fallSpeed = Math.min(this.fallSpeed, body.vy);
    const want = this.speed * dt;
    const dir = want >= 0 ? 1 : -1;
    if (wasGrounded && Math.abs(this.speed) > 0.2 && this.crouch < 0.8) this.stepUp(fx * dir, fz * dir, Math.abs(want));
    // Bumped into a trunk or a fence with the front of the body: brace against it, paws on the wood,
    // instead of sliding off to one side (a trunk is thin, and a leaning one never stops the cat dead).
    // Keep pushing and it climbs (below).
    const canClimb = k > 0.5 && c.move > 0.1 && want > 0 && this.crouch < 0.3 && !this.winded && this.stamina >= 0.1;
    let go = want;
    if (this.brace) {
      if (!wasGrounded || !canClimb || !this.woodAt(this.brace.x, this.brace.z, fx, fz)) {
        this.brace = null;
      } else {
        go = 0;
        this.face = ((Math.atan2(this.brace.x, -this.brace.z) / DEG) + 360) % 360;
      }
    }
    const moved = body.move(fx * go, fz * go, dt);
    if (!this.brace && canClimb && body.grounded && body.blocked > 0.12 && this.woodAt(body.blockX, body.blockZ, fx, fz)) {
      this.brace = { x: body.blockX, z: body.blockZ };
    }
    const braced = this.brace !== null;
    const stopped = braced || (Math.abs(want) > 1e-5 && moved < Math.abs(want) * 0.35);
    if (stopped && body.grounded) {
      // ran into something: lose speed instead of grinding against it
      this.speed = smooth(this.speed, 0, 9, dt);
    }

    // ---- things in the way
    if (k > 0.5 && this.speed > 0.3 && c.move > 0.1) {
      if (!body.grounded) {
        // in the air: catch an edge that is within reach of the front paws, otherwise bounce off
        if (body.vy < 4.5 && this.tryMantle(fx, fz)) {
          this.updateCamera(dt, Math.abs(this.speed));
          return;
        }
        // nothing to stand on, but there is wood within reach of the claws: dig them in
        if (body.vy < 3.5 && this.clawWood(fx, fz)) {
          this.updateCamera(dt, 0);
          return;
        }
        if (stopped && !this.bumped && this.speed > 2) {
          this.bumped = true;
          const force = clamp(this.speed / SPEED.run, 0.25, 1);
          this.shake = Math.max(this.shake, 0.2 + 0.3 * force);
          this.onBump?.(force);
          this.speed *= 0.25;
        }
      } else if (stopped && this.crouch < 0.3) {
        // on the ground, pushing against something low: hop onto it
        this.pushing += dt;
        if (this.pushing > (c.sprint ? 0.05 : 0.16)) {
          const rise = this.ledgeAhead(fx, fz, JUMP.hop);
          if (rise > JUMP.step) {
            this.takeOff(Math.sqrt(2 * GRAVITY.rise * (rise + 0.12)), true);
            this.speed = Math.max(this.speed, 2.2);
            this.pushing = 0;
          } else if (this.pushing > (braced ? 0.22 : 0.3)) {
            // kept pushing against something too high to hop onto: if it is wood, up it goes
            if (this.brace ? this.tryClimb(this.brace.x, this.brace.z) : this.tryClimb(fx, fz)) {
              this.updateCamera(dt, 0);
              return;
            }
            this.pushing = 0;
          }
        }
      } else {
        this.pushing = 0;
      }
    } else {
      this.pushing = 0;
    }

    this.airborne = !body.grounded;
    this.airTime = this.airborne ? this.airTime + dt : 0;
    if (body.grounded && !wasGrounded) {
      if (this.fallSpeed > -3.4) {
        // no more than stepping off a kerb: a soft paw-fall, not a landing
        this.landVel -= 0.1;
      } else {
        const force = clamp(-this.fallSpeed / 9, 0.12, 1);
        this.landVel -= force * 1.7;
        if (force > 0.55) this.shake = Math.max(this.shake, (force - 0.55) * 0.9);
        this.onLand?.(force);
      }
      this.fallSpeed = 0;
      this.bumped = false;
    }
    if (body.grounded) {
      const ground = this.physics.groundBelow(body.x, body.y, body.z, 0.4);
      if (ground) this.surface = ground.surface;
      // remember solid ground now and then, in case the cat ever falls out of the world
      this.safeTimer += dt;
      if (this.safeTimer > 0.5) {
        this.safeTimer = 0;
        this.safe.x = body.x;
        this.safe.y = body.feetY;
        this.safe.z = body.z;
      }
    }
    if (body.feetY < this.safe.y - 25) {
      body.teleport(this.safe.x, this.safe.y + 0.05, this.safe.z);
      this.speed = 0;
      this.feetShown = body.feetY;
    }

    // ---- stride cycle and footfalls
    const v = Math.abs(this.speed);
    if (v > 0.15 && body.grounded) {
      this.phase = (this.phase + (v / this.strideLength(v)) * dt) % 1;
      this.idle = 0;
      const galloping = v > 4.2;
      // footfall order: walk/trot = four separate beats, gallop = front pair then hind pair
      const beats = galloping ? [0.02, 0.1, 0.52, 0.6] : [0.0, 0.5, 0.25, 0.75];
      const feet = galloping ? [0, 1, 2, 3] : [0, 1, 3, 2];
      let foot = -1;
      for (let i = 0; i < 4; i++) {
        const d = (this.phase - beats[i] + 1) % 1;
        if (d < 0.12) foot = feet[i];
      }
      if (foot !== -1 && foot !== this.lastFoot) {
        this.onStep?.({ foot, surface: this.inHedge ? 'hedge' : this.surface, force: clamp(v / SPEED.run, 0.15, 1) });
      }
      this.lastFoot = foot;
    } else {
      this.idle += dt;
      this.lastFoot = -1;
    }

    // ---- landing spring
    this.landVel += (-this.land * 180 - this.landVel * 16) * dt;
    this.land += this.landVel * dt;

    this.updateCamera(dt, v);
  }

  /**
   * The jump the player asked for. A cat on the move pounces: low, long and fast. From a standstill it jumps
   * up. And when there is something ahead that it could land on, it puts in exactly what that takes.
   */
  private leap(fx: number, fz: number, move: number): void {
    const pace = clamp(Math.abs(this.speed) / SPEED.trot, 0, 1);
    let up = lerp(JUMP.speed, JUMP.pounce, pace);
    if (move > 0.3) {
      // the push of the hind legs goes forwards too
      this.speed = Math.min(SPEED.run + 0.6, Math.max(this.speed + 1.4 * pace, lerp(2.4, 4.6, pace)));
    }
    let sure = false;
    if (move > 0.1 && this.speed > 0) {
      const rise = this.perchAhead(fx, fz, clamp(this.speed * 0.45 + 0.2, 0.7, 3.2));
      if (rise > 0) {
        const need = Math.sqrt(2 * GRAVITY.rise * Math.max(0.05, rise - JUMP.reach + 0.14)) * 1.03;
        if (need <= JUMP.most && need > up) {
          up = need;
          sure = true;
        }
      }
    }
    this.takeOff(up, sure);
  }

  /**
   * How high above the paws is the top of the first thing in the way, within `dist` metres, if the cat could
   * stand on it? 0 when the way is clear, or when what is there is no place to land (a house wall, a lamp post).
   */
  private perchAhead(fx: number, fz: number, dist: number): number {
    const body = this.body;
    const feet = body.feetY;
    let near = dist;
    let found = false;
    let wood = false;
    // (along the middle and along both shoulders: a tree trunk is thinner than the cat)
    for (const side of [0, -0.07, 0.07]) {
      const ox = body.x - fz * side;
      const oz = body.z + fx * side;
      for (const h of [0.32, 0.62, 0.95, 1.3]) {
        const hit = this.physics.rayHit(ox, feet + h, oz, fx, 0, fz, near);
        if (hit && Math.abs(hit.ny) < 0.6) {
          near = hit.toi;
          found = true;
          wood = hit.surface === 'wood';
        }
      }
    }
    // wood is for the claws: the cat leaps at it and climbs
    if (!found || wood) return 0;
    // the top just behind that face; if that is a slope (a windscreen, the side of a car), a little further in
    const from = feet + 1.85;
    for (const more of [0.1, 0.32, 0.56, 0.82, 1.1]) {
      const px = body.x + fx * (near + more);
      const pz = body.z + fz * (near + more);
      if (this.physics.insideSolid(px, from, pz)) return 0; // taller than any cat jumps
      const top = this.physics.groundBelow(px, from, pz, 1.85 - JUMP.step);
      if (!top) return 0;
      if (top.ny < 0.7) continue;
      const y = top.y + body.radius + 0.03;
      if (!this.physics.freeAt(px, y, pz, body.radius) || this.physics.insideSolid(px, top.y + 0.03, pz)) continue;
      return top.y - feet;
    }
    return 0;
  }

  private takeOff(speed: number, auto: boolean): void {
    this.body.jump(speed);
    this.jumping = true;
    this.jumpAge = 0;
    this.autoHop = auto;
    this.jumpBuffer = 0;
    this.coyote = 0;
    this.squat = 0;
    this.pushing = 0;
    this.bumped = false;
    this.fallSpeed = 0;
    // the push-off: the lens dips for an instant before it rises (a requested jump has dipped already)
    if (auto) this.landVel -= 0.55;
    this.onJump?.();
  }

  /**
   * Walk up kerbs and stairs. Looks at the ground just ahead (and, when the cat is sliding along something,
   * at the ground on that side too); if it is a little higher and there is room to stand, the cat is lifted
   * onto it. Unlike a rule that reacts to bumping into the step, this works at any angle and never snags.
   */
  private stepUp(dx: number, dz: number, travel: number): void {
    const body = this.body;
    const r = body.radius;
    const reach = r + 0.02 + travel;
    if (this.stepAt(body.x + dx * reach, body.z + dz * reach, dx, dz, reach)) return;
    if (body.blocked > 0.06) {
      const side = r + 0.035;
      this.stepAt(body.x + body.blockX * side, body.z + body.blockZ * side, body.blockX, body.blockZ, side);
    }
  }

  private stepAt(px: number, pz: number, dx: number, dz: number, dist: number): boolean {
    const rise = this.stepHeight(px, pz, dx, dz, dist);
    if (rise < 0.025) return false;
    this.body.lift(rise + 0.015);
    return true;
  }

  /**
   * How much higher is the ground at (px, pz) than under the paws, if the cat could simply step up there?
   * 0 when it is not higher, too high, or not somewhere it could stand (inside a wall, under a car body).
   * (dx, dz) is the direction from the cat to the spot, `dist` how far away it is.
   */
  private stepHeight(px: number, pz: number, dx: number, dz: number, dist: number): number {
    const body = this.body;
    const feet = body.feetY;
    const ground = this.physics.groundBelow(px, feet + JUMP.step + 0.06, pz, JUMP.step + 0.1);
    if (!ground || ground.ny < 0.7) return 0;
    const rise = ground.y - feet;
    if (rise < 0.01 || rise > JUMP.step) return 0;
    const y = ground.y + body.radius + 0.02;
    // there must be room to stand on it, and nothing between here and there at that height (a wall is not a step)
    if (!this.physics.freeAt(px, y, pz, body.radius * 0.9) || this.physics.insideSolid(px, ground.y + 0.03, pz)) return 0;
    if (this.physics.rayHit(body.x, y, body.z, dx, 0, dz, dist)) return 0;
    return rise;
  }

  /** Height (above the paws) of a ledge right ahead that the cat could stand on, up to `max`; 0 when there is none. */
  private ledgeAhead(fx: number, fz: number, max: number): number {
    const body = this.body;
    const r = body.radius;
    const wall = this.physics.rayHit(body.x, body.y, body.z, fx, 0, fz, r + 0.22);
    if (!wall || Math.abs(wall.ny) > 0.6) return 0;
    const reach = wall.toi + 0.09;
    const px = body.x + fx * reach;
    const pz = body.z + fz * reach;
    const top = this.physics.groundBelow(px, body.feetY + max + 0.08, pz, max + 0.1);
    if (!top || top.ny < 0.7) return 0;
    const rise = top.y - body.feetY;
    if (rise < 0.04 || rise > max) return 0;
    const y = top.y + r + 0.03;
    if (!this.physics.freeAt(px, y, pz, r) || this.physics.insideSolid(px, top.y + 0.03, pz)) return 0; // room on top
    if (!this.physics.freeAt(body.x, y, body.z, r * 0.9)) return 0; // room to rise
    if (this.physics.rayHit(body.x, y, body.z, fx, 0, fz, reach)) return 0; // and nothing in between up there
    this.ledgeX = px;
    this.ledgeZ = pz;
    this.ledgeY = top.y;
    return rise;
  }

  private ledgeX = 0;
  private ledgeY = 0;
  private ledgeZ = 0;
  /** seconds left before a requested jump leaves the ground (0 = none pending) */
  private squat = 0;
  /** seconds left of the pause after scrambling up onto something narrow (see updateMantle) */
  private perchHold = 0;
  /** direction (unit, on the ground plane) of the wood the cat is braced against, if any */
  private brace: { x: number; z: number } | null = null;
  /** heading the cat is turning to on its own (to face what it has grabbed), if any */
  private face: number | null = null;
  private climb: { nx: number; nz: number; fromY: number } | null = null;

  /** In mid-air against something: if its top is within reach of the front paws, grab it and scramble up. */
  private tryMantle(fx: number, fz: number): boolean {
    const body = this.body;
    const rise = this.ledgeAhead(fx, fz, JUMP.reach);
    if (rise <= 0) return false;
    this.mantle = {
      x0: body.x,
      y0: body.y,
      z0: body.z,
      x1: this.ledgeX + fx * 0.04,
      y1: this.ledgeY + body.radius + 0.012,
      z1: this.ledgeZ + fz * 0.04,
      t: 0,
      len: 0.15 + rise * 0.42,
      // a narrow perch (the top of a fence, the fork of a tree): nothing to walk on beyond it
      narrow: this.narrowAt(this.ledgeX, this.ledgeY, this.ledgeZ, fx, fz),
    };
    this.mantling = true;
    this.mantleT = 0;
    this.mantleLen = this.mantle.len;
    this.jumping = false;
    this.onMantle?.(rise);
    return true;
  }

  /**
   * Is the thing right against the body in direction (bx, bz) wood, and is the cat (heading fx, fz) facing
   * it? A trunk or a post counts anywhere in the front half of the view, since the cat can simply turn to
   * it; a flat fence only when the cat is heading into it rather than along it.
   */
  private woodAt(bx: number, bz: number, fx: number, fz: number, reach = 0.09): boolean {
    const facing = bx * fx + bz * fz;
    if (facing < 0.64) return false;
    const body = this.body;
    const r = body.radius;
    const wall = this.physics.rayHit(body.x, body.y, body.z, bx, 0, bz, r + reach);
    if (!wall || wall.surface !== 'wood' || Math.abs(wall.ny) > 0.6) return false;
    if (facing >= 0.86) return true;
    // off to one side: is it thin? (feel for wood a hand's width to either side of it)
    const sx = -bz * 0.19;
    const sz = bx * 0.19;
    const a = this.physics.rayHit(body.x + sx, body.y, body.z + sz, bx, 0, bz, r + 0.25);
    const b = this.physics.rayHit(body.x - sx, body.y, body.z - sz, bx, 0, bz, r + 0.25);
    return !(a && a.surface === 'wood') || !(b && b.surface === 'wood');
  }

  /**
   * In mid-air: reach for wood with the front paws, straight ahead first, then a little to either side
   * (a trunk leans, so at jumping height it is often not where it stands on the ground).
   */
  private clawWood(fx: number, fz: number): boolean {
    for (const turn of CLAW_FAN) {
      const c = Math.cos(turn * DEG);
      const s = Math.sin(turn * DEG);
      const dx = fx * c - fz * s;
      const dz = fx * s + fz * c;
      if (this.woodAt(dx, dz, fx, fz, 0.16) && this.tryClimb(dx, dz)) return true;
    }
    return false;
  }

  /** Cling to the wood (a tree trunk, a fence) that is within reach in direction (dx, dz). */
  private tryClimb(dx: number, dz: number): boolean {
    if (this.winded || this.stamina < 0.1) return false;
    const body = this.body;
    const wall = this.physics.rayHit(body.x, body.y, body.z, dx, 0, dz, body.radius + 0.16);
    if (!wall || wall.surface !== 'wood' || Math.abs(wall.ny) > 0.6) return false;
    const len = Math.hypot(wall.nx, wall.nz);
    if (len < 0.5) return false;
    this.climb = { nx: wall.nx / len, nz: wall.nz / len, fromY: body.feetY };
    this.brace = null;
    this.climbing = true;
    this.climbRate = 0;
    this.climbT = 0;
    this.jumping = false;
    this.speed = 0;
    // turn to face the wood
    this.face = ((Math.atan2(-this.climb.nx, this.climb.nz) / DEG) + 360) % 360;
    this.onClimb?.();
    return true;
  }

  private letGo(): void {
    this.climb = null;
    this.climbing = false;
    this.climbRate = 0;
  }

  /** On a trunk or a fence: forward climbs, back climbs down, nothing hangs on, jump kicks off backwards. */
  private updateClimb(dt: number, c: Controls): void {
    const cl = this.climb!;
    const body = this.body;
    const r = body.radius;
    const fx = -cl.nx;
    const fz = -cl.nz;
    this.climbT += dt;
    this.airborne = true;
    this.airTime = 0;

    if (c.jump) {
      // kick off: leap the way the cat is looking if that is away from the wood, otherwise straight back
      const h = this.heading * DEG;
      const away = Math.sin(h) * cl.nx - Math.cos(h) * cl.nz;
      if (away < 0.35) this.heading = ((Math.atan2(cl.nx, -cl.nz) / DEG) + 360) % 360;
      this.face = null;
      this.letGo();
      this.speed = 3.6;
      this.takeOff(4.6, true);
      return;
    }
    let rate = 0;
    if (this.stamina <= 0) rate = -1.4; // out of breath: claws slip
    else if (c.move > 0.3) rate = 1.5;
    else if (c.move < -0.3) rate = -1.2;
    this.stamina = clamp(this.stamina - dt / (rate > 0 ? STAMINA.climb : STAMINA.hang), 0, 1);
    if (this.stamina <= 0) this.winded = true;
    this.climbRate = rate;

    // going up: is there a top within reach of the front paws? Then over it goes.
    if (rate > 0 && this.tryMantle(fx, fz)) {
      const height = this.ledgeY - cl.fromY;
      this.letGo();
      this.onClimbed?.(height);
      return;
    }
    const y = body.y + rate * dt;
    // going down: back on the ground?
    if (rate < 0) {
      const ground = this.physics.groundBelow(body.x, body.y, body.z, r + 0.06 - rate * dt);
      if (ground) {
        body.teleport(body.x, ground.y, body.z);
        body.grounded = true;
        this.letGo();
        this.airborne = false;
        return;
      }
    }
    // stay on the trunk: find its surface at the new height and sit just off it
    const ox = body.x + cl.nx * 0.06;
    const oz = body.z + cl.nz * 0.06;
    const reach = r + 0.4;
    const wall = this.physics.rayHit(ox, y, oz, fx, 0, fz, reach);
    if (!wall || wall.surface !== 'wood') {
      // ran out of trunk with nothing to stand on: drop
      this.letGo();
      return;
    }
    const d = wall.toi - 0.06 - (r + 0.02); // how far too far from the surface the ball is
    // A trunk rarely stands straight. Feel for it with a paw on either side: where the wood is nearer,
    // that is the way the trunk leans, and the cat shuffles over to stay on it.
    const sx = -fz;
    const sz = fx;
    const a = this.physics.rayHit(ox + sx * CLIMB_FEEL, y, oz + sz * CLIMB_FEEL, fx, 0, fz, reach);
    const b = this.physics.rayHit(ox - sx * CLIMB_FEEL, y, oz - sz * CLIMB_FEEL, fx, 0, fz, reach);
    const ta = a && a.surface === 'wood' ? a.toi : reach;
    const tb = b && b.surface === 'wood' ? b.toi : reach;
    const side = clamp((tb - ta) * 0.8, -0.025, 0.025);
    body.setPosition(body.x + fx * d + sx * side, y, body.z + fz * d + sz * side);
    const before = this.climbPhase;
    this.climbPhase = (this.climbPhase + (Math.abs(rate) * dt) / 0.5) % 1;
    if (rate !== 0 && (Math.floor(before * 2) !== Math.floor(this.climbPhase * 2))) this.onClaw?.();
  }

  private updateMantle(dt: number): void {
    const m = this.mantle!;
    const body = this.body;
    m.t += dt;
    this.mantleT = m.t;
    const u = clamp(m.t / m.len, 0, 1);
    // paws pull the body all the way up first, and only then does it tip forward over the edge
    // (going forward any sooner would drag the lens through the corner of whatever is being climbed)
    const up = 1 - (1 - clamp(u / 0.6, 0, 1)) ** 2;
    const fwd = ease(clamp((u - 0.58) / 0.42, 0, 1));
    body.setPosition(lerp(m.x0, m.x1, fwd), lerp(m.y0, m.y1, up), lerp(m.z0, m.z1, fwd));
    this.airborne = true;
    this.airTime += dt;
    if (u >= 1) {
      body.teleport(m.x1, m.y1 - body.radius - 0.01, m.z1);
      body.grounded = true;
      this.mantle = null;
      this.mantling = false;
      this.airborne = false;
      this.airTime = 0;
      this.fallSpeed = 0;
      this.bumped = false;
      this.speed = clamp(this.speed, 1.2, SPEED.trot);
      this.landVel -= 0.5;
      if (m.narrow) {
        // up on something narrow: stop for a moment, or the cat would walk straight off the far side
        // before the player has seen where it is
        this.speed = 0;
        this.perchHold = 0.7;
      }
    }
  }

  /** Is the ledge at (x, y, z) too narrow to walk on in direction (fx, fz)? */
  private narrowAt(x: number, y: number, z: number, fx: number, fz: number): boolean {
    for (const d of [0.22, 0.42, 0.62]) {
      const g = this.physics.groundBelow(x + fx * d, y + 0.2, z + fz * d, 0.2 + JUMP.step);
      if (!g || g.ny < 0.7) return true;
    }
    return false;
  }

  private updateCamera(dt: number, v: number): void {
    const body = this.body;
    const run = clamp((v - 1) / (SPEED.run - 1), 0, 1);
    const moving = clamp(v / 1.2, 0, 1);
    const galloping = clamp((v - 3.6) / 1.2, 0, 1);
    const a = this.phase * Math.PI * 2;
    const grounded = body.grounded && !this.mantle && !this.climb;

    // Paw height as the lens sees it. On the ground it glides after the real height, so a kerb or a stair is a
    // quick smooth rise instead of a jump of the whole picture; in the air it follows exactly.
    // The collar is at the front of the cat, so it starts to rise when the front paws reach a step, before
    // the rest of the body gets there (and dips when they step down): look at the ground a little ahead.
    // It must be above a step by the time it gets there, so it starts rising a stride early: take the
    // highest ground within reach ahead (never the lowest: going down, it follows the body).
    let feet = body.feetY;
    if (grounded && this.speed > 0.2) {
      const hh = this.heading * DEG;
      const reach = 0.2 + v * 0.06;
      const sx = Math.sin(hh);
      const sz = -Math.cos(hh);
      for (const part of [0.5, 1]) {
        const d = reach * part;
        feet = Math.max(feet, body.feetY + this.stepHeight(body.x + sx * d, body.z + sz * d, sx, sz, d));
      }
    }
    if (dt <= 0) {
      this.feetShown = body.feetY;
      this.feetVel = 0;
    } else {
      // a spring with no overshoot: soft on the ground (and for the instant it takes to drop off a kerb),
      // stiff in a real jump so the lens goes where the cat goes
      const realJump = !grounded && (body.vy > 0.5 || this.airTime > 0.12 || !!this.mantle || !!this.climb);
      // coming down from a real fall the lens lands with the cat (no gliding down afterwards: that would
      // leave it hanging above the body for a moment, next to whatever the cat fell past)
      if (this.wasRealJump && grounded) {
        this.feetShown = body.feetY;
        this.feetVel = 0;
      }
      this.wasRealJump = realJump;
      const w = realJump ? 60 : 24;
      const x = this.feetShown - feet;
      const e = Math.exp(-w * dt);
      const k = this.feetVel + w * x;
      this.feetVel = (this.feetVel - k * w * dt) * e;
      this.feetShown = clamp(feet + (x + k * dt) * e, body.feetY - 0.22, body.feetY + 0.22);
    }

    // height of the collar above the paws: head up when standing, neck stretched low at speed, belly down when ducking
    let height = lerp(0.118, 0.106, run) - 0.004 * moving;
    height = lerp(height, 0.062, this.crouch);
    // the up-and-down of the stride: two small bobs per stride when walking, one big bound when galloping
    const bobWalk = Math.sin(a * 2) * lerp(0.004, 0.009, moving);
    const bound = (0.5 - 0.5 * Math.cos(a)) ** 1.6;
    const bobGallop = (bound - 0.45) * 0.034;
    // (rock = the quick rocking with every stride, sway = the slow things: leaning into a turn, the dip of a landing)
    const rock = 0.12 + 0.88 * this.motion ** 1.5;
    const sway = 0.4 + 0.6 * this.motion;
    if (grounded) height += lerp(bobWalk, bobGallop, galloping) * moving * (1 - this.crouch * 0.7) * (0.35 + 0.65 * this.motion);
    height += Math.sin(this.time * 1.9) * 0.0016; // breathing
    height += this.land * 0.07;
    if (this.airborne) height += 0.012;

    // the lens tips down as the front paws land and comes up in the push-off
    const stride = grounded ? moving : 0;
    const pitchStride = lerp(Math.sin(a * 2 + 0.6) * 0.9, Math.sin(a + 1.9) * 4.2, galloping) * stride;
    const rollStride = Math.sin(a) * lerp(2.3, 1.2, galloping) * stride;
    const yawStride = Math.sin(a + 1.1) * 1.1 * stride;
    this.lean = dt > 0 ? smooth(this.lean, clamp(-this.yawRate * v * 0.012, -11, 11), 7, dt) : this.lean;
    // standing still: the head drifts about as the cat looks around
    const looking = clamp((this.idle - 1.5) / 2, 0, 1);
    this.lookYaw = Math.sin(this.time * 0.43) * 14 * looking + Math.sin(this.time * 1.07 + 2) * 5 * looking;
    const idlePitch = (3 + Math.sin(this.time * 0.31) * 3) * looking;

    // in a jump the cat looks where it is going: up on the way up, down at the landing spot on the way down
    const wantAir = this.airborne && !this.mantle ? clamp(body.vy * 1.45, -15, 8) : 0;
    this.airPitch = dt > 0 ? smooth(this.airPitch, wantAir, this.airborne ? 11 : 16, dt) : wantAir;
    // scrambling up: nose to the edge, then up and over
    let wantClimb = 0;
    let climbRoll = 0;
    if (this.mantle) {
      const u = clamp(this.mantle.t / this.mantle.len, 0, 1);
      wantClimb = lerp(-16, 6, ease(u));
      climbRoll = Math.sin(u * Math.PI * 3) * 3.5 * (1 - u);
    }
    if (this.climb) {
      // up a trunk: looking where the paws go, with a heave on every reach
      const reach = Math.sin(this.climbPhase * Math.PI * 4) * (this.climbRate !== 0 ? 1 : 0);
      wantClimb = (this.climbRate > 0 ? 34 : this.climbRate < 0 ? -22 : 14) + reach * 3.5;
      climbRoll = Math.sin(this.climbPhase * Math.PI * 2) * 4 * (this.climbRate !== 0 ? 1 : 0.2);
    }
    this.climbPitch = dt > 0 ? smooth(this.climbPitch, wantClimb, this.climb ? 7 : 22, dt) : wantClimb;

    const basePitch = lerp(-3, -9, run) - 7 * this.crouch;
    this.camPitch = basePitch + this.lookPitch + pitchStride * rock + idlePitch + this.land * 22 * sway + this.airPitch + this.climbPitch;
    this.camRoll = rollStride * rock + (this.lean + climbRoll) * sway;
    this.camHeading = this.heading + yawStride * rock + this.lookYaw;

    // knocks and scuffles: a short jolt that dies away (mostly a tilt: that is the easiest on the eyes)
    if (this.shake > 0.001) {
      const s = this.shake * (0.25 + 0.75 * this.motion);
      this.camPitch += Math.sin(this.time * 61.3) * 2.0 * s;
      this.camRoll += Math.sin(this.time * 53.7 + 1.3) * 2.8 * s;
      this.camHeading += Math.sin(this.time * 47.1 + 2.1) * 1.4 * s;
      this.shake = dt > 0 ? this.shake * Math.exp(-dt * 9) : this.shake;
    }
    this.camPitch += this.tiltUp;

    const h = this.heading * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const camH = Math.max(0.045, height);
    this.camY = this.feetShown + camH;

    // The collar sits a hand's width ahead of the shoulders. It must never come closer to a surface than the
    // lens can focus through, or the picture would show the inside of a wall or a car: look ahead along three
    // lines and hold the lens back when something is near. Backing off is instant, coming forward is gentle.
    let ahead = 0.07 + Math.sin(a) * 0.012 * galloping * (grounded ? 1 : 0) - this.pullBack;
    const reach = Math.max(ahead, 0) + LENS_CLEAR;
    // (at the true height of the lens: on steps it trails below the body for a moment, and must then
    // wait in front of the riser instead of being pushed up through it)
    // If the lens is above the cat's own body for a moment (gliding down after a step), the place above the
    // body must be in the open too; otherwise it comes down to the body at once.
    const topOfBody = body.feetY + body.radius * 2 - 0.02;
    if (this.camY > topOfBody && this.physics.insideSolid(body.x, this.camY, body.z)) this.camY = topOfBody;
    const y = this.camY;
    let nearest = reach;
    for (let i = -1; i <= 1; i++) {
      const ox = body.x - fz * i * 0.045;
      const oz = body.z + fx * i * 0.045;
      nearest = Math.min(nearest, this.physics.rayDistance(ox, y, oz, fx, 0, fz, reach));
    }
    if (nearest < reach) ahead = Math.min(ahead, nearest - LENS_CLEAR);
    ahead = Math.max(ahead, -0.04);
    this.aheadNow = dt > 0 && ahead > this.aheadNow ? smooth(this.aheadNow, ahead, 14, dt) : ahead;
    this.camX = body.x + fx * this.aheadNow;
    this.camZ = body.z + fz * this.aheadNow;
    // and never closer to whatever is right under the lens than it can focus through
    const below = this.physics.rayHit(this.camX, this.camY + 0.06, this.camZ, 0, -1, 0, 0.11, true);
    if (below && below.toi < 0.105 && !this.physics.insideSolid(this.camX, this.camY + 0.06, this.camZ)) this.camY += 0.105 - below.toi;
    // Last resort: if all that still left the lens inside something solid, bring it home to the middle of the
    // cat's own body, which is always in the open.
    if (this.physics.insideSolid(this.camX, this.camY, this.camZ)) {
      this.aheadNow = 0;
      this.camX = body.x;
      this.camZ = body.z;
      this.camY = clamp(this.camY, body.feetY + 0.03, body.feetY + body.radius * 2 - 0.03);
    }
    // And in whatever direction: nothing may be nearer to the glass than the lens can see past (the corner
    // of a ledge during a scramble, a post brushed in passing), or the picture would look through it.
    for (let i = 0; i < 2; i++) {
      const near = this.physics.nearestSurface(this.camX, this.camY, this.camZ);
      if (!near || near.dist >= LENS_MIN || near.dist < 1e-4) break;
      const push = (LENS_MIN - near.dist) / near.dist;
      this.camX += (this.camX - near.x) * push;
      this.camY += (this.camY - near.y) * push;
      this.camZ += (this.camZ - near.z) * push;
    }
  }

  apply(rig: LensRig): void {
    rig.setPose(this.camX, this.camY, this.camZ, this.camHeading, this.camPitch, this.camRoll);
  }
}
