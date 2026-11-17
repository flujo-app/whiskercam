// Turn the Blender export (build/export/<set>/) into what the game loads (public/assets/<set>/).
//
//   node tools/pack.mjs <set> [--force]
//
// * surface pictures are resized and re-encoded (WebP)
// * light maps are re-encoded (sun: lossless grey, bounce/sky light: high-quality lossy)
// * geometry and the small JSON files are copied
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const set = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
if (!set) {
  console.error('usage: node tools/pack.mjs <set> [--force]');
  process.exit(1);
}
const SRC = path.join(ROOT, 'build', 'export', set);
const OUT = path.join(ROOT, 'public', 'assets', set);
const TEX_OUT = path.join(ROOT, 'public', 'assets', 'tex'); // shared by all sets
const PH = path.join(ROOT, 'assets_src', 'polyhaven');

// surfaces the camera gets very close to keep their full 2k scans
const HERO = new Set([
  'asphalt_01', 'asphalt_04', 'weathered_planks', 'tarred_gravel', 'concrete_pavers', 'square_concrete_pavers', 'concrete_floor_worn_001',
  'brushed_concrete', 'forrest_ground_01', 'wood_chips', 'wood_floor_deck', 'gravel_floor_02',
]);

const newer = (src, dst) => force || !fssync.existsSync(dst) || fssync.statSync(src).mtimeMs > fssync.statSync(dst).mtimeMs;

async function convert(src, dst, { size, kind }) {
  if (!newer(src, dst)) return false;
  let img = sharp(src);
  const meta = await img.metadata();
  if (size && meta.width > size) img = img.resize(size, size, { fit: 'inside', kernel: 'lanczos3' });
  const opts =
    kind === 'normal' ? { quality: 90, smartSubsample: true, effort: 5 }
    : kind === 'data' ? { quality: 82, smartSubsample: true, effort: 5 }
    : { quality: 84, effort: 5 };
  await img.webp(opts).toFile(dst);
  return true;
}

async function main() {
  await fs.mkdir(path.join(OUT, 'chunks'), { recursive: true });
  await fs.mkdir(path.join(OUT, 'lm'), { recursive: true });
  await fs.mkdir(TEX_OUT, { recursive: true });

  const world = JSON.parse(await fs.readFile(path.join(SRC, 'world.json'), 'utf8'));
  const mats = JSON.parse(await fs.readFile(path.join(SRC, 'materials.json'), 'utf8'));
  let made = 0;

  // ---- materials and their pictures
  const outMats = {};
  for (const [name, d] of Object.entries(mats)) {
    const m = { ...d };
    if (d.ph && d.kind === 'tile') {
      const res = HERO.has(d.ph) ? '2k' : '1k';
      const size = HERO.has(d.ph) ? 2048 : 1024;
      const dir = path.join(PH, 'textures', d.ph);
      for (const [key, map, kind] of [['diff', 'Diffuse', 'color'], ['nor', 'nor_gl', 'normal'], ['arm', 'arm', 'data']]) {
        const src = path.join(dir, `${d.ph}_${map}_${res}.jpg`);
        const file = `${d.ph}_${key}.webp`;
        if (await convert(src, path.join(TEX_OUT, file), { size, kind })) made++;
        m[key] = `tex/${file}`;
      }
    } else if (d.kind === 'unique' || d.kind === 'leaf') {
      for (const [key, kind] of [['diff', 'color'], ['nor', 'normal'], ['arm', 'data']]) {
        if (!d[key]) continue;
        const src = d[key];
        const file = `${path.basename(src).replace(/\.[^.]+$/, '').replace(/_(1|2|4)k$/, '')}.webp`;
        if (await convert(src, path.join(TEX_OUT, file), { size: 1024, kind })) made++;
        m[key] = `tex/${file}`;
      }
    }
    outMats[name] = m;
  }
  await fs.writeFile(path.join(OUT, 'materials.json'), JSON.stringify(outMats));

  // ---- light maps
  for (const chunk of world.chunks) {
    const sunSrc = path.join(SRC, chunk.sun);
    const irrSrc = path.join(SRC, chunk.irr);
    chunk.sun = chunk.sun.replace(/\.png$/, '.webp');
    chunk.irr = chunk.irr.replace(/\.png$/, '.webp');
    const sunDst = path.join(OUT, chunk.sun);
    const irrDst = path.join(OUT, chunk.irr);
    if (newer(sunSrc, sunDst)) {
      await sharp(sunSrc).removeAlpha().toColourspace('b-w').webp({ lossless: true, effort: 5 }).toFile(sunDst);
      made++;
    }
    if (newer(irrSrc, irrDst)) {
      await sharp(irrSrc).removeAlpha().webp({ quality: 92, smartSubsample: true, effort: 5 }).toFile(irrDst);
      made++;
    }
    const src = path.join(SRC, chunk.file);
    const dst = path.join(OUT, chunk.file);
    if (newer(src, dst)) {
      await fs.copyFile(src, dst);
      made++;
    }
  }

  // ---- everything else
  for (const f of ['collision.json', 'collision.bin', 'sky.png']) {
    await fs.copyFile(path.join(SRC, f), path.join(OUT, f));
  }
  await fs.writeFile(path.join(OUT, 'world.json'), JSON.stringify(world));

  let bytes = 0;
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else bytes += (await fs.stat(p)).size;
    }
  };
  await walk(OUT);
  console.log(`packed ${set}: ${made} files written, set size ${(bytes / 1e6).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
