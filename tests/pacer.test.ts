import { describe, expect, it } from 'vitest';
import { Pacer } from '../src/engine/pacer';

/**
 * Play `seconds` on a made-up device whose frame time depends on the picture size and on "thrifty".
 * Frames arrive on the beat of a 60 Hz screen, as they do in a browser: a frame that takes 20 ms of work is
 * shown after 33 ms.
 */
function play(pacer: Pacer, work: (size: number, thrifty: boolean) => number, seconds = 40, screen = 1 / 60): number {
  let changes = 0;
  for (let t = 0; t < seconds; ) {
    const dt = Math.max(1, Math.ceil(work(pacer.size, pacer.thrifty) / screen - 1e-6)) * screen;
    if (pacer.frame(dt)) changes++;
    t += dt;
  }
  return changes;
}

describe('picture size follows what the device can really do', () => {
  it('leaves a fast device alone', () => {
    const p = new Pacer();
    expect(play(p, () => 0.008)).toBe(0);
    expect(p.size).toBe(0);
    expect(p.thrifty).toBe(false);
  });

  it('gives a phone that is held back by geometry its full picture back', () => {
    // 28 ms of work whatever the picture size, and thinning the plants does not help either
    const p = new Pacer();
    const changes = play(p, () => 0.028);
    expect(p.size).toBe(0);
    expect(p.thrifty).toBe(false);
    // it tried each once (small picture and back, thrifty and back) and then left the picture in peace
    expect(changes).toBe(4);
    expect(play(p, () => 0.028, 60)).toBe(0);
  });

  it('keeps the smallest picture where only that is fast', () => {
    const p = new Pacer();
    play(p, (size) => [0.03, 0.022, 0.015][size]);
    expect(p.size).toBe(2);
  });

  it('settles for the middle size where that is as fast as the smallest', () => {
    const p = new Pacer();
    play(p, (size) => [0.03, 0.015, 0.012][size]);
    expect(p.size).toBe(1);
  });

  it('thins out grass and fur only where that is what helps', () => {
    const p = new Pacer();
    play(p, (_size, thrifty) => (thrifty ? 0.015 : 0.03));
    expect(p.size).toBe(0);
    expect(p.thrifty).toBe(true);
  });

  it('does not judge while pictures are still loading, or after the tab was away', () => {
    const p = new Pacer();
    for (let i = 0; i < 2000; i++) expect(p.frame(0.05, true)).toBe(false);
    expect(p.size).toBe(0);
    // one frame of two seconds (the tab was in the background) among fast ones changes nothing
    for (let i = 0; i < 400; i++) p.frame(i === 200 ? 2 : 0.01);
    expect(p.size).toBe(0);
  });

  it('starts afresh when the player picks another picture setting', () => {
    const p = new Pacer();
    play(p, (size) => [0.03, 0.022, 0.015][size]);
    expect(p.size).toBe(2);
    p.restart();
    expect(p.size).toBe(0);
    play(p, () => 0.008);
    expect(p.size).toBe(0);
  });
});
