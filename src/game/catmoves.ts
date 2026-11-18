/**
 * How a cat moves: turns what a cat is doing (a CatLook) into a pose, every frame, with no animation clips.
 *
 * Plain numbers only (no three.js), so the timing can be tested; furcat.ts puts the pose on the bones.
 *
 * The pose is a flat list of channels (see `CH`, `FRONT`, `HIND`, `TAIL`). Each frame the choreography
 * below writes a target value for every channel; the targets are then followed by springs, a stiff one for
 * a striking paw and soft, slightly bouncy ones for the tail and ears, so that the spine leads, the paws
 * follow and the tail lags behind without every move having to spell that out.
 *
 * Units and directions, in the cat's own space: metres, radians; x = the cat's right, y = up,
 * f = forwards (the way the cat faces). Side -1 = the cat's own left, +1 = its own right.
 * Joint angles are the raw turns about each bone's own axes:
 *   X (bend): + swings the far end of the bone forwards / up (counter-clockwise seen from the cat's right),
 *   Y (twist): + rolls the bone's top towards the cat's right,
 *   Z (side): + swings the far end towards the cat's left.
 */
import type { CatAct, CatLook } from './cats';

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** 0..1 progress of `t` between `a` and `b` */
const seg = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
/** ease in and out */
const sm = (t: number): number => t * t * (3 - 2 * t);
/** fast start, soft stop */
const out3 = (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t);
/** slow start, hard stop */
const in2 = (t: number): number => t * t;
/** up from 0 to 1 between a and b, back down to 0 between c and d (smoothly) */
const bump = (t: number, a: number, b: number, c: number, d: number): number => sm(seg(t, a, b)) * (1 - sm(seg(t, c, d)));

/**
 * Which way "positive" bends each joint, as built by pipeline/blender/assets/cat.py: multiply a
 * "flex / forwards / up" amount by this to get the raw X turn.
 */
export const JOINT_SIGN = {
  // bones that point forwards (spine, neck, head): + tips the front end up
  spine: 1, neck: 1, head: 1,
  // bones that point backwards / down-back: + would tip them down, so lift = -1
  tail: -1, jaw: -1,
  // leg bones point down: + swings the far end forwards. Flexing a joint means:
  scapula: 1, upperarm: 1, forearm: 1, wrist: -1, paw: -1,
  thigh: 1, shin: -1, hock: 1, hindpaw: -1, ear: 1,
} as const;

/** Rest positions of the joints the choreography aims for (cat space: x right, y up, f forwards; metres). */
export const REST = {
  shoulder: { x: 0.031, y: 0.178, f: 0.118 },
  /** front wrist joint with the paw flat on the ground */
  wrist: { x: 0.031, y: 0.036, f: 0.071 },
  hip: { x: 0.035, y: 0.2, f: -0.128 },
  /** hind ankle (hock) joint, standing */
  hock: { x: 0.035, y: 0.066, f: -0.153 },
  neck: { y: 0.197, f: 0.118 },
  /** the point on the ground under the hips the whole body tips about */
  pivotF: -0.13,
  /** how far the arm reaches from the shoulder to the wrist joint, fully stretched */
  armReach: 0.0778 + 0.0885,
};

// ---------------------------------------------------------------- channels

/** smoothing groups: every channel belongs to one, and each group has its own spring per frame */
export const GROUP = { body: 0, spine: 1, head: 2, face: 3, tail: 4, frontL: 5, frontR: 6, hindL: 7, hindR: 8 } as const;
const NGROUPS = 9;
const groupOf: number[] = [];
const names: string[] = [];
const ch = (name: string, group: number): number => {
  names.push(name);
  groupOf.push(group);
  return names.length - 1;
};

/** body and head channels */
export const CH = {
  // the whole body, moved and turned about the ground point under the hips
  bodyX: ch('bodyX', GROUP.body),
  bodyY: ch('bodyY', GROUP.body),
  bodyF: ch('bodyF', GROUP.body),
  /** + = front end up */
  bodyPitch: ch('bodyPitch', GROUP.body),
  /** + = front end to the cat's left */
  bodyYaw: ch('bodyYaw', GROUP.body),
  /** + = back rolls towards the cat's right */
  bodyRoll: ch('bodyRoll', GROUP.body),
  hipsB: ch('hipsB', GROUP.spine), hipsT: ch('hipsT', GROUP.spine), hipsS: ch('hipsS', GROUP.spine),
  sp1B: ch('sp1B', GROUP.spine), sp1T: ch('sp1T', GROUP.spine), sp1S: ch('sp1S', GROUP.spine),
  sp2B: ch('sp2B', GROUP.spine), sp2T: ch('sp2T', GROUP.spine), sp2S: ch('sp2S', GROUP.spine),
  chestB: ch('chestB', GROUP.spine), chestT: ch('chestT', GROUP.spine), chestS: ch('chestS', GROUP.spine),
  neckB: ch('neckB', GROUP.head), neckT: ch('neckT', GROUP.head), neckS: ch('neckS', GROUP.head),
  /** the head's own bend / twist / side turn, used where `gaze` is 0 */
  headB: ch('headB', GROUP.head), headT: ch('headT', GROUP.head), headS: ch('headS', GROUP.head),
  /** where the head points in the cat's own space (used where `gaze` is 1): pitch + = nose up, yaw + = to the cat's left, roll + = top to the right */
  headP: ch('headP', GROUP.head), headY: ch('headY', GROUP.head), headR: ch('headR', GROUP.head),
  gaze: ch('gaze', GROUP.head),
  jaw: ch('jaw', GROUP.face),
  /** ears: back (+ folds the tip back), out (+ swings it out sideways), turn (+ turns the opening outwards) */
  earLBack: ch('earLBack', GROUP.face), earLOut: ch('earLOut', GROUP.face), earLTurn: ch('earLTurn', GROUP.face),
  earRBack: ch('earRBack', GROUP.face), earROut: ch('earROut', GROUP.face), earRTurn: ch('earRTurn', GROUP.face),
};

/** tail: lift (raw X, so + = down) and side (+ = to the cat's left) for tail1..tail5 */
export const TAIL = {
  lift: [1, 2, 3, 4, 5].map((i) => ch(`tail${i}L`, GROUP.tail)),
  side: [1, 2, 3, 4, 5].map((i) => ch(`tail${i}S`, GROUP.tail)),
};

const frontLeg = (side: 'L' | 'R', group: number) => ({
  /** shoulder blade: swing (raw X) and out (raw Z) */
  scap: ch(`f${side}scap`, group),
  scapOut: ch(`f${side}scapOut`, group),
  /** joint angles used while running (raw X; upperOut raw Z) */
  upper: ch(`f${side}upper`, group),
  upperOut: ch(`f${side}upperOut`, group),
  fore: ch(`f${side}fore`, group),
  wrist: ch(`f${side}wrist`, group),
  paw: ch(`f${side}paw`, group),
  /** 0 = joint angles above, 1 = reach for the target below */
  ik: ch(`f${side}ik`, group),
  /** where the wrist joint should be, cat space */
  x: ch(`f${side}x`, group),
  y: ch(`f${side}y`, group),
  f: ch(`f${side}f`, group),
  /** which way the elbow points (cat space direction) */
  px: ch(`f${side}px`, group),
  py: ch(`f${side}py`, group),
  pf: ch(`f${side}pf`, group),
  /** 1 = the paw stays flat on the ground whatever the leg does; 0 = `wrist` bends it */
  plant: ch(`f${side}plant`, group),
});
const hindLeg = (side: 'L' | 'R', group: number) => ({
  thigh: ch(`h${side}thigh`, group),
  thighOut: ch(`h${side}thighOut`, group),
  shin: ch(`h${side}shin`, group),
  hock: ch(`h${side}hock`, group),
  paw: ch(`h${side}paw`, group),
  ik: ch(`h${side}ik`, group),
  /** where the hock (ankle) joint should be, cat space */
  x: ch(`h${side}x`, group),
  y: ch(`h${side}y`, group),
  f: ch(`h${side}f`, group),
  /** sideways lean of the knee (+ = outwards) */
  knee: ch(`h${side}knee`, group),
  /** 1 = the foot keeps its own angle to the ground (`hockAbs`); 0 = `hock` bends it */
  plant: ch(`h${side}plant`, group),
  /** angle of the long foot bone against the ground, + = tipped forwards (1.33 = flat on the ground) */
  hockAbs: ch(`h${side}hockAbs`, group),
});
export type FrontLeg = ReturnType<typeof frontLeg>;
export type HindLeg = ReturnType<typeof hindLeg>;
/** [left, right] */
export const FRONT: [FrontLeg, FrontLeg] = [frontLeg('L', GROUP.frontL), frontLeg('R', GROUP.frontR)];
export const HIND: [HindLeg, HindLeg] = [hindLeg('L', GROUP.hindL), hindLeg('R', GROUP.hindR)];
export const CHANNELS = names.length;
const GROUP_OF = Int8Array.from(groupOf);

/** channels whose spring is softer than the rest of their group (leg weights, so FK / IK hand over gently) */
const SOFT = new Float32Array(CHANNELS).fill(1);
for (const l of FRONT) SOFT[l.ik] = 0.55;
for (const l of HIND) SOFT[l.ik] = 0.55;
SOFT[CH.gaze] = 0.5;

/** a tiny repeatable random source per cat */
class Rand {
  constructor(private s: number) {}
  next(): number {
    this.s = (this.s * 16807) % 2147483647;
    return this.s / 2147483647;
  }
}

