import type { Controls } from '../engine/input';
import type { LensRig } from '../engine/lens';
import { CharacterBody, type Physics } from '../engine/physics';

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

export const SPEED = { walk: 1.3, trot: 3.3, run: 7.6, back: 0.9, crouch: 1.5, hedge: 1.1 } as const;

export interface StepEvent {
  /** 0 = front left, 1 = front right, 2 = hind left, 3 = hind right */
  foot: number;
  surface: string;
  /** 0..1, how hard the paw came down */
  force: number;
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
  /** how much of the input is obeyed (0 while a duel or cut-scene has the cat) */
  control = 1;
  onStep: ((e: StepEvent) => void) | null = null;
  onLand: ((force: number) => void) | null = null;
  onJump: (() => void) | null = null;

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
  private idle = 0;
  private lastFoot = -1;
  private fallSpeed = 0;
  private time = 0;

  constructor(private readonly physics: Physics) {
    this.body = new CharacterBody(physics);
  }

  place(x: number, y: number, z: number, heading: number): void {
    const ground = this.physics.groundBelow(x, y + 1.5, z, 6);
    this.body.teleport(x, ground ? ground.y : y, z);
    this.heading = heading;
    this.speed = 0;
    this.lookPitch = 0;
    this.lookYaw = 0;
    this.updateCamera(0, 0);
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
    this.lookPitch = clamp(this.lookPitch + c.pitch * k, -28, 38);
    if (Math.abs(this.speed) > 0.5) this.lookPitch = smooth(this.lookPitch, 0, 1.2, dt);

    // ---- how fast do we want to go
    const headroom = body.headroom(0.5);
    const clear = body.radius * 2 + headroom; // free height from the ground up
    const wantCrouch = clamp((0.27 - clear) / 0.12, 0, 1);
    this.crouch = smooth(this.crouch, wantCrouch, wantCrouch > this.crouch ? 16 : 6, dt);
    this.inHedge = this.physics.insideSoft(body.x, body.y + 0.05, body.z, 0.09);
    let target = 0;
    if (c.move > 0.05) target = (c.sprint ? SPEED.run : SPEED.trot) * c.move;
    else if (c.move < -0.05) target = -SPEED.back * -c.move;
    target *= k;
    if (this.crouch > 0.3) target = clamp(target, -SPEED.back, SPEED.crouch);
    if (this.inHedge) target = clamp(target, -SPEED.back, SPEED.hedge);
    const accel = Math.abs(target) > Math.abs(this.speed) ? 10 : 16;
    const dv = target - this.speed;
    this.speed += clamp(dv, -accel * dt, accel * dt);

    // ---- move through the world
    if (c.jump && k > 0.5 && body.grounded && this.crouch < 0.3) {
      body.jump(4.4 + Math.min(Math.abs(this.speed), SPEED.run) * 0.12);
      this.onJump?.();
    }
    const h = this.heading * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const wasGrounded = body.grounded;
    if (!wasGrounded) this.fallSpeed = Math.min(this.fallSpeed, body.vy);
    const want = this.speed * dt;
    const moved = body.move(fx * want, fz * want, dt);
    if (Math.abs(want) > 1e-5 && moved < Math.abs(want) * 0.35) {
      // ran into something: lose speed instead of grinding against it
      this.speed = smooth(this.speed, 0, 9, dt);
    }
    this.airborne = !body.grounded;
    if (body.grounded && !wasGrounded) {
      const force = clamp(-this.fallSpeed / 6, 0.15, 1);
      this.landVel -= force * 1.6;
      this.onLand?.(force);
      this.fallSpeed = 0;
    }
    if (body.grounded) {
      const ground = this.physics.groundBelow(body.x, body.y, body.z, 0.4);
      if (ground) this.surface = ground.surface;
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

  private updateCamera(dt: number, v: number): void {
    const body = this.body;
    const run = clamp((v - 1) / (SPEED.run - 1), 0, 1);
    const moving = clamp(v / 1.2, 0, 1);
    const galloping = clamp((v - 3.6) / 1.2, 0, 1);
    const a = this.phase * Math.PI * 2;

    // height of the collar above the paws: head up when standing, neck stretched low at speed, belly down when ducking
    let height = lerp(0.175, 0.118, run) - 0.012 * moving;
    height = lerp(height, 0.062, this.crouch);
    // the up-and-down of the stride: two small bobs per stride when walking, one big bound when galloping
    const bobWalk = Math.sin(a * 2) * lerp(0.004, 0.009, moving);
    const bound = (0.5 - 0.5 * Math.cos(a)) ** 1.6;
    const bobGallop = (bound - 0.45) * 0.034;
    height += lerp(bobWalk, bobGallop, galloping) * moving * (1 - this.crouch * 0.7);
    height += Math.sin(this.time * 1.9) * 0.0016; // breathing
    height += this.land * 0.07;
    if (this.airborne) height += 0.012;

    // the lens tips down as the front paws land and comes up in the push-off
    const pitchStride = lerp(Math.sin(a * 2 + 0.6) * 0.9, Math.sin(a + 1.9) * 5.2, galloping) * moving;
    const rollStride = Math.sin(a) * lerp(2.3, 1.2, galloping) * moving;
    const yawStride = Math.sin(a + 1.1) * 1.1 * moving;
    this.lean = dt > 0 ? smooth(this.lean, clamp(-this.yawRate * v * 0.012, -11, 11), 7, dt) : this.lean;
    // standing still: the head drifts about as the cat looks around
    const looking = clamp((this.idle - 1.5) / 2, 0, 1);
    this.lookYaw = Math.sin(this.time * 0.43) * 14 * looking + Math.sin(this.time * 1.07 + 2) * 5 * looking;
    const idlePitch = (3 + Math.sin(this.time * 0.31) * 3) * looking;

    const basePitch = lerp(-3, -9, run) - 7 * this.crouch;
    this.camPitch = basePitch + this.lookPitch + pitchStride + idlePitch + this.land * 26 + (this.airborne ? body.vy * 1.3 : 0);
    this.camRoll = rollStride + this.lean;
    this.camHeading = this.heading + yawStride + this.lookYaw;

    const h = this.heading * DEG;
    // the collar sits a hand's width ahead of the shoulders
    const ahead = 0.07 + Math.sin(a) * 0.012 * galloping;
    this.camX = body.x + Math.sin(h) * ahead;
    this.camZ = body.z - Math.cos(h) * ahead;
    this.camY = body.feetY + Math.max(0.045, height);
  }

  apply(rig: LensRig): void {
    rig.setPose(this.camX, this.camY, this.camZ, this.camHeading, this.camPitch, this.camRoll);
  }
}
