/** One frame of what the player wants, whatever device it came from. */
export interface Controls {
  /** forward (+1) / back (-1) */
  move: number;
  /** turn right (+1) / left (-1), as a rate */
  turn: number;
  /** turn in degrees since last frame (mouse, touch drag) */
  yaw: number;
  /** head tilt in degrees since last frame */
  pitch: number;
  sprint: boolean;
  /** true only on the frame the button went down */
  jump: boolean;
  pawLeft: boolean;
  pawRight: boolean;
  dodge: boolean;
  pause: boolean;
  /** any key, click or tap this frame (used by "press to start") */
  any: boolean;
}

export interface TouchLayout {
  /** called when the on-screen stick should be drawn (null = hide) */
  onStick?: (centre: { x: number; y: number } | null, knob: { x: number; y: number } | null) => void;
}

const DEAD = 0.18;
const stick = (v: number): number => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

export class Input {
  readonly state: Controls = {
    move: 0, turn: 0, yaw: 0, pitch: 0, sprint: false, jump: false, pawLeft: false, pawRight: false, dodge: false, pause: false, any: false,
  };
  mouseSensitivity = 0.11; // degrees per pixel
  touchSensitivity = 0.28;
  usingTouch = false;
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private any = false;
  private stickId: number | null = null;
  private stickCentre = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private readonly virtual = new Set<string>();
  private padButtons: boolean[] = [];

  constructor(private readonly target: HTMLElement, private readonly layout: TouchLayout = {}) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      this.any = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());

    target.addEventListener('mousedown', (e) => {
      this.any = true;
      if (document.pointerLockElement === target) {
        this.pressed.add(e.button === 2 ? 'MouseRight' : 'MouseLeft');
      }
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== target) return;
      this.yaw += e.movementX * this.mouseSensitivity;
      this.pitch -= e.movementY * this.mouseSensitivity * 0.6;
    });

    target.addEventListener('touchstart', (e) => this.touchStart(e), { passive: false });
    target.addEventListener('touchmove', (e) => this.touchMove(e), { passive: false });
    target.addEventListener('touchend', (e) => this.touchEnd(e), { passive: false });
    target.addEventListener('touchcancel', (e) => this.touchEnd(e), { passive: false });
  }

  /** Capture the mouse so moving it steers (desktop). Must be called from a click. */
  lockPointer(): void {
    if (!this.usingTouch && document.pointerLockElement !== this.target) {
      void this.target.requestPointerLock?.();
    }
  }

  unlockPointer(): void {
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.target;
  }

  /** On-screen buttons call this (name = "jump", "pawLeft", "pawRight", "dodge", "sprint", "pause"). */
  press(name: string, held = false): void {
    this.any = true;
    if (held) this.virtual.add(name);
    else this.pressed.add(`v:${name}`);
  }

  release(name: string): void {
    this.virtual.delete(name);
  }

  private touchStart(e: TouchEvent): void {
    e.preventDefault();
    this.usingTouch = true;
    this.any = true;
    const rect = this.target.getBoundingClientRect();
    for (const t of Array.from(e.changedTouches)) {
      const x = t.clientX - rect.left;
      if (x < rect.width * 0.5 && this.stickId === null) {
        this.stickId = t.identifier;
        this.stickCentre = { x: t.clientX, y: t.clientY };
        this.stickVec = { x: 0, y: 0 };
        this.layout.onStick?.(this.stickCentre, this.stickCentre);
      } else if (this.lookId === null) {
        this.lookId = t.identifier;
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private touchMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        const r = 56;
        let dx = (t.clientX - this.stickCentre.x) / r;
        let dy = (t.clientY - this.stickCentre.y) / r;
        const len = Math.hypot(dx, dy);
        if (len > 1) {
          dx /= len;
          dy /= len;
        }
        this.stickVec = { x: dx, y: dy };
        this.layout.onStick?.(this.stickCentre, { x: this.stickCentre.x + dx * r, y: this.stickCentre.y + dy * r });
      } else if (t.identifier === this.lookId) {
        this.yaw += (t.clientX - this.lookLast.x) * this.touchSensitivity;
        this.pitch -= (t.clientY - this.lookLast.y) * this.touchSensitivity * 0.5;
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private touchEnd(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.stickId = null;
        this.stickVec = { x: 0, y: 0 };
        this.layout.onStick?.(null, null);
      } else if (t.identifier === this.lookId) {
        this.lookId = null;
      }
    }
  }

  private hit(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  private held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** Collect everything since the last call into `state`. Call once per frame. */
  poll(): Controls {
    const s = this.state;
    let move = (this.held('KeyW', 'ArrowUp') ? 1 : 0) - (this.held('KeyS', 'ArrowDown') ? 1 : 0);
    let turn = (this.held('KeyD', 'ArrowRight') ? 1 : 0) - (this.held('KeyA', 'ArrowLeft') ? 1 : 0);
    let sprint = this.held('ShiftLeft', 'ShiftRight') || this.virtual.has('sprint');
    let jump = this.hit('Space', 'v:jump');
    let pawLeft = this.hit('MouseLeft', 'KeyJ', 'KeyQ', 'v:pawLeft');
    let pawRight = this.hit('MouseRight', 'KeyK', 'KeyE', 'v:pawRight');
    let dodge = this.hit('KeyS', 'ArrowDown', 'ControlLeft', 'v:dodge');
    let pause = this.hit('Escape', 'KeyP', 'v:pause');
    let yaw = this.yaw;
    let pitch = this.pitch;

    if (this.stickId !== null) {
      move += -stick(this.stickVec.y);
      turn += stick(this.stickVec.x);
      if (Math.hypot(this.stickVec.x, this.stickVec.y) > 0.92) sprint = true;
    }

    const pad = navigator.getGamepads?.().find((p) => p && p.connected) ?? null;
    if (pad) {
      move += -stick(pad.axes[1] ?? 0);
      turn += stick(pad.axes[0] ?? 0);
      yaw += stick(pad.axes[2] ?? 0) * 2.6;
      pitch += -stick(pad.axes[3] ?? 0) * 1.4;
      const b = pad.buttons.map((x) => x.pressed);
      const edge = (i: number) => !!b[i] && !this.padButtons[i];
      if (edge(0)) jump = true;
      if (edge(2) || edge(4)) pawLeft = true;
      if (edge(1) || edge(5)) pawRight = true;
      if (edge(3)) dodge = true;
      if (edge(9)) pause = true;
      if (b[7] || b[6] || b[10]) sprint = true;
      if (b.some(Boolean) && !this.padButtons.some(Boolean)) this.any = true;
      this.padButtons = b;
    }

    s.move = Math.max(-1, Math.min(1, move));
    s.turn = Math.max(-1, Math.min(1, turn));
    s.yaw = yaw;
    s.pitch = pitch;
    s.sprint = sprint;
    s.jump = jump;
    s.pawLeft = pawLeft;
    s.pawRight = pawRight;
    s.dodge = dodge;
    s.pause = pause;
    s.any = this.any;
    this.pressed.clear();
    this.yaw = 0;
    this.pitch = 0;
    this.any = false;
    return s;
  }
}
