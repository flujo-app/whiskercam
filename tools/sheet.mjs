// Build a labelled contact sheet from a list of images.
// Usage: node tools/sheet.mjs out.jpg [--cols N] [--cell WxH] img1 img2 ...
//        (a file argument may be "path=label")
import sharp from 'sharp';
import path from 'node:path';

const args = process.argv.slice(2);
const out = args.shift();
let cols = 4;
let cellW = 320;
let cellH = 320;
const items = [];
while (args.length) {
  const a = args.shift();
  if (a === '--cols') cols = Number(args.shift());
  else if (a === '--cell') [cellW, cellH] = args.shift().split('x').map(Number);
  else {
    const [file, label] = a.includes('=') ? a.split('=') : [a, path.basename(a).replace(/\.[^.]+$/, '')];
    items.push({ file, label });
  }
}
if (!out || items.length === 0) {
  console.error('usage: node tools/sheet.mjs out.jpg [--cols N] [--cell WxH] images...');
  process.exit(1);
}
const labelH = 22;
const rows = Math.ceil(items.length / cols);
const composites = [];
for (let i = 0; i < items.length; i++) {
  const { file, label } = items[i];
  const x = (i % cols) * cellW;
  const y = Math.floor(i / cols) * (cellH + labelH);
  try {
    const buf = await sharp(file)
      .resize(cellW, cellH, { fit: 'contain', background: '#202020' })
      .flatten({ background: '#202020' })
      .toBuffer();
    composites.push({ input: buf, left: x, top: y });
  } catch (err) {
    console.error(`skip ${file}: ${err.message}`);
  }
  const safe = label.replace(/[<&>]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="16" font-family="Segoe UI, Arial" font-size="13" fill="#eee">${safe}</text></svg>`;
  composites.push({ input: Buffer.from(svg), left: x, top: y + cellH });
}
await sharp({
  create: { width: cols * cellW, height: rows * (cellH + labelH), channels: 3, background: '#202020' },
})
  .composite(composites)
  .jpeg({ quality: 86 })
  .toFile(out);
console.log(`wrote ${out} (${items.length} images)`);
