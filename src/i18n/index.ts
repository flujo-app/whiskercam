/**
 * Languages. English is built in; the others are fetched when they are wanted (a few kilobytes each).
 * `S()` hands out the words of the language in use: read it at the moment something is written to the
 * screen, never keep its result, so a change of language shows at once.
 */
import { en, type Plural, type Strings } from './en';

export type { Plural, Strings };

/** The languages on offer, each under its own name. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'pt', name: 'Português' },
  { code: 'tr', name: 'Türkçe' },
];

const LOADERS: Record<string, () => Promise<{ default: Strings }>> = {
  de: () => import('./de'),
  es: () => import('./es'),
  fr: () => import('./fr'),
  it: () => import('./it'),
  nl: () => import('./nl'),
  pl: () => import('./pl'),
  pt: () => import('./pt'),
  tr: () => import('./tr'),
};

let current: Strings = en;
let code = 'en';
let rules = new Intl.PluralRules('en');

/** The words of the language in use. */
export const S = (): Strings => current;

/** The code of the language in use ("en", "de", ...). */
export const language = (): string => code;

/**
 * Which language to use: the player's own choice, or with "auto" the first of the browser's languages
 * that the game speaks (so "de-AT" gets German, "pt-BR" Portuguese), or English.
 */
export function chooseLanguage(wanted: string, browser: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]): string {
  const known = (c: string) => LANGUAGES.some((l) => l.code === c);
  if (wanted !== 'auto' && known(wanted)) return wanted;
  for (const tag of browser) {
    const base = tag.toLowerCase().split('-')[0];
    if (known(base)) return base;
  }
  return 'en';
}

/** Switch to a language. If its words cannot be fetched, the game stays in English. */
export async function setLanguage(to: string): Promise<void> {
  let next = en;
  let nextCode = 'en';
  const load = LOADERS[to];
  if (load) {
    try {
      next = (await load()).default;
      nextCode = to;
    } catch {
      // no connection for the language file: English it is
    }
  }
  current = next;
  code = nextCode;
  rules = new Intl.PluralRules(nextCode);
  if (typeof document !== 'undefined') document.documentElement.lang = nextCode;
}

/** Fill the `{blanks}` of a sentence. */
export function fill(sentence: string, values: Record<string, string | number>): string {
  return sentence.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** A number the way the language writes it ("4,175" in English, "4.175" in German). */
export function num(n: number): string {
  return Math.round(n).toLocaleString(current.locale);
}

/** The form of a word that goes with a number ("view" with 1, "views" with 2). */
export function word(n: number, f: Plural): string {
  return f[rules.select(Math.round(n))] ?? f.other;
}

/** A number with its word: "4,175 views". */
export function count(n: number, f: Plural): string {
  return `${num(n)} ${word(n, f)}`;
}

/** The name of another cat in this language (or as it is, where the game has no translation). */
export function catName(name: string): string {
  return (current.names as Record<string, string>)[name] ?? name;
}
