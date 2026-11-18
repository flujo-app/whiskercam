// Build the game and publish it to the gh-pages branch (GitHub Pages).
//
//   node tools/deploy.mjs [--dry]
//
// The packed world (public/assets, public/audio) is not kept in the main branch because it is
// large and can be rebuilt; it only lives in the published site, as one commit that is replaced
// on every deploy.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' }).toString().trim();

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!fs.existsSync(path.join(ROOT, 'public', 'assets', 'estate', 'world.json'))) {
  console.error('public/assets/estate is missing: build, bake and pack the world first (see docs/PIPELINE.md)');
  process.exit(1);
}
console.log('building...');
run('npx', ['vite', 'build']);
const dist = path.join(ROOT, 'dist');
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

// only ship what the game loads: no test slices, no surface pictures left over from earlier builds
for (const e of fs.readdirSync(path.join(dist, 'assets'), { withFileTypes: true })) {
  if (e.isDirectory() && !['estate', 'cats', 'tex'].includes(e.name)) fs.rmSync(path.join(dist, 'assets', e.name), { recursive: true });
}
const used = new Set();
for (const f of ['materials.json', 'world.json']) {
  const text = fs.readFileSync(path.join(dist, 'assets', 'estate', f), 'utf8');
  for (const m of text.matchAll(/tex\/([\w.-]+\.webp)/g)) used.add(m[1]);
}
let dropped = 0;
// (the folder "s" holds the small copies the game starts on: same names, same rule)
for (const dir of [path.join(dist, 'assets', 'tex'), path.join(dist, 'assets', 'tex', 's')]) {
  if (!fs.existsSync(dir)) continue;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() || used.has(e.name)) continue;
    fs.rmSync(path.join(dir, e.name));
    dropped++;
  }
}
console.log(`kept ${used.size} surface pictures, left out ${dropped} unused ones`);
let bytes = 0;
let biggest = ['', 0];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const s = fs.statSync(p).size;
      bytes += s;
      if (s > biggest[1]) biggest = [path.relative(dist, p), s];
    }
  }
};
walk(dist);
console.log(`site: ${(bytes / 1e6).toFixed(1)} MB, biggest file ${biggest[0]} (${(biggest[1] / 1e6).toFixed(1)} MB)`);
if (dry) process.exit(0);

const remote = run('git', ['remote', 'get-url', 'origin']);
const name = run('git', ['config', 'user.name']);
const email = run('git', ['config', 'user.email']);
fs.rmSync(path.join(dist, '.git'), { recursive: true, force: true });
run('git', ['init', '-q', '-b', 'gh-pages'], dist);
run('git', ['config', 'user.name', `"${name}"`], dist);
run('git', ['config', 'user.email', email], dist);
run('git', ['add', '-A'], dist);
run('git', ['commit', '-q', '-m', `"Whiskercam ${version}"`], dist);
run('git', ['push', '-q', '--force', remote, 'gh-pages'], dist);
fs.rmSync(path.join(dist, '.git'), { recursive: true, force: true });
console.log(`published ${version} to gh-pages`);