const FIGHT_ACTS: ReadonlySet<CatAct> = new Set<CatAct>(['guard', 'windup', 'feint', 'strike', 'recover', 'stagger', 'flee', 'gloat']);

/**
 * One cat's movement brain: keeps the springs and the little timers (ear flicks, tail twitches,
 * the landing after a jump) and writes the pose for each frame into `pose`.
 */
export class CatMoves {
  /** what the choreography asks for this frame */
  readonly target = new Float32Array(CHANNELS);
  /** what the bones get: the target, followed by springs */
  readonly pose = new Float32Array(CHANNELS);
  private readonly vel = new Float32Array(CHANNELS);
  private readonly omega = new Float32Array(NGROUPS);
  private readonly zeta = new Float32Array(NGROUPS);
  private readonly rnd: Rand;
  private t: number;
  private first = true;
  /** the player's own cat: its head carries the picture's chin, so it keeps still */
  carriesCamera = false;
  /** how much the fur should stand up this frame, relative to `look.puff` (gloating cats smooth it down) */
  puffScale = 1;

  // act bookkeeping
  private act: CatAct | undefined = undefined;
  private actAge = 0;
  private lastActT = -1;
  /** seconds since `actT` last moved on (a finished act is left behind in the look after a fight) */
  private stale = 0;
  private staggerSide: -1 | 1 = 1;
  private lead: -1 | 1 = 1;
  private gloatW = 0;
  private fleeW = 0;
  // jumps
  private wasAir = false;
  private landT = 9;
  private landHard = 0;
  private airMin = 0;
  // idle life
  private earFlick = [0, 0];
  private earNext = [1, 2];
  private earSide = 0;
  private twitchT = 9;
  private twitchNext = 3;
  private lookT = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookYawTo = 0;
  private lookPitchTo = 0;

  constructor(seed = Math.floor(Math.random() * 2147483646) + 1) {
    this.rnd = new Rand(seed);
    this.t = this.rnd.next() * 10;
    this.earNext[0] = 1 + this.rnd.next() * 4;
    this.earNext[1] = 1 + this.rnd.next() * 4;
    this.lead = this.rnd.next() < 0.5 ? -1 : 1;
  }

  /** Work out this frame's pose from the look. */
  update(l: CatLook, dt: number): void {
    this.t += dt;
    this.trackAct(l, dt);
    this.trackAir(l, dt);
    this.idleTimers(dt);
    const T = this.target;
    const tired = clamp01(l.tired ?? 0);
    this.base(l);
    const act = this.liveAct(l);
    const fightAct = act !== undefined && FIGHT_ACTS.has(act) && l.stance === 'fight';
    if (fightAct) {
      if (this.carriesCamera) this.playerGuard(tired);
      else this.rivalFight(l, act, tired);
    }
    if (act === 'slap' || act === 'dodge' || act === 'flinch') {
      this.playerGuard(tired);
      this.playerFight(l, act);
    }
    if (act === 'swipe') this.swipe(l);
    if (act === 'climb') this.climb(l);
    if (act === 'mantle') this.mantle(l);
    if (l.airborne && act !== 'mantle' && act !== 'climb') this.jump(l);
    else if (this.landT < 0.3) this.landing();
    if (act === 'flee' || this.fleeW > 0) this.flee(act === 'flee' ? 1 : 0, dt);
    this.gloatW = act === 'gloat' && l.stance === 'fight' ? Math.min(1, this.gloatW + dt * 2) : Math.max(0, this.gloatW - dt * 0.5);
    this.puffScale = 1 - 0.7 * this.gloatW;
    // out of breath: heavier breathing and a heavier body (the timing of every move stays the same)
    this.tiredness(tired, l.stance === 'move' ? 0.3 : 1);
    if (tired > 0) {
      const k = 1 - 0.3 * tired;
      this.omega[GROUP.body] *= k;
      this.omega[GROUP.spine] *= k;
      this.omega[GROUP.head] *= k;
      this.omega[GROUP.tail] *= k;
    }
    // never ask a spring for something silly
    for (let i = 0; i < CHANNELS; i++) if (!Number.isFinite(T[i])) T[i] = 0;
    this.follow(dt);
  }

  // ---------------------------------------------------------------- bookkeeping

  /** which act is really going on: an act whose clock has stopped is over (a fight leaves its last act behind) */
  private liveAct(l: CatLook): CatAct | undefined {
    if (!l.act) return undefined;
    if (this.stale > 0.25 && l.act !== 'guard') return undefined;
    return l.act;
  }

  private trackAct(l: CatLook, dt: number): void {
    const at = l.actT ?? 0;
    if (l.act !== this.act || at < this.lastActT - 1e-6) {
      if (l.act === 'stagger' && this.act !== 'stagger') this.staggerSide = this.rnd.next() < 0.5 ? -1 : 1;
      // after each swipe the rival settles into its guard with the other shoulder leading
      if (this.act === 'strike' && l.act === 'recover') this.lead = (l.actSide ?? 1) > 0 ? -1 : 1;
      this.act = l.act;
      this.actAge = 0;
      this.stale = 0;
    } else {
      this.actAge += dt;
      this.stale = Math.abs(at - this.lastActT) < 1e-6 && dt > 0 ? this.stale + dt : 0;
    }
    this.lastActT = at;
  }

  private trackAir(l: CatLook, dt: number): void {
    const air = !!l.airborne;
    if (air) this.airMin = Math.min(this.airMin, l.airSpeed ?? 0);
    if (this.wasAir && !air) {
      this.landT = 0;
      this.landHard = clamp(-this.airMin / 6, 0.2, 1);
      this.airMin = 0;
    }
    if (!air) this.landT += dt;
    this.wasAir = air;
  }

  private idleTimers(dt: number): void {
    const r = this.rnd;
    for (let i = 0; i < 2; i++) {
      this.earFlick[i] += dt;
      this.earNext[i] -= dt;
      if (this.earNext[i] <= 0) {
        this.earFlick[i] = 0;
        this.earNext[i] = 2.5 + r.next() * 6;
        // sometimes both ears go together
        if (r.next() < 0.25) {
          this.earFlick[1 - i] = 0;
          this.earNext[1 - i] = Math.max(this.earNext[1 - i], 1.5);
        }
      }
    }
    this.twitchT += dt;
    this.twitchNext -= dt;
    if (this.twitchNext <= 0) {
      this.twitchT = 0;
      this.twitchNext = 1.8 + r.next() * 4.5;
    }
    this.lookT -= dt;
    if (this.lookT <= 0) {
      this.lookT = 1.2 + r.next() * 3.2;
      this.lookYawTo = (r.next() - 0.5) * 0.7;
      this.lookPitchTo = (r.next() - 0.5) * 0.18;
      this.earSide = r.next() < 0.5 ? -1 : 1;
    }
    // the eyes lead and the head follows quickly: a short, decisive turn and then stillness
    const k = 1 - Math.exp(-dt * 9);
    this.lookYaw += (this.lookYawTo - this.lookYaw) * k;
    this.lookPitch += (this.lookPitchTo - this.lookPitch) * k;
  }

  // ---------------------------------------------------------------- springs

  private springs(group: number, omega: number, zeta = 1): void {
    this.omega[group] = omega;
    this.zeta[group] = zeta;
  }

  private follow(dt: number): void {
    const T = this.target;
    const P = this.pose;
    const V = this.vel;
    if (this.first) {
      P.set(T);
      V.fill(0);
      this.first = false;
      return;
    }
    if (dt <= 0) return;
    for (let i = 0; i < CHANNELS; i++) {
      const g = GROUP_OF[i];
      const w = this.omega[g] * SOFT[i];
      const z = this.zeta[g];
      if (z >= 1) {
        // critically damped: exact, stable for any step
        const y = P[i] - T[i];
        const e = Math.exp(-w * dt);
        const tmp = (V[i] + w * y) * dt;
        P[i] = T[i] + (y + tmp) * e;
        V[i] = (V[i] - w * tmp) * e;
      } else {
        // a little bounce (tail, ears): small steps keep it stable
        const n = Math.max(1, Math.ceil(dt / Math.min(1 / 120, 0.25 / w)));
        const h = dt / n;
        let x = P[i];
        let v = V[i];
        for (let k = 0; k < n; k++) {
          v += (w * w * (T[i] - x) - 2 * z * w * v) * h;
          x += v * h;
        }
        P[i] = x;
        V[i] = v;
      }
    }
  }

  // ---------------------------------------------------------------- helpers for the choreography

  /** put a front wrist joint at a spot (cat space), with the elbow pointing back and a little out */
  private front(s: 0 | 1, x: number, y: number, f: number, plant = 1): void {
    const T = this.target;
    const L = FRONT[s];
    T[L.ik] = 1;
    T[L.x] = x;
    T[L.y] = y;
    T[L.f] = f;
    T[L.px] = s === 0 ? -0.15 : 0.15;
    T[L.py] = -0.1;
    T[L.pf] = -1;
    T[L.plant] = plant;
  }

  private pole(s: 0 | 1, x: number, y: number, f: number): void {
    const T = this.target;
    const L = FRONT[s];
    T[L.px] = x;
    T[L.py] = y;
    T[L.pf] = f;
  }

