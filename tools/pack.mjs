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
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

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

await MeshoptEncoder.ready;
const gltfIO = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

/** Copy a model, squeezing its geometry (about a fifth of the size; the game unpacks it while loading). */
async function packGlb(src, dst) {
  const doc = await gltfIO.read(src);
  doc.setLogger({ debug() {}, info() {}, warn() {}, error: console.error });
  await doc.transform(
    // materials are told apart by name only, so they must not be merged
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH] }),
    prune({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.BUFFER], keepAttributes: true, keepLeaves: true }),
    meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 14, quantizeColor: 8 }),
  );
  await gltfIO.write(dst, doc);
}

const newer = (src, dst) => force || !fssync.existsSync(dst) || fssync.statSync(src).mtimeMs > fssync.statSync(dst).mtimeMs;

async function convert(src, dst, { size, kind }) {
  if (!newer(src, dst)) return false;
  let img = sharp(src);
  const meta = await img.metadata();
  if (size && meta.width > size) img = img.resize(size, size, { fit: 'inside', kernel: 'lanczos3' });
  const opts =
    kind === 'normal' ? { quality: 92, smartSubsample: true, effort: 5 }
    : kind === 'data' ? { quality: 82, smartSubsample: true, effort: 5 }
    : { quality: 90, effort: 5 };
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
        // Looks come before download size (phones shrink the pictures themselves while loading): the surfaces
        // the camera gets right up to keep colour and bumps at full size; the rest keep full colour, half bumps.
        const full = kind === 'color' || (kind === 'normal' && HERO.has(d.ph));
        if (await convert(src, path.join(TEX_OUT, file), { size: full ? size : size / 2, kind })) made++;
        m[key] = `tex/${file}`;
      }
    } else if (d.kind === 'leaf') {
      // leaf picture with cut-out edges: keep a little alpha everywhere so browsers do not throw the colour away
      const src = d.diff;
      const file = `${path.basename(src).replace(/\.[^.]+$/, '')}.webp`;
      const dst = path.join(TEX_OUT, file);
      if (newer(src, dst)) {
        const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let i = 3; i < data.length; i += 4) data[i] = Math.max(data[i], 16);
        await sharp(data, { raw: info }).webp({ quality: 88, alphaQuality: 92, effort: 5 }).toFile(dst);
        made++;
      }
      m.diff = `tex/${file}`;
    } else if (d.kind === 'unique') {
      for (const [key, kind] of [['diff', 'color'], ['nor', 'normal'], ['arm', 'data']]) {
        if (!d[key]) continue;
        const src = d[key];
        const file = `${path.basename(src).replace(/\.[^.]+$/, '').replace(/_(1|2|4)k$/, '')}.webp`;
        if (await convert(src, path.join(TEX_OUT, file), { size: kind === 'color' ? 1024 : 512, kind })) made++;
        m[key] = `tex/${file}`;
      }
    }
    outMats[name] = m;
  }
  await fs.writeFile(path.join(OUT, 'materials.json'), JSON.stringify(outMats));

  // ---- light maps
  for (const chunk of world.chunks) {
    if (!chunk.sun) {
      // leaves carry their light in the mesh itself
      const src = path.join(SRC, chunk.file);
      const dst = path.join(OUT, chunk.file);
      if (newer(src, dst)) {
        await packGlb(src, dst);
        made++;
      }
      continue;
    }
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
      await packGlb(src, dst);
      made++;
    }
  }

  // ---- one small light picture of the whole ground (left half: sky + bounce light, right half: sun)
  // used by everything that stands on the ground without its own light map: weeds, grass, cats
  const tiles = world.chunks.filter((c) => c.kind === 'ground');
  if (tiles.length) {
    const T = tiles[0].tile_size;
    const px = 128;
    const x0 = Math.min(...tiles.map((c) => c.tile_origin[0]));
    const z0 = Math.min(...tiles.map((c) => c.tile_origin[1]));
    const cols = Math.round((Math.max(...tiles.map((c) => c.tile_origin[0])) - x0) / T) + 1;
    const rows = Math.round((Math.max(...tiles.map((c) => c.tile_origin[1])) - z0) / T) + 1;
    const W = cols * px;
    const H = rows * px;
    const out = Buffer.alloc(W * 2 * H * 3);
    const open = world.sky_irradiance_up.map((v) => Math.round(Math.sqrt(Math.min(1, v / Math.PI / world.irr_range)) * 255));
    for (let i = 0; i < W * 2 * H; i++) {
      const right = i % (W * 2) >= W;
      out[i * 3] = right ? 255 : open[0];
      out[i * 3 + 1] = right ? 255 : open[1];
      out[i * 3 + 2] = right ? 255 : open[2];
    }
    for (const c of tiles) {
      const cx = Math.round((c.tile_origin[0] - x0) / T) * px;
      const cy = Math.round((c.tile_origin[1] - z0) / T) * px;
      const irr = await sharp(path.join(SRC, c.irr.replace(/\.webp$/, '.png'))).removeAlpha().resize(px, px).raw().toBuffer();
      const sun = await sharp(path.join(SRC, c.sun.replace(/\.webp$/, '.png'))).removeAlpha().resize(px, px).raw().toBuffer();
      for (let y = 0; y < px; y++) {
        for (let x = 0; x < px; x++) {
          const s = (y * px + x) * 3;
          const a = ((cy + y) * W * 2 + cx + x) * 3;
          const b = ((cy + y) * W * 2 + W + cx + x) * 3;
          out[a] = irr[s];
          out[a + 1] = irr[s + 1];
          out[a + 2] = irr[s + 2];
          out[b] = out[b + 1] = out[b + 2] = sun[s];
        }
      }
    }
    await sharp(out, { raw: { width: W * 2, height: H, channels: 3 } }).webp({ lossless: true, effort: 4 }).toFile(path.join(OUT, 'ground_light.webp'));
    world.ground_light = { file: 'ground_light.webp', x0, z0, w: cols * T, h: rows * T };
    made++;
  }

  // ---- small plants drawn as copies
  if (world.scatter) {
    await fs.mkdir(path.join(OUT, 'scatter'), { recursive: true });
    for (const model of Object.values(world.scatter)) {
      const src = path.join(SRC, model.file);
      const dst = path.join(OUT, model.file);
      if (newer(src, dst)) {
        await packGlb(src, dst);
        made++;
      }
    }
  }

  // ---- loose things
  if (world.props) {
    await fs.mkdir(path.join(OUT, 'props'), { recursive: true });
    for (const model of Object.values(world.props.models)) {
      const src = path.join(SRC, model.file);
      const dst = path.join(OUT, model.file);
      if (newer(src, dst)) {
        await packGlb(src, dst);
        made++;
      }
    }
  }

  // ---- the cat model (shared by every set)
  const catSrc = path.join(ROOT, 'build', 'export', 'cats');
  if (fssync.existsSync(path.join(catSrc, 'cat.glb'))) {
    const catOut = path.join(ROOT, 'public', 'assets', 'cats');
    await fs.mkdir(catOut, { recursive: true });
    for (const f of await fs.readdir(catSrc)) {
      const src = path.join(catSrc, f);
      if (f.endsWith('.glb')) {
        if (newer(src, path.join(catOut, f))) {
          await fs.copyFile(src, path.join(catOut, f));
          made++;
        }
      } else if (f.endsWith('.png')) {
        const dst = path.join(catOut, f.replace(/\.png$/, '.webp'));
        if (newer(src, dst)) {
          // the fur map holds numbers, not colours: keep it exact
          const opts = f === 'cat_fur.png' ? { lossless: true, effort: 5 } : { quality: 90, smartSubsample: true, effort: 5 };
          await sharp(src).removeAlpha().webp(opts).toFile(dst);
          made++;
        }
      }
    }
  }

  // ---- everything else
  for (const f of ['collision.json', 'collision.bin', 'sky.png', 'kinds.png']) {
    if (fssync.existsSync(path.join(SRC, f))) await fs.copyFile(path.join(SRC, f), path.join(OUT, f));
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
