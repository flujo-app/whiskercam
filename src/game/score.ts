/**
 * The clip's audience. Everything the cat does is worth "views" once the clip is posted;
 * doing different things in a row builds hype, which multiplies them.
 */

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
  | 'climb';

const BASE: Record<Deed, number> = {
  chase: 140, tag: 4500, knock: 900, undercar: 1400, hedge: 700, zoomies: 1200, jump: 450, slap: 350, counter: 800,
  dodge: 500, turf: 12000, flawless: 6000, lostDuel: 600, pigeons: 1500, meow: 250, climb: 2400,
};

const LABEL: Partial<Record<Deed, string>> = {
  tag: 'Tagged Rocket', knock: 'Knocked it over', undercar: 'Under the car', hedge: 'Through the hedge',
  zoomies: 'Zoomies', jump: 'Big jump', counter: 'Got in first', dodge: 'Made them miss', turf: 'Turf taken',
  flawless: 'Not a scratch', lostDuel: 'Took a slapping', pigeons: 'Scattered the pigeons', meow: 'Said hello', climb: 'Up a tree',
};

const KNOCK_NAMES: Record<string, [string, number]> = {
  pot: ['Pot, meet floor', 1500], vase: ['That was a nice vase', 2200], gnome: ['Gnome down', 2600], can: ['Kicked the can', 600],
  bottle: ['Bottle bowling', 700], ball: ['Ball!', 400], sign: ['Sign flattened', 1100], lid: ['Bin lid crash', 1300],
};

export interface Popup {
  text: string;
  views: number;
  big: boolean;
}

export interface Comment {
  who: string;
  text: string;
}

const NAMES = [
  'tabbycat_dad', 'mrs_whiskerson', 'not_a_dog_person', 'loaf_enjoyer', 'beans_inspector', 'kev_from_no_12', 'purrito99',
  'the_real_gran', 'window_bird_watcher', 'catnip_dealer', 'sock_thief', 'three_am_zoomer', 'box_resident', 'pspspsps',
  'vet_tech_lu', 'ginger_appreciator', 'cardboard_castle', 'toe_bean_counter', 'small_tiger_fan', 'nanna_pat',
];

const LINES: Record<string, string[]> = {
  idle: [
    'he is so low to the ground', 'the chin cam is sending me', 'where is he going', 'what a lovely day for crimes',
    'i can hear the little bell', 'who put a camera on this animal', 'this is better than tv', 'why am i nervous',
    'look at those whiskers', 'first', 'the commitment to the bit', 'cat tax paid in full',
  ],
  chase: ['GO GO GO', 'he is gaining', 'brothers.', 'the tabby is too fast', 'legs for days', 'CATCH HIM', 'olympic final energy'],
  tag: ['GOT HIM', 'tag you are it', 'justice', 'rocket in shambles', 'he let you win (he did not)'],
  knock: ['NOT THE POT', 'gravity check complete', 'no thoughts just push', 'he looked at it first. premeditated.', 'someone is paying for that', 'classic'],
  gnome: ['THE GNOME', 'rest in pieces little guy', 'the gnome had a family'],
  undercar: ['it went dark', 'under the car like a pro', 'liquid confirmed', 'mind the exhaust'],
  hedge: ['through the hedge!!', 'leaves everywhere', 'shortcut unlocked', 'hedge: 0 cat: 1'],
  zoomies: ['ZOOMIES', 'maximum speed achieved', 'somebody stop him', 'he has the speed of ten cats'],
  jump: ['AIR', 'ten out of ten landing', 'parkour'],
  slap: ['BAP', 'bap bap bap', 'right on the nose', 'hands rated E for everyone'],
  counter: ['he got in first!!', 'reflexes', 'read like a book'],
  dodge: ['matrix dodge', 'missed him', 'too slow'],
  playerHit: ['ouch', 'he felt that one', 'shake it off', 'that was personal'],
  turf: ['NEW KING', 'the bins are ours', 'he ran!!', 'respect earned', 'this is his estate now'],
  lostDuel: ['we go again', 'pain', 'that cat lifts', 'strategic retreat'],
  battery: ['battery is dying nooo', 'do not end here', 'someone charge this cat'],
  duelStart: ['oh no', 'here we go', 'that one looks mean', 'square up', 'ears are back. it is on.'],
  pigeons: ['PIGEONS', 'he has wanted to do that all day', 'chaos'],
  climb: ['HOW is he getting down', 'someone call the fire brigade', 'the view from up there', 'tree cat', 'he lives there now'],
  blocked: ['batted away', 'stop flailing!!', 'wait for it', 'patience, small tiger'],
  rivalWinded: ['he is puffed, GO', 'now now now', 'out of breath lol'],
  meow: ['he said hello', 'MEOW', 'talkative today', 'someone translate that', 'he is calling his brother'],
};

