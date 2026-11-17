// Write CREDITS.md from what the game actually uses: the Poly Haven asset lists and the audio credits.
//   node tools/credits.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lists = [path.join(ROOT, 'pipeline', 'asset_list.json'), ...fs.readdirSync(path.join(ROOT, 'pipeline', 'asset_lists')).filter((f) => f.endsWith('.json')).map((f) => path.join(ROOT, 'pipeline', 'asset_lists', f))];
const wanted = { textures: {}, models: {}, hdris: {} };
for (const f of lists) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const kind of Object.keys(wanted)) Object.assign(wanted[kind], j[kind] ?? {});
}
const info = (kind, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'assets_src', 'polyhaven', kind, id, 'info.json'), 'utf8'));
  } catch {
    return {};
  }
};
const row = (kind, id) => {
  const i = info(kind, id);
  const authors = Object.keys(i.authors ?? {}).join(', ') || 'Poly Haven';
  return `| [${i.name ?? id}](https://polyhaven.com/a/${id}) | ${authors} |`;
};

let md = `# Credits

Whiskercam is built from free material made by other people. Thank you.

## Scanned surfaces and objects

All from [Poly Haven](https://polyhaven.com), released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain).

### Objects and plants

| Asset | Made by |
| --- | --- |
${Object.keys(wanted.models).sort().map((id) => row('models', id)).join('\n')}

### Surfaces

| Asset | Made by |
| --- | --- |
${Object.keys(wanted.textures).sort().map((id) => row('textures', id)).join('\n')}
`;

const audioFile = path.join(ROOT, 'public', 'audio', 'credits.json');
if (fs.existsSync(audioFile)) {
  const audio = JSON.parse(fs.readFileSync(audioFile, 'utf8'));
  md += `
## Sound recordings

| File | Recording | By | Licence | Changes |
| --- | --- | --- | --- | --- |
${audio.map((a) => `| ${a.file} | [${(a.title ?? '').replace(/\|/g, '/')}](${a.source_url}) | ${(a.author ?? '').replace(/\|/g, '/')} | ${a.licence} | ${(a.changes ?? '').replace(/\|/g, '/')} |`).join('\n')}
`;
}

md += `
## Software

| What | Licence |
| --- | --- |
| [three.js](https://threejs.org) (drawing) | MIT |
| [Rapier](https://rapier.rs) (physics) | Apache 2.0 |
| [Blender](https://www.blender.org) and Cycles (world building and light baking) | GPL (tool only) |
| [xatlas](https://github.com/jpcy/xatlas) (light-map layout) | MIT (tool only) |
| [Shapely](https://shapely.readthedocs.io) (ground plan) | BSD (tool only) |
| [glTF Transform](https://gltf-transform.dev), [meshoptimizer](https://meshoptimizer.org), [sharp](https://sharp.pixelplumbing.com) (packing) | MIT (tools only) |

The cat, the estate, the game and all code are original work, built by script. No part of any existing game was used.
`;
fs.writeFileSync(path.join(ROOT, 'CREDITS.md'), md);
console.log(`wrote CREDITS.md (${Object.keys(wanted.models).length} objects, ${Object.keys(wanted.textures).length} surfaces)`);
