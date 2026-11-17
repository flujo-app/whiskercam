import { Game } from './game/game';
import { loadSettings, QUALITY_SCALE, saveSettings } from './game/settings';
import { Hud } from './ui/hud';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const bootFill = document.getElementById('boot-fill') as HTMLElement;
const bootText = document.getElementById('boot-text') as HTMLElement;
const boot = document.getElementById('boot') as HTMLElement;

async function start(): Promise<void> {
  const settings = loadSettings();
  const manual = params.has('manual');
  const touchDevice = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (touchDevice && !localStorage.getItem('whiskercam.settings.v1')) settings.quality = 1;
  const size = params.get('size')?.split('x').map(Number);

  const game = await Game.create(canvas, {
    set: params.get('set') ?? 'estate',
    quality: params.has('q') ? Number(params.get('q')) : QUALITY_SCALE[settings.quality] ?? 1,
    size: size && size.length === 2 ? [size[0], size[1]] : undefined,
    manual,
    onProgress: (f, text) => {
      bootFill.style.width = `${Math.round(f * 100)}%`;
      bootText.textContent = text;
    },
  });

  const hud = new Hud(
    settings,
    {
      play() {
        game.input.lockPointer();
        game.beginRun(settings);
        hud.resetRun();
        hud.show('none');
      },
      resume() {
        game.input.lockPointer();
        game.audio.suspend(false);
        game.paused = false;
        hud.show('none');
      },
      restart() {
        game.resetRun();
        game.audio.suspend(false);
        game.input.lockPointer();
        game.beginRun(settings);
        hud.resetRun();
        hud.show('none');
      },
      toMenu() {
        game.resetRun();
        game.audio.suspend(false);
        game.paused = false;
        hud.show('title');
      },
      saveClip() {
        game.recorder.save(`${settings.catName.replace(/[^\w-]+/g, '_') || 'cat'}_whiskercam`);
      },
      settingsChanged() {
        saveSettings(settings);
        game.applySettings(settings);
      },
      press: (name, held) => game.input.press(name, held),
      release: (name) => game.input.release(name),
    },
    touchDevice,
  );
  game.applySettings(settings);
  game.input.onStick = (c, k) => hud.setStick(c, k, canvas.getBoundingClientRect());

  const place = () => hud.place(canvas.getBoundingClientRect());
  place();
  addEventListener('resize', () => requestAnimationFrame(place));

  // leaving the picture (Esc, switching tabs) pauses a run
  const pause = () => {
    if (hud.current === 'none' && game.session.active) {
      game.paused = true;
      game.audio.suspend(true);
      hud.show('pause');
    }
  };
  document.addEventListener('pointerlockchange', () => {
    if (!game.input.pointerLocked && !game.input.usingTouch) pause();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });

  let finished = false;
  game.onFrame = (dt, controls) => {
    if (controls.pause) pause();
    hud.update(game.session, dt, game.input.usingTouch);
    if (game.session.phase === 'ended' && !finished) {
      finished = true;
      game.input.unlockPointer();
      const best = Math.max(settings.best, game.session.score.views);
      void game.recorder.stop().then((ok) => {
        hud.showEnd(game.session, settings.catName, settings.best, ok);
        settings.best = best;
        settings.runs += 1;
        saveSettings(settings);
      });
    }
    if (game.session.phase !== 'ended') finished = false;
  };

  boot.classList.add('done');

  // hooks for automated test pictures (tools/shots.mjs) and for poking around in the console
  const api = {
    game,
    hud,
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
    /** start a run without touching the menus */
    play() {
      game.beginRun(settings);
      hud.resetRun();
      hud.show('none');
    },
    stats() {
      const r = game.renderer.info.render;
      return { calls: r.calls, triangles: r.triangles, textures: game.renderer.info.memory.textures, programs: game.renderer.info.programs?.length ?? 0 };
    },
    shot(): string {
      return canvas.toDataURL('image/jpeg', 0.92);
    },
  };
  (window as unknown as { __wc: typeof api }).__wc = api;

  if (manual) game.sim({}, 1 / 60);
  else game.start();
}

start().catch((err) => {
  console.error(err);
  boot.classList.remove('done');
  bootText.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
