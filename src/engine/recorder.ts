/**
 * Records the picture (and sound) into a video file while the game runs, so every run
 * ends with a real clip the player can keep. Only the picture is recorded, not the menus.
 */
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private blob: Blob | null = null;
  private ext = 'webm';

  constructor(private readonly canvas: HTMLCanvasElement) {}

  get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof this.canvas.captureStream === 'function';
  }

  get recording(): boolean {
    return this.rec !== null && this.rec.state === 'recording';
  }

  start(audio?: MediaStream | null): void {
    this.discard();
    if (!this.supported) return;
    const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) return;
    try {
      const stream = this.canvas.captureStream(30);
      for (const track of audio?.getAudioTracks() ?? []) stream.addTrack(track);
      this.rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 });
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

  /** Finish the file. Resolves true when a clip is ready to save. */
  stop(): Promise<boolean> {
    const rec = this.rec;
    if (!rec || rec.state === 'inactive') return Promise.resolve(this.blob !== null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        this.blob = this.chunks.length ? new Blob(this.chunks, { type: rec.mimeType }) : null;
        this.chunks = [];
        this.rec = null;
        resolve(this.blob !== null);
      };
      rec.stop();
    });
  }

  discard(): void {
    if (this.rec && this.rec.state !== 'inactive') {
      this.rec.onstop = null;
      this.rec.stop();
    }
    this.rec = null;
    this.chunks = [];
    this.blob = null;
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
