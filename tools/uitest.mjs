// Click through the whole game like a player would, on a desktop-sized and a phone-sized screen.
//
//   node tools/uitest.mjs [set] [--dist] [--url https://...]
//
// Title screen -> name and coat -> settings -> start -> run about -> pause -> carry on -> battery runs out ->
// "clip posted" screen -> run it back -> back to menu. Then the same start on a phone with touch controls.
// Then once in a browser set to German, and once more from a server that refuses every eighth file the
// first time. Along the way every language is put on every screen to see that it fits.
// Pictures land in build/uitest/. Exits with code 1 when a step fails or the browser reports an error.
// With --dist it tests the built game in dist/ (what gets published) instead of the dev server,
// with --url a copy that is already online.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer, preview } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const set = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--url') ?? 'estate';
const outDir = path.join(ROOT, 'build', 'uitest');
await fs.mkdir(outDir, { recursive: true });

let server;
let url;
const urlAt = args.indexOf('--url');
if (urlAt >= 0) {
  url = args[urlAt + 1]; // an already published copy, e.g. the live page
} else if (args.includes('--dist')) {
  server = await preview({ root: ROOT, logLevel: 'error', preview: { port: 5198, strictPort: false } });
  url = server.resolvedUrls.local[0];
} else {
  server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5198, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls.local[0];
}

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

const failures = [];
const problems = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}: ${String(err.message ?? err).split(/\r?\n/).filter((l) => !/waiting|scrolling|attempting|retrying/.test(l)).slice(0, 5).join(' | ')}`);
  }
};
const watch = (page, tag) => {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${tag}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${tag} pageerror] ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`[${tag} http ${r.status()}] ${r.url()}`);
  });
};
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.jpg`), type: 'jpeg', quality: 88 });
const state = (page) =>
  page.evaluate(() => {
    const g = window.__wc.game;
    return { phase: g.session.phase, x: g.player.x, z: g.player.z, views: g.session.score.views, paused: g.paused, battery: g.session.battery };
  });
const ready = async (page) => {
  await page.waitForFunction(() => window.__wc !== undefined, null, { timeout: 180000 });
  await page.waitForSelector('.screen.title', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1800); // the loading screen fades out
};

// ---------------------------------------------------------------- checks used on more than one screen size
/** A player who has never played: sharpest picture, steadiest camera, quickest turning (asked for in 1.2.1). */
const startingValues = async (page) => {
  const v = await page.evaluate(() => {
    const value = (key) => document.querySelector(`.screen.title input[data-setting="${key}"]`);
    const picture = document.querySelector('.screen.title details.settings label:not(.language) select');
    return {
      picture: picture?.value,
      turning: [value('sensitivity')?.value, value('sensitivity')?.max],
      shake: [value('motion')?.value, value('motion')?.min],
      scale: window.__wc.game.opts.quality,
    };
  });
  if (v.picture !== '2' || v.scale < 1.2) throw new Error(`the picture starts on step ${v.picture} (scale ${v.scale}), not on the sharpest`);
  if (v.turning[0] !== v.turning[1]) throw new Error(`turning speed starts at ${v.turning[0]} of ${v.turning[1]}`);
  if (v.shake[0] !== v.shake[1]) throw new Error(`camera shake starts at ${v.shake[0]}, not at its lowest (${v.shake[1]})`);
};

/**
 * Put every language on every screen and measure: nothing may stick out of the picture, be cut off, or wrap
 * where there is one line of room. Also every pop-up label, every hint and every fight prompt.
 */
