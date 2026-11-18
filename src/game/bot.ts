import type { Controls } from '../engine/input';
import type { Game } from './game';
import { Nav } from './nav';

const DEG = Math.PI / 180;

/**
 * A simple player that plays by itself: follows the brother along the paths, fights rivals it
 * meets and swipes at things on the way. Used for automated play tests (tools/playtest.mjs).
 */
export class Bot {
  private readonly nav: Nav;
  private path: number[] = [];
  private pathIndex = 0;
  private replan = 0;
  private stuck = 0;
  private lastX = 0;
  private lastZ = 0;
  private swipeIn = 2;
  private backOff = 0;
  /** which cat to go after: the brother, or a rival's index */
  goal: 'brother' | number = 'brother';

  constructor(private readonly game: Game) {
    this.nav = new Nav(game.world.info.nav ?? { nodes: [[0, 0]], edges: [], ring: [0], home: 0 });
  }

  controls(dt: number): Controls {
    const c: Controls = { move: 0, turn: 0, yaw: 0, pitch: 0, sprint: false, jump: false, jumpHeld: true, pawLeft: false, pawRight: false, dodge: false, pause: false, any: false };
    const s = this.game.session;
    const p = this.game.player;

    if (s.phase === 'duel' && s.duel) {
      const d = s.duel;
      // wait, pull back when the paw comes up, hit back while it is off balance (flailing loses)
      const danger = (d.rivalState === 'windup' || d.rivalState === 'feint') && d.rivalT > d.windupLen - 0.3;
      if (d.playerState === 'ready') {
        if (danger) c.dodge = true;
        else if ((d.rivalState === 'recover' || d.rivalState === 'stagger') && d.stamina >= 0.16) c.pawLeft = true;
      }
      return c;
    }
    if (!s.active) return c;

    // where to?
    let tx: number;
    let tz: number;
    if (this.goal === 'brother') {
      tx = s.brother.x;
      tz = s.brother.z;
    } else {
      const r = s.rivals[this.goal];
      tx = r.npc.x;
      tz = r.npc.z;
    }
    const direct = Math.hypot(tx - p.x, tz - p.z);
    this.replan -= dt;
    if (this.replan <= 0 || this.pathIndex >= this.path.length) {
      this.replan = 1.5;
      this.path = this.nav.path(this.nav.nearest(p.x, p.z), this.nav.nearest(tx, tz));
      this.pathIndex = this.path.length > 1 ? 1 : 0;
    }
    let ax = tx;
    let az = tz;
    if (direct > 6 && this.pathIndex < this.path.length) {
      [ax, az] = this.nav.nodes[this.path[this.pathIndex]];
      if (Math.hypot(ax - p.x, az - p.z) < 1.4) this.pathIndex++;
    }
    const want = Math.atan2(ax - p.x, -(az - p.z)) / DEG;
    const diff = ((want - p.heading + 540) % 360) - 180;
    c.turn = Math.max(-1, Math.min(1, diff / 25));
    c.move = Math.abs(diff) > 100 ? 0.3 : 1;
    c.sprint = direct > 2.5 && Math.abs(diff) < 50;

    // not getting anywhere: hop, or back off and try again
    const moved = Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    this.lastX = p.x;
    this.lastZ = p.z;
    this.stuck = moved < 0.012 && c.move > 0.5 ? this.stuck + dt : 0;
    if (this.stuck > 0.5 && this.stuck < 0.56) c.jump = true;
    if (this.stuck > 1.4) {
      this.backOff = 0.7;
      this.stuck = 0;
      this.replan = 0;
    }
    if (this.backOff > 0) {
      this.backOff -= dt;
      c.move = -1;
      c.turn = 1;
    }
    // bat at whatever is around now and then
    this.swipeIn -= dt;
    if (this.swipeIn <= 0) {
      this.swipeIn = 1.2 + Math.random() * 2;
      c.pawLeft = true;
    }
    return c;
  }
}
