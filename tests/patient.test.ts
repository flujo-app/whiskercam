import { describe, expect, it } from 'vitest';
import { patient } from '../src/engine/patient';

describe('patient downloads', () => {
  it('hands back the result of a job that works first time', async () => {
    let runs = 0;
    const got = await patient(async () => {
      runs++;
      return 'wall';
    });
    expect(got).toBe('wall');
    expect(runs).toBe(1);
  });

  it('tries again after a hiccup', async () => {
    let runs = 0;
    const got = await patient(
      async () => {
        runs++;
        if (runs < 3) throw new Error('503');
        return 'wall';
      },
      4,
      1,
    );
    expect(got).toBe('wall');
    expect(runs).toBe(3);
  });

  it('does not try again when the failure is final (a file that is not there)', async () => {
    let runs = 0;
    await expect(
      patient(
        async () => {
          runs++;
          throw Object.assign(new Error('404'), { final: true });
        },
        4,
        1,
      ),
    ).rejects.toThrow('404');
    expect(runs).toBe(1);
  });

  it('gives up after the last try and passes the failure on', async () => {
    let runs = 0;
    await expect(
      patient(
        async () => {
          runs++;
          throw new Error('gone');
        },
        3,
        1,
      ),
    ).rejects.toThrow('gone');
    expect(runs).toBe(3);
  });
});