const languagesFit = async (page, tag) => {
  const result = await page.evaluate(async () => {
    const wc = window.__wc;
    const g = wc.game;
    const hud = wc.hud;
    const I = wc.i18n;
    const root = document.getElementById('hud');
    const box = root.getBoundingClientRect();
    const problems = [];
    const lineOf = (e) => parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.3;
    const check = (code, where) => {
      for (const e of root.querySelectorAll('button, .field-label, .chip, .end-label, .end-unit, .logo, .tag, summary, .best, .duel-name, .duel-help, .duel-keys, .clip-note')) {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height || e.matches('.tbtn, .coat')) continue;
        const text = (e.textContent || '').trim().slice(0, 40);
        if (r.left < box.left - 1 || r.right > box.right + 1) problems.push(`${code}, ${where}: "${text}" sticks out sideways`);
        if (e.scrollWidth > e.clientWidth + 2) problems.push(`${code}, ${where}: "${text}" is cut off`);
        if (e.matches('button, .chip, .field-label, summary, .duel-keys')) {
          const cs = getComputedStyle(e);
          const lines = (r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lineOf(e);
          if (lines > (e.matches('.field-label') ? 2.7 : 1.7)) problems.push(`${code}, ${where}: "${text}" wraps onto ${Math.round(lines)} lines`);
        }
      }
    };
    const settle = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const popups = root.querySelector('.popups');
    const hint = root.querySelector('.hint');
    const duel = root.querySelector('.duel');
    const duelKeys = root.querySelector('.duel-keys');
    const titles = {};
    const s = g.session;
    const keep = { views: s.score.views, turf: s.score.turf, tag: s.score.counts.tag, knock: s.score.counts.knock };
    for (const { code } of I.LANGUAGES) {
      await I.setLanguage(code);
      I.relabel();
      const w = I.S();
      if (document.documentElement.lang !== code) problems.push(`${code}: the page does not say which language it is in`);
      hud.show('title');
      root.querySelector('details.settings')?.setAttribute('open', '');
      await settle();
      check(code, 'title screen');
      hud.show('pause');
      await settle();
      check(code, 'pause screen');
      // an end screen with the longest title and every chip
      Object.assign(s.score, { views: 1234567, turf: 3 });
      s.score.counts.tag = 1;
      s.score.counts.knock = 12;
      hud.showEnd(s, 'Biscuit', 0, true);
      hud.clipReady(true, true);
      await settle();
      check(code, 'end screen');
      titles[code] = s.score.title('Biscuit');
      // while playing: every pop-up label, every hint, every fight prompt
      hud.show('none');
      for (const t of [...Object.values(w.deeds).map((x) => x.replace('{name}', w.names.Rocket)), ...Object.values(w.knocks)]) {
        const row = document.createElement('div');
        row.className = 'popup big';
        row.innerHTML = '<span class="popup-views">+12,000</span><span class="popup-text"></span>';
        row.lastChild.textContent = t;
        popups.append(row);
        const r = row.getBoundingClientRect();
        if (r.left < box.left - 1 || r.right > box.right + 1 || r.width > box.width * 0.96) problems.push(`${code}, pop-up: "${t}" is ${Math.round(r.width)} of ${Math.round(box.width)} points wide`);
        row.remove();
      }
      hint.classList.add('on');
      const longest = Object.values(w.names).sort((a, b) => b.length - a.length)[0];
      for (const t of [w.hints.follow, w.hints.tagged, w.hints.puffed, w.hints.rivalPuffed, w.hints.backOff, w.hints.battery, ...Object.values(w.hints.guards), ...Object.values(w.hints.won)]) {
        hint.textContent = t.replace('{name}', longest);
        const r = hint.getBoundingClientRect();
        if (r.left < box.left - 1 || r.right > box.right + 1 || r.height > lineOf(hint) * 2.6) problems.push(`${code}, hint: "${hint.textContent}" does not fit`);
      }
      hint.textContent = '';
      hint.classList.remove('on');
      duel.classList.add('on');
      for (const t of [w.duel.breathe, w.duel.wait, w.duel.batted, w.duel.pull, w.duel.puffed, w.duel.rivalPuffed, w.duel.now]) {
        duelKeys.textContent = t;
        const r = duelKeys.getBoundingClientRect();
        if (r.left < box.left - 1 || r.right > box.right + 1 || r.height > lineOf(duelKeys) * 1.7 + 12) problems.push(`${code}, fight prompt: "${t}" does not fit on one line`);
      }
      check(code, 'fight');
      duel.classList.remove('on');
    }
    Object.assign(s.score, { views: keep.views, turf: keep.turf });
    s.score.counts.tag = keep.tag;
    s.score.counts.knock = keep.knock;
    await I.setLanguage('en');
    I.relabel();
    hud.show('title');
    return { problems, titles, languages: I.LANGUAGES.length, start: document.querySelector('.screen.title .btn.primary')?.textContent };
  });
  console.log(`      ${result.languages} languages; a German clip title: ${result.titles.de}`);
  if (result.problems.length) throw new Error(`${result.problems.length} labels do not fit: ${result.problems.slice(0, 6).join(' | ')}`);
  if (result.start !== 'Start recording') throw new Error(`back in English the start button says "${result.start}"`);
  await shot(page, `${tag}_languages_back_in_english`);
};

