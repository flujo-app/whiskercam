/**
 * Keeps the game smooth without ever paying for it with a worse picture that buys nothing.
 *
 * The usual rule ("frames are late, so draw fewer points") assumes the device is held back by the number of
 * points it draws. Many phones are not: they are held back by the amount of geometry, and on those a smaller
 * picture is just a worse picture at the same speed. So this does not assume, it tries:
 *
 * - Frame times are averaged over stretches of fifty frames.
 * - Two slow stretches in a row: the smallest picture is tried for one stretch.
 * - Clearly faster (12 % or more)? Then a smaller picture stays: the middle size if that is as fast as the
 *   smallest, the smallest otherwise.
 * - Not faster? The full picture comes back for good, and the same test is made with leaving out grass, fur
 *   and far plants ("thrifty").
 *
 * What is judged is the time between frames as the player sees them. A change that makes the graphics chip
 * work less but does not bring frames any sooner is, to the player, no change, and is undone.
 */
export class Pacer {
  /** which picture size to use: 0 = full, 1 = middle, 2 = smallest */
  size = 0;
  /** leave out the grass, half the fur and the far plants */
  thrifty = false;

  /** frames slower than this on average (seconds) count as "cannot keep up": under about 47 pictures a second */
  static readonly SLOW = 0.0215;
  static readonly SPAN = 50;

  private sum = 0;
  private n = 0;
  private skip = 90;
  private slowSpans = 0;
  private trial: { what: 'small' | 'middle' | 'thrifty'; before: number } | null = null;
  private sizeSettled = false;
  private thriftSettled = false;

  /** Another picture setting was chosen: start from its full size and find out afresh. */
  restart(): void {
    this.size = 0;
    this.sizeSettled = false;
    this.trial = null;
    this.slowSpans = 0;
    this.sum = this.n = 0;
    this.skip = 60;
  }

  /**
   * One frame took `dt` seconds. `busy` = the game is doing something that makes frames late by itself
   * (pictures still arriving, reflections being taken): nothing is measured then.
   * Returns true when `size` or `thrifty` changed and the game has to follow.
   */
  frame(dt: number, busy = false): boolean {
    if (busy) this.skip = Math.max(this.skip, 45);
    // (a very long frame is the tab coming back from the background, not a slow device)
    if (dt > 0.25) this.skip = Math.max(this.skip, 30);
    if (this.skip > 0) {
      this.skip--;
      this.sum = this.n = 0;
      return false;
    }
    this.sum += dt;
    if (++this.n < Pacer.SPAN) return false;
    const avg = this.sum / this.n;
    this.sum = this.n = 0;
    const t = this.trial;
    if (t) {
      this.trial = null;
      if (t.what === 'small') {
        if (avg < t.before * 0.88) {
          // fewer points do make it faster here: is the middle size as fast?
          this.trial = { what: 'middle', before: avg };
          return this.resize(1);
        }
        this.sizeSettled = true;
        return this.resize(0);
      }
      if (t.what === 'middle') {
        this.sizeSettled = true;
        return avg > t.before * 1.1 ? this.resize(2) : false;
      }
      this.thriftSettled = true;
      if (avg > t.before * 0.9) {
        this.thrifty = false;
        this.skip = 12;
        return true;
      }
      return false;
    }
    if (avg <= Pacer.SLOW) {
      this.slowSpans = 0;
      return false;
    }
    if (++this.slowSpans < 2) return false;
    this.slowSpans = 0;
    if (!this.sizeSettled) {
      this.trial = { what: 'small', before: avg };
      return this.resize(2);
    }
    if (!this.thriftSettled) {
      this.trial = { what: 'thrifty', before: avg };
      this.thrifty = true;
      this.skip = 12;
      return true;
    }
    return false;
  }

  private resize(size: number): boolean {
    this.size = size;
    // (a new picture size means new buffers: the first frames after it are not typical)
    this.skip = 24;
    return true;
  }
}
