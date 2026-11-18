/**
 * Records every run as a video that is ready to post: upright 9:16, with the views counter, the comments,
 * the fight bars and everything else the player saw written into the picture, and a closing card with the
 * clip's title and score. (Version 1.0 recorded the bare camera picture, so a shared clip said nothing
 * about what happened in it.)
 */

/** What to write on top of the picture for one frame. */
export interface ClipFrame {
  views: number;
  hype: number;
  /** seconds of recording so far */
  seconds: number;
  /** 0..1 */
  battery: number;
  turf: number;
  turfMax: number;
  /** 0..1 */
  stamina: number;
  /** newest last; `age` in seconds */
  feed: { text: string; views: number; age: number }[];
  comments: { who: string; text: string; age: number }[];
  hint: string;
  duel: { you: number; them: number; name: string; prompt: string } | null;
}

/** The closing card. */
export interface ClipCard {
  title: string;
  views: number;
  likes: number;
  rank: string;
  /** shown at the bottom, e.g. where the game can be played */
  link: string;
}

const CARD_SECONDS = 2.8;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private blob: Blob | null = null;
  private ext = 'webm';
  private readonly out = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private lastDraw = 0;
  private card: ClipCard | null = null;
  private cardSince = 0;
  private cardDone: ((ok: boolean) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = this.out.getContext('2d', { alpha: false });
  }

  get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof this.out.captureStream === 'function' && this.ctx !== null;
  }

  get recording(): boolean {
    return this.rec !== null && this.rec.state === 'recording';
  }

  start(audio?: MediaStream | null): void {
    this.discard();
    if (!this.supported) return;
    // MP4 first: that is what the video platforms and phones take without converting
    const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) return;
    // upright 9:16 at a size the platforms like; no bigger than what is actually drawn
    const tall = this.canvas.height >= 1500 ? 1920 : 1280;
    this.out.height = tall;
    this.out.width = (tall * 9) / 16;
    try {
      const stream = this.out.captureStream(30);
      for (const track of audio?.getAudioTracks() ?? []) stream.addTrack(track);
      this.rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: tall > 1300 ? 8_000_000 : 4_500_000, audioBitsPerSecond: 128_000 });
      this.ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
      this.rec.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.rec.start(1000);
    } catch (err) {
      console.warn('clip recording is not available here', err);
      this.rec = null;
    }
  }

  /**
   * Call once per drawn frame, right after the game has drawn it (the picture can only be copied then).
   * Composes the clip at up to 30 frames per second.
   */
  frame(info: ClipFrame, now = performance.now()): void {
    const ctx = this.ctx;
    if (!ctx || !this.rec || this.rec.state !== 'recording') return;
    if (now - this.lastDraw < 30) return;
    this.lastDraw = now;
    const W = this.out.width;
    const H = this.out.height;
    // the game picture, fitted upright
    const src = this.canvas;
    const k = Math.min(W / src.width, H / src.height);
    const dw = src.width * k;
    const dh = src.height * k;
    if (dw < W - 1 || dh < H - 1) {
      ctx.fillStyle = '#0b0b0c';
      ctx.fillRect(0, 0, W, H);
    }
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    if (this.card) {
      const t = (now - this.cardSince) / 1000;
      this.drawCard(ctx, W, H, this.card, t);
      if (t >= CARD_SECONDS) this.close();
    } else {
      this.drawOverlay(ctx, W, H, info);
    }
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, f: ClipFrame): void {
    const u = H / 100;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = u * 0.6;
    ctx.shadowOffsetY = u * 0.12;
    ctx.fillStyle = '#f5f2ea';

    // top line: REC and time, battery
    const m = Math.floor(f.seconds / 60);
    const s = Math.floor(f.seconds % 60);
    ctx.font = `600 ${u * 1.9}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ff4a2e';
    ctx.beginPath();
    ctx.arc(u * 2.7, u * 2.8, u * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f5f2ea';
    ctx.fillText(`REC ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`, u * 4.1, u * 2.85);
    const pct = Math.max(0, Math.round(f.battery * 100));
    ctx.textAlign = 'right';
    ctx.fillText(`${pct}%`, W - u * 2, u * 2.85);
    const bw = u * 4.2;
    const bx = W - u * 2 - ctx.measureText(`${pct}%`).width - u * 1 - bw;
    ctx.lineWidth = u * 0.22;
    ctx.strokeStyle = '#f5f2ea';
    ctx.strokeRect(bx, u * 1.85, bw, u * 2);
    ctx.fillStyle = f.battery < 0.15 ? '#ff4a2e' : '#f5f2ea';
    ctx.fillRect(bx + u * 0.3, u * 2.15, (bw - u * 0.6) * Math.max(0, Math.min(1, f.battery)), u * 1.4);

    // views and the multiplier
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f5f2ea';
    ctx.font = `700 ${u * 2.9}px ${FONT}`;
    const views = Math.round(f.views).toLocaleString('en-GB');
    ctx.fillText(views, u * 5.6, u * 7.3);
    this.eye(ctx, u * 3.3, u * 7.3, u * 1.25);
    if (f.hype > 1.01) {
      const vw = ctx.measureText(views).width;
      ctx.font = `700 ${u * 2}px ${FONT}`;
      ctx.fillStyle = '#ffd23f';
      ctx.fillText(`×${f.hype.toFixed(2).replace(/0$/, '')}`, u * 6.6 + vw, u * 7.45);
    }
    // turf won
    for (let i = 0; i < f.turfMax; i++) {
      ctx.beginPath();
      ctx.arc(W - u * 2.8 - i * u * 2.2, u * 7.2, u * 0.7, 0, Math.PI * 2);
      if (i >= f.turfMax - f.turf) {
        ctx.fillStyle = '#7ddc6a';
        ctx.fill();
      } else {
        ctx.lineWidth = u * 0.2;
        ctx.strokeStyle = '#f5f2ea';
        ctx.stroke();
      }
    }
    // breath, only while it is in use
    if (f.stamina < 0.995) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      this.pill(ctx, u * 2, u * 9.5, u * 13, u * 0.75);
      ctx.fillStyle = f.stamina < 0.2 ? '#ff4a2e' : '#f5f2ea';
      this.pill(ctx, u * 2, u * 9.5, u * 13 * Math.max(0.03, f.stamina), u * 0.75);
      ctx.shadowBlur = u * 0.6;
    }

    // what just happened: "+675  Big jump"
    ctx.textAlign = 'center';
    let y = u * 12.5;
    for (const p of f.feed.slice(-3)) {
      const a = Math.max(0, Math.min(1, (2.4 - p.age) / 0.5, p.age / 0.12));
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.font = `700 ${u * 2}px ${FONT}`;
      const gain = `+${Math.round(p.views).toLocaleString('en-GB')}`;
      const gw = ctx.measureText(gain).width;
      ctx.font = `600 ${u * 2}px ${FONT}`;
      const tw = ctx.measureText(p.text).width;
      const w = gw + tw + u * 3.4;
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(20,20,22,0.55)';
      this.pill(ctx, W / 2 - w / 2, y - u * 1.7, w, u * 3.4);
      ctx.shadowBlur = u * 0.6;
      ctx.textAlign = 'left';
      ctx.font = `700 ${u * 2}px ${FONT}`;
      ctx.fillStyle = '#ffd23f';
      ctx.fillText(gain, W / 2 - w / 2 + u * 1.2, y);
      ctx.font = `600 ${u * 2}px ${FONT}`;
      ctx.fillStyle = '#f5f2ea';
      ctx.fillText(p.text, W / 2 - w / 2 + u * 2.2 + gw, y);
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1;
      y += u * 4;
    }

    // a hint or the fight
    if (f.duel) {
      const x0 = W * 0.08;
      const bw2 = W * 0.84;
      let dy = u * 24;
      for (const [label, value, colour] of [['You', f.duel.you, '#f5f2ea'], [f.duel.name, f.duel.them, '#ff4a2e']] as const) {
        ctx.textAlign = 'left';
        ctx.font = `600 ${u * 1.6}px ${FONT}`;
        ctx.fillStyle = '#f5f2ea';
        ctx.fillText(label, x0, dy);
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        this.pill(ctx, x0 + u * 9, dy - u * 0.5, bw2 - u * 9, u * 1);
        ctx.fillStyle = colour;
        this.pill(ctx, x0 + u * 9, dy - u * 0.5, (bw2 - u * 9) * Math.max(0.02, Math.min(1, value)), u * 1);
        ctx.shadowBlur = u * 0.6;
        dy += u * 2.4;
      }
      ctx.textAlign = 'center';
      ctx.font = `800 ${u * 2.6}px ${FONT}`;
      ctx.fillStyle = '#f5f2ea';
      ctx.fillText(f.duel.prompt, W / 2, dy + u * 1.4);
    } else if (f.hint) {
      ctx.textAlign = 'center';
      ctx.font = `800 ${u * 2.8}px ${FONT}`;
      ctx.fillStyle = '#f5f2ea';
      ctx.fillText(f.hint, W / 2, H * 0.44);
    }

    // what the viewers say
    ctx.textAlign = 'left';
    let cy = H - u * 9;
    for (const c of f.comments.slice(-3).reverse()) {
      const a = Math.max(0, Math.min(1, (5.2 - c.age) / 0.8));
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.font = `700 ${u * 1.75}px ${FONT}`;
      ctx.fillStyle = '#f5f2ea';
      ctx.fillText(c.who, u * 2, cy);
      const ww = ctx.measureText(c.who).width;
      ctx.font = `500 ${u * 1.75}px ${FONT}`;
      ctx.fillText(` ${c.text}`, u * 2 + ww, cy, W - u * 4 - ww);
      ctx.globalAlpha = 1;
      cy -= u * 2.5;
    }

    // whose clip this is
    ctx.textAlign = 'right';
    ctx.globalAlpha = 0.7;
    ctx.font = `700 ${u * 1.5}px ${FONT}`;
    ctx.fillStyle = '#f5f2ea';
    ctx.fillText('whiskercam', W - u * 2, H - u * 2.6);
    ctx.restore();
  }

  private drawCard(ctx: CanvasRenderingContext2D, W: number, H: number, c: ClipCard, t: number): void {
    const u = H / 100;
    const a = Math.min(1, t / 0.35);
    ctx.save();
    ctx.fillStyle = `rgba(8,8,10,${0.62 * a})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff4a2e';
    ctx.font = `800 ${u * 1.9}px ${FONT}`;
    ctx.fillText('C L I P   P O S T E D', W / 2, H * 0.3);
    // the title, on up to three lines
    ctx.fillStyle = '#f5f2ea';
    ctx.font = `800 ${u * 3.6}px ${FONT}`;
    const words = c.title.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > W * 0.84 && line) {
        lines.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    let y = H * 0.36;
    for (const l of lines.slice(0, 3)) {
      ctx.fillText(l, W / 2, y);
      y += u * 4.4;
    }
    // the count runs up
    const shown = Math.round(c.views * Math.min(1, t / 1.3) ** 0.6);
    ctx.font = `900 ${u * 9}px ${FONT}`;
    ctx.fillText(shown.toLocaleString('en-GB'), W / 2, y + u * 5.5);
    ctx.font = `600 ${u * 2.2}px ${FONT}`;
    ctx.globalAlpha = a * 0.8;
    ctx.fillText('views', W / 2, y + u * 11.4);
    ctx.globalAlpha = a;
    ctx.font = `700 ${u * 2.1}px ${FONT}`;
    ctx.fillText(`${c.likes.toLocaleString('en-GB')} likes   ·   ${c.rank}`, W / 2, y + u * 16.2);
    ctx.globalAlpha = a * 0.75;
    ctx.font = `600 ${u * 1.7}px ${FONT}`;
    ctx.fillText(c.link, W / 2, H * 0.9);
    ctx.restore();
  }

  private pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const r = Math.min(h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }

  private eye(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    ctx.save();
    ctx.lineWidth = r * 0.28;
    ctx.strokeStyle = '#f5f2ea';
    ctx.beginPath();
    ctx.moveTo(x - r * 1.5, y);
    ctx.quadraticCurveTo(x, y - r * 1.35, x + r * 1.5, y);
    ctx.quadraticCurveTo(x, y + r * 1.35, x - r * 1.5, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = '#f5f2ea';
    ctx.fill();
    ctx.restore();
  }

  /**
   * The run is over: show the closing card for a few seconds (keep calling `frame`), then close the file.
   * Resolves true when a clip is ready to save or share.
   */
  finish(card: ClipCard): Promise<boolean> {
    if (!this.rec || this.rec.state === 'inactive') return Promise.resolve(this.blob !== null);
    this.card = card;
    this.cardSince = performance.now();
    return new Promise((resolve) => {
      this.cardDone = resolve;
      // if frames stop coming (tab hidden), close anyway
      setTimeout(() => this.close(), (CARD_SECONDS + 1.5) * 1000);
    });
  }

  private close(): void {
    const rec = this.rec;
    const done = this.cardDone;
    this.cardDone = null;
    this.card = null;
    if (!rec || rec.state === 'inactive') {
      done?.(this.blob !== null);
      return;
    }
    rec.onstop = () => {
      this.blob = this.chunks.length ? new Blob(this.chunks, { type: rec.mimeType.split(';')[0] }) : null;
      this.chunks = [];
      this.rec = null;
      done?.(this.blob !== null);
    };
    rec.stop();
  }

  discard(): void {
    if (this.rec && this.rec.state !== 'inactive') {
      this.rec.onstop = null;
      this.rec.stop();
    }
    this.rec = null;
    this.chunks = [];
    this.blob = null;
    this.card = null;
    this.cardDone = null;
  }

  /** The finished clip as a file, or null. */
  file(name: string): File | null {
    return this.blob ? new File([this.blob], `${name}.${this.ext}`, { type: this.blob.type }) : null;
  }

  /** Can this device hand the clip straight to other apps (the share sheet on a phone)? */
  canShare(name: string): boolean {
    const file = this.file(name);
    return !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  }

  /** Open the share sheet with the clip. Resolves false when the player backs out or sharing is not possible. */
  async share(name: string, text: string): Promise<boolean> {
    const file = this.file(name);
    if (!file || !this.canShare(name)) return false;
    try {
      await navigator.share({ files: [file], title: 'Whiskercam', text });
      return true;
    } catch {
      return false;
    }
  }

  /** Hand the finished clip to the browser as a download. */
  save(name: string): void {
    if (!this.blob) return;
    const url = URL.createObjectURL(this.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.${this.ext}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