// ---------------------------------------------------------------- desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'en-GB' });
  const page = await ctx.newPage();
  watch(page, 'desktop');
  const t0 = Date.now();
  await page.goto(`${url}?set=${set}`);
  await step('desktop: game loads to the title screen', async () => {
    await ready(page);
    console.log(`      loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await shot(page, 'desk_1_title');
  });
  await step('desktop: the full pictures arrive, and shiny things get their surroundings to mirror', async () => {
    // the game starts on small copies of every picture; the full ones and the reflection pictures follow
    await page.waitForFunction(() => window.__wc.game.world.pictures.owed === 0, null, { timeout: 180000 });
    await page.waitForFunction(() => window.__wc.game.reflections?.probes.every((p) => p.taken && p.faces >= 6), null, { timeout: 90000 });
    const r = await page.evaluate(() => {
      const g = window.__wc.game;
      const probes = g.reflections.probes;
      return { cars: probes.filter((p) => p.kind === 'car').length, walls: probes.filter((p) => p.kind === 'wall').length, failed: g.world.pictures.failed.length };
    });
    console.log(`      sharp after ${((Date.now() - t0) / 1000).toFixed(1)} s; reflection pictures: ${r.cars} cars, ${r.walls} stretches of wall`);
    if (r.failed) throw new Error(`${r.failed} pictures did not load`);
    if (r.cars < 5 || r.walls < 10) throw new Error('too few reflection pictures');
  });
  await step('desktop: a cat in front of a glass door sees itself', async () => {
    const seen = await page.evaluate(async () => {
      const wc = window.__wc;
      const g = wc.game;
      const r = g.reflections;
      // on the landing of the entrance at -2.9, -25.4 (the door faces south), looking at the door
      wc.pose(null);
      wc.place(-3.3, 0.9, -24.3, 0);
      await new Promise((done) => setTimeout(done, 700));
      const eye = g.rig.rig.position.clone();
      const wall = g.glassWalls.find((w) => w.nz === 1 && Math.abs(w.offset + 25.37) < 0.2);
      if (!wall) return { error: 'no glass wall found at the entrance' };
      const size = 768;
      const read = () => {
        r.setMirror(eye, wall, 1);
        const px = new Uint16Array(size * size * 4);
        g.renderer.readRenderTargetPixels(r.mirror, 0, 0, size, size, px);
        return px;
      };
      const withCat = read();
      // the light the cat stands in: the landing is a slab, and the ground sealed under it is black
      const light = (x, z, y) => {
        const v = g.world.groundLight.sample(x, z, { r: 0, g: 0, b: 0, sun: 0 }, y);
        return v.r + v.g + v.b;
      };
      const lit = { landing: light(g.player.x, g.player.z, g.player.y), beside: light(-5.5, -24.3, 0.1), roof: 0, road: 0, under: 0 };
      // and on the roof of the car parked in the open at -19.5, 19.7, against the road beside it and the ground under it
      const roof = g.physics.groundBelow(-19.5, 2.2, 19.7, 3);
      if (roof) {
        lit.roof = light(-19.5, 19.7, roof.y);
        lit.road = light(-16.5, 19.7, 0);
        lit.under = light(-19.5, 19.7, 0);
      }
      g.playerCat.root.visible = false;
      const without = read();
      g.playerCat.root.visible = true;
      // back to where a run starts
      const [sx, sy, sz] = g.world.info.spawn.pos;
      wc.place(sx, sy, sz, g.world.info.spawn.heading);
      const f = wc.THREE.DataUtils.fromHalfFloat;
      let changed = 0;
      for (let i = 0; i < withCat.length; i += 4 * 3) {
        if (withCat[i] !== without[i] && Math.abs(f(withCat[i]) - f(without[i])) + Math.abs(f(withCat[i + 1]) - f(without[i + 1])) > 0.02) changed++;
      }
      return { changed: changed * 3, glassFrom: wall.y0, lit, catAt: [g.player.x, g.player.y, g.player.z].map((v) => +v.toFixed(2)) };
    });
    if (seen.error) throw new Error(seen.error);
    console.log(`      the cat takes up about ${seen.changed} of the mirror picture's ${768 * 768} points (glass starts ${seen.glassFrom.toFixed(2)} m above the ground)`);
    if (seen.changed < 300) throw new Error('the cat does not show in the mirror image of the door');
    const pc = (a, b) => `${Math.round((a / b) * 100)}%`;
    console.log(`      light on the cat: on the landing ${pc(seen.lit.landing, seen.lit.beside)} of the light beside it; on a car roof ${pc(seen.lit.roof, seen.lit.road)} of the light on the road, under that car ${pc(seen.lit.under, seen.lit.road)}`);
    if (seen.lit.landing < seen.lit.beside * 0.5) throw new Error('a cat on the landing stands in the dark');
    if (seen.lit.roof < seen.lit.road * 0.5) throw new Error('a cat on a car roof stands in the dark');
    if (seen.lit.under > seen.lit.road * 0.3) throw new Error('a cat under a car is as bright as one in the open');
  });
  await step('desktop: name, coat and settings', async () => {
    await page.fill('input.name', 'Biscuit');
    await page.locator('button.coat').nth(2).click();
    await page.locator('details.settings summary').click();
    await page.waitForTimeout(300);
    await shot(page, 'desk_2_settings');
    await page.locator('details.settings summary').click();
  });
  await step('desktop: a new player starts with the sharpest picture, the steadiest camera, the quickest turning', async () => startingValues(page));
  await step('desktop: every language fits the screen, and the game comes back to English', async () => languagesFit(page, 'desk'));
  let before;
  await step('desktop: start, and the cat runs when W is held', async () => {
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.waitForFunction(() => window.__wc.game.session.phase === 'play', null, { timeout: 15000 });
    before = await state(page);
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await page.waitForTimeout(2500);
    await shot(page, 'desk_3_play');
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');
    const after = await state(page);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    if (moved < 3) throw new Error(`cat only moved ${moved.toFixed(2)} m`);
    if (after.views <= 0) throw new Error('no views counted');
  });
  await step('desktop: a paw swipe and a jump do not break anything', async () => {
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('Space');
    await page.waitForTimeout(700);
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
  });
  await step('desktop: Esc pauses, "Carry on" resumes', async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.screen.pause', { state: 'visible', timeout: 5000 });
    const b1 = (await state(page)).battery;
    await page.waitForTimeout(800);
    const b2 = (await state(page)).battery;
    if (Math.abs(b1 - b2) > 0.01) throw new Error('the battery keeps draining while paused');
    await shot(page, 'desk_4_pause');
    await page.getByRole('button', { name: 'Carry on' }).click();
    await page.waitForSelector('.screen.pause', { state: 'hidden', timeout: 5000 });
    await page.waitForTimeout(500);
    if ((await state(page)).paused) throw new Error('still paused after "Carry on"');
  });
  await step('desktop: the battery runs out and the clip is posted', async () => {
    await page.evaluate(() => (window.__wc.game.session.battery = 1.5));
    await page.waitForSelector('.screen.end', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1200);
    await shot(page, 'desk_5_end');
    const title = await page.locator('.end-title').textContent();
    if (!title || title.length < 4) throw new Error('no clip title');
    console.log(`      clip title: ${title}`);
  });
  await step('desktop: "Save the clip" hands over a real video file', async () => {
    // the clip takes a few more seconds: its closing card (title, views) is written at the end
    const button = page.locator('.clip-save');
    if (!(await button.isVisible())) throw new Error('no clip button (recording not supported here?)');
    await page.waitForFunction(() => {
      const b = document.querySelector('.clip-save');
      return b && !b.disabled && b.textContent === 'Save the clip';
    }, null, { timeout: 15000 });
    await shot(page, 'desk_6_clip_ready');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), button.click()]);
    const file = path.join(outDir, download.suggestedFilename());
    await download.saveAs(file);
    const size = (await fs.stat(file)).size;
    console.log(`      ${download.suggestedFilename()}: ${(size / 1e6).toFixed(2)} MB`);
    if (size < 50000) throw new Error('the clip file is nearly empty');
    await fs.rm(file);
  });
  await step('desktop: "Run it back" starts a fresh round', async () => {
    await page.getByRole('button', { name: 'Run it back' }).click();
    await page.waitForFunction(() => window.__wc.game.session.phase === 'play', null, { timeout: 15000 });
    const s = await state(page);
    if (s.views > 400) throw new Error(`views not reset (${s.views})`);
    if (s.battery < 170) throw new Error(`battery not refilled (${s.battery})`);
  });
  await step('desktop: back to the menu from the pause screen', async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.screen.pause', { state: 'visible', timeout: 5000 });
    await page.getByRole('button', { name: 'Back to menu' }).click();
    await page.waitForSelector('.screen.title', { state: 'visible', timeout: 5000 });
    const best = await page.locator('.screen.title .best').textContent();
    console.log(`      title screen says: ${best}`);
  });
  await step('desktop: the name and the best score are remembered after a reload', async () => {
    await page.reload();
    await ready(page);
    const name = await page.inputValue('input.name');
    if (name !== 'Biscuit') throw new Error(`name came back as "${name}"`);
  });
  await ctx.close();
}

