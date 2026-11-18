import type { Coat } from './cats';

/** What the player chose; kept in the browser between visits. */
export interface Settings {
  catName: string;
  coat: Coat;
  /** 0 = low, 1 = medium, 2 = high */
  quality: number;
  volume: number;
  /** mouse / touch turning speed, 0.4 .. 2 */
  sensitivity: number;
  /** how much the camera bobs and shakes, 0 .. 1 */
  motion: number;
  /** the player has moved the shake slider (until then the device decides) */
  motionChosen: boolean;
  comments: boolean;
  record: boolean;
  best: number;
  runs: number;
  /** which set of defaults these were saved under (see `loadSettings`) */
  version: number;
  /** "auto" (the browser's language) or the code of a language the game speaks */
  language: string;
}

const KEY = 'whiskercam.settings.v1';

export const defaults: Settings = {
  catName: 'Biscuit',
  coat: 'ginger',
  quality: 2,
  volume: 0.8,
  sensitivity: 2,
  motion: 0,
  motionChosen: false,
  comments: true,
  record: true,
  best: 0,
  runs: 0,
  version: 2,
  language: 'auto',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Settings>;
      if ((stored.version ?? 1) < 2) {
        // 1.2.1 changed what a new player starts with: the sharpest picture (the lower steps used to be far
        // too coarse, and phones started on one of them), the steadiest camera, the quickest turning.
        // Whoever played before gets the same start, once; a camera shake they chose themselves is kept.
        stored.quality = defaults.quality;
        if (stored.sensitivity === undefined || stored.sensitivity === 1) stored.sensitivity = defaults.sensitivity;
        if (!stored.motionChosen) stored.motion = defaults.motion;
        stored.version = 2;
      }
      return { ...defaults, ...stored };
    }
  } catch {
    // private window or blocked storage: carry on with defaults
  }
  return { ...defaults };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // nothing to do: the game works without remembering
  }
}

/**
 * How finely the two views behind the fisheye picture are drawn at each picture setting ("Faster",
 * "Balanced", "Sharpest"). None of them is coarse: the lowest still draws about as many points as the
 * screen shows.
 */
export const QUALITY_SCALE = [0.85, 1.0, 1.25];
/** Most picture lines drawn for each quality step. */
export const QUALITY_LINES = [1200, 1440, 1600];
