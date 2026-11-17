// Take test pictures of the game in a real (headless) browser.
//
//   node tools/shots.mjs <set> [--out build/shots] [--size 540x960] [--only name]
//
// Starts the dev server, opens the page in Edge with ?manual (frames only when asked),
// moves the camera to each pose from tools/shots.json and saves a JPEG.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const set = args.find((a) => !a.startsWith('--')) ?? 'estate';
const outDir = path.resolve(ROOT, opt('out', 'build/shots'));
const size = opt('size', '540x960');
const only = opt('only', null);
const [W, H] = size.split('x').map(Number);

const shots = JSON.parse(await fs.readFile(path.join(ROOT, 'tools', 'shots.json'), 'utf8'))[set] ?? [];
await fs.mkdir(outDir, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5199, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url()}`);
});

await page.goto(`${url}?set=${set}&manual=1&size=${size}`);
try {
  await page.waitForFunction(() => window.__wc !== undefined, null, { timeout: 120000 });
} catch {
  console.error('game did not start:\n' + problems.join('\n'));
  await browser.close();
  await server.close();
  process.exit(1);
}
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`gpu: ${gpu}`);

for (const s of shots) {
  if (only && s.name !== only) continue;
  const dataUrl = await page.evaluate((shot) => {
    const wc = window.__wc;
    if (shot.look) Object.assign(wc.look, shot.look);
    if (shot.pose) {
      // camera only, detached from the cat
      wc.pose(shot.pose);
      wc.step(40); // let the automatic exposure settle
    } else if (shot.cat) {
      // the real thing: put the cat down and play the listed inputs
      wc.pose(null);
      wc.place(shot.cat.x, shot.cat.y ?? 0.6, shot.cat.z, shot.cat.heading ?? 0);
      wc.step(40);
      for (const seg of shot.sim ?? []) wc.sim(seg, seg.t);
    }
    return wc.shot();
  }, s);
  const file = path.join(outDir, `${set}_${s.name}.jpg`);
  await fs.writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  const stats = await page.evaluate(() => window.__wc.stats());
  console.log(`${s.name}: ${stats.calls} draw calls, ${stats.triangles} triangles`);
}
if (problems.length) console.log('browser messages:\n' + [...new Set(problems)].slice(0, 20).join('\n'));
await browser.close();
await server.close();
