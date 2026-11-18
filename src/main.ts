import type { ClipFrame } from './engine/recorder';
import { RUN_SECONDS } from './game/session';
import * as THREE from 'three';
import type { Controls } from './engine/input';
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
    msaa: params.has('msaa') ? Number(params.get('msaa')) : undefined,
    pictureScale: params.has('pics') ? Number(params.get('pics')) : undefined,
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
        game.recorder.save(clipName());
      },
      shareClip() {
        const score = game.session.score;
        void game.recorder.share(clipName(), `${score.title(settings.catName)}: ${Math.round(score.views).toLocaleString('en-GB')} views on Whiskercam. ${LINK}`);
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
  const LINK = 'flujo-app.github.io/whiskercam';
  const clipName = () => `${settings.catName.replace(/[^\w-]+/g, '_') || 'cat'}_whiskercam`;
  const clip: ClipFrame = { views: 0, hype: 1, seconds: 0, battery: 1, turf: 0, turfMax: 3, stamina: 1, feed: [], comments: [], hint: '', duel: null };
  game.onFrame = (dt, controls) => {
    game.input.live = hud.current === 'none' && game.session.active && !game.paused;
    if (glowOn && glowCtx && glowTick++ % 2 === 0) glowCtx.drawImage(canvas, 0, 0, 288, 512);
    if (controls.pause) pause();
    hud.update(game.session, dt, game.input.usingTouch);
    // the clip: the picture plus everything written on it, composed right after each frame is drawn
    if (game.recorder.recording) {
      const s = game.session;
      const sc = s.score;
      const now = sc.clock;
      clip.views = sc.views;
      clip.hype = sc.hype;
      clip.seconds = s.elapsed;
      clip.battery = s.battery / RUN_SECONDS;
      clip.turf = sc.turf;
      clip.turfMax = s.rivals.length;
      clip.stamina = s.stamina;
      clip.feed = sc.feed.map((f) => ({ text: f.text, views: f.views, age: now - f.t }));
      clip.comments = settings.comments ? sc.comments.slice(-3).map((c) => ({ who: c.who, text: c.text, age: now - c.t })) : [];
      clip.hint = s.hintFor > 0 ? s.hint : '';
      clip.duel = s.phase === 'duel' && s.duel ? { you: s.playerNerve, them: s.rivalNerve, name: s.duelRival?.info.name ?? '', prompt: hud.duelPrompt } : null;
      game.recorder.frame(clip);
    }
    if (game.session.phase === 'ended' && !finished) {
      finished = true;
      game.input.unlockPointer();
      const score = game.session.score;
      const best = Math.max(settings.best, score.views);
      const making = game.recorder.recording;
      hud.showEnd(game.session, settings.catName, settings.best, making);
      settings.best = best;
      settings.runs += 1;
      saveSettings(settings);
      if (making) {
        // the closing card (title, views, likes) is written into the last seconds of the clip
        void game.recorder
          .finish({ title: score.title(settings.catName), views: score.views, likes: score.likes, rank: score.rank(), link: LINK })
          .then((ok) => hud.clipReady(ok, ok && game.recorder.canShare(clipName())));
      }
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
    /** Play on without drawing (fast: for movement tests). `c` holds the buttons for the whole stretch. */
    walk(c: Partial<Controls>, seconds: number) {
      const held: Controls = { move: 0, turn: 0, yaw: 0, pitch: 0, sprint: false, jump: false, jumpHeld: false, pawLeft: false, pawRight: false, dodge: false, pause: false, any: false, ...c };
      let first = true;
      game.simWith(() => {
        // one-shot buttons only on the first step
        if (!first) held.jump = held.pawLeft = held.pawRight = held.dodge = false;
        first = false;
        return held;
      }, seconds, 1e9);
    },
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
  // tests need to cast rays at what is drawn, to compare it with what is solid
  (api as unknown as { THREE: unknown }).THREE = THREE;
  (window as unknown as { __wc: typeof api }).__wc = api;

  if (manual) game.sim({}, 1 / 60);
  else game.start();
}

start().catch((err) => {
  console.error(err);
  boot.classList.remove('done');
  // say something a person can act on (a failed file used to show up as "[object Event]")
  const file = (err as { target?: { src?: string } } | null)?.target?.src;
  const why = err instanceof Error ? err.message : file ? `a file did not load (${file.split('/').pop()})` : 'a file did not load';
  bootText.textContent = `Could not start: ${why}. Check the connection and reload the page.`;
});
