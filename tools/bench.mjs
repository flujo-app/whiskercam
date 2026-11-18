// Measure how long a frame really takes (game step + drawing, waiting for the graphics card to finish).
//
//   node tools/bench.mjs [set] [WxH] ['[[x, z, heading], ...]'] [extra page options, e.g. refl=0]
//
// Run it after anything that changes how the world is packed or drawn. It is how the slow path on
// Windows was found (see src/engine/geometry.ts): frame time that does not change with the picture
// size means the time is going into the shapes, not the pixels.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const set = process.argv[2] ?? 'estate';
const size = process.argv[3] ?? '608x1080';
const [W, H] = size.split('x').map(Number);
const spots = JSON.parse(process.argv[4] ?? '[[37.5,-3,80],[6,18,265],[-3.4,30.4,10],[8,-2,60]]');

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5196, strictPort: false } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('pageerror: ' + e.message));
const extra = process.argv[5] ? `&${process.argv[5]}` : '';
await page.goto(`${server.resolvedUrls.local[0]}?set=${set}&manual=1&size=${size}${extra}`);
await page.waitForFunction(() => window.__wc !== undefined, null, { timeout: 180000 });
let worst = 0;
for (const [x, z, h] of spots) {
  const r = await page.evaluate(([x, z, h]) => {
    const wc = window.__wc;
    wc.pose(null);
    wc.place(x, 0.6, z, h);
    wc.bench(60); // warm up
    return { ms: wc.bench(120), ...wc.stats() };
  }, [x, z, h]);
  worst = Math.max(worst, r.ms);
  console.log(`at ${x}, ${z} heading ${h}: ${r.ms.toFixed(2)} ms per frame (${(1000 / r.ms).toFixed(0)} per second), ${r.calls} draw calls, ${(r.triangles / 1e6).toFixed(2)}M triangles`);
}
console.log(`slowest spot: ${worst.toFixed(2)} ms per frame at ${size}`);
await browser.close();
await server.close();