export class Score {
  views = 0;
  hype = 1;
  turf = 0;
  readonly counts: Partial<Record<Deed, number>> = {};
  readonly popups: Popup[] = [];
  readonly comments: Comment[] = [];
  /** the three best moments, for the clip title */
  readonly highlights: { text: string; views: number }[] = [];
  private readonly recent = new Map<Deed, number>();
  private time = 0;
  private nextIdle = 3;

  constructor(private readonly rand: () => number = Math.random) {}

  private pick<T>(list: T[]): T {
    return list[Math.floor(this.rand() * list.length) % list.length];
  }

  say(topic: string): void {
    const pool = LINES[topic] ?? LINES.idle;
    this.comments.push({ who: this.pick(NAMES), text: this.pick(pool) });
    if (this.comments.length > 40) this.comments.shift();
  }

  /** Something happened. `detail` picks a special name (kind of thing knocked over). Returns the views earned. */
  add(deed: Deed, detail?: string, scale = 1): number {
    let base = BASE[deed];
    let label = LABEL[deed];
    if (deed === 'knock' && detail && KNOCK_NAMES[detail]) [label, base] = KNOCK_NAMES[detail];
    if (deed !== 'chase' && !this.recent.has(deed)) this.hype = Math.min(3, this.hype + 0.25);
    if (deed !== 'chase') this.recent.set(deed, this.time);
    const gain = Math.round(base * scale * this.hype);
    this.views += gain;
    this.counts[deed] = (this.counts[deed] ?? 0) + 1;
    if (deed === 'turf') this.turf++;
    if (label) {
      const big = gain >= 4000;
      this.popups.push({ text: label, views: gain, big });
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
    if (v >= 400000) return 'Internet famous';
    if (v >= 200000) return 'Estate legend';
    if (v >= 90000) return 'Local menace';
    if (v >= 35000) return 'Street cat';
    if (v >= 10000) return 'Garden explorer';
    return 'Indoor cat';
  }

  /** A clip title made from what actually happened. */
  title(catName: string): string {
    const bits: string[] = [];
    if (this.turf >= 3) bits.push('takes over the whole estate');
    else if (this.turf > 0) bits.push(`wins ${this.turf === 1 ? 'a turf war' : 'two turf wars'}`);
    if ((this.counts.tag ?? 0) > 0) bits.push('finally catches his brother');
    else if ((this.counts.chase ?? 0) > 60) bits.push('chases his faster brother');
    const knocks = this.counts.knock ?? 0;
    if (knocks >= 5) bits.push(`knocks over ${knocks} things`);
    else if (knocks > 0) bits.push('knocks a pot off the wall');
    if ((this.counts.undercar ?? 0) > 0 && bits.length < 3) bits.push('goes under a car');
    if (bits.length === 0) bits.push('goes for a quiet walk');
    const body = bits.slice(0, 3).join(', ').replace(/, ([^,]*)$/, ' and $1');
    return `${catName} ${body}`;
  }
}
