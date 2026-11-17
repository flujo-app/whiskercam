// Let the built-in bot play whole runs in a hidden browser and report what happened.
//
//   node tools/playtest.mjs [set] [--size 540x960] [--seconds 200] [--goal brother|0|1|2]
//
// Prints a line every ten game seconds (views, battery, position) and saves pictures to build/playtest/.
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
const set = args.find((a) => !a.startsWith('--') && !/^\d/.test(a)) ?? 'estate';
const size = opt('size', '540x960');
const seconds = Number(opt('seconds', '200'));
const goalArg = opt('goal', 'brother');
const goal = goalArg === 'brother' ? 'brother' : Number(goalArg);
const [W, H] = size.split('x').map(Number);
const outDir = path.join(ROOT, 'build', 'playtest');
await fs.mkdir(outDir, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5198, strictPort: false } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
await page.goto(`${server.resolvedUrls.local[0]}?set=${set}&manual=1&size=${size}`);
await page.waitForFunction(() => window.__wc !== undefined, null, { timeout: 180000 });
await page.evaluate(() => window.__wc.play());

let frame = 0;
let slowest = 0;
for (let t = 0; t < seconds; t += 10) {
  const r = await page.evaluate(([g]) => window.__wc.bot(10, g, 1), [goal]);
  slowest = Math.max(slowest, r.msPerFrame);
  console.log(`${String(t + 10).padStart(4)}s  ${r.phase.padEnd(7)} views ${String(r.views).padStart(7)}  hype ${r.hype.toFixed(2)}  turf ${r.turf}  battery ${String(r.battery).padStart(3)}  at ${r.pos.join(', ')}  brother ${r.brotherAway} m  ${r.msPerFrame.toFixed(1)} ms/frame`);
  const data = await page.evaluate(() => window.__wc.shot());
  await fs.writeFile(path.join(outDir, `${set}_${String(frame++).padStart(2, '0')}.jpg`), Buffer.from(data.split(',')[1], 'base64'));
  if (r.phase === 'ended') {
    console.log('counts:', JSON.stringify(r.counts));
    break;
  }
}
console.log(`slowest ten-second stretch: ${slowest.toFixed(1)} ms per frame`);
if (problems.length) console.log('browser errors:\n' + [...new Set(problems)].slice(0, 15).join('\n'));
await browser.close();
await server.close();
