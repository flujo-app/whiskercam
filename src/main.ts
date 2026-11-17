import { Bot } from './game/bot';
import { restLook, type CatLook, type Coat } from './game/cats';
import type { FurCat } from './game/furcat';
import { Game } from './game/game';
import { loadSettings, QUALITY_SCALE, saveSettings } from './game/settings';
import { Hud } from './ui/hud';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const bootFill = document.getElementById('boot-fill') as HTMLElement;
const bootText = document.getElementById('boot-text') as HTMLElement;
const boot = document.getElementById('boot') as HTMLElement;

/** Can this browser draw the game at all? Returns a plain-language reason when it cannot. */
function unsupported(): string | null {
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) return 'This browser cannot show the game: it needs WebGL 2. A current Chrome, Edge, Firefox or Safari will work.';
  if (!probe.getExtension('EXT_color_buffer_float') && !probe.getExtension('EXT_color_buffer_half_float')) {
    return 'This device’s graphics cannot show the game (no high-range colour buffers). Try another browser or device.';
  }
  return null;
}

async function start(): Promise<void> {
  const reason = unsupported();
  if (reason) {
    bootText.textContent = reason;
    (bootFill.parentElement as HTMLElement).style.display = 'none';
    return;
  }
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    boot.classList.remove('done');
    (bootFill.parentElement as HTMLElement).style.display = 'none';
    bootText.textContent = 'The graphics card dropped the game. Reload the page to carry on.';
  });
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
    lean: touchDevice || params.has('lean'),
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

  // the blurred copy of the picture that fills the sides of a wide screen
  const glow = document.getElementById('glow') as HTMLCanvasElement | null;
  const glowCtx = glow?.getContext('2d') ?? null;
  let glowOn = false;
  let glowTick = 0;
  const place = () => {
    const rect = canvas.getBoundingClientRect();
    hud.place(rect);
    glowOn = !!glow && !manual && innerWidth - rect.width > 80;
    if (glow) glow.style.display = glowOn ? 'block' : 'none';
  };
  place();
  addEventListener('resize', () => requestAnimationFrame(place));

  // leaving the picture (Esc, switching tabs) pauses a run
  const pause = () => {
    if (hud.current === 'none' && game.session.active) {
      game.paused = true;
      game.audio.suspend(true);
      hud.show('pause');
      // give the mouse back, or the pause buttons cannot be clicked (pausing from a gamepad, for instance)
      game.input.unlockPointer();
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
    if (glowOn && glowCtx && glowTick++ % 2 === 0) glowCtx.drawImage(canvas, 0, 0, 288, 512);
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
  const bot = new Bot(game);
  let debugCat: FurCat | null = null;
  let debugCoat: Coat = 'tabby';
  const debugLook: CatLook = restLook();
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
    /** let the bot play for `seconds`; returns where the run stands afterwards */
    bot(seconds: number, goal: 'brother' | number = 'brother', drawEvery = 1) {
      bot.goal = goal;
      const t0 = performance.now();
      game.simWith((dt) => bot.controls(dt), seconds, drawEvery);
      const s = game.session;
      return {
        phase: s.phase,
        views: s.score.views,
        hype: s.score.hype,
        turf: s.score.turf,
        battery: Math.round(s.battery),
        counts: s.score.counts,
        pos: [Math.round(game.player.x * 10) / 10, Math.round(game.player.y * 100) / 100, Math.round(game.player.z * 10) / 10],
        brotherAway: Math.round(s.brother.distanceTo(game.player.x, game.player.z) * 10) / 10,
        msPerFrame: (performance.now() - t0) / ((seconds * 60) / drawEvery),
      };
    },
    /** put a test cat in front of the camera and pose it (for tuning fur and movement) */
    cat(opts: Partial<CatLook> & { coat?: Coat; x?: number; z?: number; heading?: number } = {}) {
      if (!game.catModel) return 'no cat model';
      if (!debugCat || (opts.coat && opts.coat !== debugCoat)) {
        if (debugCat) game.scene.remove(debugCat.root);
        debugCoat = opts.coat ?? 'tabby';
        debugCat = game.catModel.make(debugCoat, 'debug');
        game.scene.add(debugCat.root);
      }
      const x = opts.x ?? game.player.x;
      const z = opts.z ?? game.player.z - 1;
      const g = game.physics.groundBelow(x, 3, z, 6);
      debugCat.root.position.set(x, g ? g.y : 0, z);
      debugCat.root.rotation.y = (-(opts.heading ?? 0) * Math.PI) / 180;
      Object.assign(debugLook, opts);
      debugCat.setLight(game.world.groundLight.sample(x, z, { r: 0, g: 0, b: 0, sun: 1 }));
      debugCat.update(debugLook, 1 / 60);
      return 'ok';
    },
    /** draw `n` frames as fast as possible and report the time per frame (waits for the graphics card) */
    bench(n = 120) {
      const gl = game.renderer.getContext();
      const px = new Uint8Array(4);
      game.sim({}, 10 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      game.sim({ turn: 0.4 }, n / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return (performance.now() - t0) / n;
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
