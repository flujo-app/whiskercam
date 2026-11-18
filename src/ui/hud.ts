import type { Coat } from '../game/cats';
import type { Session } from '../game/session';
import { RUN_SECONDS } from '../game/session';
import type { Settings } from '../game/settings';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const fmt = (n: number): string => Math.round(n).toLocaleString('en-GB');
const clock = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const COATS: [Coat, string, string][] = [
  ['ginger', 'Ginger', '#c9742c'],
  ['tabby', 'Tabby', '#7a6248'],
  ['black', 'Black', '#1c1c1f'],
  ['white', 'White', '#e9e6df'],
  ['grey', 'Grey', '#7d848c'],
  ['tux', 'Tuxedo', '#2a2a2e'],
];

export interface HudActions {
  play(): void;
  resume(): void;
  restart(): void;
  toMenu(): void;
  saveClip(): void;
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
  private readonly flash = el('div', 'flash');
  private readonly touch = el('div', 'touch');
  private readonly stick = el('div', 'stick');
  private readonly knob = el('div', 'knob');
  private readonly title = el('div', 'screen title');
  private readonly pause = el('div', 'screen pause');
  private readonly end = el('div', 'screen end');
  private readonly endTitle = el('div', 'end-title');
  private readonly endViews = el('div', 'end-views', '0');
  private readonly endMeta = el('div', 'end-meta');
  private readonly endComments = el('div', 'end-comments');
  private readonly clipBtn = el('button', 'btn ghost', 'Save the clip');
  private readonly bestLine = el('div', 'best');
  private shownViews = 0;
  private lastComment = 0;
  private lastTurf = -1;
  private endCount = 0;
  private endTarget = 0;
  private screen: 'title' | 'pause' | 'end' | 'none' = 'title';

  constructor(private readonly settings: Settings, private readonly actions: HudActions, touchDevice: boolean) {
    this.root = document.getElementById('hud') as HTMLElement;
    this.root.innerHTML = '';

    const top = el('div', 'top');
    this.rec.append(el('span', 'rec-dot'), el('span', 'rec-label', 'REC'), this.recTime);
    this.battery.append(el('div', 'battery-shell'), this.batteryText);
    this.battery.firstElementChild!.append(this.batteryFill);
    top.append(this.rec, this.battery);

    this.views.append(this.eye(), this.viewsNum, this.hype);
    this.duel.append(this.bar('You', this.duelYou), this.bar('', this.duelThem, this.duelName), this.duelKeys);
    this.stick.append(this.knob);
    this.touch.append(this.stick, this.touchButton('pawLeft', 'Left paw', 'paw-l'), this.touchButton('pawRight', 'Right paw', 'paw-r'), this.touchButton('jump', 'Jump', 'jump'));
    if (!touchDevice) this.touch.style.display = 'none';

    this.buildTitle(touchDevice);
    this.buildPause();
    this.buildEnd();
    this.root.append(top, this.views, this.turf, this.popups, this.comments, this.hint, this.duel, this.touch, this.flash, this.title, this.pause, this.end);
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

  private touchButton(name: string, label: string, cls: string): HTMLElement {
    const b = el('button', `tbtn ${cls}`, label);
    const down = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.actions.press(name, false);
    };
    b.addEventListener('touchstart', down, { passive: false });
    b.addEventListener('mousedown', down);
    return b;
  }

