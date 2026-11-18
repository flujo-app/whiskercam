import { describe, expect, it } from 'vitest';
import { chooseLanguage, count, fill, LANGUAGES, num, S, setLanguage, word } from '../src/i18n';
import { en, type Strings } from '../src/i18n/en';
import { Score } from '../src/game/score';

const blanks = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string): number => (s.match(/<\/?b>/g) ?? []).length;

/** Walk a language next to English and report everything that does not line up. */
function compare(a: unknown, b: unknown, path: string, out: string[]): void {
  if (typeof a === 'string') {
    if (typeof b !== 'string') return void out.push(`${path}: not a text`);
    if (!b.trim()) out.push(`${path}: empty`);
    if (blanks(a).join() !== blanks(b).join()) out.push(`${path}: blanks differ (${blanks(a).join()} / ${blanks(b).join()})`);
    if (tags(a) !== tags(b)) out.push(`${path}: <b> tags differ`);
    return;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return void out.push(`${path}: not a list`);
    if (b.length < Math.min(3, a.length)) out.push(`${path}: only ${b.length} entries`);
    for (const [i, line] of b.entries()) if (typeof line !== 'string' || !line.trim()) out.push(`${path}[${i}]: empty`);
    return;
  }
  if (a && typeof a === 'object') {
    const A = a as Record<string, unknown>;
    const B = (b ?? {}) as Record<string, unknown>;
    // the forms of a word after a number: the language decides which it has, but there is always a general one
    if ('other' in A && Object.keys(A).every((k) => ['zero', 'one', 'two', 'few', 'many', 'other'].includes(k))) {
      if (typeof B.other !== 'string' || !B.other) out.push(`${path}: no general form`);
      return;
    }
    for (const key of Object.keys(A)) compare(A[key], B[key], `${path}.${key}`, out);
    for (const key of Object.keys(B)) if (!(key in A)) out.push(`${path}.${key}: not in the English original`);
  }
}

describe('languages', () => {
  it('every language has every text, with the same blanks to fill', async () => {
    for (const { code } of LANGUAGES) {
      await setLanguage(code);
      const problems: string[] = [];
      compare(en, S(), code, problems);
      expect(problems, `${code}:\n${problems.join('\n')}`).toEqual([]);
      expect(S().ranks.length, `${code}: ranks`).toBe(6);
      // and its locale is one the browser knows how to write numbers in
      expect(() => (1234567).toLocaleString(S().locale)).not.toThrow();
    }
    await setLanguage('en');
  });

  it('the clip title reads as a sentence in every language', async () => {
    for (const { code } of LANGUAGES) {
      await setLanguage(code);
      const s = new Score(() => 0.5);
      s.add('turf');
      s.add('tag', 'Rocket');
      for (let i = 0; i < 6; i++) s.add('knock', 'pot');
      const title = s.title('Biscuit');
      expect(title.startsWith('Biscuit ') || title.includes('Biscuit'), `${code}: ${title}`).toBe(true);
      expect(title, code).not.toMatch(/[{}]|undefined/);
      expect(title, code).toContain('6');
    }
    await setLanguage('en');
  });

  it('follows the browser unless the player chose', () => {
    expect(chooseLanguage('auto', ['de-AT', 'en'])).toBe('de');
    expect(chooseLanguage('auto', ['pt-BR'])).toBe('pt');
    expect(chooseLanguage('auto', ['ja', 'ko'])).toBe('en');
    expect(chooseLanguage('auto', ['ja', 'fr-CA', 'en'])).toBe('fr');
    expect(chooseLanguage('pl', ['de-DE'])).toBe('pl');
    expect(chooseLanguage('xx', ['nl'])).toBe('nl');
    expect(chooseLanguage('auto', [])).toBe('en');
  });

  it('falls back to English for a language it does not speak', async () => {
    await setLanguage('zz');
    expect(S().pause.resume).toBe('Carry on');
  });

  it('fills blanks and leaves unknown ones alone', () => {
    expect(fill('Follow {name}', { name: 'Rocket' })).toBe('Follow Rocket');
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });

  it('writes numbers and their words the way the language does', async () => {
    await setLanguage('en');
    expect(num(4175)).toBe('4,175');
    expect(count(1, S().end.views)).toBe('1 view');
    expect(count(4175, S().end.views)).toBe('4,175 views');
    await setLanguage('de');
    expect(count(4175, S().end.views)).toBe('4.175 Aufrufe');
    await setLanguage('pl');
    const f = (S() as Strings).end.views;
    expect(word(1, f)).toBe(f.one);
    expect(word(3, f)).toBe(f.few);
    expect(word(5, f)).toBe(f.many);
    expect(word(22, f)).toBe(f.few);
    await setLanguage('en');
  });
});
