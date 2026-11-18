import type { Coat } from '../game/cats';
import type { Session } from '../game/session';
import { RUN_SECONDS } from '../game/session';
import type { Settings } from '../game/settings';
import { catName, count, fill, LANGUAGES, num, S, word } from '../i18n';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const fmt = num;
const clock = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const COATS: [Coat, string][] = [
  ['ginger', '#c9742c'],
  ['tabby', '#7a6248'],
  ['black', '#1c1c1f'],
  ['white', '#e9e6df'],
  ['grey', '#7d848c'],
  ['tux', '#2a2a2e'],
];

export interface HudActions {
  play(): void;
  resume(): void;
  restart(): void;
  toMenu(): void;
  saveClip(): void;
  shareClip(): void;
  settingsChanged(): void;
  press(name: string, held: boolean): void;
  release(name: string): void;
}

/** Everything drawn on top of the picture: recording bar, views, comments, menus. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly rec = el('div', 'rec');
  private readonly recTime = el('span', 'rec-time', '00:00');
  private readonly battery = el('div', 'battery');
  private readonly batteryFill = el('div', 'battery-fill');
  private readonly batteryText = el('span', 'battery-text', '100%');
  private readonly views = el('div', 'views');
  private readonly viewsNum = el('span', 'views-num', '0');
  private readonly hype = el('span', 'hype');
  private readonly turf = el('div', 'turf');
  private readonly popups = el('div', 'popups');
  private readonly comments = el('div', 'comments');
  private readonly hint = el('div', 'hint');
  private readonly duel = el('div', 'duel');
  private readonly duelYou = el('div', 'bar-fill');
  private readonly duelThem = el('div', 'bar-fill them');
  private readonly duelName = el('span', 'duel-name');
  private readonly duelKeys = el('div', 'duel-keys');
  private readonly duelHelp = el('div', 'duel-help');
  private readonly breath = el('div', 'breath');
  private readonly breathFill = el('div', 'breath-fill');
  private readonly flash = el('div', 'flash');
  private readonly touch = el('div', 'touch');
  private readonly stick = el('div', 'stick');
  private readonly knob = el('div', 'knob');
  private readonly title = el('div', 'screen title');
  private readonly pause = el('div', 'screen pause');
  private readonly end = el('div', 'screen end');
  private readonly endTitle = el('div', 'end-title');
  private readonly endViews = el('div', 'end-views', '0');
  private readonly endUnit = el('div', 'end-unit');
  private readonly endMeta = el('div', 'end-meta');
  private readonly endComments = el('div', 'end-comments');
  private readonly clipBtn = el('button', 'btn ghost clip-save');
  private readonly shareBtn = el('button', 'btn primary clip-share');
  private readonly youLabel = el('span', 'duel-name');
  private readonly touchLabels: [HTMLElement, 'left' | 'right' | 'jump'][] = [];
  /** what the clip button says at the moment: still being finished, or ready to save */
  private clipState: 'finishing' | 'ready' = 'ready';
  private readonly clipNote = el('div', 'clip-note');
  private readonly bestLine = el('div', 'best');
  private shownViews = 0;
  private lastComment = 0;
  private lastTurf = -1;
  private endCount = 0;
  private endTarget = 0;
  private screen: 'title' | 'pause' | 'end' | 'none' = 'title';

  constructor(private readonly settings: Settings, private readonly actions: HudActions, private readonly touchDevice: boolean) {
    this.root = document.getElementById('hud') as HTMLElement;
    this.root.innerHTML = '';

    const top = el('div', 'top');
    this.rec.append(el('span', 'rec-dot'), el('span', 'rec-label', 'REC'), this.recTime);
    this.battery.append(el('div', 'battery-shell'), this.batteryText);
    this.battery.firstElementChild!.append(this.batteryFill);
    top.append(this.rec, this.battery);

    this.views.append(this.eye(), this.viewsNum, this.hype);
    this.duel.append(this.bar('', this.duelYou, this.youLabel), this.bar('', this.duelThem, this.duelName), this.duelKeys, this.duelHelp);
    this.breath.append(this.breathFill);
    this.stick.append(this.knob);
    this.touch.append(this.stick, this.touchButton('pawLeft', 'left', 'paw-l'), this.touchButton('pawRight', 'right', 'paw-r'), this.touchButton('jump', 'jump', 'jump'));
    if (!touchDevice) this.touch.style.display = 'none';
    this.clipBtn.addEventListener('click', () => this.actions.saveClip());
    this.shareBtn.addEventListener('click', () => this.actions.shareClip());

    this.relabel();
    this.root.append(top, this.views, this.breath, this.turf, this.popups, this.comments, this.hint, this.duel, this.touch, this.flash, this.title, this.pause, this.end);
    this.show('title');
  }

  private eye(): SVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'eye');
    svg.innerHTML = '<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>';
    return svg;
  }

  private bar(label: string, fill: HTMLElement, labelEl?: HTMLElement): HTMLElement {
    const row = el('div', 'bar-row');
    const name = labelEl ?? el('span', 'duel-name', label);
    const track = el('div', 'bar');
    track.append(fill);
    row.append(name, track);
    return row;
  }

  /**
   * Write every label in the language in use. Called once at the start and again when the player picks
   * another language: the three menu screens are built afresh, the labels on the picture are rewritten.
   */
  relabel(): void {
    const w = S();
    const settingsOpen = this.title.querySelector('details.settings')?.hasAttribute('open') ?? false;
    for (const screen of [this.title, this.pause, this.end]) screen.innerHTML = '';
    this.buildTitle(this.touchDevice);
    this.buildPause();
    this.buildEnd();
    if (settingsOpen) this.title.querySelector('details.settings')?.setAttribute('open', '');
    this.youLabel.textContent = w.duel.you;
    this.duelHelp.textContent = this.touchDevice ? w.duel.helpTouch : w.duel.helpKeys;
    for (const [button, key] of this.touchLabels) button.textContent = w.touch[key];
    this.shareBtn.textContent = w.end.share;
    this.clipBtn.textContent = this.clipState === 'finishing' ? w.end.finishing : w.end.save;
    this.clipNote.textContent = w.end.note;
  }

  private bestText(): string {
    return this.settings.best > 0 ? fill(S().title.best, { views: count(this.settings.best, S().end.views) }) : '';
  }

  private touchButton(name: string, label: 'left' | 'right' | 'jump', cls: string): HTMLElement {
    const b = el('button', `tbtn ${cls}`);
    this.touchLabels.push([b, label]);
    const down = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.actions.press(name, false);
      this.actions.press(name, true); // and it stays down until let go (a longer hold jumps higher)
    };
    const up = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.actions.release(name);
    };
    b.addEventListener('touchstart', down, { passive: false });
    b.addEventListener('touchend', up, { passive: false });
    b.addEventListener('touchcancel', up, { passive: false });
    b.addEventListener('mousedown', down);
    b.addEventListener('mouseup', up);
    b.addEventListener('mouseleave', up);
    return b;
  }

  private buildTitle(touchDevice: boolean): void {
    const box = el('div', 'panel');
    const w = S();
    box.append(el('div', 'logo', 'Whiskercam'), el('div', 'tag', w.page.tagline));

    const nameRow = el('label', 'field');
    nameRow.append(el('span', 'field-label', w.title.yourCat));
    const name = el('input', 'name');
    name.type = 'text';
    name.maxLength = 14;
    name.value = this.settings.catName;
    name.setAttribute('aria-label', w.title.catName);
    name.addEventListener('input', () => {
      this.settings.catName = name.value.trim() || 'Biscuit';
      this.actions.settingsChanged();
    });
    nameRow.append(name);

    const coats = el('div', 'coats');
    for (const [id, colour] of COATS) {
      const b = el('button', 'coat');
      b.title = w.coats[id];
      b.setAttribute('aria-label', w.coats[id]);
      b.style.setProperty('--c', colour);
      if (id === 'tux') b.classList.add('tux');
      if (this.settings.coat === id) b.classList.add('on');
      b.addEventListener('click', () => {
        this.settings.coat = id;
        coats.querySelectorAll('.coat').forEach((c) => c.classList.remove('on'));
        b.classList.add('on');
        this.actions.settingsChanged();
      });
      coats.append(b);
    }

    const play = el('button', 'btn primary', w.title.start);
    play.addEventListener('click', () => this.actions.play());

    const how = el('div', 'how');
    how.innerHTML = touchDevice ? w.title.howTouch : w.title.howKeys;
    const goal = el('div', 'goal', w.title.goal);
    const best = this.bestLine;
    best.textContent = this.bestText();
    const about = el('div', 'about');
    about.innerHTML = `Whiskercam ${__APP_VERSION__} &nbsp;·&nbsp; <a href="https://github.com/flujo-app/whiskercam" target="_blank" rel="noopener">${w.title.about}</a>`;
    box.append(nameRow, coats, play, goal, how, best, this.settingsRows(), about);
    this.title.append(box);
  }

  private settingsRows(): HTMLElement {
    const w = S().settings;
    const wrap = el('details', 'settings');
    wrap.append(el('summary', undefined, w.heading));
    const range = (label: string, key: 'volume' | 'sensitivity' | 'motion', min: number, max: number) => this.rangeRow(label, key, min, max);
    const choice = (label: string, options: [string, string][], value: string, picked: (value: string) => void) => {
      const row = el('label', 'field');
      row.append(el('span', 'field-label', label));
      const sel = el('select');
      for (const [id, name] of options) {
        const o = el('option', undefined, name);
        o.value = id;
        sel.append(o);
      }
      sel.value = value;
      sel.addEventListener('change', () => picked(sel.value));
      row.append(sel);
      return row;
    };
    const picture = choice(w.picture, [['0', w.faster], ['1', w.balanced], ['2', w.sharpest]], String(this.settings.quality), (v) => {
      this.settings.quality = Number(v);
      this.actions.settingsChanged();
    });
    // every language under its own name, so it can be found by someone who cannot read the one in use
    const languages: [string, string][] = [['auto', w.automatic], ...LANGUAGES.map((l): [string, string] => [l.code, l.name])];
    const language = choice(w.language, languages, this.settings.language, (v) => {
      this.settings.language = v;
      this.actions.settingsChanged();
    });
    language.classList.add('language');
    const check = (label: string, key: 'comments' | 'record') => {
      const row = el('label', 'field check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = this.settings[key];
      input.addEventListener('change', () => {
        this.settings[key] = input.checked;
        this.actions.settingsChanged();
      });
      row.append(input, el('span', undefined, label));
      return row;
    };
    wrap.append(language, picture, range(w.sound, 'volume', 0, 1), range(w.turning, 'sensitivity', 0.4, 2), range(w.shake, 'motion', 0, 1),
      check(w.comments, 'comments'), check(w.record, 'record'));
    return wrap;
  }

  /** A slider for one of the settings. Sliders for the same setting on different screens stay in step. */
  private rangeRow(label: string, key: 'volume' | 'sensitivity' | 'motion', min: number, max: number): HTMLElement {
    const row = el('label', 'field');
    row.append(el('span', 'field-label', label));
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '0.05';
    input.value = String(this.settings[key]);
    input.dataset.setting = key;
    input.addEventListener('input', () => {
      this.settings[key] = Number(input.value);
      if (key === 'motion') this.settings.motionChosen = true;
      document.querySelectorAll<HTMLInputElement>(`input[data-setting="${key}"]`).forEach((other) => {
        if (other !== input) other.value = input.value;
      });
      this.actions.settingsChanged();
    });
    row.append(input);
    return row;
  }

  private buildPause(): void {
    const box = el('div', 'panel small');
    const w = S();
    box.append(el('div', 'logo small', w.pause.heading));
    // the things a player wants to change once they have seen the picture move
    const comfort = el('div', 'settings open');
    comfort.append(this.rangeRow(w.settings.shake, 'motion', 0, 1), this.rangeRow(w.settings.turning, 'sensitivity', 0.4, 2), this.rangeRow(w.settings.sound, 'volume', 0, 1));
    box.append(comfort);
    const resume = el('button', 'btn primary', w.pause.resume);
    resume.addEventListener('click', () => this.actions.resume());
    const again = el('button', 'btn ghost', w.pause.restart);
    again.addEventListener('click', () => this.actions.restart());
    const menu = el('button', 'btn ghost', w.pause.menu);
    menu.addEventListener('click', () => this.actions.toMenu());
    box.append(resume, again, menu);
    this.pause.append(box);
  }

  private buildEnd(): void {
    const box = el('div', 'panel');
    const w = S().end;
    box.append(el('div', 'end-label', w.posted), this.endTitle, this.endViews, this.endUnit, this.endMeta, this.endComments);
    const again = el('button', 'btn primary', w.again);
    again.addEventListener('click', () => this.actions.restart());
    const menu = el('button', 'btn ghost', w.menu);
    menu.addEventListener('click', () => this.actions.toMenu());
    box.append(this.clipNote, this.shareBtn, this.clipBtn, again, menu);
    this.end.append(box);
  }

  /** Keep the overlay exactly on top of the picture. */
  place(rect: DOMRect): void {
    const s = this.root.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    this.root.style.setProperty('--u', `${rect.height / 100}px`);
  }

  show(screen: 'title' | 'pause' | 'end' | 'none'): void {
    this.screen = screen;
    if (screen === 'title') this.bestLine.textContent = this.bestText();
    this.title.classList.toggle('on', screen === 'title');
    this.pause.classList.toggle('on', screen === 'pause');
    this.end.classList.toggle('on', screen === 'end');
    this.root.classList.toggle('playing', screen === 'none');
  }

  /** what the fight prompt says right now (for the recorded clip) */
  get duelPrompt(): string {
    return this.duelKeys.textContent ?? '';
  }

  get current(): string {
    return this.screen;
  }

  setStick(centre: { x: number; y: number } | null, knob: { x: number; y: number } | null, rect: DOMRect): void {
    if (!centre || !knob) {
      this.stick.classList.remove('on');
      return;
    }
    this.stick.classList.add('on');
    this.stick.style.left = `${centre.x - rect.left}px`;
    this.stick.style.top = `${centre.y - rect.top}px`;
    this.knob.style.transform = `translate(${knob.x - centre.x}px, ${knob.y - centre.y}px)`;
  }

  /** Fill in the end screen. `clip` = whether a video file is ready to save. */
  /** The clip file is finished (or could not be made): switch the buttons on. */
  clipReady(ok: boolean, canShare: boolean): void {
    this.clipBtn.style.display = ok ? '' : 'none';
    this.shareBtn.style.display = ok && canShare ? '' : 'none';
    (this.clipBtn as HTMLButtonElement).disabled = !ok;
    (this.shareBtn as HTMLButtonElement).disabled = !ok;
    this.clipState = 'ready';
    this.clipBtn.textContent = S().end.save;
    // with a share button the save button steps back; without one it is the main thing to do
    this.clipBtn.className = `btn ${ok && canShare ? 'ghost' : 'primary'} clip-save`;
    this.clipNote.textContent = S().end.note;
    this.clipNote.style.display = ok ? '' : 'none';
  }

  /** `clip`: is a clip of this run being finished right now? */
  showEnd(session: Session, catName: string, best: number, clip: boolean): void {
    const score = session.score;
    this.endTitle.textContent = score.title(catName);
    this.endTarget = score.views;
    this.endCount = 0;
    const record = score.views >= best && score.views > 0;
    this.endMeta.innerHTML = '';
    const w = S().end;
    this.endUnit.textContent = word(score.views, w.views);
    this.endMeta.append(
      el('span', 'chip', count(score.likes, w.likes)),
      el('span', 'chip', fill(w.turf, { won: score.turf, all: session.rivals.length })),
      el('span', 'chip rank', score.rank()),
    );
    if (record) this.endMeta.append(el('span', 'chip best', w.best));
    this.endComments.innerHTML = '';
    for (const c of score.comments.slice(-3)) {
      const row = el('div', 'comment');
      row.append(el('b', undefined, c.who), document.createTextNode(` ${c.text}`));
      this.endComments.append(row);
    }
    // the clip needs a few more seconds (its closing card is still being written)
    this.clipBtn.style.display = clip ? '' : 'none';
    this.clipState = 'finishing';
    this.clipBtn.textContent = w.finishing;
    this.clipBtn.className = 'btn ghost clip-save';
    (this.clipBtn as HTMLButtonElement).disabled = true;
    this.shareBtn.style.display = 'none';
    this.clipNote.style.display = 'none';
    this.show('end');
  }

  update(session: Session, dt: number, _touch: boolean): void {
    // end-screen count-up
    if (this.screen === 'end' && this.endCount < this.endTarget) {
      this.endCount = Math.min(this.endTarget, this.endCount + Math.max(40, this.endTarget * dt * 0.7));
      this.endViews.textContent = fmt(this.endCount);
    }
    if (this.screen !== 'none') return;

    const score = session.score;
    this.recTime.textContent = clock(session.elapsed);
    const frac = Math.max(0, session.battery / RUN_SECONDS);
    this.batteryFill.style.width = `${Math.round(frac * 100)}%`;
    this.batteryText.textContent = `${Math.ceil(frac * 100)}%`;
    this.battery.classList.toggle('low', session.battery < 20);

    this.shownViews += (score.views - this.shownViews) * Math.min(1, dt * 6);
    this.viewsNum.textContent = fmt(this.shownViews);
    this.hype.textContent = score.hype > 1.01 ? `×${score.hype.toFixed(2).replace(/0$/, '')}` : '';

    if (this.lastTurf !== score.turf) {
      this.lastTurf = score.turf;
      this.turf.innerHTML = '';
      session.rivals.forEach((_, i) => this.turf.append(el('span', `pip${i < score.turf ? ' on' : ''}`)));
    }

    for (const p of score.drainPopups()) {
      const row = el('div', `popup${p.big ? ' big' : ''}`);
      row.append(el('span', 'popup-views', `+${fmt(p.views)}`), el('span', 'popup-text', p.text));
      this.popups.append(row);
      setTimeout(() => row.remove(), p.big ? 2600 : 1900);
      while (this.popups.childElementCount > 4) this.popups.firstElementChild!.remove();
    }

    if (this.settings.comments && score.comments.length !== this.lastComment) {
      for (let i = Math.max(this.lastComment, score.comments.length - 3); i < score.comments.length; i++) {
        const c = score.comments[i];
        const row = el('div', 'comment');
        row.append(el('b', undefined, c.who), document.createTextNode(` ${c.text}`));
        this.comments.append(row);
        setTimeout(() => row.classList.add('old'), 4200);
        setTimeout(() => row.remove(), 5200);
      }
      while (this.comments.childElementCount > 4) this.comments.firstElementChild!.remove();
      this.lastComment = score.comments.length;
    }
    this.comments.style.display = this.settings.comments ? '' : 'none';

    this.hint.textContent = session.hintFor > 0 ? session.hint : '';
    this.hint.classList.toggle('on', session.hintFor > 0);

    const inDuel = session.phase === 'duel' && !!session.duel;
    this.duel.classList.toggle('on', inDuel);
    if (inDuel) {
      this.duelYou.style.width = `${session.playerNerve * 100}%`;
      this.duelThem.style.width = `${session.rivalNerve * 100}%`;
      this.duelName.textContent = catName(session.duelRival?.info.name ?? '');
      const d = session.duel!;
      const open = d.rivalState === 'recover' || d.rivalState === 'stagger';
      const danger = d.rivalState === 'windup' || d.rivalState === 'feint' || d.rivalState === 'strike';
      const puffed = d.stamina < 0.16;
      // The prompt teaches the rhythm: wait, pull back when the paw comes up, hit back while it is off balance.
      const w = S().duel;
      let text = puffed ? w.breathe : w.wait;
      let mood = '';
      if (d.playerState === 'parried') {
        text = w.batted;
        mood = ' danger';
      } else if (danger) {
        text = w.pull;
        mood = ' danger';
      } else if (open || d.rivalWinded) {
        text = puffed ? w.puffed : d.rivalWinded && !open ? w.rivalPuffed : w.now;
        mood = puffed ? '' : ' open';
      }
      this.duelKeys.textContent = text;
      this.duelKeys.className = `duel-keys${mood}`;
    }
    // breath: shown while it is in use, fades away once it is full again
    const breath = session.stamina;
    this.breathFill.style.width = `${Math.round(breath * 100)}%`;
    this.breath.className = `breath${breath < 0.999 || inDuel ? ' on' : ''}${breath < 0.2 ? ' low' : ''}`;
    this.flash.style.opacity = String(session.flash * 0.55);
    this.root.classList.toggle('dying', session.phase === 'ending');
  }

  resetRun(): void {
    this.shownViews = 0;
    this.lastComment = 0;
    this.lastTurf = -1;
    this.popups.innerHTML = '';
    this.comments.innerHTML = '';
  }
}
