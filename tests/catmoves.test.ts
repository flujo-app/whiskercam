import { describe, expect, it } from 'vitest';
import { restLook, type CatAct, type CatLook } from '../src/game/cats';
import { CatMoves, CH, CHANNELS, FRONT, REST } from '../src/game/catmoves';

const DT = 1 / 60;

function fightLook(): CatLook {
  return { ...restLook(), stance: 'fight', puff: 1, act: 'guard', actT: 0, actLen: 1, actSide: 1 };
}

/** Run a cat through `act` from its start for `seconds`, calling `probe` each frame with the time into the act. */
function play(m: CatMoves, l: CatLook, act: CatAct, len: number, side: -1 | 1, seconds: number, probe?: (t: number) => void): void {
  l.act = act;
  l.actLen = len;
  l.actSide = side;
  for (let t = 0; t <= seconds + 1e-9; t += DT) {
    l.actT = t;
    m.update(l, DT);
    probe?.(t);
  }
}

/** A rival that has been on guard for a second. */
function settledRival(seed = 7): { m: CatMoves; l: CatLook } {
  const m = new CatMoves(seed);
  const l = fightLook();
  play(m, l, 'guard', 1.2, 1, 1);
  return { m, l };
}

describe('cat moves', () => {
  it('every move gives finite joint values for both paws, fresh and tired, rival and player', () => {
    const acts: [CatAct, number][] = [
      ['guard', 1], ['windup', 0.42], ['windup', 0.62], ['feint', 0.35], ['strike', 0.16], ['recover', 0.5], ['recover', 0.85],
      ['stagger', 0.34], ['gloat', 0], ['flee', 0], ['slap', 0.2], ['dodge', 0.6], ['flinch', 0.4], ['swipe', 0.22], ['mantle', 0.8], ['climb', 0],
    ];
    for (const cam of [false, true]) {
      for (const tired of [0, 1]) {
        for (const side of [-1, 1] as const) {
          const m = new CatMoves(3);
          m.carriesCamera = cam;
          const l = fightLook();
          l.tired = tired;
          l.speed = 1.4;
          for (const [act, len] of acts) play(m, l, act, len, side, Math.max(0.3, len));
          for (let i = 0; i < CHANNELS; i++) expect(Number.isFinite(m.pose[i])).toBe(true);
        }
      }
    }
  });

  it('the windup shows which paw is coming within a tenth of a second', () => {
    for (const len of [0.42, 0.62]) {
      for (const side of [-1, 1] as const) {
        const { m, l } = settledRival();
        const strike = FRONT[side < 0 ? 0 : 1];
        const other = FRONT[side < 0 ? 1 : 0];
        play(m, l, 'windup', len, side, 0.1);
        // the striking paw is well off the ground and out on its own side; the other one stays down
        expect(m.pose[strike.y] - REST.wrist.y).toBeGreaterThan(0.04);
        expect(m.pose[strike.x] * side).toBeGreaterThan(0.03);
        expect(m.pose[other.y]).toBeLessThan(REST.wrist.y + 0.01);
        // by the end it is held up beside the head
        play(m, l, 'windup', len, side, len);
        expect(m.pose[strike.y]).toBeGreaterThan(0.25);
      }
    }
  });

  it('left and right windups mirror each other', () => {
    const a = settledRival(11);
    const b = settledRival(11);
    play(a.m, a.l, 'windup', 0.5, -1, 0.4);
    play(b.m, b.l, 'windup', 0.5, 1, 0.4);
    expect(a.m.pose[FRONT[0].y]).toBeCloseTo(b.m.pose[FRONT[1].y], 2);
    expect(a.m.pose[FRONT[0].f]).toBeCloseTo(b.m.pose[FRONT[1].f], 2);
    expect(a.m.pose[FRONT[0].x] + b.m.pose[FRONT[1].x]).toBeCloseTo(0, 1);
  });

  it('the swipe is furthest out when the hit lands (0.06 s) and snapped back by the end', () => {
    const { m, l } = settledRival();
    play(m, l, 'windup', 0.5, 1, 0.5);
    const reach: number[] = [];
    play(m, l, 'strike', 0.16, 1, 0.16, () => reach.push(m.pose[FRONT[1].f]));
    const hitFrame = Math.round(0.06 / DT);
    const best = reach.indexOf(Math.max(...reach));
    expect(Math.abs(best - hitFrame)).toBeLessThanOrEqual(2);
    expect(reach[hitFrame]).toBeGreaterThan(0.36);
    expect(reach[reach.length - 1]).toBeLessThan(reach[hitFrame] - 0.1);
    // the body lunges in with it
    expect(m.pose[CH.bodyF]).toBeGreaterThan(0);
  });

  it("the player's slap comes up in front of the lens, near the middle, when it lands", () => {
    const m = new CatMoves(5);
    m.carriesCamera = true;
    const l = fightLook();
    play(m, l, 'guard', 0, 1, 0.5);
    let atHit = { x: 0, y: 0, f: 0 };
    play(m, l, 'slap', 0.2, -1, 0.2, (t) => {
      if (Math.abs(t - 0.09) < DT / 2) atHit = { x: m.pose[FRONT[0].x], y: m.pose[FRONT[0].y], f: m.pose[FRONT[0].f] };
    });
    // the lens hangs at about y 0.115, f 0.165 in the cat's own space
    expect(atHit.f).toBeGreaterThan(0.21);
    expect(atHit.y).toBeGreaterThan(0.11);
    expect(Math.abs(atHit.x)).toBeLessThan(0.035);
    play(m, l, 'guard', 0, 1, 0.15);
    expect(m.pose[FRONT[0].y]).toBeLessThan(REST.wrist.y + 0.02);
  });

  it('climbing reaches up with the left paw, then the right', () => {
    const m = new CatMoves(9);
    const l: CatLook = { ...restLook(), act: 'climb', speed: 1.4, actT: 0, actLen: 0 };
    const at = (phase: number) => {
      for (let i = 0; i < 40; i++) {
        l.phase = phase;
        l.actT = (l.actT ?? 0) + DT;
        m.update(l, DT);
      }
      return m.pose[FRONT[0].y] - m.pose[FRONT[1].y];
    };
    expect(at(0.3)).toBeGreaterThan(0.05);
    expect(at(0.8)).toBeLessThan(-0.05);
  });

  it('a move left behind (its clock stopped) is dropped', () => {
    const { m, l } = settledRival();
    play(m, l, 'windup', 0.5, 1, 0.4);
    expect(m.pose[FRONT[1].y]).toBeGreaterThan(0.2);
    // nobody moves the clock on any more (a fight that ended leaves its last move in the look)
    for (let i = 0; i < 90; i++) m.update(l, DT);
    expect(m.pose[FRONT[1].y]).toBeLessThan(REST.wrist.y + 0.02);
  });
});
