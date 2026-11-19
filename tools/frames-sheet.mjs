// Contact sheet from captured frames (e2e screenshots, physics or motion proofs): a grid of resized frames with an optional caption per tile.
// usage:
//   node frames-sheet.mjs <out.jpg|png> <frame-or-dir>... [--match <regex>] [--pick 1,4,7] [--cols 4] [--width 480] [--labels] [--title "text"]
//   node frames-sheet.mjs selftest
// A directory adds its .png/.jpg/.webp files in name order (filtered by --match). --pick keeps those 1-based positions of the list.
// --labels writes each file's name on its tile; --title adds a caption bar on top. Needs sharp (studio node_modules).
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
const sharp = require('sharp');

export function parseArgs(argv) {
  const o = { cols: 4, width: 480, labels: false, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { assert(i + 1 < argv.length, `${a} needs a value`); return argv[++i]; };
    if (a === '--cols') o.cols = Math.max(1, +v()); else if (a === '--width') o.width = Math.max(16, +v()); else if (a === '--labels') o.labels = true;
    else if (a === '--match') o.match = new RegExp(v()); else if (a === '--pick') o.pick = v().split(',').map(Number); else if (a === '--title') o.title = v();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`); else if (!o.out) o.out = a; else o.inputs.push(a);
  }
  assert(o.out && o.inputs.length, 'usage: frames-sheet.mjs <out> <frame-or-dir>... [options]');
  return o;
}
export function listFrames(inputs, match, pick) {
  let files = inputs.flatMap(p => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort().map(f => path.join(p, f)) : [p]);
  if (match) files = files.filter(f => match.test(path.basename(f)));
  if (pick) files = pick.map(i => { assert(files[i - 1], `--pick ${i}: only ${files.length} frames`); return files[i - 1]; });
  assert(files.length, 'no frames matched');
  return files;
}
const esc = s => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
export async function makeSheet(o) {
  const files = listFrames(o.inputs, o.match, o.pick), meta = await sharp(files[0]).metadata();
  const w = o.width, h = Math.round(w * meta.height / meta.width), cols = Math.min(o.cols, files.length), rows = Math.ceil(files.length / cols), top = o.title ? 36 : 0;
  const tiles = await Promise.all(files.map(async (f, i) => {
    let img = sharp(f).resize(w, h, { fit: 'fill' });
    if (o.labels) img = sharp(await img.png().toBuffer()).composite([{ input: Buffer.from(`<svg width="${w}" height="24"><rect width="${w}" height="24" fill="black" fill-opacity=".55"/><text x="6" y="17" font-family="sans-serif" font-size="14" fill="white">${esc(path.basename(f))}</text></svg>`), left: 0, top: h - 24 }]);
    return { input: await img.png().toBuffer(), left: (i % cols) * w, top: top + Math.floor(i / cols) * h };
  }));
  if (o.title) tiles.push({ input: Buffer.from(`<svg width="${cols * w}" height="${top}"><text x="10" y="24" font-family="sans-serif" font-size="18" fill="white">${esc(o.title)}</text></svg>`), left: 0, top: 0 });
  const sheet = sharp({ create: { width: cols * w, height: top + rows * h, channels: 3, background: '#111' } }).composite(tiles);
  await (/\.png$/i.test(o.out) ? sheet.png() : sheet.jpeg({ quality: 85 })).toFile(o.out);
  return { out: o.out, frames: files.length, size: [cols * w, top + rows * h] };
}
if (process.argv[2] === 'selftest') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));
  for (let i = 1; i <= 5; i++) await sharp({ create: { width: 160, height: 90, channels: 3, background: { r: 40 * i, g: 20, b: 200 - 30 * i } } }).png().toFile(path.join(d, `push-${i}.png`));
  fs.writeFileSync(path.join(d, 'note.txt'), 'x');
  assert.deepEqual(listFrames([d], /push-[2-4]/).map(f => path.basename(f)), ['push-2.png', 'push-3.png', 'push-4.png']);
  const r = await makeSheet({ ...parseArgs([path.join(d, 'sheet.jpg'), d, '--match', '^push', '--pick', '1,3,5', '--cols', '2', '--width', '100', '--labels', '--title', 'selftest']), match: /^push/ });
  assert.deepEqual([r.frames, ...r.size], [3, 200, 36 + 2 * 56]);
  const m = await sharp(path.join(d, 'sheet.jpg')).metadata(); assert.deepEqual([m.width, m.height], [200, 148]);
  assert.throws(() => parseArgs(['out.jpg']), /usage/); assert.throws(() => listFrames([d], /nomatch/), /no frames/);
  fs.rmSync(d, { recursive: true, force: true });
  console.log('selftest ok'); process.exit(0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await makeSheet(parseArgs(process.argv.slice(2)))));
