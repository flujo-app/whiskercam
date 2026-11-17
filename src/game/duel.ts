/**
 * A slap fight, cat style: two cats face each other and bat at each other's heads until one loses its nerve.
 *
 * The rival shows what it is about to do (a paw comes up on one side). The player can
 *   - slap (left or right paw): lands when the rival is open, i.e. winding up, recovering or caught off guard
 *   - pull back: the rival's swipe misses and leaves it wide open for a moment
 * Pure logic, no drawing: the duel is fully testable and the visuals just follow `state`.
 */

export type RivalState = 'intro' | 'guard' | 'windup' | 'feint' | 'strike' | 'recover' | 'stagger' | 'flee' | 'gloat';
export type PlayerState = 'ready' | 'slap' | 'dodge' | 'flinch';

export interface DuelTuning {
  rivalNerve: number;
  windup: number;
  guard: [number, number];
  feint: number;
  block: number;
}

export const LEVELS: Record<number, DuelTuning> = {
  1: { rivalNerve: 5, windup: 0.62, guard: [0.8, 1.4], feint: 0, block: 0.2 },
  2: { rivalNerve: 6, windup: 0.5, guard: [0.55, 1.1], feint: 0.16, block: 0.38 },
  3: { rivalNerve: 8, windup: 0.42, guard: [0.4, 0.9], feint: 0.3, block: 0.52 },
};

export const PLAYER_NERVE = 4;
const SLAP_TIME = 0.2;
const SLAP_HIT_AT = 0.09;
const SLAP_COOLDOWN = 0.14;
const DODGE_ACTIVE = 0.4;
const DODGE_TIME = 0.6;
const FLINCH_TIME = 0.4;

export type DuelEvent =
  | { type: 'start' }
  | { type: 'windup'; side: -1 | 1 }
  | { type: 'rivalHit'; side: -1 | 1; counter: boolean; clean: boolean }
  | { type: 'blocked'; side: -1 | 1 }
  | { type: 'whiff'; side: -1 | 1 }
  | { type: 'playerHit'; side: -1 | 1 }
  | { type: 'dodged'; side: -1 | 1 }
  | { type: 'slap'; side: -1 | 1 }
  | { type: 'dodge' }
  | { type: 'won'; flawless: boolean }
  | { type: 'lost' };

export interface DuelInput {
  slapLeft: boolean;
  slapRight: boolean;
  dodge: boolean;
}

export class Duel {
  rivalState: RivalState = 'intro';
  rivalT = 0;
  /** which paw the rival is using: -1 = its left (the player's right-hand side of the screen), +1 = its right */
  rivalSide: -1 | 1 = 1;
  rivalNerve: number;
  readonly rivalNerveMax: number;

  playerState: PlayerState = 'ready';
  playerT = 0;
  playerSide: -1 | 1 = 1;
  playerNerve = PLAYER_NERVE;
  private slapCool = 0;
  private slapLanded = false;
  private recentSlaps = 0;
  private guardFor = 1;
  private struck = false;
  private tookHit = false;
  private missed = false;
  over: 'won' | 'lost' | null = null;
  readonly events: DuelEvent[] = [];

  constructor(readonly tuning: DuelTuning, private readonly rand: () => number = Math.random) {
    this.rivalNerve = tuning.rivalNerve;
    this.rivalNerveMax = tuning.rivalNerve;
    this.events.push({ type: 'start' });
  }

  private setRival(state: RivalState): void {
    this.rivalState = state;
    this.rivalT = 0;
    this.struck = false;
    if (state === 'guard') {
      const [a, b] = this.tuning.guard;
      this.guardFor = a + (b - a) * this.rand();
    }
    if (state === 'windup' || state === 'feint') {
      this.rivalSide = this.rand() < 0.5 ? -1 : 1;
      this.events.push({ type: 'windup', side: this.rivalSide });
    }
  }

  private hitRival(counter: boolean, clean: boolean): void {
    this.rivalNerve -= 1;
    this.events.push({ type: 'rivalHit', side: this.playerSide, counter, clean });
    if (this.rivalNerve <= 0) {
      this.over = 'won';
      this.setRival('flee');
      this.events.push({ type: 'won', flawless: !this.tookHit });
    } else {
      this.setRival('stagger');
    }
  }

