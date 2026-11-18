/**
 * A slap fight, cat style: two cats face each other and bat at each other's heads until one loses its nerve.
 *
 * The rival shows what it is about to do (a paw comes up on one side). The player can
 *   - slap (left or right paw): lands when the rival is open, i.e. winding up, recovering or caught off guard
 *   - pull back: the rival's swipe misses and leaves it wide open for a moment
 *
 * Both cats have stamina. Every slap costs some; a slap at a rival that is on guard is mostly batted away,
 * which costs more, leaves the player open for a moment and brings an instant swipe back. So flailing loses:
 * the way to win is to wait, make the rival miss, and hit it while it is off balance or out of breath.
 * Pure logic, no drawing: the duel is fully testable and the visuals just follow `state`.
 */

export type RivalState = 'intro' | 'guard' | 'windup' | 'feint' | 'strike' | 'recover' | 'stagger' | 'flee' | 'gloat';
export type PlayerState = 'ready' | 'slap' | 'dodge' | 'flinch' | 'parried';

export interface DuelTuning {
  rivalNerve: number;
  /** seconds from the paw coming up to the swipe */
  windup: number;
  /** how long it watches between attacks (seconds, shortest and longest) */
  guard: [number, number];
  /** chance that a raised paw is a bluff */
  feint: number;
  /** chance that it bats away a slap while it is on guard and fresh */
  block: number;
  /** how much of its stamina one swipe costs it */
  effort: number;
}

export const LEVELS: Record<number, DuelTuning> = {
  1: { rivalNerve: 5, windup: 0.62, guard: [0.8, 1.4], feint: 0, block: 0.64, effort: 0.2 },
  2: { rivalNerve: 6, windup: 0.5, guard: [0.55, 1.1], feint: 0.16, block: 0.7, effort: 0.16 },
  3: { rivalNerve: 8, windup: 0.42, guard: [0.4, 0.9], feint: 0.3, block: 0.82, effort: 0.13 },
};

export const PLAYER_NERVE = 4;
const SLAP_TIME = 0.2;
const SLAP_HIT_AT = 0.09;
const SLAP_COOLDOWN = 0.14;
const DODGE_ACTIVE = 0.5;
const DODGE_TIME = 0.66;
const FLINCH_TIME = 0.4;
const PARRY_TIME = 0.24;
const STAGGER_TIME = 0.5;

/** What things cost the player, as a share of a full stamina bar, and how fast it comes back while waiting. */
export const STAMINA = { slap: 0.16, parried: 0.08, dodge: 0.05, dodged: 0.14, regen: 0.14 } as const;
/** A swipe straight back after batting a slap away comes this much quicker than a normal one. */
const RIPOSTE = 0.75;

