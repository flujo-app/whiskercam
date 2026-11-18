/**
 * Every word the game shows, in English. This file is the original: the other languages (de.ts, fr.ts, ...)
 * have exactly the same shape and are checked against it by the compiler.
 *
 * For translators:
 * - `{name}`, `{n}`, `{views}` and the like are filled in by the game: keep them as they are.
 * - `<b>…</b>` marks the name of a key or a button: keep the tags, translate what is between them only where
 *   it is a word (W, Q, E, Esc stay).
 * - The viewer comments (`lines`) are what people type under a cat video: lower case, short, silly. Translate
 *   the joke, not the words; a list may be longer or shorter than the English one.
 * - `forms(...)` holds the forms a word takes after a number ("1 view", "2 views"). Give every form the
 *   language has: `one`, `few`, `many`, `other` (the names come from the Unicode plural rules).
 */

/** The forms of a word after a number. `other` is the general one. */
export interface Plural {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export const forms = (f: Plural): Plural => f;

export const en = {
  /** the locale used for writing numbers (thousands separators) */
  locale: 'en-GB',

  page: {
    tagline: 'A day on the estate, filmed from under a cat’s chin.',
  },

  /** while the game loads, and when it cannot */
  boot: {
    waking: 'Waking the cat',
    unrolling: 'Unrolling the estate',
    camera: 'Checking the camera',
    claws: 'Sharpening claws',
    ready: 'Ready',
    noWebgl: 'This browser cannot show the game: it needs WebGL 2. A current Chrome, Edge, Firefox or Safari will work.',
    noFloat: 'This device’s graphics cannot show the game (no high-range colour buffers). Try another browser or device.',
    lost: 'The graphics card dropped the game. Reload the page to carry on.',
    failed: 'Could not start: {why}. Check the connection and reload the page.',
    fileMissing: 'a file did not load ({file})',
    fileMissingPlain: 'a file did not load',
  },

  title: {
    yourCat: 'Your cat',
    catName: 'Cat name',
    start: 'Start recording',
    goal: 'The camera battery lasts three minutes. Chase your brother, knock things over, climb a tree, win the turf. Everything earns views, and the run becomes a video you can post.',
    howTouch:
      '<b>Left thumb</b> run and steer (push far to sprint) &nbsp;·&nbsp; <b>right side</b> drag to look &nbsp;·&nbsp; <b>Jump</b> tap to pounce, hold to leap higher; with a car or a wall ahead the cat lands on it &nbsp;·&nbsp; <b>paws</b> slap things &nbsp;·&nbsp; push against a tree or a fence to climb it',
    howKeys:
      '<b>W</b> run &nbsp;·&nbsp; <b>Shift</b> sprint &nbsp;·&nbsp; <b>mouse</b> or <b>A / D</b> steer &nbsp;·&nbsp; <b>Space</b> tap to pounce, hold to leap higher; with a car or a wall ahead the cat lands on it &nbsp;·&nbsp; <b>click</b> or <b>Q / E</b> paws &nbsp;·&nbsp; <b>F</b> meow &nbsp;·&nbsp; push against a tree or a fence to climb &nbsp;·&nbsp; <b>S</b> pull back in a fight &nbsp;·&nbsp; <b>Esc</b> pause',
    /** {views} is a number with its word, e.g. "4,175 views" */
    best: 'Best clip so far: {views}',
    about: 'how it is made, credits',
  },

  coats: {
    ginger: 'Ginger',
    tabby: 'Tabby',
    black: 'Black',
    white: 'White',
    grey: 'Grey',
    tux: 'Tuxedo',
  },

  settings: {
    heading: 'Settings',
    picture: 'Picture',
    faster: 'Faster',
    balanced: 'Balanced',
    sharpest: 'Sharpest',
    sound: 'Sound',
    turning: 'Turning speed',
    shake: 'Camera shake',
    comments: 'Show viewer comments',
    record: 'Keep the clip as a video file',
    language: 'Language',
    /** the choice that follows the browser's language */
    automatic: 'Automatic',
  },

  pause: {
    heading: 'Paused',
    resume: 'Carry on',
    restart: 'Start over',
    menu: 'Back to menu',
  },

  /** the screen after a run, and the closing card written into the recorded clip */
  end: {
    posted: 'Clip posted',
    /** the word after the number of views */
    views: forms({ one: 'view', other: 'views' }),
    /** the word after the number of likes */
    likes: forms({ one: 'like', other: 'likes' }),
    turf: 'Turf {won} / {all}',
    best: 'Personal best',
    again: 'Run it back',
    menu: 'Menu',
    save: 'Save the clip',
    share: 'Share the clip',
    finishing: 'Finishing your clip…',
    note: 'Your run is a video, score and comments included. Post it as a Short, a Reel or a TikTok.',
    /** the text that goes with a shared clip; {views} is a number with its word */
    shareText: '{title}: {views} on Whiskercam. {link}',
  },

  /** the buttons on a touch screen */
  touch: {
    left: 'Left paw',
    right: 'Right paw',
    jump: 'Jump',
  },

  /** a fight with another cat */
  duel: {
    you: 'You',
    helpTouch: 'paw buttons: slap  ·  Jump button: pull back',
    helpKeys: 'click or Q / E: slap  ·  S or Space: pull back',
    breathe: 'Catch your breath',
    wait: 'Wait for the paw',
    batted: 'Batted away!',
    pull: 'Pull back!',
    puffed: 'Out of breath',
    rivalPuffed: 'It is out of breath: slap!',
    now: 'Now! Slap!',
  },

  /** short messages in the middle of the picture */
  hints: {
    follow: 'Follow {name}',
    tagged: 'Tagged {name}!',
    puffed: 'Out of breath',
    rivalPuffed: '{name} is out of breath',
    backOff: 'Ow. Back off for now',
    battery: 'Battery low',
    /** another cat stands its ground; one sentence per place, and one for any other place */
    guards: {
      'the bins': '{name} guards the bins',
      'the car port': '{name} guards the car port',
      'the square': '{name} guards the square',
      other: '{name} guards this spot',
    },
    /** the fight is won; one sentence per place, and one for any other place */
    won: {
      'the bins': 'The bins: yours now',
      'the car port': 'The car port: yours now',
      'the square': 'The square: yours now',
      other: 'This spot: yours now',
    },
  },

  /** the other cats (a name the game does not know is shown as it is) */
  names: {
    Rocket: 'Rocket',
    'Big Ginger': 'Big Ginger',
    Duchess: 'Duchess',
    'The Colonel': 'The Colonel',
  },

  /** what earns views: the label that pops up */
  deeds: {
    /** {name} is the brother */
    tag: 'Tagged {name}',
    knock: 'Knocked it over',
    undercar: 'Under the car',
    hedge: 'Through the hedge',
    zoomies: 'Zoomies',
    jump: 'Big jump',
    counter: 'Got in first',
    dodge: 'Made them miss',
    turf: 'Turf taken',
    flawless: 'Not a scratch',
    lostDuel: 'Took a slapping',
    pigeons: 'Scattered the pigeons',
    meow: 'Said hello',
    climb: 'Up a tree',
    mirror: 'Who is that?',
  },

  /** things knocked over */
  knocks: {
    pot: 'Pot, meet floor',
    vase: 'That was a nice vase',
    gnome: 'Gnome down',
    can: 'Kicked the can',
    bottle: 'Bottle bowling',
    ball: 'Ball!',
    sign: 'Sign flattened',
    lid: 'Bin lid crash',
  },

  /** what the run made of the cat, from the fewest views to the most */
  ranks: ['Indoor cat', 'Garden explorer', 'Street cat', 'Local menace', 'Estate legend', 'Internet famous'],

  /**
   * The title of the clip is put together from what happened: the cat's name, then up to three of these,
   * e.g. "Biscuit wins a turf war, finally catches his brother and knocks over 5 things".
   */
  clipTitle: {
    pattern: '{name} {deeds}',
    comma: ', ',
    and: ' and ',
    turfAll: 'takes over the whole estate',
    turfOne: 'wins a turf war',
    turfTwo: 'wins two turf wars',
    tag: 'finally catches his brother',
    chase: 'chases his faster brother',
    /** {n} is five or more */
    knocksMany: 'knocks over {n} things',
    knocksFew: 'knocks a pot off the wall',
    undercar: 'goes under a car',
    quiet: 'goes for a quiet walk',
  },

  /** what viewers type while the clip runs */
  lines: {
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
    mirror: [
      'HE SEES HIMSELF', 'who is that handsome cat', 'the other cat has a camera too', 'he does not know it is him',
      'main character moment', 'staring contest with himself', 'the cat in the door started it',
    ],
  },
};

export type Strings = typeof en;