  /** Is the rival open to a slap right now? */
  private resolveSlap(): void {
    const t = this.tuning;
    switch (this.rivalState) {
      case 'recover':
        this.hitRival(false, true);
        break;
      case 'windup':
        // strike first: an early slap stops the attack, a late one still lands but so does the rival's
        if (this.rivalT < t.windup * 0.62) this.hitRival(true, false);
        else {
          this.rivalNerve -= 1;
          this.events.push({ type: 'rivalHit', side: this.playerSide, counter: false, clean: false });
          if (this.rivalNerve <= 0) {
            this.over = 'won';
            this.setRival('flee');
            this.events.push({ type: 'won', flawless: !this.tookHit });
          }
        }
        break;
      case 'guard':
      case 'feint':
      case 'intro': {
        // a watchful cat bats the paw away, more often when the player just keeps flailing
        const block = Math.min(0.9, t.block + this.recentSlaps * 0.22);
        if (this.rand() < block) this.events.push({ type: 'blocked', side: this.playerSide });
        else this.hitRival(false, false);
        break;
      }
      default:
        this.events.push({ type: 'whiff', side: this.playerSide });
    }
  }

  update(dt: number, input: DuelInput): void {
    if (this.over && this.rivalState !== 'flee' && this.rivalState !== 'gloat') return;
    const t = this.tuning;
    this.rivalT += dt;
    this.playerT += dt;
    this.slapCool = Math.max(0, this.slapCool - dt);
    this.recentSlaps = Math.max(0, this.recentSlaps - dt * 1.4);

    // ---- the player
    if (!this.over) {
      if (this.playerState === 'ready') {
        if (input.dodge) {
          this.playerState = 'dodge';
          this.playerT = 0;
          this.events.push({ type: 'dodge' });
        } else if ((input.slapLeft || input.slapRight) && this.slapCool <= 0) {
          this.playerState = 'slap';
          this.playerT = 0;
          this.playerSide = input.slapLeft ? -1 : 1;
          this.slapLanded = false;
          this.recentSlaps += 1;
          this.events.push({ type: 'slap', side: this.playerSide });
        }
      } else if (this.playerState === 'slap') {
        if (!this.slapLanded && this.playerT >= SLAP_HIT_AT) {
          this.slapLanded = true;
          this.resolveSlap();
        }
        if (this.playerT >= SLAP_TIME) {
          this.playerState = 'ready';
          this.slapCool = SLAP_COOLDOWN;
        }
      } else if (this.playerState === 'dodge') {
        if (this.playerT >= DODGE_TIME) this.playerState = 'ready';
      } else if (this.playerState === 'flinch') {
        if (this.playerT >= FLINCH_TIME) this.playerState = 'ready';
      }
    }
    if (this.over === 'won') return;

    // ---- the rival
    switch (this.rivalState) {
      case 'intro':
        if (this.rivalT > 0.9) this.setRival('guard');
        break;
      case 'guard':
        if (this.rivalT > this.guardFor) this.setRival(this.rand() < t.feint ? 'feint' : 'windup');
        break;
      case 'feint':
        if (this.rivalT > t.windup * 0.7) this.setRival('guard');
        break;
      case 'windup':
        if (this.rivalT > t.windup) this.setRival('strike');
        break;
      case 'strike':
        if (!this.struck && this.rivalT > 0.06) {
          this.struck = true;
          const dodging = this.playerState === 'dodge' && this.playerT < DODGE_ACTIVE;
          this.missed = dodging;
          if (dodging) {
            this.events.push({ type: 'dodged', side: this.rivalSide });
          } else if (!this.over) {
            this.playerNerve -= 1;
            this.tookHit = true;
            this.playerState = 'flinch';
            this.playerT = 0;
            this.events.push({ type: 'playerHit', side: this.rivalSide });
            if (this.playerNerve <= 0) {
              this.over = 'lost';
              this.events.push({ type: 'lost' });
              this.setRival('gloat');
              return;
            }
          }
        }
        if (this.rivalT > 0.16) this.setRival('recover');
        break;
      case 'recover':
        // a swipe that hit nothing leaves the rival off balance for longer
        if (this.rivalT > (this.missed ? 0.85 : 0.5)) this.setRival('guard');
        break;
      case 'stagger':
        if (this.rivalT > 0.34) this.setRival('guard');
        break;
      default:
        break;
    }
  }

  /** Hand the collected events to the caller and forget them. */
  drain(): DuelEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
