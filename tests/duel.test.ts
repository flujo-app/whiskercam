import { describe, expect, it } from 'vitest';
import { Duel, LEVELS, PLAYER_NERVE, STAMINA, type DuelEvent } from '../src/game/duel';

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

/** Hammer both paws as fast as the game allows and never pull back. */
const mash = (d: Duel) => ({ slapLeft: d.playerState === 'ready', slapRight: false, dodge: false });

/** Wait, pull back when the paw comes up, hit back while the rival is off balance. */
const patient = (d: Duel) => ({
  slapLeft: (d.rivalState === 'recover' || d.rivalState === 'stagger') && d.playerState === 'ready' && d.stamina >= STAMINA.slap,
  slapRight: false,
  dodge: (d.rivalState === 'windup' || d.rivalState === 'feint') && d.rivalT > d.windupLen - 0.25 && d.playerState === 'ready',
});

function wins(level: number, play: (d: Duel) => typeof none, games = 60): number {
  let won = 0;
  for (let seed = 1; seed <= games; seed++) {
    const duel = new Duel(LEVELS[level], rng(seed * 7 + level));
    run(duel, 150, play);
    if (duel.over === 'won') won++;
  }
  return won / games;
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
    const events = run(duel, 12, (d) => ({ ...none, dodge: d.rivalState === 'windup' && d.rivalT > d.windupLen - 0.25 && d.playerState === 'ready' }));
    expect(events.some((e) => e.type === 'dodged')).toBe(true);
    expect(events.some((e) => e.type === 'playerHit')).toBe(false);
  });

  it('slapping a rival that just missed always lands', () => {
    const duel = new Duel(LEVELS[3], rng(11));
    let tried = 0;
    const events = run(duel, 60, (d) => {
      const dodge = d.rivalState === 'windup' && d.rivalT > d.windupLen - 0.2 && d.playerState === 'ready';
      const slap = d.rivalState === 'recover' && d.rivalT > 0.25 && d.playerState === 'ready' && d.stamina >= STAMINA.slap;
      if (slap) tried++;
      return { slapLeft: slap, slapRight: false, dodge };
    });
    const landed = events.filter((e) => e.type === 'rivalHit' && e.clean).length;
    expect(tried).toBeGreaterThan(0);
    expect(landed).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'blocked')).toBe(false);
    expect(duel.over).toBe('won');
  });

  it('good play wins without a scratch and says so', () => {
    const duel = new Duel(LEVELS[1], rng(5));
    const events = run(duel, 60, patient);
    const won = events.find((e) => e.type === 'won');
    expect(won).toBeDefined();
    expect(won && won.type === 'won' && won.flawless).toBe(true);
  });

  it('mashing the paw gets batted away more often than it lands', () => {
    let blocked = 0;
    let hits = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const duel = new Duel({ ...LEVELS[3], rivalNerve: 99 }, rng(seed));
      const events = run(duel, 6, mash);
      blocked += events.filter((e) => e.type === 'blocked').length;
      hits += events.filter((e) => e.type === 'rivalHit').length;
    }
    expect(blocked).toBeGreaterThan(hits * 0.5);
  });

  it('mashing loses against every rival', () => {
    // the complaint about 1.0: "simply spamming Q/E wins every fight"
    for (const level of [1, 2, 3]) expect(wins(level, mash)).toBeLessThan(0.12);
  });

  it('waiting, pulling back and hitting back wins against every rival', () => {
    expect(wins(1, patient)).toBeGreaterThan(0.95);
    expect(wins(2, patient)).toBeGreaterThan(0.9);
    expect(wins(3, patient)).toBeGreaterThan(0.8);
  });

  it('a cat that is out of breath cannot slap, and gets its breath back by waiting', () => {
    const duel = new Duel({ ...LEVELS[1], guard: [50, 50] }, rng(2), 0.05);
    duel.update(DT, { slapLeft: true, slapRight: false, dodge: false });
    const events = duel.drain();
    expect(events.some((e) => e.type === 'tired')).toBe(true);
    expect(events.some((e) => e.type === 'slap')).toBe(false);
    for (let t = 0; t < 3; t += DT) duel.update(DT, none);
    expect(duel.stamina).toBeGreaterThan(STAMINA.slap);
  });

  it('a slap that is batted away costs extra and brings a quicker swipe straight back', () => {
    // a rival that blocks everything and would otherwise wait for a long time
    const duel = new Duel({ ...LEVELS[1], block: 1, guard: [50, 50] }, rng(4));
    for (let t = 0; t < 1.2; t += DT) duel.update(DT, none); // let the opening stare pass
    duel.drain();
    const before = duel.stamina;
    const events: DuelEvent[] = [];
    duel.update(DT, { slapLeft: true, slapRight: false, dodge: false });
    for (let t = 0; t < 0.2; t += DT) {
      duel.update(DT, none);
      events.push(...duel.drain());
    }
    expect(events.some((e) => e.type === 'blocked')).toBe(true);
    const back = events.find((e) => e.type === 'windup');
    expect(back && back.type === 'windup' && back.quick).toBe(true);
    expect(duel.windupLen).toBeLessThan(LEVELS[1].windup);
    expect(before - duel.stamina).toBeGreaterThan(STAMINA.slap + STAMINA.parried - 0.03);
  });

  it('a rival that keeps missing runs out of breath and is then easy to hit', () => {
    const duel = new Duel({ ...LEVELS[3], rivalNerve: 99 }, rng(9));
    const events = run(duel, 40, (d) => ({ ...none, dodge: (d.rivalState === 'windup' || d.rivalState === 'feint') && d.rivalT > d.windupLen - 0.22 && d.playerState === 'ready' }));
    expect(events.some((e) => e.type === 'rivalWinded')).toBe(true);
  });

  it('every level can be won and lost', () => {
    for (const level of [1, 2, 3]) {
      const lose = new Duel(LEVELS[level], rng(level));
      run(lose, 90, () => none);
      expect(lose.over).toBe('lost');
      const win = new Duel(LEVELS[level], rng(level + 20));
      run(win, 150, patient);
      expect(win.over).toBe('won');
    }
  });
});