// ---------------------------------------------------------------- phone
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  watch(page, 'phone');
  await page.goto(`${url}?set=${set}`);
  await step('phone: game loads to the title screen', async () => {
    await ready(page);
    await shot(page, 'phone_1_title');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1);
    if (overflow) throw new Error('the page scrolls on a phone');
  });
  await step('phone: the pictures fit a phone\'s memory', async () => {
    // 1.0 never started on a real phone: it unpacked about 300 full-size pictures at once
    // (the game starts on small copies; the count that matters is with every full picture in)
    await page.waitForFunction(() => window.__wc.game.world.pictures.owed === 0, null, { timeout: 240000 });
    const m = await page.evaluate(() => {
      const p = window.__wc.game.world.pictures;
      return { mb: p.bytes / 1e6, count: p.total, failed: p.failed.length, scale: p.scale, parallel: p.parallel };
    });
    console.log(`      ${m.count} pictures at ${m.scale} size, ${m.parallel} at a time: about ${m.mb.toFixed(0)} MB on the graphics chip, ${m.failed} failed`);
    if (m.failed) throw new Error(`${m.failed} pictures did not load`);
    if (m.mb > 330) throw new Error(`pictures take ${m.mb.toFixed(0)} MB, more than a phone can be trusted with (330 MB)`);
    if (m.parallel > 4) throw new Error('too many pictures are unpacked at once');
  });
  await step('phone: the picture is drawn at a proper size', async () => {
    // 1.2.0 drew a phone's two views at about 350 x 350 points and blew them up: blocks and ragged edges
    const v = await page.evaluate(() => {
      const g = window.__wc.game;
      return { view: [g.rig.viewSize.x, g.rig.viewSize.y], canvas: [g.canvas.width, g.canvas.height], step: g.pacer.size, thrifty: g.thrifty };
    });
    console.log(`      picture ${v.canvas[0]} x ${v.canvas[1]}, each of its two views ${v.view[0]} x ${v.view[1]}`);
    if (v.canvas[1] < 1200) throw new Error(`the picture has only ${v.canvas[1]} lines`);
    if (v.view[1] < v.canvas[1] * 0.7) throw new Error(`the views are only ${v.view[1]} points high for a picture of ${v.canvas[1]} lines`);
  });
  await step('phone: a new player starts with the sharpest picture, the steadiest camera, the quickest turning', async () => startingValues(page));
  await step('phone: every language fits the screen, and the game comes back to English', async () => languagesFit(page, 'phone'));
  await step('phone: start, touch controls appear', async () => {
    await page.getByRole('button', { name: 'Start recording' }).tap();
    await page.waitForFunction(() => window.__wc.game.session.phase === 'play', null, { timeout: 15000 });
    await page.waitForSelector('.touch', { state: 'visible', timeout: 5000 });
    const buttons = await page.locator('.tbtn').count();
    if (buttons < 3) throw new Error(`only ${buttons} touch buttons`);
  });
  const cdp = await ctx.newCDPSession(page);
  const finger = (id, x, y) => [{ x, y, id, radiusX: 12, radiusY: 12, force: 1 }];
  await step('phone: the left thumb makes the cat run', async () => {
    const before = await state(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger(1, 95, 640) });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: finger(1, 95, 640 - i * 11) });
    await page.waitForTimeout(2200);
    await shot(page, 'phone_2_play');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const after = await state(page);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    if (moved < 2) throw new Error(`cat only moved ${moved.toFixed(2)} m`);
  });
  await step('phone: Jump and the paw buttons do something', async () => {
    const centre = async (cls) => {
      const r = await page.locator(`.tbtn.${cls}`).boundingBox();
      return [r.x + r.width / 2, r.y + r.height / 2];
    };
    const press = async (cls) => {
      const [x, y] = await centre(cls);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger(2, x, y) });
      await page.waitForTimeout(90);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await page.waitForTimeout(600);
    // a tap of 90 ms, the way a thumb taps: in 1.2.0 that was a hop of 30 cm
    const y0 = await page.evaluate(() => window.__wc.game.player.y);
    await press('jump');
    let up = false;
    let top = 0;
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(40);
      const now = await page.evaluate(() => ({ air: window.__wc.game.player.airborne, y: window.__wc.game.player.y }));
      up ||= now.air;
      top = Math.max(top, now.y - y0);
    }
    if (!up) throw new Error('Jump did not lift the cat');
    console.log(`      a tap on Jump lifts the cat ${top.toFixed(2)} m`);
    if (top < 0.38) throw new Error(`a tap on Jump only lifts the cat ${top.toFixed(2)} m`);
    await page.waitForTimeout(900);
    for (const [cls, index] of [['paw-l', 0], ['paw-r', 1]]) {
      await press(cls);
      let swung = false;
      for (let i = 0; i < 10 && !swung; i++) {
        await page.waitForTimeout(30);
        swung = await page.evaluate((k) => window.__wc.game.session.swipeAnim[k] > 0, index);
      }
      if (!swung) throw new Error(`${cls} did not swing a paw`);
      await page.waitForTimeout(400);
    }
  });
  await step('phone: the clip screen fits', async () => {
    await page.evaluate(() => (window.__wc.game.session.battery = 1.2));
    await page.waitForSelector('.screen.end', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1200);
    await shot(page, 'phone_3_end');
    const fits = await page.evaluate(() => {
      const r = document.querySelector('.screen.end .panel').getBoundingClientRect();
      return r.left >= -1 && r.right <= innerWidth + 1;
    });
    if (!fits) throw new Error('the end panel is wider than the screen');
  });
  await ctx.close();
}

