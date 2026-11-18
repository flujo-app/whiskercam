/**
 * The clip's audience. Everything the cat does is worth "views" once the clip is posted;
 * doing different things in a row builds hype, which multiplies them.
 */
import { catName, fill, S } from '../i18n';

export type Deed =
  | 'chase'       // keeping up with the brother (ticks)
  | 'tag'         // catching him
  | 'knock'       // something loose went flying
  | 'undercar'    // squeezed under a car
  | 'hedge'       // burst through a hedge
  | 'zoomies'     // a long flat-out sprint
  | 'jump'        // a proper leap
  | 'slap'        // landed a slap in a duel
  | 'counter'     // ... before the rival could
  | 'dodge'       // made the rival miss
  | 'turf'        // won a duel
  | 'flawless'    // ... without taking a hit
  | 'lostDuel'
  | 'pigeons'
  | 'meow'
  | 'climb'
  | 'mirror';     // stopped to look at the cat in the glass door

const BASE: Record<Deed, number> = {
  chase: 140, tag: 4500, knock: 900, undercar: 1400, hedge: 700, zoomies: 1200, jump: 450, slap: 350, counter: 800,
  dodge: 500, turf: 12000, flawless: 6000, lostDuel: 600, pigeons: 1500, meow: 250, climb: 2400, mirror: 1800,
};

/** views for knocking over each kind of thing (their names are in the language files, under `knocks`) */
const KNOCK_VIEWS: Record<string, number> = { pot: 1500, vase: 2200, gnome: 2600, can: 600, bottle: 700, ball: 400, sign: 1100, lid: 1300 };

export interface Popup {
  text: string;
  views: number;
  big: boolean;
}

export interface Comment {
  who: string;
  text: string;
  /** when it was said (seconds on the score's own clock) */
  t: number;
}

const NAMES = [
  'tabbycat_dad', 'mrs_whiskerson', 'not_a_dog_person', 'loaf_enjoyer', 'beans_inspector', 'kev_from_no_12', 'purrito99',
  'the_real_gran', 'window_bird_watcher', 'catnip_dealer', 'sock_thief', 'three_am_zoomer', 'box_resident', 'pspspsps',
  'vet_tech_lu', 'ginger_appreciator', 'cardboard_castle', 'toe_bean_counter', 'small_tiger_fan', 'nanna_pat',
];

export class Score {
  views = 0;
  hype = 1;
  turf = 0;
  readonly counts: Partial<Record<Deed, number>> = {};
  readonly popups: Popup[] = [];
  readonly comments: Comment[] = [];
  /** the last few things that earned views, with the time, for the recorded clip */
  readonly feed: { text: string; views: number; t: number }[] = [];
  /** the three best moments, for the clip title */
  readonly highlights: { text: string; views: number }[] = [];
  private readonly recent = new Map<Deed, number>();
  private time = 0;
  private nextIdle = 3;

  constructor(private readonly rand: () => number = Math.random) {}

  /** seconds this score has been running */
  get clock(): number {
    return this.time;
  }

  private pick<T>(list: T[]): T {
    return list[Math.floor(this.rand() * list.length) % list.length];
  }

  say(topic: string): void {
    const lines = S().lines as Record<string, string[]>;
    const pool = lines[topic] ?? lines.idle;
    this.comments.push({ who: this.pick(NAMES), text: this.pick(pool), t: this.time });
    if (this.comments.length > 40) this.comments.shift();
  }

  /**
   * Something happened. `detail` picks a special name (the kind of thing knocked over, the cat that was
   * caught). Returns the views earned.
   */
  add(deed: Deed, detail?: string, scale = 1): number {
    let base = BASE[deed];
    let label: string | undefined = (S().deeds as Record<string, string>)[deed];
    if (deed === 'tag' && label) label = fill(label, { name: catName(detail ?? 'Rocket') });
    if (deed === 'knock' && detail && KNOCK_VIEWS[detail]) {
      label = (S().knocks as Record<string, string>)[detail] ?? label;
      base = KNOCK_VIEWS[detail];
    }
    if (deed !== 'chase' && !this.recent.has(deed)) this.hype = Math.min(3, this.hype + 0.25);
    if (deed !== 'chase') this.recent.set(deed, this.time);
    const gain = Math.round(base * scale * this.hype);
    this.views += gain;
    this.counts[deed] = (this.counts[deed] ?? 0) + 1;
    if (deed === 'turf') this.turf++;
    if (label) {
      const big = gain >= 4000;
      this.popups.push({ text: label, views: gain, big });
      this.feed.push({ text: label, views: gain, t: this.time });
      if (this.feed.length > 6) this.feed.shift();
      this.highlights.push({ text: label, views: gain });
      this.highlights.sort((a, b) => b.views - a.views);
      this.highlights.length = Math.min(this.highlights.length, 3);
      if (this.rand() < (big ? 1 : 0.7)) this.say(deed === 'knock' && detail === 'gnome' ? 'gnome' : deed);
    }
    return gain;
  }

  update(dt: number): void {
    this.time += dt;
    for (const [deed, at] of this.recent) {
      if (this.time - at > 12) {
        this.recent.delete(deed);
        this.hype = Math.max(1, this.hype - 0.25);
      }
    }
    if (this.time > this.nextIdle) {
      this.nextIdle = this.time + 5 + this.rand() * 6;
      this.say('idle');
    }
  }

  drainPopups(): Popup[] {
    return this.popups.splice(0, this.popups.length);
  }

  /** Likes are a steady share of views; a little luck on top. */
  get likes(): number {
    return Math.round(this.views * 0.072);
  }

  rank(): string {
    const v = this.views;
    const step = v >= 400000 ? 5 : v >= 200000 ? 4 : v >= 90000 ? 3 : v >= 35000 ? 2 : v >= 10000 ? 1 : 0;
    const ranks = S().ranks;
    return ranks[Math.min(step, ranks.length - 1)];
  }

  /** A clip title made from what actually happened. */
  title(name: string): string {
    const w = S().clipTitle;
    const bits: string[] = [];
    if (this.turf >= 3) bits.push(w.turfAll);
    else if (this.turf > 0) bits.push(this.turf === 1 ? w.turfOne : w.turfTwo);
    if ((this.counts.tag ?? 0) > 0) bits.push(w.tag);
    else if ((this.counts.chase ?? 0) > 60) bits.push(w.chase);
    const knocks = this.counts.knock ?? 0;
    if (knocks >= 5) bits.push(fill(w.knocksMany, { n: knocks }));
    else if (knocks > 0) bits.push(w.knocksFew);
    if ((this.counts.undercar ?? 0) > 0 && bits.length < 3) bits.push(w.undercar);
    if (bits.length === 0) bits.push(w.quiet);
    const said = bits.slice(0, 3);
    const deeds = said.length > 1 ? `${said.slice(0, -1).join(w.comma)}${w.and}${said[said.length - 1]}` : said[0];
    return fill(w.pattern, { name, deeds });
  }
}