  /** put a hock joint at a spot (cat space); `abs` is the foot bone's angle to the ground (0 = standing) */
  private hind(s: 0 | 1, x: number, y: number, f: number, abs = 0): void {
    const T = this.target;
    const L = HIND[s];
    T[L.ik] = 1;
    T[L.x] = x;
    T[L.y] = y;
    T[L.f] = f;
    T[L.knee] = 0.15;
    T[L.plant] = 1;
    T[L.hockAbs] = abs;
    // keep the toes flat as the foot bone tips forwards
    T[L.paw] = -abs * 0.9;
  }

  /** rotate a planted foot spot about the pivot under the hips (turning the whole stance) */
  private turned(x: number, f: number, yaw: number, out: { x: number; f: number }): { x: number; f: number } {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const rf = f - REST.pivotF;
    // + yaw turns the front to the cat's left (towards -x)
    out.x = x * c - rf * s;
    out.f = REST.pivotF + rf * c + x * s;
    return out;
  }
  private readonly spot = { x: 0, f: 0 };

  private ears(back: number, out: number, turn: number): void {
    const T = this.target;
    T[CH.earLBack] = back;
    T[CH.earRBack] = back;
    T[CH.earLOut] = out;
    T[CH.earROut] = out;
    T[CH.earLTurn] = turn;
    T[CH.earRTurn] = turn;
  }

  /** a tail that swishes: base lift (+ = up), side swing amplitude, speed (Hz) and how far the wave travels */
  private tailWave(lift: number, curl: number, amp: number, hz: number, lag = 0.55, tip = 0): void {
    const T = this.target;
    const a = this.t * hz * TAU;
    for (let i = 0; i < 5; i++) {
      const k = (i + 1) / 5;
      T[TAIL.lift[i]] = -(i === 0 ? lift : lift * 0.35) + (i >= 3 ? tip : 0);
      T[TAIL.side[i]] = Math.sin(a - i * lag) * amp * (0.55 + 0.6 * k) + curl;
    }
  }

  // ---------------------------------------------------------------- the base: standing, sitting, moving

  private base(l: CatLook): void {
    const T = this.target;
    const S = JOINT_SIGN;
    T.fill(0);
    const a = l.phase * TAU;
    const v = l.speed;
    const move = l.stance === 'move' ? clamp(v / 1.0, 0, 1) : 0;
    const run = clamp((v - 1) / 6.6, 0, 1);
    const gallop = smoothstepRange(3.6, 4.8, v) * move;
    const sit = l.stance === 'sit' ? 1 : 0;
    const low = l.stance === 'crouch' ? 1 : 0;
    const fight = l.stance === 'fight' ? 1 : 0;
    const still = 1 - move;
    const lowAng = clamp(l.headLow / 0.17, -0.5, 0.9);
    const puff = l.puff;
    const breath = Math.sin(this.t * TAU * (0.45 + 0.4 * puff + 0.3 * fight));
    const cam = this.carriesCamera ? 1 : 0;

    this.springs(GROUP.body, 14);
    this.springs(GROUP.spine, 13);
    this.springs(GROUP.head, 16);
    this.springs(GROUP.face, 22, 0.5);
    this.springs(GROUP.tail, 9, 0.55);
    for (let g = GROUP.frontL; g <= GROUP.hindR; g++) this.springs(g, move > 0.05 ? 60 : 16);

    // ---- spine: arches and stretches with every bound
    const bound = Math.sin(a) * gallop;
    const arch = bound * 0.2;
    T[CH.hipsB] = S.spine * (-arch * 0.6);
    T[CH.sp1B] = S.spine * (-arch * 0.5);
    T[CH.sp2B] = S.spine * (arch * 0.4);
    T[CH.chestB] = S.spine * (arch * 0.7 - lowAng * 0.5) + breath * 0.012 * still;
    const sway = Math.sin(a) * 0.05 * move * (1 - gallop);
    const nod = Math.sin(a * 2) * 0.04 * move * (1 - gallop) + bound * 0.1;
    T[CH.neckB] = S.neck * (nod - low * 0.2 - lowAng * 0.35);
    T[CH.neckS] = -l.headTurn * 0.5 * (1 - still) - sway;
    T[CH.headB] = S.head * (low * 0.25 - arch * 0.3 + lowAng * 0.7);
    T[CH.headS] = -l.headTurn * 0.6;
    // the head looks where the cat means to look, however the body moves (cats keep their heads very still)
    T[CH.gaze] = 1;
    const roam = (1 - cam) * still * (1 - fight);
    T[CH.headP] = (1 - cam) * (-0.05 - low * 0.05 - lowAng * 0.25) + this.lookPitch * roam;
    T[CH.headY] = -l.headTurn * 0.9 + this.lookYaw * roam * (1 - Math.abs(l.headTurn));
    T[CH.headR] = this.lookYaw * 0.25 * roam;
    // ears: up and swivelling, a flick now and then; back and out when scared
    const earBack = clamp(puff * 0.9 + l.flinch, 0, 1);
    this.ears(-0.05 + earBack * 0.55, earBack * 0.6, earBack * 0.35);
    for (let i = 0; i < 2; i++) {
      const fl = this.earFlick[i];
      const k = fl < 0.22 ? Math.sin((fl / 0.22) * Math.PI) : 0;
      T[i === 0 ? CH.earLBack : CH.earRBack] += k * 0.5;
      T[i === 0 ? CH.earLTurn : CH.earRTurn] += k * 0.6;
    }
    // the ear on the side the cat is looking towards swivels round that way
    T[CH.earLTurn] += this.earSide < 0 ? 0.3 * still : -0.12 * still;
    T[CH.earRTurn] += this.earSide > 0 ? 0.3 * still : -0.12 * still;

    // a startled flinch (tagged, slapped): head jerks back and up, body shrinks back
    if (l.flinch > 0 && !this.carriesCamera) {
      T[CH.neckB] += 0.22 * l.flinch;
      T[CH.headP] += 0.12 * l.flinch;
      T[CH.bodyF] -= 0.025 * l.flinch;
      T[CH.hipsB] += 0.08 * l.flinch;
    }

    // ---- tail: streams behind at speed, bottle-brush when puffed; the tip twitches now and then
    const tw = this.twitch();
    for (let i = 0; i < 5; i++) {
      const wave = Math.sin(this.t * 2.1 - i * 0.6) * 0.1 * (1 - run);
      const lift = (0.06 + run * 0.1 + puff * 0.3) * (i === 0 ? 1.4 : 0.6);
      T[TAIL.lift[i]] = S.tail * (lift + Math.sin(a - i * 0.5) * 0.06 * gallop);
      T[TAIL.side[i]] = wave + (i >= 3 ? tw * 0.35 : 0);
    }

    // ---- legs while running: joint angles following the stride
    for (let s = 0; s < 2; s++) {
      const F = FRONT[s];
      const H = HIND[s];
      const fPhase = a + (s === 0 ? 0 : Math.PI) * (1 - gallop) + (s === 0 ? 0 : 0.6) * gallop;
      const fSwing = Math.sin(fPhase) * (0.3 + 0.2 * run + 0.08 * gallop) * move;
      const fLift = Math.max(0, Math.cos(fPhase)) * move;
      T[F.scap] = S.scapula * fSwing * 0.3;
      T[F.upper] = S.upperarm * (fSwing * 0.9 + low * 0.45);
      T[F.fore] = S.forearm * (fLift * (0.45 + 0.45 * run) - low * 0.95);
      T[F.wrist] = S.wrist * (fLift * 0.7 - low * 0.4);
      T[F.paw] = S.paw * (fLift * 0.4);
      const hPhase = a + (s === 0 ? Math.PI : 0) * (1 - gallop) + (Math.PI + (s === 0 ? 0 : 0.5)) * gallop;
      const hSwing = Math.sin(hPhase) * (0.28 + 0.26 * run + 0.32 * gallop) * move;
      const hLift = Math.max(0, Math.cos(hPhase)) * move;
      T[H.thigh] = S.thigh * (hSwing * 0.9 + low * 0.5);
      T[H.shin] = S.shin * (hLift * (0.5 + 0.4 * run) + low * 0.9);
      T[H.hock] = S.hock * (hLift * 0.6 + low * 0.5);
      T[H.paw] = S.hindpaw * (hLift * 0.4);
    }
    // whole body bob with the stride; crouching sinks it
    const bob = gallop * Math.abs(Math.sin(a)) * 0.022 + (1 - gallop) * Math.sin(a * 2) * 0.004 * move;
    T[CH.bodyY] = bob - low * 0.058 * move;

    // ---- standing still or sitting: the paws stay planted and the legs reach for them
    if (still > 0) {
      if (sit) this.sitPose(breath);
      else this.standPose(low, breath, puff * (1 - fight));
      // hand over from the running joint angles to the planted paws as the cat slows down
      for (const L of FRONT) T[L.ik] = still;
      for (const L of HIND) T[L.ik] = still;
    }
  }

  /** a tail tip twitch every few seconds: -1..1, mostly 0 */
  private twitch(): number {
    const k = this.twitchT / 0.35;
    return k < 1 ? Math.sin(k * TAU) * (1 - k) : 0;
  }

