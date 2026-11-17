import { describe, expect, it } from 'vitest';
import { Duel, LEVELS, PLAYER_NERVE, type DuelEvent } from '../src/game/duel';

const DT = 1 / 60;
const none = { slapLeft: false, slapRight: false, dodge: false };

/** Small repeatable random source. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function run(duel: Duel, seconds: number, input: (d: Duel, t: number) => typeof none): DuelEvent[] {
  const events: DuelEvent[] = [];
  for (let t = 0; t < seconds && !(duel.over && duel.rivalT > 0.2); t += DT) {
    duel.update(DT, input(duel, t));
    events.push(...duel.drain());
  }
  return events;
}

describe('slap duel', () => {
  it('a cat that never reacts loses its nerve', () => {
    const duel = new Duel(LEVELS[1], rng(3));
    const events = run(duel, 60, () => none);
    expect(duel.over).toBe('lost');
    expect(events.filter((e) => e.type === 'playerHit')).toHaveLength(PLAYER_NERVE);
  });

  it('pulling back when the paw comes up makes the rival miss', () => {
    const duel = new Duel(LEVELS[2], rng(7));
    const events = run(duel, 12, (d) => ({ ...none, dodge: d.rivalState === 'windup' && d.rivalT > LEVELS[2].windup - 0.25 && d.playerState === 'ready' }));
    expect(events.some((e) => e.type === 'dodged')).toBe(true);
    expect(events.some((e) => e.type === 'playerHit')).toBe(false);
  });

  it('slapping a rival that just missed always lands', () => {
    const duel = new Duel(LEVELS[3], rng(11));
    let landed = 0;
    let tried = 0;
    const events = run(duel, 40, (d) => {
      const dodge = d.rivalState === 'windup' && d.rivalT > LEVELS[3].windup - 0.2 && d.playerState === 'ready';
      const slap = d.rivalState === 'recover' && d.rivalT > 0.25 && d.playerState === 'ready';
      if (slap) tried++;
      return { slapLeft: slap, slapRight: false, dodge };
    });
    landed = events.filter((e) => e.type === 'rivalHit' && e.clean).length;
    expect(tried).toBeGreaterThan(0);
    expect(landed).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'blocked')).toBe(false);
    expect(duel.over).toBe('won');
  });

  it('good play wins without a scratch and says so', () => {
    const duel = new Duel(LEVELS[1], rng(5));
    const events = run(duel, 40, (d) => ({
      slapLeft: (d.rivalState === 'recover' || (d.rivalState === 'windup' && d.rivalT < 0.15)) && d.playerState === 'ready',
      slapRight: false,
      dodge: d.rivalState === 'windup' && d.rivalT > LEVELS[1].windup - 0.25 && d.playerState === 'ready',
    }));
    const won = events.find((e) => e.type === 'won');
    expect(won).toBeDefined();
    expect(won && won.type === 'won' && won.flawless).toBe(true);
  });

  it('mashing the paw gets blocked more and more', () => {
    let blocked = 0;
    let hits = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const duel = new Duel({ ...LEVELS[3], rivalNerve: 99 }, rng(seed));
      const events = run(duel, 6, (d) => ({ slapLeft: d.playerState === 'ready', slapRight: false, dodge: false }));
      blocked += events.filter((e) => e.type === 'blocked').length;
      hits += events.filter((e) => e.type === 'rivalHit').length;
    }
    expect(blocked).toBeGreaterThan(hits * 0.5);
  });

  it('every level can be won and lost', () => {
    for (const level of [1, 2, 3]) {
      const lose = new Duel(LEVELS[level], rng(level));
      run(lose, 90, () => none);
      expect(lose.over).toBe('lost');
      const win = new Duel(LEVELS[level], rng(level + 20));
      run(win, 120, (d) => ({
        slapLeft: d.rivalState === 'recover' && d.playerState === 'ready',
        slapRight: false,
        dodge: (d.rivalState === 'windup' || d.rivalState === 'feint') && d.rivalT > LEVELS[level].windup * 0.45 && d.playerState === 'ready',
      }));
      expect(win.over).toBe('won');
    }
  });
});