  private buildTitle(touchDevice: boolean): void {
    const box = el('div', 'panel');
    box.append(el('div', 'logo', 'Whiskercam'), el('div', 'tag', 'A day on the estate, filmed from under a cat’s chin.'));

    const nameRow = el('label', 'field');
    nameRow.append(el('span', 'field-label', 'Your cat'));
    const name = el('input', 'name');
    name.type = 'text';
    name.maxLength = 14;
    name.value = this.settings.catName;
    name.setAttribute('aria-label', 'Cat name');
    name.addEventListener('input', () => {
      this.settings.catName = name.value.trim() || 'Biscuit';
      this.actions.settingsChanged();
    });
    nameRow.append(name);

    const coats = el('div', 'coats');
    for (const [id, label, colour] of COATS) {
      const b = el('button', 'coat');
      b.title = label;
      b.setAttribute('aria-label', label);
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

    const play = el('button', 'btn primary', 'Start recording');
    play.addEventListener('click', () => this.actions.play());

    const how = el('div', 'how');
    how.innerHTML = touchDevice
      ? '<b>Left thumb</b> run and steer (push far to sprint) &nbsp;·&nbsp; <b>right side</b> drag to look &nbsp;·&nbsp; buttons: paws and jump'
      : '<b>W</b> run &nbsp;·&nbsp; <b>Shift</b> sprint &nbsp;·&nbsp; <b>mouse</b> or <b>A / D</b> steer &nbsp;·&nbsp; <b>Space</b> jump &nbsp;·&nbsp; <b>click</b> left / right paw &nbsp;·&nbsp; <b>F</b> meow &nbsp;·&nbsp; <b>S</b> pull back in a fight &nbsp;·&nbsp; <b>Esc</b> pause';
    const goal = el('div', 'goal', 'The camera battery lasts three minutes. Chase your brother, knock things over, win the turf. Everything earns views.');
    const best = this.bestLine;
    best.textContent = this.settings.best > 0 ? `Best clip so far: ${fmt(this.settings.best)} views` : '';
    const about = el('div', 'about');
    about.innerHTML = `Whiskercam ${__APP_VERSION__} &nbsp;·&nbsp; <a href="https://github.com/flujo-app/whiskercam" target="_blank" rel="noopener">how it is made, credits</a>`;
    box.append(nameRow, coats, play, goal, how, best, this.settingsRows(), about);
    this.title.append(box);
  }

  private settingsRows(): HTMLElement {
    const wrap = el('details', 'settings');
    wrap.append(el('summary', undefined, 'Settings'));
    const range = (label: string, key: 'volume' | 'sensitivity' | 'motion', min: number, max: number) => {
      const row = el('label', 'field');
      row.append(el('span', 'field-label', label));
      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = '0.05';
      input.value = String(this.settings[key]);
      input.addEventListener('input', () => {
        this.settings[key] = Number(input.value);
        this.actions.settingsChanged();
      });
      row.append(input);
      return row;
    };
    const q = el('label', 'field');
    q.append(el('span', 'field-label', 'Picture'));
    const sel = el('select');
    ['Faster', 'Balanced', 'Sharpest'].forEach((name, i) => {
      const o = el('option', undefined, name);
      o.value = String(i);
      sel.append(o);
    });
    sel.value = String(this.settings.quality);
    sel.addEventListener('change', () => {
      this.settings.quality = Number(sel.value);
      this.actions.settingsChanged();
    });
    q.append(sel);
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
    wrap.append(q, range('Sound', 'volume', 0, 1), range('Turning speed', 'sensitivity', 0.4, 2), range('Camera wobble', 'motion', 0, 1),
      check('Show viewer comments', 'comments'), check('Keep the clip as a video file', 'record'));
    return wrap;
  }

  private buildPause(): void {
    const box = el('div', 'panel small');
    box.append(el('div', 'logo small', 'Paused'));
    const resume = el('button', 'btn primary', 'Carry on');
    resume.addEventListener('click', () => this.actions.resume());
    const again = el('button', 'btn ghost', 'Start over');
    again.addEventListener('click', () => this.actions.restart());
    const menu = el('button', 'btn ghost', 'Back to menu');
    menu.addEventListener('click', () => this.actions.toMenu());
    box.append(resume, again, menu);
    this.pause.append(box);
  }

  private buildEnd(): void {
    const box = el('div', 'panel');
    box.append(el('div', 'end-label', 'Clip posted'), this.endTitle, this.endViews, el('div', 'end-unit', 'views'), this.endMeta, this.endComments);
    const again = el('button', 'btn primary', 'Run it back');
    again.addEventListener('click', () => this.actions.restart());
    this.clipBtn.addEventListener('click', () => this.actions.saveClip());
    const menu = el('button', 'btn ghost', 'Menu');
    menu.addEventListener('click', () => this.actions.toMenu());
    box.append(again, this.clipBtn, menu);
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
    if (screen === 'title') this.bestLine.textContent = this.settings.best > 0 ? `Best clip so far: ${fmt(this.settings.best)} views` : '';
    this.title.classList.toggle('on', screen === 'title');
    this.pause.classList.toggle('on', screen === 'pause');
    this.end.classList.toggle('on', screen === 'end');
    this.root.classList.toggle('playing', screen === 'none');
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
  showEnd(session: Session, catName: string, best: number, clip: boolean): void {
    const score = session.score;
    this.endTitle.textContent = score.title(catName);
    this.endTarget = score.views;
    this.endCount = 0;
    const record = score.views >= best && score.views > 0;
    this.endMeta.innerHTML = '';
    this.endMeta.append(
      el('span', 'chip', `${fmt(score.likes)} likes`),
      el('span', 'chip', `Turf ${score.turf} / ${session.rivals.length}`),
      el('span', 'chip rank', score.rank()),
    );
    if (record) this.endMeta.append(el('span', 'chip best', 'Personal best'));
    this.endComments.innerHTML = '';
    for (const c of score.comments.slice(-3)) {
      const row = el('div', 'comment');
      row.append(el('b', undefined, c.who), document.createTextNode(` ${c.text}`));
      this.endComments.append(row);
    }
    this.clipBtn.style.display = clip ? '' : 'none';
    this.show('end');
  }

  update(session: Session, dt: number, touchDuel: boolean): void {
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
      this.duelName.textContent = session.duelRival?.info.name ?? '';
      const d = session.duel!;
      const open = d.rivalState === 'recover' || d.rivalState === 'stagger';
      const danger = d.rivalState === 'windup' || d.rivalState === 'feint' || d.rivalState === 'strike';
      this.duelKeys.textContent = danger ? (touchDuel ? 'Pull back!' : 'S: pull back!') : open ? 'Now! Slap!' : touchDuel ? 'Tap a paw to slap' : 'Click to slap';
      this.duelKeys.className = `duel-keys${danger ? ' danger' : open ? ' open' : ''}`;
    }
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