// ---------------------------------------------------------------- a browser set to German
// The game follows the browser's language unless the player picks one, and remembers what they picked.
// (Not on a live copy: nobody needs the whole estate downloaded once more for this.)
if (urlAt < 0) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'de-AT' });
  const page = await ctx.newPage();
  watch(page, 'german');
  await page.goto(`${url}?set=${set}`);
  await step('german browser: the game starts in German', async () => {
    await ready(page);
    const t = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      start: document.querySelector('.screen.title .btn.primary')?.textContent,
      choice: document.querySelector('.screen.title label.language select')?.value,
    }));
    await shot(page, 'german_1_title');
    if (t.lang !== 'de' || t.start !== 'Aufnahme starten') throw new Error(`language "${t.lang}", start button "${t.start}"`);
    if (t.choice !== 'auto') throw new Error(`the language setting says "${t.choice}", not automatic`);
  });
  await step('german browser: the run is in German too', async () => {
    await page.getByRole('button', { name: 'Aufnahme starten' }).tap();
    await page.waitForFunction(() => window.__wc.game.session.phase === 'play', null, { timeout: 15000 });
    // the first hint, and something knocked over
    const hint = await page.evaluate(() => window.__wc.game.session.hint);
    if (hint !== 'Folge Rocket') throw new Error(`the first hint says "${hint}"`);
    await page.evaluate(() => {
      const s = window.__wc.game.session.score;
      s.add('knock', 'gnome');
      s.say('knock');
    });
    await page.waitForTimeout(500);
    await shot(page, 'german_2_run');
    const seen = await page.evaluate(() => ({ popup: document.querySelector('.popup .popup-text')?.textContent, jump: document.querySelector('.tbtn.jump')?.textContent }));
    if (seen.popup !== 'Ein Zwerg ist gefallen' || seen.jump !== 'Sprung') throw new Error(`pop-up "${seen.popup}", jump button "${seen.jump}"`);
    await page.evaluate(() => (window.__wc.game.session.battery = 1.2));
    await page.waitForSelector('.screen.end', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(800);
    await shot(page, 'german_3_end');
    const end = await page.evaluate(() => document.querySelector('.screen.end .end-label')?.textContent);
    if (end !== 'Clip gepostet') throw new Error(`the end screen is headed "${end}"`);
  });
  await step('german browser: picking English switches at once and is remembered', async () => {
    await page.getByRole('button', { name: 'Menü' }).tap();
    await page.waitForSelector('.screen.title', { state: 'visible', timeout: 15000 });
    await page.locator('details.settings summary').tap();
    await page.locator('.screen.title label.language select').selectOption('en');
    await page.waitForFunction(() => document.querySelector('.screen.title .btn.primary')?.textContent === 'Start recording', null, { timeout: 10000 });
    const open = await page.evaluate(() => document.querySelector('.screen.title details.settings')?.hasAttribute('open'));
    if (!open) throw new Error('the settings closed when the language changed');
    await page.reload();
    await ready(page);
    const start = await page.evaluate(() => document.querySelector('.screen.title .btn.primary')?.textContent);
    if (start !== 'Start recording') throw new Error(`after a reload the start button says "${start}"`);
  });
  await ctx.close();
}

