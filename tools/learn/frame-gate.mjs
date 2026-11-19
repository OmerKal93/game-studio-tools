#!/usr/bin/env node
// Usage: node tools/learn/frame-gate.mjs <boxes.json> <baseline-frames-dir> <candidate-frames-dir> [--out report.md]
// Numbers before eyes: measure the frames, then look. boxes.json: [{name, frame, x, y, w, h, tol:{luma,hue_deg,chroma,g_over_r,r_over_b}}].
// Per box, from the MEAN 8-bit RGB of the box (alpha ignored: engine PNGs have alpha 0): Rec.709 luma (0.2126R+0.7152G+0.0722B on
// sRGB values), HSV hue in degrees and HSV chroma (max-min, 0-255 scale), g/r, r/b. Defaults: luma 4, hue 4 deg, chroma 3, ratios 0.03.
// Hue is not checked (SKIP) when both chromas are below 6. PNGs with a tRNS colour key are rejected (pngjs zeroes keyed pixels).
// Baseline and candidate frames must have the same size. boxes.json must be a non-empty list.
// Exit 2 on a tool error (bad boxes.json or arguments); exit 1 on any broken tolerance, a box outside the image, or a near-black frame (mean luma < 3: broken capture).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

export const DEFAULT_TOL = { luma: 4, hue_deg: 4, chroma: 3, g_over_r: 0.03, r_over_b: 0.03 };
const GREY = 6; // hue is noise on grey stone or road: skipped when both chromas are below this
const METRICS = ['luma', 'hue_deg', 'chroma', 'g_over_r', 'r_over_b'];

function checkTrns(buf) {
  let colorType = -1;
  for (let p = 8; p + 8 <= buf.length; p += 12 + buf.readUInt32BE(p)) {
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IHDR') colorType = buf[p + 8 + 9];
    if (type === 'tRNS' && colorType !== 3) throw new Error('tRNS colour key not supported');
    if (type === 'IDAT') break;
  }
}

export function decode(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) { checkTrns(buf); return PNG.sync.read(buf); }
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true });
  throw new Error('not a PNG or JPEG');
}

function meanRGB(img, { x, y, w, h }, label) {
  if (![x, y, w, h].every(Number.isInteger) || w < 1 || h < 1 || x < 0 || y < 0 || x + w > img.width || y + h > img.height)
    throw new Error(`${label}: box x=${x} y=${y} w=${w} h=${h} is outside the ${img.width}x${img.height} image`);
  let r = 0, g = 0, b = 0;
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    const p = (j * img.width + i) * 4; r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2];
  }
  const n = w * h;
  return [r / n, g / n, b / n];
}

export function metrics([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
  let hue = 0;
  if (c > 0) {
    hue = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { luma: 0.2126 * r + 0.7152 * g + 0.0722 * b, hue_deg: hue, chroma: c, g_over_r: g / (r || 1e-9), r_over_b: r / (b || 1e-9) };
}

const delta = (m, a, b) => (m === 'hue_deg' ? ((b - a + 540) % 360) - 180 : b - a);

// Returns {rows, errors, failed}. rows: one per box and metric. Errors (outside image, near-black, unreadable, size mismatch) fail the gate.
// Boxes are grouped by frame so at most one decoded frame per side is alive at a time (4K RGBA is 33 MB).
export function gate(boxes, loadBase, loadCand) {
  if (!Array.isArray(boxes) || boxes.length === 0) throw new Error('boxes.json must be a non-empty list of boxes');
  const errors = []; const byBox = new Array(boxes.length).fill(null);
  const frames = [...new Set(boxes.map((b) => b.frame))];
  for (const frame of frames) {
    const idx = boxes.map((b, i) => (b.frame === frame ? i : -1)).filter((i) => i >= 0);
    try {
      let base = loadBase(frame), cand = loadCand(frame);
      if (base.width !== cand.width || base.height !== cand.height)
        throw new Error(`${frame}: baseline is ${base.width}x${base.height} but candidate is ${cand.width}x${cand.height}; frames must match in size`);
      for (const i of idx) {
        const bx = boxes[i];
        try {
          const ms = [['baseline', base], ['candidate', cand]].map(([side, img]) => {
            const m = metrics(meanRGB(img, bx, `${bx.name} (${side} ${bx.frame})`));
            if (m.luma < 3) throw new Error(`${side} ${bx.frame} is near-black (box mean luma ${m.luma.toFixed(1)} < 3), a broken capture; recapture`);
            return m;
          });
          const tol = { ...DEFAULT_TOL, ...(bx.tol || {}) };
          byBox[i] = METRICS.map((m) => {
            const d = delta(m, ms[0][m], ms[1][m]);
            const skip = m === 'hue_deg' && ms[0].chroma < GREY && ms[1].chroma < GREY;
            return { name: bx.name, metric: m, base: ms[0][m], cand: ms[1][m], d, tol: tol[m], skip, pass: skip || Math.abs(d) <= tol[m] };
          });
        } catch (e) { errors.push(`${bx.name}: ${e.message}`); }
      }
      base = cand = null;
    } catch (e) { errors.push(e.message); }
  }
  const rows = byBox.flat().filter(Boolean);
  return { rows, errors, failed: errors.length > 0 || rows.some((r) => !r.pass) };
}

export function markdown({ rows, errors, failed }) {
  const f = (m, v) => (m.includes('over') ? v.toFixed(3) : v.toFixed(1));
  const out = ['| box | metric | baseline | candidate | delta | tol | result |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) out.push(`| ${r.name} | ${r.metric} | ${f(r.metric, r.base)} | ${f(r.metric, r.cand)} | ${r.d >= 0 ? '+' : ''}${f(r.metric, r.d)} | ±${r.tol} | ${r.skip ? 'SKIP (grey)' : r.pass ? 'PASS' : 'FAIL'} |`);
  for (const e of errors) out.push('', `ERROR: ${e}`);
  out.push('', failed ? 'FRAME GATE: FAIL' : 'FRAME GATE: PASS');
  return out.join('\n');
}

function main(argv) {
  try {
    const oi = argv.indexOf('--out');
    const outPath = oi >= 0 ? argv.splice(oi, 2)[1] : null;
    if (argv.length !== 3 || (oi >= 0 && !outPath)) throw new Error('usage: frame-gate.mjs <boxes.json> <baseline-dir> <candidate-dir> [--out report.md]');
    const boxes = JSON.parse(readFileSync(argv[0], 'utf8'));
    const loader = (dir) => (f) => decode(readFileSync(join(dir, f)));
    const res = gate(boxes, loader(argv[1]), loader(argv[2]));
    const md = markdown(res);
    if (outPath) writeFileSync(outPath, md + '\n');
    console.log(md);
    return res.failed ? 1 : 0;
  } catch (e) { console.error('error: ' + e.message); return 2; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
