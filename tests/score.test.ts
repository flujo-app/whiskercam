import { describe, expect, it } from 'vitest';
import { Nav } from '../src/game/nav';
import { Score } from '../src/game/score';

const fixed = () => 0.5;

describe('views', () => {
  it('different deeds in a row build hype, quiet time lets it drop again', () => {
    const s = new Score(fixed);
    const first = s.add('knock', 'pot');
    s.add('hedge');
    s.add('jump');
    expect(s.hype).toBeCloseTo(1.75);
    const later = s.add('knock', 'pot');
    expect(later).toBeGreaterThan(first);
    for (let t = 0; t < 30; t += 0.5) s.update(0.5);
    expect(s.hype).toBe(1);
  });

  it('hype never passes three times', () => {
    const s = new Score(fixed);
    for (const d of ['knock', 'hedge', 'jump', 'undercar', 'zoomies', 'tag', 'slap', 'counter', 'dodge', 'turf', 'flawless'] as const) s.add(d);
    expect(s.hype).toBe(3);
  });

  it('chasing ticks do not build hype on their own', () => {
    const s = new Score(fixed);
    for (let i = 0; i < 20; i++) s.add('chase');
    expect(s.hype).toBe(1);
    expect(s.views).toBe(20 * 140);
  });

  it('counts turf and names the clip after what happened', () => {
    const s = new Score(fixed);
    expect(s.title('Biscuit')).toBe('Biscuit goes for a quiet walk');
    s.add('turf', undefined, 2);
    s.add('tag');
    s.add('knock', 'gnome');
    expect(s.turf).toBe(1);
    expect(s.title('Biscuit')).toBe('Biscuit wins a turf war, finally catches his brother and knocks a pot off the wall');
    expect(s.highlights[0].views).toBeGreaterThanOrEqual(s.highlights[1].views);
  });

  it('ranks rise with views', () => {
    const s = new Score(fixed);
    expect(s.rank()).toBe('Indoor cat');
    s.views = 120000;
    expect(s.rank()).toBe('Local menace');
    s.views = 500000;
    expect(s.rank()).toBe('Internet famous');
  });
});

describe('paths', () => {
  // a square with one diagonal:  0 - 1
  //                               | \ |
  //                               3 - 2
  const nav = new Nav({
    nodes: [[0, 0], [10, 0], [10, 10], [0, 10]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]],
    ring: [0, 1, 2, 3],
    home: 0,
  });

  it('finds the short way', () => {
    expect(nav.path(0, 2)).toEqual([0, 2]);
    expect(nav.path(1, 3)).toHaveLength(3);
    expect(nav.path(2, 2)).toEqual([2]);
  });

  it('finds the nearest node', () => {
    expect(nav.nearest(9, 1)).toBe(1);
    expect(nav.nearest(-5, 12)).toBe(3);
  });

  it('wanders for about the asked distance without turning straight back', () => {
    let s = 9;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    const route = nav.wander(0, 45, rand);
    let length = 0;
    for (let i = 1; i < route.length; i++) {
      length += nav.dist(route[i - 1], route[i]);
      if (i >= 2) expect(route[i]).not.toBe(route[i - 2]);
    }
    expect(length).toBeGreaterThanOrEqual(45);
    expect(length).toBeLessThan(45 + 15);
  });
});