// ---------------------------------------------------------------- a busy server
// A host under load answers "busy, try later" (503) for a file now and then, and so does mobile data in its
// own way. Here every eighth file of the estate is refused the first time it is asked for. The game has to
// ask again by itself and end up with every wall and every picture. (Not on a live copy: nobody needs the
// whole estate downloaded a third time for this.)
if (urlAt < 0) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'en-GB' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[busy server pageerror] ${e.message}`));
  const asked = new Set();
  let refused = 0;
  let count = 0;
  await page.route(/\/assets\/.+\.(glb|webp|png|json|bin)(\?.*)?$/, async (route) => {
    const u = route.request().url();
    // the small copies are meant to be given up on at once: leave those alone
    if (/\/s\/[^/]+$/.test(u) || asked.has(u)) return route.continue();
    asked.add(u);
    if (++count % 8 === 0) {
      refused++;
      return route.fulfill({ status: 503, body: 'busy' });
    }
    return route.continue();
  });
  await page.goto(`${url}?set=${set}`);
  await step('busy server: the game asks again for every file it was refused', async () => {
    await ready(page);
    await page.waitForFunction(() => window.__wc.game.world.pictures.owed === 0, null, { timeout: 180000 });
    const r = await page.evaluate(() => {
      const g = window.__wc.game;
      let meshes = 0;
      g.world.group.traverse((o) => {
        if (o.isMesh) meshes++;
      });
      return { failed: g.world.pictures.failed, meshes, chunks: g.world.info.chunks.length };
    });
    console.log(`      ${refused} of ${count} files refused once; ${r.failed.length} pictures missing in the end; ${r.meshes} parts of the estate in place`);
    if (refused < 20) throw new Error('the test refused too few files to mean anything');
    if (r.failed.length) throw new Error(`${r.failed.length} pictures never arrived, e.g. ${r.failed[0]}`);
    if (r.meshes < r.chunks) throw new Error('parts of the estate are missing');
    await shot(page, 'busy_1_title');
  });
  await ctx.close();
}

await browser.close();
if (server) await (server.close?.() ?? server.httpServer?.close());
const unique = [...new Set(problems)];
if (unique.length) console.log('browser messages:\n' + unique.slice(0, 20).join('\n'));
console.log(failures.length || unique.length ? `\n${failures.length} step(s) failed, ${unique.length} browser message(s)` : '\nall steps passed, no browser errors');
process.exit(failures.length || unique.length ? 1 : 0);