  private standPose(low: number, breath: number, alarm: number): void {
    const T = this.target;
    // the alarmed side-on stance with the fur up (the "Halloween cat"): up on stiff legs, back arched high
    const yaw = alarm * 0.4 * this.lead;
    const sp = this.spot;
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      this.turned(sx * (0.033 + 0.008 * alarm), REST.wrist.f + 0.006 - 0.02 * low - 0.01 * alarm, yaw, sp);
      this.front(s, sp.x, REST.wrist.y, sp.f);
      this.turned(sx * (0.037 + 0.008 * alarm), REST.hock.f + 0.01 * low + 0.035 * alarm, yaw, sp);
      this.hind(s, sp.x, REST.hock.y - 0.03 * low + 0.012 * alarm, sp.f, 0.25 * low - 0.1 * alarm);
    }
    T[CH.bodyYaw] = yaw;
    T[CH.bodyY] = -0.058 * low + 0.022 * alarm + breath * 0.0018;
    T[CH.bodyPitch] = -0.04 * alarm;
    T[CH.hipsB] += 0.3 * alarm;
    T[CH.sp1B] += 0.16 * alarm;
    T[CH.sp2B] += -0.1 * alarm;
    T[CH.chestB] += -0.34 * alarm;
    T[CH.neckB] += -0.05 * alarm;
    // the head stays on whatever it is staring at
    T[CH.headY] -= yaw * 0.85;
    T[CH.headP] += 0.05 * alarm;
    // tail up in an arch
    T[TAIL.lift[0]] -= 0.6 * alarm;
    T[TAIL.lift[2]] += 0.25 * alarm;
    T[TAIL.lift[3]] += 0.35 * alarm;
  }

  private sitPose(breath: number): void {
    const T = this.target;
    // haunches on the ground, front legs straight down under the chest, chest up; the tail wraps round
    T[CH.bodyPitch] = 0.72;
    T[CH.bodyY] = -0.07 + breath * 0.0015;
    T[CH.bodyF] = 0.05;
    T[CH.hipsB] = 0.16;
    T[CH.sp1B] = 0.0;
    T[CH.sp2B] = -0.06;
    T[CH.chestB] = -0.12 + breath * 0.015;
    T[CH.neckB] = 0.05;
    T[CH.headP] += 0.03;
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      this.front(s, sx * 0.028, REST.wrist.y, 0.025);
      this.hind(s, sx * 0.05, 0.018, -0.155, 1.25);
      T[HIND[s].knee] = 0.45;
    }
    const curl = this.lead;
    for (let i = 0; i < 5; i++) {
      T[TAIL.lift[i]] = i === 0 ? 1.0 : i === 1 ? 0.25 : 0.02;
      T[TAIL.side[i]] = curl * (i === 0 ? 0.3 : 0.45) + Math.sin(this.t * 0.9 + i) * 0.03;
    }
    const tw = this.twitch();
    T[TAIL.side[4]] += tw * 0.45;
    T[TAIL.lift[4]] -= Math.abs(tw) * 0.3;
  }

  /** Out of breath: panting chest, mouth a little open, head lower, ears drooping sideways, tail low. */
  private tiredness(k: number, still: number): void {
    if (k <= 0.001) return;
    const T = this.target;
    const hz = 1.3 + 1.7 * k;
    const pant = Math.sin(this.t * TAU * hz);
    T[CH.chestB] += pant * 0.045 * k * still;
    T[CH.sp2B] += pant * 0.02 * k * still;
    T[CH.bodyY] += (pant * 0.003 - 0.008) * k * still;
    T[CH.jaw] += (-0.1 - 0.05 * Math.max(0, pant)) * k;
    T[CH.neckB] -= 0.12 * k;
    T[CH.headP] -= 0.1 * k * (this.carriesCamera ? 0 : 1);
    T[CH.earLOut] += 0.5 * k;
    T[CH.earROut] += 0.5 * k;
    T[CH.earLBack] += 0.1 * k;
    T[CH.earRBack] += 0.1 * k;
    T[TAIL.lift[0]] += 0.25 * k;
  }

  // ---------------------------------------------------------------- the rival in a fight

  /** the boxing stance every fight move starts from and goes back to */
  private guardPose(tired: number): void {
    const T = this.target;
    const t = this.t;
    const lead = this.lead;
    const fresh = 1 - 0.6 * tired;
    // turned a little side-on, rear end down and weight back, front legs braced, head low and pulled in
    const stanceYaw = lead * 0.2;
    // weaving: a slow sway with a second, faster one on top so it never looks like a metronome
    const weave = (Math.sin(t * 2.3) * 0.6 + Math.sin(t * 3.7 + 1) * 0.4) * fresh;
    const breath = Math.sin(t * TAU * 1.05);
    const sp = this.spot;
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      this.turned(sx * 0.043, 0.086, stanceYaw, sp);
      this.front(s, sp.x, REST.wrist.y, sp.f);
      this.turned(sx * 0.052, -0.165, stanceYaw, sp);
      this.hind(s, sp.x, 0.046, sp.f, 0.45);
    }
    T[CH.bodyPitch] = 0.2 + breath * 0.01 - 0.05 * tired;
    T[CH.bodyY] = -0.028 + breath * 0.002;
    T[CH.bodyF] = -0.015;
    T[CH.bodyYaw] = stanceYaw + weave * 0.05;
    T[CH.bodyRoll] = weave * 0.04;
    T[CH.bodyX] = weave * 0.006;
    // a hunched, coiled back
    T[CH.hipsB] = 0.12;
    T[CH.sp1B] = 0.05;
    T[CH.sp2B] = -0.04;
    T[CH.chestB] = -0.16 + breath * 0.02;
    T[CH.chestS] = -weave * 0.05;
    T[CH.neckB] = -0.28 + Math.sin(t * 4.6) * 0.025 * fresh;
    T[CH.neckS] = weave * 0.08;
    // chin down, eyes on the opponent's face the whole time
    T[CH.gaze] = 1;
    T[CH.headP] = -0.2;
    T[CH.headY] = -weave * 0.04;
    T[CH.headR] = -weave * 0.06;
    // a low growl: the mouth opens a crack now and then
    T[CH.jaw] = -0.08 * Math.max(0, Math.sin(t * 1.7)) ** 3;
    // airplane ears: swung right out to the sides, openings turned away
    this.ears(0.4, 1.15, 0.8);
    T[CH.earLBack] += this.earFlick[0] < 0.18 ? Math.sin((this.earFlick[0] / 0.18) * Math.PI) * 0.35 : 0;
    T[CH.earRBack] += this.earFlick[1] < 0.18 ? Math.sin((this.earFlick[1] / 0.18) * Math.PI) * 0.35 : 0;
    // low, lashing tail with a whipping tip
    this.tailWave(-0.15, -lead * 0.1, 0.32 * fresh + 0.1, 0.85 - 0.3 * tired, 0.7, 0.15);
    T[TAIL.side[4]] += Math.sin(t * 9.1) * 0.12 * fresh;
    this.springs(GROUP.tail, 11, 0.45);
  }

  private rivalFight(l: CatLook, act: CatAct, tired: number): void {
    this.guardPose(tired);
    const a = l.actT ?? 0;
    const len = l.actLen ?? 0;
    const side = l.actSide ?? 1;
    switch (act) {
      case 'windup':
        this.windup(a, len, side, 1, tired);
        break;
      case 'feint':
        this.feint(a, len, side, tired);
        break;
      case 'strike':
        this.strike(a, side, tired);
        break;
      case 'recover':
        if (len > 0.7) this.recoverMiss(a, len, side, tired);
        else this.recoverHit(a, len, side);
        break;
      case 'stagger':
        this.stagger(a, this.staggerSide);
        break;
      case 'gloat':
        this.gloat(a);
        break;
      default:
        break;
    }
    // sitting back must not drag the shoulders off the paws
    this.target[CH.bodyF] += shoulderDrift(this.target[CH.bodyPitch]) * 0.9;
  }

  /** the paw that is not striking braces under the chest and takes the weight */
  private brace(si: 0 | 1, f: number, w: number): void {
    const T = this.target;
    const L = FRONT[si];
    const sx = si === 0 ? -1 : 1;
    T[L.x] = lerp(T[L.x], sx * 0.022, w);
    T[L.f] = lerp(T[L.f], f, w);
  }

  /**
   * The paw comes up and back beside the head and is held there for a beat. `amount` scales the
   * whole thing (a feint uses the same start). The first tenth of a second already shows which paw it is.
   */
  private windup(a: number, len: number, side: number, amount: number, tired: number): void {
    const T = this.target;
    const si = (side < 0 ? 0 : 1) as 0 | 1;
    const L = FRONT[si];
    const len0 = Math.max(0.3, len);
    const hold = Math.max(0.1, len0 * 0.25);
    const top = len0 - hold;
    const lift = out3(seg(a, 0, 0.09));
    const rise = sm(seg(a, 0.05, top));
    const cock = sm(seg(a, top - 0.04, len0));
    const k = amount;
    const high = 1 - 0.15 * tired;
    // the striking wrist: off the ground at once, then up, out and back beside the cheek
    const x0 = T[L.x];
    const f0 = T[L.f];
    let x = lerp(x0, side * 0.055, lift);
    let y = lerp(REST.wrist.y, 0.115, lift);
    let f = lerp(f0, 0.125, lift);
    x = lerp(x, side * 0.088, rise);
    y = lerp(y, 0.29 * high, rise);
    f = lerp(f, 0.09, rise);
    // the extra draw-back in the hold, with a tremble of held tension
    x += side * 0.01 * cock;
    y += 0.012 * cock + Math.sin(a * 57) * 0.0018 * cock;
    f -= 0.015 * cock;
    T[L.x] = lerp(x0, x, k);
    T[L.y] = lerp(REST.wrist.y, y, k);
    T[L.f] = lerp(f0, f, k);
    T[L.plant] = 1 - lift;
    // paw curled while it travels, opened up (pad out, toes spread) in the hold
    T[L.wrist] = lerp(-1.0 * lift, 0.35, cock);
    T[L.paw] = lerp(-0.3 * lift, 0.5, cock);
    // elbow out and down, shoulder blade up
    this.pole(si, side * lerp(0.15, 0.85, rise), lerp(-0.1, -0.5, rise), lerp(-1, -0.3, rise));
    T[L.scap] = -0.15 * rise;
    T[L.scapOut] = -side * 0.15 * rise;
    this.brace((1 - si) as 0 | 1, 0.095, lift * k);

    // the body: sits back on its haunches, turns the striking shoulder away, leans onto the other paw
    const load = sm(seg(a, 0.0, top * 0.9));
    T[CH.bodyPitch] += 0.22 * load * k;
    T[CH.bodyY] -= 0.022 * load * k;
    T[CH.bodyF] -= 0.02 * load * k;
    T[CH.bodyYaw] += -side * 0.3 * sm(seg(a, 0.02, top)) * k;
    T[CH.bodyRoll] += -side * 0.11 * load * k;
    T[CH.chestS] += -side * 0.08 * load * k;
    T[CH.chestB] += 0.05 * load * k;
    // the head ducks and tips away from the paw but keeps looking; the mouth opens in a hiss
    T[CH.neckB] -= 0.1 * lift * k;
    T[CH.neckS] += side * 0.1 * load * k;
    T[CH.headR] += -side * 0.24 * lift * k;
    T[CH.headY] += side * 0.08 * load * k;
    T[CH.jaw] = lerp(T[CH.jaw], -0.3, sm(seg(a, 0.05, top)) * k);
    // ears pinned right back, tail swings hard to the striking side
    T[CH.earLBack] += 0.35 * lift * k;
    T[CH.earRBack] += 0.35 * lift * k;
    for (let i = 0; i < 5; i++) T[TAIL.side[i]] = lerp(T[TAIL.side[i]], -side * 0.22 * (0.6 + i * 0.15), load * k * 0.8);
    this.springs(si === 0 ? GROUP.frontL : GROUP.frontR, 30);
    this.springs(GROUP.body, 18 * (1 - 0.3 * tired));
  }

  /** the swipe itself: down and across at the opponent's face, then snapped back. Lands 0.06 s in. */
  private strike(a: number, side: number, tired: number): void {
    const T = this.target;
    const si = (side < 0 ? 0 : 1) as 0 | 1;
    const L = FRONT[si];
    const heavy = 1 - 0.25 * tired;
    // where the windup left the paw
    const cx = side * 0.098;
    const cy = 0.302;
    const cf = 0.075;
    // the face it is aimed at (the camera hangs 0.55 m ahead of this cat, under the opponent's chin)
    const hx = -side * 0.012;
    const hy = 0.15;
    const hf = 0.44;
    const go = out3(seg(a, 0, 0.058));
    const snap = sm(seg(a, 0.075, 0.16));
    // an overhand arc: forwards and high first, then down onto the target
    const kx = side * 0.075;
    const ky = 0.33;
    const kf = 0.32;
    const u = go;
    const b0 = (1 - u) * (1 - u);
    const b1 = 2 * u * (1 - u);
    const b2 = u * u;
    let x = b0 * cx + b1 * kx + b2 * hx;
    let y = b0 * cy + b1 * ky + b2 * hy;
    let f = b0 * cf + b1 * kf + b2 * hf;
    // follow-through past the face, then snapped back in front of the chest
    const thru = bump(a, 0.055, 0.075, 0.08, 0.11);
    x += -side * 0.03 * thru;
    y -= 0.03 * thru;
    x = lerp(x, side * 0.045, snap);
    y = lerp(y, 0.165, snap);
    f = lerp(f, 0.215, snap);
    T[L.x] = x;
    T[L.y] = y;
    T[L.f] = f;
    T[L.plant] = 0;
    T[L.wrist] = lerp(lerp(0.35, -0.15, go), -0.75, snap);
    T[L.paw] = lerp(lerp(0.5, 0.55, go), -0.2, snap);
    this.pole(si, side * lerp(0.85, 0.35, go), lerp(-0.5, -0.7, go), lerp(-0.3, -0.6, go));
    T[L.scap] = lerp(-0.15, 0.45, go) * (1 - snap * 0.6);
    T[L.scapOut] = -side * 0.05;
    // the other paw steps in to carry the lunge
    this.brace((1 - si) as 0 | 1, lerp(0.095, 0.15, out3(seg(a, 0, 0.09))), 1);

    // the spine leads: the body uncoils a moment before the paw, lunges in and turns across
    const body = out3(seg(a, -0.012, 0.05));
    const back = sm(seg(a, 0.07, 0.16));
    const lunge = body * (1 - back * 0.45) * heavy;
    T[CH.bodyPitch] += lerp(0.22, -0.06, body) + 0.06 * back;
    T[CH.bodyY] += lerp(-0.022, 0.0, body);
    T[CH.bodyF] += lerp(-0.02, 0.13, lunge);
    T[CH.bodyYaw] += lerp(-side * 0.3, side * 0.24, body) * (1 - back * 0.4);
    T[CH.bodyRoll] += lerp(-side * 0.11, side * 0.08, body);
    T[CH.chestS] += lerp(-side * 0.08, side * 0.1, body);
    T[CH.chestB] += 0.05 * (1 - body);
    // the head drives in with the body but tucks away from the line of the blow, mouth open
    T[CH.neckB] += lerp(-0.1, 0.06, body);
    T[CH.neckS] += lerp(side * 0.1, -side * 0.06, body);
    T[CH.headR] += lerp(-side * 0.24, -side * 0.1, body);
    T[CH.headY] += side * 0.1 * body;
    T[CH.headP] += -0.08 * body;
    T[CH.jaw] = -0.3 * (1 - back);
    T[CH.earLBack] += 0.4;
    T[CH.earRBack] += 0.4;
    // the tail swings against the turn
    for (let i = 0; i < 5; i++) T[TAIL.side[i]] = side * 0.3 * (0.6 + i * 0.15) * body;
    this.springs(si === 0 ? GROUP.frontL : GROUP.frontR, 95);
    this.springs(GROUP.body, 60 * heavy);
    this.springs(GROUP.spine, 50 * heavy);
    this.springs(GROUP.head, 40);
  }

  /** the swipe connected: paw back down, body back into the stance, a satisfied little settle */
  private recoverHit(a: number, len: number, side: number): void {
    const T = this.target;
    const si = (side < 0 ? 0 : 1) as 0 | 1;
    const L = FRONT[si];
    const down = sm(seg(a, 0, 0.2));
    const gx = T[L.x];
    const gf = T[L.f];
    T[L.x] = lerp(side * 0.045, gx, down);
    T[L.f] = lerp(0.215, gf, down);
    T[L.y] = lerp(0.165, REST.wrist.y, in2(down)) + bump(a, 0.0, 0.08, 0.1, 0.2) * 0.02;
    T[L.plant] = sm(seg(a, 0.12, 0.2));
    T[L.wrist] = -0.75 * (1 - down);
    T[L.paw] = -0.2 * (1 - down);
    this.pole(si, side * lerp(0.35, 0.15, down), lerp(-0.7, -0.1, down), -0.6 - 0.4 * down);
    const settle = sm(seg(a, 0, Math.min(0.42, len * 0.85)));
    T[CH.bodyF] += lerp(0.07, 0, settle);
    // the turn across overshoots the stance a little and swings back
    T[CH.bodyYaw] += side * 0.14 * (1 - settle) - side * 0.05 * bump(a, 0.15, 0.28, 0.32, 0.5);
    T[CH.neckB] += 0.06 * (1 - settle);
    this.springs(GROUP.body, 16);
    this.springs(si === 0 ? GROUP.frontL : GROUP.frontR, 26);
  }

  /** the swipe hit nothing: carried through, off balance, open; then scrambles back into the stance */
  private recoverMiss(a: number, len: number, side: number, tired: number): void {
    const T = this.target;
    const si = (side < 0 ? 0 : 1) as 0 | 1;
    const oi = (1 - si) as 0 | 1;
    const L = FRONT[si];
    const O = FRONT[oi];
    const end = Math.max(0.6, len);
    const sway = 1 + 0.4 * tired;
    // 1. carried on through: the paw slaps down across, the body tips forwards and over
    const thru = out3(seg(a, 0, 0.13));
    // 3. scrambling back from about halfway
    const back = sm(seg(a, end * 0.52, end * 0.92));
    const gx = T[L.x];
    const gf = T[L.f];
    // striking paw: down on the ground across the middle, then lifted and put back in its place
    let x = lerp(side * 0.045, -side * 0.035, thru);
    let y = lerp(0.165, 0.03, in2(thru));
    let f = lerp(0.215, 0.29, thru);
    const step = seg(a, end * 0.5, end * 0.72);
    x = lerp(x, gx, sm(step));
    f = lerp(f, gf, sm(step));
    y += Math.sin(step * Math.PI) * 0.045;
    T[L.x] = x;
    T[L.y] = y;
    T[L.f] = f;
    T[L.plant] = thru * (1 - Math.sin(step * Math.PI));
    T[L.wrist] = -0.6 * (1 - thru) - 0.5 * Math.sin(step * Math.PI);
    this.pole(si, side * 0.3, -0.2, -1);
    // the other paw scrambles for balance: a quick step out and forwards, later back
    const catchStep = seg(a, 0.12, 0.26);
    const home = seg(a, end * 0.66, end * 0.86);
    const ox0 = T[O.x];
    const of0 = T[O.f];
    T[O.x] = ox0 - side * 0.025 * sm(catchStep) * (1 - sm(home));
    T[O.f] = of0 + 0.06 * sm(catchStep) * (1 - sm(home));
    T[O.y] = REST.wrist.y + Math.sin(catchStep * Math.PI) * 0.035 + Math.sin(home * Math.PI) * 0.03;
    T[O.plant] = 1 - Math.sin(catchStep * Math.PI) * 0.8 - Math.sin(home * Math.PI) * 0.8;
    // body: lurches forwards and over to the side, wobbles, then pulls back with a little hop
    const off = thru * (1 - back);
    const wob = Math.sin(seg(a, 0.12, end * 0.55) * TAU * 1.5) * (1 - seg(a, 0.12, end * 0.55)) * off;
    T[CH.bodyF] += 0.1 * off;
    T[CH.bodyPitch] += -0.2 * off;
    T[CH.bodyY] += -0.012 * off + bump(a, end * 0.55, end * 0.66, end * 0.7, end * 0.82) * 0.016;
    T[CH.bodyYaw] += side * 0.34 * off;
    T[CH.bodyRoll] += (-side * 0.16 * off + wob * 0.07) * sway;
    T[CH.bodyX] += -side * 0.02 * off * sway;
    T[CH.chestS] += side * 0.12 * off;
    // head dips, exposed, then snaps back up with a shake
    const shake = seg(a, end * 0.62, end * 0.9);
    T[CH.neckB] += -0.3 * off;
    T[CH.headP] += -0.2 * off;
    T[CH.headY] += side * 0.2 * off + Math.sin(shake * TAU * 2.5) * 0.22 * (1 - shake) * (shake > 0 ? 1 : 0);
    T[CH.headR] += side * 0.15 * off;
    // ears blown sideways, then pinned again
    T[CH.earLBack] -= 0.3 * off;
    T[CH.earRBack] -= 0.3 * off;
    for (let i = 0; i < 5; i++) T[TAIL.side[i]] += side * 0.28 * off * (0.5 + i * 0.2);
    T[TAIL.lift[0]] -= 0.3 * off;
    this.springs(GROUP.body, 18 * (1 - 0.3 * tired));
    this.springs(GROUP.frontL, 26);
    this.springs(GROUP.frontR, 26);
  }

  /** just got slapped: head knocked aside, a hop back, a shake, then back on guard */
  private stagger(a: number, from: number): void {
    const T = this.target;
    const hit = out3(seg(a, 0, 0.05));
    const back = sm(seg(a, 0.1, 0.34));
    const k = hit * (1 - back);
    // the blow came from the side `from`: the head turns away from it and tips
    T[CH.headY] += -from * 0.5 * k;
    T[CH.headR] += from * 0.3 * k;
    T[CH.headP] += 0.18 * k;
    T[CH.neckB] += 0.2 * k;
    T[CH.neckS] += -from * 0.12 * k;
    // a quick shake as it comes back
    const sh = seg(a, 0.12, 0.34);
    T[CH.headY] += Math.sin(sh * TAU * 2) * 0.12 * (1 - sh) * (sh > 0 ? 1 : 0);
    // body recoils back, both front paws come off the ground for a moment
    const hop = bump(a, 0.0, 0.06, 0.12, 0.24);
    T[CH.bodyF] += -0.05 * k;
    T[CH.bodyPitch] += 0.16 * k;
    T[CH.bodyY] += 0.01 * hop;
    T[CH.bodyYaw] += from * 0.12 * k;
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const L = FRONT[s];
      T[L.y] += 0.045 * hop * (s === (from > 0 ? 1 : 0) ? 1.2 : 0.8);
      T[L.f] -= 0.02 * hop;
      T[L.plant] = 1 - hop;
      T[L.wrist] = -0.7 * hop;
    }
    T[CH.jaw] = -0.15 * k;
    T[CH.earLBack] += 0.45 * k;
    T[CH.earRBack] += 0.45 * k;
    for (let i = 0; i < 5; i++) T[TAIL.side[i]] += from * 0.3 * k * (0.5 + i * 0.2);
    this.springs(GROUP.head, 45);
    this.springs(GROUP.body, 30);
  }

  /** a windup that turns into a bluff: a jerk forwards without the swipe, then the paw goes back down */
  private feint(a: number, len: number, side: number, tired: number): void {
    const T = this.target;
    const wind = Math.max(0.3, len / 0.7);
    const bluff = bump(a, len * 0.5, len * 0.6, len * 0.66, len * 0.8);
    const drop = sm(seg(a, len * 0.66, len));
    this.windup(Math.min(a, len * 0.62), wind, side, 1 - drop, tired);
    const si = (side < 0 ? 0 : 1) as 0 | 1;
    const L = FRONT[si];
    T[L.f] += 0.06 * bluff;
    T[L.y] -= 0.02 * bluff;
    T[CH.bodyF] += 0.045 * bluff;
    T[CH.neckB] += 0.12 * bluff;
    T[CH.bodyPitch] -= 0.06 * bluff;
    for (let i = 0; i < 5; i++) T[TAIL.side[i]] += side * 0.25 * bluff;
    this.springs(GROUP.body, 30);
  }

  /** won: stands up tall, chin up, ears up, tail up with a hooked tip, and looks away */
  private gloat(a: number): void {
    const T = this.target;
    const up = sm(seg(a, 0, 0.45));
    const away = sm(seg(a, 0.35, 0.9));
    const sp = this.spot;
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      const L = FRONT[s];
      const H = HIND[s];
      this.turned(sx * 0.032, 0.078, 0.25 * away, sp);
      T[L.x] = lerp(T[L.x], sp.x, up);
      T[L.f] = lerp(T[L.f], sp.f, up);
      this.turned(sx * 0.037, -0.15, 0.25 * away, sp);
      T[H.x] = lerp(T[H.x], sp.x, up);
      T[H.f] = lerp(T[H.f], sp.f, up);
      T[H.y] = lerp(T[H.y], REST.hock.y + 0.004, up);
      T[H.hockAbs] = lerp(T[H.hockAbs], 0, up);
      T[H.paw] = lerp(T[H.paw], 0, up);
    }
    T[CH.bodyPitch] = lerp(T[CH.bodyPitch], 0.04, up);
    T[CH.bodyY] = lerp(T[CH.bodyY], 0.01, up);
    T[CH.bodyYaw] = lerp(T[CH.bodyYaw], 0.25 * away, up);
    T[CH.bodyRoll] *= 1 - up;
    T[CH.hipsB] *= 1 - up;
    T[CH.sp1B] *= 1 - up;
    T[CH.sp2B] = lerp(T[CH.sp2B], 0.03, up);
    T[CH.chestB] = lerp(T[CH.chestB], 0.06, up);
    T[CH.neckB] = lerp(T[CH.neckB], 0.12, up);
    T[CH.headP] = lerp(T[CH.headP], 0.22, up);
    T[CH.headY] = lerp(T[CH.headY], 0.45 * away, up);
    T[CH.headR] = lerp(T[CH.headR], -0.1 * away, up);
    T[CH.jaw] *= 1 - up;
    T[CH.earLBack] = lerp(T[CH.earLBack], -0.15, up);
    T[CH.earRBack] = lerp(T[CH.earRBack], -0.15, up);
    T[CH.earLOut] = lerp(T[CH.earLOut], 0, up);
    T[CH.earROut] = lerp(T[CH.earROut], 0, up);
    T[CH.earLTurn] = lerp(T[CH.earLTurn], 0, up);
    T[CH.earRTurn] = lerp(T[CH.earRTurn], 0, up);
    // tail straight up, the tip hooked over
    for (let i = 0; i < 5; i++) {
      T[TAIL.lift[i]] = lerp(T[TAIL.lift[i]], GLOAT_TAIL[i], up);
      T[TAIL.side[i]] = lerp(T[TAIL.side[i]], Math.sin(this.t * 1.3 - i * 0.5) * 0.05, up);
    }
    this.springs(GROUP.tail, 7, 0.6);
    this.springs(GROUP.body, 8);
    this.springs(GROUP.head, 8);
  }

  /** lost: runs off low, ears flat, tail down */
  private flee(on: number, dt: number): void {
    this.fleeW = on ? Math.min(1, this.fleeW + dt * 4) : Math.max(0, this.fleeW - dt * 0.6);
    const w = this.fleeW;
    if (w <= 0) return;
    const T = this.target;
    T[CH.bodyY] -= 0.014 * w;
    T[CH.neckB] -= 0.2 * w;
    T[CH.headP] -= 0.08 * w;
    T[CH.earLBack] = lerp(T[CH.earLBack], 0.9, w);
    T[CH.earRBack] = lerp(T[CH.earRBack], 0.9, w);
    T[CH.earLOut] = lerp(T[CH.earLOut], 0.6, w);
    T[CH.earROut] = lerp(T[CH.earROut], 0.6, w);
    for (let i = 0; i < 5; i++) T[TAIL.lift[i]] = lerp(T[TAIL.lift[i]], i === 0 ? 0.35 : 0.08, w);
  }

  // ---------------------------------------------------------------- the player's own cat
  //
  // The camera hangs under this cat's chin, about 5 cm ahead of the shoulders and 6 cm below them
  // (cat space y 0.115, f 0.165). Anything nearer than about 8 cm to it fills the picture, and the
  // shoulders are above it, so the paws must come up from below with the elbows tucked in behind the
  // lens: then the player sees a forearm rise from the bottom of the picture, not an arm hanging from the sky.

  /** fight stance for the cat that carries the camera: weight back, paws planted just out of sight */
  private playerGuard(tired: number): void {
    const T = this.target;
    const breath = Math.sin(this.t * TAU * 1.0);
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      this.front(s, sx * 0.04, REST.wrist.y, 0.11);
      this.hind(s, sx * 0.05, 0.05, -0.165, 0.4);
    }
    T[CH.bodyPitch] = 0.12 + breath * 0.008 - 0.04 * tired;
    T[CH.hipsB] = 0.08;
    T[CH.chestB] = -0.1 + breath * 0.015;
    this.ears(0.4, 1.1, 0.8);
    this.tailWave(-0.1, 0, 0.28 * (1 - 0.5 * tired), 0.8, 0.7, 0.1);
  }

  private playerFight(l: CatLook, act: CatAct): void {
    const a = l.actT ?? 0;
    const side = l.actSide ?? 1;
    if (act === 'slap') this.slap(a, side);
    else if (act === 'dodge') this.dodge(a);
    else this.flinch(a);
  }

  /**
   * The player's slap: the paw shoots up from the bottom corner of the picture, hooks in towards the
   * middle (the rival's face) by 0.08 s, carries on across a touch and snaps back down out of sight by 0.2 s.
   */
  private slap(a: number, side: number): void {
    const T = this.target;
    const si = (side < 0 ? 0 : 1) as 0 | 1;
    const L = FRONT[si];
    const up = out3(seg(a, 0, 0.035));
    const reach = out3(seg(a, 0.025, 0.075));
    const back = in2(seg(a, 0.1, 0.145));
    const down = sm(seg(a, 0.14, 0.2));
    // planted -> up at the bottom corner -> in to the middle -> back down
    let x = lerp(side * 0.04, side * 0.062, up);
    let y = lerp(REST.wrist.y, 0.08, up);
    let f = lerp(0.11, 0.185, up);
    x = lerp(x, side * 0.012, reach);
    y = lerp(y, 0.138, reach);
    f = lerp(f, 0.238, reach);
    // carry on across a touch (follow-through), then snap back
    x += -side * 0.014 * bump(a, 0.07, 0.09, 0.095, 0.115);
    x = lerp(x, side * 0.05, back);
    y = lerp(y, 0.07, back);
    f = lerp(f, 0.17, back);
    x = lerp(x, side * 0.04, down);
    y = lerp(y, REST.wrist.y, down);
    f = lerp(f, 0.11, down);
    this.front(si, x, y, f, down);
    // paw curled on the way up, opened flat at the face (toes spread), curled again coming back
    T[L.wrist] = lerp(-0.8 * up, 0.55, reach) * (1 - back) - 0.7 * back * (1 - down);
    T[L.paw] = 0.45 * reach * (1 - back);
    // elbow out to the side and a little down, so the forearm sweeps in from the edge of the picture
    this.pole(si, side * 0.95, -0.5, -0.35);
    T[L.scap] = 0.2 * reach * (1 - back);
    // the shoulder drives across behind the paw
    T[CH.bodyYaw] += side * 0.1 * reach * (1 - down);
    T[CH.chestS] += side * 0.08 * reach * (1 - down);
    // the other paw braces
    this.brace((1 - si) as 0 | 1, 0.115, up * (1 - down));
    this.springs(si === 0 ? GROUP.frontL : GROUP.frontR, 110);
    this.springs(GROUP.body, 40);
  }

  /** pulling back out of reach: rears back, both paws come up at the bottom of the picture */
  private dodge(a: number): void {
    const T = this.target;
    const up = out3(seg(a, 0, 0.12));
    const down = sm(seg(a, 0.38, 0.6));
    const k = up * (1 - down);
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      const L = FRONT[s];
      const wob = Math.sin(a * 21 + s * 1.7) * 0.004 * k;
      // the near paw a touch higher than the other: guarding, not mirrored
      this.front(s, sx * lerp(0.04, 0.052, k), lerp(REST.wrist.y, 0.068 + (s === 0 ? 0.012 : 0), k) + wob, lerp(0.11, 0.228, k), 1 - k);
      T[L.wrist] = -0.7 * k;
      T[L.paw] = 0.15 * k;
      this.pole(s, sx * 0.4, -1, -0.4);
    }
    T[CH.bodyPitch] += 0.28 * k;
    this.springs(GROUP.frontL, 30);
    this.springs(GROUP.frontR, 34);
  }

  /** got slapped: a jolt, the paws jerk up into the bottom of the picture, then settle */
  private flinch(a: number): void {
    const T = this.target;
    const jolt = out3(seg(a, 0, 0.05));
    const rel = sm(seg(a, 0.08, 0.4));
    const k = jolt * (1 - rel);
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      const L = FRONT[s];
      this.front(s, sx * lerp(0.04, 0.048, k), REST.wrist.y + (s === 0 ? 0.045 : 0.032) * k, lerp(0.11, 0.2, k), 1 - k);
      T[L.wrist] = -0.8 * k;
      this.pole(s, sx * 0.4, -1, -0.4);
    }
    T[CH.bodyPitch] += 0.18 * k;
    this.springs(GROUP.frontL, 60);
    this.springs(GROUP.frontR, 60);
  }

  /** batting at something outside a fight: a low sweep across, along the bottom of the picture */
  private swipe(l: CatLook): void {
    const T = this.target;
    const a = l.actT ?? 0;
    const len = Math.max(0.15, l.actLen ?? 0.22);
    const side = l.actSide ?? 1;
    const si = (side < 0 ? 0 : 1) as 0 | 1;
    const L = FRONT[si];
    const u = a / len;
    const up = out3(seg(u, 0, 0.22));
    const across = sm(seg(u, 0.18, 0.5));
    const back = sm(seg(u, 0.55, 1));
    let x = lerp(side * 0.04, side * 0.07, up);
    let y = lerp(REST.wrist.y, 0.075, up);
    let f = lerp(0.09, 0.19, up);
    x = lerp(x, -side * 0.015, across);
    y = lerp(y, 0.06, across);
    f = lerp(f, 0.25, across);
    x = lerp(x, side * 0.04, back);
    y = lerp(y, REST.wrist.y, in2(back));
    f = lerp(f, 0.09, back);
    this.front(si, x, y, f, back);
    T[FRONT[si].ik] = 1;
    T[L.wrist] = lerp(-0.7 * up, 0.2, across) * (1 - back);
    T[L.paw] = 0.4 * across * (1 - back);
    this.pole(si, side * 0.95, -0.5, -0.35);
    T[L.scap] = 0.2 * across * (1 - back);
    T[CH.bodyYaw] += side * 0.08 * across * (1 - back);
    this.springs(si === 0 ? GROUP.frontL : GROUP.frontR, 80);
  }

  // ---------------------------------------------------------------- jumping

  /** in the air: stretched out on the way up, tucked at the top, front paws reaching down for the landing */
  private jump(l: CatLook): void {
    const T = this.target;
    const vy = l.airSpeed ?? 0;
    const upK = clamp(vy / 5.5, 0, 1);
    const downK = clamp(-vy / 5, 0, 1);
    const top = 1 - Math.max(upK, downK);
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      const F = FRONT[s];
      const H = HIND[s];
      // front: folded up under the chest on the way up, reaching forwards and down to land (not mirrored)
      const lead = s === 0 ? 1 : 0.9;
      const fx = sx * lerp(0.032, 0.046, downK);
      const fy = 0.11 * upK + 0.07 * top - 0.01 * downK * lead;
      const ff = 0.14 * upK + 0.19 * top + 0.215 * downK * lead;
      this.front(s, fx, fy, ff, 0);
      T[F.wrist] = -1.1 * upK - 0.5 * top + 0.3 * downK;
      T[F.paw] = 0.4 * downK;
      T[F.scap] = 0.25 * downK;
      this.pole(s, sx * 0.2, -0.4, -1);
      // hind: pushed out behind on the way up, tucked forwards for the landing
      const hy = lerp(0.07, 0.085, top) + 0.01 * downK;
      const hf = -0.26 * upK - 0.17 * top - 0.12 * downK;
      this.hind(s, sx * 0.045, hy, hf, -0.6 * upK + 0.3 * downK);
      T[H.paw] = 0.3 * upK;
    }
    T[CH.bodyPitch] = 0.16 * upK - 0.12 * downK;
    T[CH.bodyY] = 0.01 * top;
    T[CH.hipsB] = -0.06 * upK + 0.1 * downK;
    T[CH.chestB] = 0.05 * upK - 0.1 * downK;
    // the tail swings against the body to balance
    for (let i = 0; i < 5; i++) T[TAIL.lift[i]] = (i === 0 ? 1 : 0.4) * (0.3 * upK - 0.4 * downK);
    this.ears(0.1, 0.1, 0);
    this.springs(GROUP.frontL, 22);
    this.springs(GROUP.frontR, 20);
    this.springs(GROUP.hindL, 22);
    this.springs(GROUP.hindR, 22);
    this.springs(GROUP.body, 12);
  }

  /** just landed: the front legs give and spring back */
  private landing(): void {
    const T = this.target;
    const a = this.landT;
    const k = this.landHard * bump(a, 0, 0.04, 0.08, 0.3);
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const F = FRONT[s];
      T[F.f] += 0.03 * k;
      T[F.scap] -= 0.25 * k;
    }
    T[CH.chestB] -= 0.08 * k;
    T[CH.hipsB] += 0.06 * k;
    for (let i = 0; i < 5; i++) T[TAIL.lift[i]] -= 0.25 * k;
  }

  // ---------------------------------------------------------------- climbing

  /**
   * Put the neck where a climbing pose wants it (cat space, relative to its rest place). The camera cat's
   * neck is held there by furcat; any other cat is moved about the ground point under its hips instead,
   * so this works out how far that point must go for the neck to end up in the same place.
   */
  private placeNeck(dy: number, df: number, pitch: number): void {
    const T = this.target;
    T[CH.bodyPitch] = pitch;
    if (this.carriesCamera) {
      T[CH.bodyY] = dy;
      T[CH.bodyF] = df;
      return;
    }
    const ry = REST.neck.y;
    const rf = REST.neck.f - REST.pivotF;
    const c = Math.cos(pitch);
    const s = Math.sin(pitch);
    T[CH.bodyY] = dy - (ry * c + rf * s - ry);
    T[CH.bodyF] = df - (rf * c - ry * s - rf);
  }

  /**
   * Clinging to a trunk or fence 9 cm in front of the chest and going up it: body upright, belly to the
   * bark, front paws reaching up one after the other (left around phase 0, right around 0.5), hind legs
   * pushing in between, tail hanging and swinging for balance. Speed 0 = hanging on and looking up.
   */
  private climb(l: CatLook): void {
    const T = this.target;
    const v = l.speed;
    const go = clamp(Math.abs(v) / 1.4, 0, 1);
    const dir = v < -0.05 ? -1 : 1;
    const p = l.phase;
    const surf = CLIMB_SURFACE_F;
    // the body: nearly upright, the neck a little above its standing height and over the bark
    const surge = Math.sin((p * 2 + 0.1) * TAU) * 0.012 * go;
    this.placeNeck(0.09 + surge, 0.0, 1.38);
    T[CH.bodyRoll] = Math.sin(p * TAU) * 0.06 * go;
    T[CH.bodyYaw] = Math.sin(p * TAU + 0.6) * 0.05 * go;
    // a gentle arch keeps the belly on the bark
    T[CH.hipsB] = -0.08;
    T[CH.sp1B] = -0.04;
    T[CH.sp2B] = 0.04;
    T[CH.chestB] = 0.06;
    T[CH.chestS] = Math.sin(p * TAU) * 0.08 * go;
    T[CH.neckB] = -0.15;
    // where the paws go, relative to the neck (cat space, neck at about y 0.29 once lifted)
    const neckY = REST.neck.y + 0.09;
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      const F = FRONT[s];
      const H = HIND[s];
      // front: quick reach up (off the bark), then hooked in and sliding down past the body as it climbs
      let q = (p + (s === 0 ? 0 : 0.5)) % 1;
      if (dir < 0) q = 1 - q;
      const reach = q < 0.3 ? sm(q / 0.3) : 1 - (q - 0.3) / 0.7;
      const hang = s === 0 ? 0.6 : 0.35;
      const r = lerp(hang, reach, go);
      const fy = neckY + lerp(-0.02, 0.12, r) * (dir < 0 ? 0.8 : 1);
      const off = q < 0.3 ? Math.sin((q / 0.3) * Math.PI) * 0.035 * go : 0;
      this.front(s, sx * 0.036, fy, surf - 0.035 - off, 0);
      // claws in: the paw curled over onto the bark
      T[F.wrist] = -0.5 - 0.4 * (1 - r);
      T[F.paw] = -0.5;
      T[F.scap] = 0.3 * r;
      T[F.scapOut] = -sx * 0.1;
      this.pole(s, sx * 0.7, -1, -0.2);
      // hind: braced below, pushing in between the front reaches (both together, like a bound)
      let h = (p + 0.25 + (s === 0 ? 0 : 0.06)) % 1;
      if (dir < 0) h = 1 - h;
      const push = h < 0.45 ? h / 0.45 : 1 - sm((h - 0.45) / 0.55);
      const hy = neckY - lerp(0.25, 0.31, lerp(0.4, push, go));
      this.hind(s, sx * 0.06, hy, surf - 0.075, 0);
      T[H.plant] = 0;
      T[H.knee] = 0.6;
      T[H.hock] = -0.6 - 0.3 * push * go;
      T[H.paw] = -0.4;
    }
    // looking up the trunk (down it when backing down); ears back with the effort
    T[CH.gaze] = 1;
    T[CH.headP] = (this.carriesCamera ? 0.55 : 0.75 - 0.2 * go) * (dir < 0 ? -0.6 : 1);
    T[CH.headY] = 0;
    T[CH.headR] = 0;
    this.ears(0.55 + 0.2 * go, 0.4, 0.3);
    // the tail hangs down the trunk and swings for balance
    for (let i = 0; i < 5; i++) {
      T[TAIL.lift[i]] = i === 0 ? -0.9 : 0.05;
      T[TAIL.side[i]] = Math.sin(this.t * 2.4 - i * 0.7 + p * TAU) * (0.12 + 0.12 * go) * (0.4 + i * 0.2);
    }
    this.springs(GROUP.body, 16);
    this.springs(GROUP.frontL, 40);
    this.springs(GROUP.frontR, 40);
    this.springs(GROUP.hindL, 35);
    this.springs(GROUP.hindR, 35);
  }

  /**
   * The end of a climb: front paws hooked over a top edge, hauling up (elbows bend, chest rises over the
   * paws, hind legs scrabble), then tipping over onto the top. Uses actT / actLen (0.8 s if open ended).
   */
  private mantle(l: CatLook): void {
    const T = this.target;
    const a = l.actT ?? 0;
    const len = (l.actLen ?? 0) > 0 ? (l.actLen as number) : 0.8;
    const u = clamp01(a / len);
    const pull = sm(seg(u, 0.12, 0.7));
    const over = sm(seg(u, 0.6, 1));
    // from upright (hanging off the edge) to level (standing on the top)
    const pitch = lerp(1.3, 0.55, pull) * (1 - over) + 0.05 * over;
    this.placeNeck(lerp(0.0, 0.06, pull) * (1 - over), lerp(0.0, 0.05, pull) * (1 - over), pitch);
    T[CH.chestB] = -0.2 * pull * (1 - over);
    T[CH.hipsB] = 0.15 * pull * (1 - over);
    T[CH.neckB] = lerp(-0.1, 0.12, pull) * (1 - over);
    T[CH.gaze] = 1;
    T[CH.headP] = lerp(0.35, 0.05, pull);
    // the edge, relative to the neck: above the head at first, under the chest at the end
    const neckY = REST.neck.y;
    const edgeY = neckY + lerp(0.1, -0.12, pull) - 0.04 * over;
    for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
      const sx = s === 0 ? -1 : 1;
      const F = FRONT[s];
      const H = HIND[s];
      // the paws slap onto the top one after the other, then stay put while the body comes up past them
      const r = out3(seg(u, s === 0 ? 0 : 0.05, s === 0 ? 0.12 : 0.17));
      const fy = lerp(neckY + 0.02, edgeY, r) * (1 - over) + REST.wrist.y * over;
      const ff = lerp(0.17, 0.2 - 0.04 * pull, r) * (1 - over) + 0.09 * over;
      this.front(s, sx * 0.045, fy, ff, over);
      T[F.wrist] = -0.9 * r * (1 - over);
      T[F.paw] = -0.4 * r * (1 - over);
      this.pole(s, sx * 0.5, -0.6, -0.8);
      // hind legs scrabble against the face, alternating, then push off and come up
      const kick = Math.sin(a * 24 + s * Math.PI) * pull * (1 - over);
      const hy = lerp(neckY - 0.3, REST.hock.y, over) + 0.035 * Math.max(0, kick);
      const hf = lerp(CLIMB_SURFACE_F - 0.09, REST.hock.f, over) + 0.02 * kick;
      this.hind(s, sx * 0.05, hy, hf, -0.4 * pull * (1 - over));
      T[H.knee] = 0.5 * (1 - over);
    }
    this.ears(0.5 * (1 - over), 0.3 * (1 - over), 0.2);
    for (let i = 0; i < 5; i++) T[TAIL.lift[i]] = (i === 0 ? -0.5 : 0.1) * (1 - over) + Math.sin(this.t * 7 - i) * 0.05 * pull;
    this.springs(GROUP.body, 18);
    this.springs(GROUP.frontL, 40);
    this.springs(GROUP.frontR, 40);
    this.springs(GROUP.hindL, 40);
    this.springs(GROUP.hindR, 40);
  }
}

/** a proud tail: straight up from the base, the tip hooked over */
const GLOAT_TAIL = [-1.25, -0.25, -0.05, 0.25, 0.55];

/** where a climbed surface is: this far ahead of the cat's origin (about 9 cm in front of its chest) */
export const CLIMB_SURFACE_F = 0.27;

/**
 * How far tipping the body up by `pitch` (about the ground under the hips) pulls the shoulders back.
 * The fight moves add this back so a cat sitting back on its haunches keeps its shoulders over its paws.
 */
export function shoulderDrift(pitch: number): number {
  const rf = REST.shoulder.f - REST.pivotF;
  return rf * (1 - Math.cos(pitch)) + REST.shoulder.y * Math.sin(pitch);
}

function smoothstepRange(a: number, b: number, x: number): number {
  return sm(clamp01((x - a) / (b - a)));
}