export type DuelEvent =
  | { type: 'start' }
  | { type: 'windup'; side: -1 | 1; quick: boolean }
  | { type: 'rivalHit'; side: -1 | 1; counter: boolean; clean: boolean }
  | { type: 'blocked'; side: -1 | 1 }
  | { type: 'whiff'; side: -1 | 1 }
  | { type: 'playerHit'; side: -1 | 1 }
  | { type: 'dodged'; side: -1 | 1 }
  | { type: 'slap'; side: -1 | 1 }
  | { type: 'dodge' }
  | { type: 'tired' }
  | { type: 'rivalWinded' }
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
  /** 0..1; a rival that runs low is out of breath for a while: slower to recover and easy to hit */
  rivalStamina = 1;
  rivalWinded = false;
  /** how long the windup that is running now takes (a swipe straight back is quicker) */
  windupLen: number;

  playerState: PlayerState = 'ready';
  playerT = 0;
  playerSide: -1 | 1 = 1;
  playerNerve = PLAYER_NERVE;
  /** 0..1, shared with the rest of the game (sprinting uses the same breath) */
  stamina: number;
  private slapCool = 0;
  private slapLanded = false;
  private recentSlaps = 0;
  private guardFor = 1;
  private struck = false;
  private tookHit = false;
  private missed = false;
  over: 'won' | 'lost' | null = null;
  readonly events: DuelEvent[] = [];

  constructor(readonly tuning: DuelTuning, private readonly rand: () => number = Math.random, stamina = 1) {
    this.rivalNerve = tuning.rivalNerve;
    this.rivalNerveMax = tuning.rivalNerve;
    this.windupLen = tuning.windup;
    this.stamina = stamina;
    this.events.push({ type: 'start' });
  }

  private setRival(state: RivalState, quick = false): void {
    this.rivalState = state;
    this.rivalT = 0;
    this.struck = false;
    if (state === 'guard') {
      const [a, b] = this.tuning.guard;
      // out of breath: it hangs back for longer
      this.guardFor = (a + (b - a) * this.rand()) * (this.rivalWinded ? 1.7 : 1);
    }
    if (state === 'windup' || state === 'feint') {
      this.rivalSide = this.rand() < 0.5 ? -1 : 1;
      this.windupLen = this.tuning.windup * (quick ? RIPOSTE : 1);
      this.events.push({ type: 'windup', side: this.rivalSide, quick });
    }
  }

  private tireRival(amount: number): void {
    this.rivalStamina = Math.max(0, this.rivalStamina - amount);
    if (!this.rivalWinded && this.rivalStamina < 0.2) {
      this.rivalWinded = true;
      this.events.push({ type: 'rivalWinded' });
    }
  }

  private hitRival(counter: boolean, clean: boolean): void {
    this.rivalNerve -= 1;
    this.tireRival(0.06);
    this.events.push({ type: 'rivalHit', side: this.playerSide, counter, clean });
    if (this.rivalNerve <= 0) {
      this.over = 'won';
      this.setRival('flee');
      this.events.push({ type: 'won', flawless: !this.tookHit });
    } else if (this.rivalState === 'stagger') {
      // hit again while still reeling: it does not get to start reeling afresh (two quick slaps per opening, not ten)
    } else {
      this.setRival('stagger');
    }
  }

  /** Is the rival open to a slap right now? */
  private resolveSlap(): void {
    const t = this.tuning;
    switch (this.rivalState) {
      case 'recover':
      case 'stagger':
        this.hitRival(false, true);
        break;
      case 'windup':
        // strike first: an early slap stops the attack; a late one is too late, the swipe is already on its way
        if (this.rivalT < this.windupLen * 0.62) this.hitRival(true, false);
        else this.events.push({ type: 'whiff', side: this.playerSide });
        break;
      case 'guard':
      case 'feint':
      case 'intro': {
        // A watchful cat bats the paw away, more surely when the player just keeps flailing, far less when it
        // is out of breath. A slap that is batted away costs extra and brings a swipe straight back.
        let block = t.block + this.recentSlaps * 0.2;
        if (this.rivalWinded) block *= 0.35;
        if (this.rand() < Math.min(0.96, block)) {
          this.events.push({ type: 'blocked', side: this.playerSide });
          this.stamina = Math.max(0, this.stamina - STAMINA.parried);
          this.playerState = 'parried';
          this.playerT = 0;
          this.setRival('windup', true);
        } else {
          this.hitRival(false, false);
        }
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
    this.recentSlaps = Math.max(0, this.recentSlaps - dt * 1.1);

    // ---- the player
    if (!this.over) {
      if (this.playerState === 'ready') {
        this.stamina = Math.min(1, this.stamina + STAMINA.regen * dt);
        if (input.dodge) {
          this.playerState = 'dodge';
          this.playerT = 0;
          this.stamina = Math.max(0, this.stamina - STAMINA.dodge);
          this.events.push({ type: 'dodge' });
        } else if ((input.slapLeft || input.slapRight) && this.slapCool <= 0) {
          if (this.stamina < STAMINA.slap) {
            // out of breath: the paw comes up and nothing happens
            this.slapCool = 0.35;
            this.events.push({ type: 'tired' });
          } else {
            this.playerState = 'slap';
            this.playerT = 0;
            this.playerSide = input.slapLeft ? -1 : 1;
            this.slapLanded = false;
            this.recentSlaps += 1;
            this.stamina -= STAMINA.slap;
            this.events.push({ type: 'slap', side: this.playerSide });
          }
        }
      } else if (this.playerState === 'slap') {
        if (!this.slapLanded && this.playerT >= SLAP_HIT_AT) {
          this.slapLanded = true;
          this.resolveSlap();
        }
        if (this.playerState === 'slap' && this.playerT >= SLAP_TIME) {
          this.playerState = 'ready';
          this.slapCool = SLAP_COOLDOWN;
        }
      } else if (this.playerState === 'dodge') {
        if (this.playerT >= DODGE_TIME) this.playerState = 'ready';
      } else if (this.playerState === 'flinch') {
        if (this.playerT >= FLINCH_TIME) this.playerState = 'ready';
      } else if (this.playerState === 'parried') {
        if (this.playerT >= PARRY_TIME) this.playerState = 'ready';
      }
    }
    if (this.over === 'won') return;

    // ---- the rival
    if (this.rivalState === 'guard' || this.rivalState === 'intro') {
      this.rivalStamina = Math.min(1, this.rivalStamina + 0.11 * dt);
      if (this.rivalWinded && this.rivalStamina > 0.55) this.rivalWinded = false;
    }
    switch (this.rivalState) {
      case 'intro':
        if (this.rivalT > 0.9) this.setRival('guard');
        break;
      case 'guard':
        if (this.rivalT > this.guardFor) this.setRival(this.rand() < t.feint ? 'feint' : 'windup');
        break;
      case 'feint':
        if (this.rivalT > this.windupLen * 0.7) this.setRival('guard');
        break;
      case 'windup':
        if (this.rivalT > this.windupLen) this.setRival('strike');
        break;
      case 'strike':
        if (!this.struck && this.rivalT > 0.06) {
          this.struck = true;
          const dodging = this.playerState === 'dodge' && this.playerT < DODGE_ACTIVE;
          this.missed = dodging;
          this.tireRival(dodging ? t.effort * 1.8 : t.effort);
          if (dodging) {
            this.stamina = Math.min(1, this.stamina + STAMINA.dodged);
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
        if (this.rivalT > this.rivalLen) this.setRival('guard');
        break;
      case 'stagger':
        if (this.rivalT > STAGGER_TIME) this.setRival('guard');
        break;
      default:
        break;
    }
  }

  /** How long the rival's current move lasts from start to end, in seconds (0 = open ended). */
  get rivalLen(): number {
    switch (this.rivalState) {
      case 'intro': return 0.9;
      case 'guard': return this.guardFor;
      case 'feint': return this.windupLen * 0.7;
      case 'windup': return this.windupLen;
      case 'strike': return 0.16;
      // a swipe that hit nothing leaves the rival off balance for longer, and longer still when it is out of breath
      case 'recover': return (this.missed ? 0.85 : 0.5) + (this.rivalWinded ? 0.3 : 0);
      case 'stagger': return STAGGER_TIME;
      default: return 0;
    }
  }

  /** How long the player's current move lasts from start to end, in seconds (0 = open ended). */
  get playerLen(): number {
    switch (this.playerState) {
      case 'slap': return SLAP_TIME;
      case 'dodge': return DODGE_TIME;
      case 'flinch': return FLINCH_TIME;
      case 'parried': return PARRY_TIME;
      default: return 0;
    }
  }

  /** Hand the collected events to the caller and forget them. */
  drain(): DuelEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
