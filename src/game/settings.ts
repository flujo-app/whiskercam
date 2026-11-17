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
  comments: boolean;
  record: boolean;
  best: number;
  runs: number;
}

const KEY = 'whiskercam.settings.v1';

export const defaults: Settings = {
  catName: 'Biscuit',
  coat: 'ginger',
  quality: 2,
  volume: 0.8,
  sensitivity: 1,
  motion: 1,
  comments: true,
  record: true,
  best: 0,
  runs: 0,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) };
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

/** Render scale for each quality step. */
export const QUALITY_SCALE = [0.62, 0.82, 1.0];
