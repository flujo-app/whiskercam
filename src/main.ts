import { Game } from './game/game';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const bootFill = document.getElementById('boot-fill') as HTMLElement;
const bootText = document.getElementById('boot-text') as HTMLElement;
const boot = document.getElementById('boot') as HTMLElement;

async function start(): Promise<void> {
  const size = params.get('size')?.split('x').map(Number);
  const game = await Game.create(canvas, {
    set: params.get('set') ?? 'estate',
    quality: Number(params.get('q') ?? '1'),
    size: size && size.length === 2 ? [size[0], size[1]] : undefined,
    manual: params.has('manual'),
    onProgress: (f, text) => {
      bootFill.style.width = `${Math.round(f * 100)}%`;
      bootText.textContent = text;
    },
  });
  boot.classList.add('done');
  canvas.addEventListener('click', () => game.input.lockPointer());

  // hooks for automated test pictures (tools/shots.mjs) and for poking around in the console
  const api = {
    game,
    look: game.post.look,
    /** put the camera somewhere, detached from the cat (null = back to the cat) */
    pose(p: { x: number; y: number; z: number; heading?: number; pitch?: number; roll?: number } | null) {
      game.freeCam = p ? { heading: 0, pitch: -6, roll: 0, ...p } : null;
      game.post.cut();
    },
    /** put the cat somewhere */
    place(x: number, y: number, z: number, heading: number) {
      game.player.place(x, y, z, heading);
      game.post.cut();
    },
    /** advance and draw `n` frames without input */
    step(n = 1) {
      game.sim({}, n / 60);
    },
    sim: game.sim.bind(game),
    stats() {
      const r = game.renderer.info.render;
      return { calls: r.calls, triangles: r.triangles, textures: game.renderer.info.memory.textures, programs: game.renderer.info.programs?.length ?? 0 };
    },
    shot(): string {
      return canvas.toDataURL('image/jpeg', 0.92);
    },
  };
  (window as unknown as { __wc: typeof api }).__wc = api;

  if (params.has('manual')) game.sim({}, 1 / 60);
  else game.start();
}

start().catch((err) => {
  console.error(err);
  bootText.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
