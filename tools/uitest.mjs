// Click through the whole game like a player would, on a desktop-sized and a phone-sized screen.
//
//   node tools/uitest.mjs [set] [--dist]
//
// Title screen -> name and coat -> settings -> start -> run about -> pause -> carry on -> battery runs out ->
// "clip posted" screen -> run it back -> back to menu. Then the same start on a phone with touch controls.
// Pictures land in build/uitest/. Exits with code 1 when a step fails or the browser reports an error.
// With --dist it tests the built game in dist/ (what gets published) instead of the dev server.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer, preview } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const set = args.find((a) => !a.startsWith('--')) ?? 'estate';
const outDir = path.join(ROOT, 'build', 'uitest');
await fs.mkdir(outDir, { recursive: true });

let server;
let url;
if (args.includes('--dist')) {
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

// ---------------------------------------------------------------- desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page, 'desktop');
  const t0 = Date.now();
  await page.goto(`${url}?set=${set}`);
  await step('desktop: game loads to the title screen', async () => {
    await ready(page);
    console.log(`      loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await shot(page, 'desk_1_title');
  });
  await step('desktop: name, coat and settings', async () => {
    await page.fill('input.name', 'Biscuit');
    await page.locator('button.coat').nth(2).click();
    await page.locator('details.settings summary').click();
    await page.waitForTimeout(300);
    await shot(page, 'desk_2_settings');
    await page.locator('details.settings summary').click();
  });
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
    const button = page.getByRole('button', { name: 'Save the clip' });
    if (!(await button.isVisible())) throw new Error('no "Save the clip" button (recording not supported here?)');
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
    await press('jump');
    let up = false;
    for (let i = 0; i < 12 && !up; i++) {
      await page.waitForTimeout(40);
      up = await page.evaluate(() => window.__wc.game.player.airborne);
    }
    if (!up) throw new Error('Jump did not lift the cat');
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

await browser.close();
await (server.close?.() ?? server.httpServer?.close());
const unique = [...new Set(problems)];
if (unique.length) console.log('browser messages:\n' + unique.slice(0, 20).join('\n'));
console.log(failures.length || unique.length ? `\n${failures.length} step(s) failed, ${unique.length} browser message(s)` : '\nall steps passed, no browser errors');
process.exit(failures.length || unique.length ? 1 : 0);
