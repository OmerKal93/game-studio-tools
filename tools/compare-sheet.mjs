// Side-by-side review sheet: rows of tiles (renders beside reference photos), each tile cropped to a fixed cell without distortion.
// usage:
//   node compare-sheet.mjs <spec.json> <out.jpg>      spec: { "cell": [w, h], "title": "...", "rows": [ { "label": "...", "tiles": [
//                                                         { "file": "a.png", "caption": "render, noon", "crop": [l, t, w, h] (optional, px of the source),
//                                                           "fit": "cover" | "contain" (default cover) } ] } ] }
//   node compare-sheet.mjs selftest
// PNGs with alpha (Movie Render Queue writes alpha 0) are flattened onto black first. A row label sits in a bar over its first tile.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
const sharp = require('sharp');
const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const bar = (w, text, size = 15) => Buffer.from(`<svg width="${w}" height="${size + 10}"><rect width="${w}" height="${size + 10}" fill="black" fill-opacity=".6"/><text x="6" y="${size + 2}" font-family="sans-serif" font-size="${size}" fill="white">${esc(text)}</text></svg>`);

export async function tile(t, w, h) {
  let img = sharp(await sharp(t.file).removeAlpha().png().toBuffer());   // own pass: in one pipeline sharp premultiplies alpha 0 to black on resize
  if (t.crop) img = sharp(await img.extract({ left: t.crop[0], top: t.crop[1], width: t.crop[2], height: t.crop[3] }).png().toBuffer());
  img = img.resize(w, h, { fit: t.fit ?? 'cover', background: '#111' });
  const comp = t.caption ? [{ input: bar(w, t.caption, 14), left: 0, top: h - 24 }] : [];
  return sharp(await img.png().toBuffer()).composite(comp).png().toBuffer();
}

export async function makeSheet(spec, out) {
  const [w, h] = spec.cell, cols = Math.max(...spec.rows.map(r => r.tiles.length)), top = spec.title ? 34 : 0, gap = 4;
  const comps = [];
  for (const [ri, r] of spec.rows.entries()) {
    for (const [ci, t] of r.tiles.entries()) comps.push({ input: await tile(t, w, h), left: ci * (w + gap), top: top + ri * (h + gap) });
    if (r.label) comps.push({ input: bar(w, r.label, 17), left: 0, top: top + ri * (h + gap) });
  }
  const W = cols * (w + gap) - gap, H = top + spec.rows.length * (h + gap) - gap;
  if (spec.title) comps.push({ input: Buffer.from(`<svg width="${W}" height="${top}"><text x="10" y="23" font-family="sans-serif" font-size="19" fill="white">${esc(spec.title)}</text></svg>`), left: 0, top: 0 });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#111' } }).composite(comps).jpeg({ quality: 88 }).toFile(out);
  return { out, size: [W, H], tiles: comps.length };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === 'selftest') {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
    await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 0 } } }).png().toFile(path.join(d, 'a.png'));
    await sharp({ create: { width: 100, height: 300, channels: 3, background: '#3a6' } }).png().toFile(path.join(d, 'b.png'));
    const r = await makeSheet({ cell: [120, 80], title: 't', rows: [{ label: 'row', tiles: [{ file: path.join(d, 'a.png'), caption: 'x' }, { file: path.join(d, 'b.png'), crop: [0, 0, 100, 150] }] }] }, path.join(d, 's.jpg'));
    assert.deepEqual(r.size, [244, 34 + 80]);
    const m = await sharp(path.join(d, 's.jpg')).metadata(); assert.deepEqual([m.width, m.height], [244, 114]);
    fs.rmSync(d, { recursive: true, force: true });
    console.log('compare-sheet selftest ok'); process.exit(0);
  }
  assert(process.argv[3], 'usage: compare-sheet.mjs <spec.json> <out.jpg>');
  console.log(JSON.stringify(await makeSheet(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3])));
}
