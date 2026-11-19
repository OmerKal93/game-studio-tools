// Side-by-side lookdev: compare game frames with reference photos by ROI RATIOS (never absolute pixels), write a sheet per pair and REPORT.md.
// usage: node lookdev-compare.mjs <pairs.json> <outDir>      node lookdev-compare.mjs selftest
// pairs.json: { "pairs": [ { "id", "game": "frame.png", "extra": { "sun": "frame-sun.png" }, "photo": "ref.jpg"|null, "photoCrop": { "cy": 0.5 },
//   "rois": { "sky": [x,y,w,h] }, "photoRois": { "sky": [x,y,w,h] }, "ignore": [x,y,w,h],
//   "metrics": [ { "name", "kind", "a", "b", "band": [lo,hi] } ] } ] }
// ROIs are normalised [0..1] rectangles on the 16:9 frame (photos are cropped to the game frame's aspect around cy and resized to it; the crop is saved as crop-<id>.jpg so
// ROIs can be placed by eye). A metric ref is "roi" (on the game frame) or "key:roi" (on game frame extra[key]; same ROIs). Photo values use photoRois on the cropped photo.
// kinds: ratio = lin-luma(a)/lin-luma(b)   wb = (B/R of a)/(B/R of b)   srgb = mean sRGB luma of a (0..255)   mich = Michelson(a)/Michelson(b) (luma p5/p95)
// optional "scale" multiplies the value (albedo = ratio against the 18% card x 0.18).
//        sat = HSV saturation(a)/saturation(b)   clip = share of pixels with any channel >= 250 outside "ignore"   p1 = 1st percentile sRGB luma of the frame
// The band applies to the GAME value; the photo value is printed next to it. Sheet: photo left, game right, ROI boxes, luma histograms, metric table.
import sharp from 'sharp';
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';

const W = 960, H = 540;
const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
const LUT = Float32Array.from({ length: 256 }, (_, i) => lin(i));
export const cropBox = (iw, ih, cy = .5, aspect = W / H) => {   // 16:9 window inside iw x ih, centred on cy vertically (or horizontally if the image is wider)
  if (iw / ih > aspect) { const w = Math.round(ih * aspect); return { left: Math.round((iw - w) / 2), top: 0, width: w, height: ih }; }
  const h = Math.round(iw / aspect), top = Math.min(ih - h, Math.max(0, Math.round(cy * ih - h / 2))); return { left: 0, top, width: iw, height: h };
};
const load = async (p, cy, cropOut) => {
  let s = sharp(p).rotate(); if (cropOut !== undefined) { const m = await s.metadata(), b = cropBox(m.width, m.height, cy); s = s.extract(b); }
  const out = s.resize(W, H, { fit: 'fill' }).removeAlpha();
  if (cropOut) await out.clone().jpeg({ quality: 92 }).toFile(cropOut);
  return { data: await out.raw().toBuffer(), file: p };
};
const px = (f, r) => { const [x, y, w, h] = r, x0 = Math.floor(x * W), y0 = Math.floor(y * H), x1 = Math.max(x0 + 1, Math.ceil((x + w) * W)), y1 = Math.max(y0 + 1, Math.ceil((y + h) * H)); const o = []; for (let j = y0; j < Math.min(H, y1); j++) for (let i = x0; i < Math.min(W, x1); i++) { const k = (j * W + i) * 3; o.push([f.data[k], f.data[k + 1], f.data[k + 2]]); } return o; };
const llum = p => .2126 * LUT[p[0]] + .7152 * LUT[p[1]] + .0722 * LUT[p[2]];
const slum = p => .2126 * p[0] + .7152 * p[1] + .0722 * p[2];
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const meanRGB = ps => [0, 1, 2].map(c => mean(ps.map(p => p[c])));
const sat = ps => mean(ps.map(p => { const mx = Math.max(...p), mn = Math.min(...p); return mx ? (mx - mn) / mx : 0; }));
const mich = ps => { const l = ps.map(llum), hi = pct(l, .95), lo = pct(l, .05); return hi + lo ? (hi - lo) / (hi + lo) : 0; };

/** Evaluate one metric. frames: { main, <extraKey>: frame }, rois: name -> rect. Returns a number or null when a ROI is missing. */
export const evalMetric = (m, frames, rois, ignore) => {
  const get = ref => { if (ref === undefined) return null; const [k, n] = ref.includes(':') ? ref.split(':') : ['main', ref]; const f = frames[k], r = rois[n]; return f && r ? px(f, r) : null; };
  const f = frames.main;
  if (m.kind === 'clip') { let c = 0, n = 0; const ig = ignore && { x0: ignore[0] * W, y0: ignore[1] * H, x1: (ignore[0] + ignore[2]) * W, y1: (ignore[1] + ignore[3]) * H }; for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { if (ig && i >= ig.x0 && i < ig.x1 && j >= ig.y0 && j < ig.y1) continue; const k = (j * W + i) * 3; n++; if (f.data[k] >= 250 || f.data[k + 1] >= 250 || f.data[k + 2] >= 250) c++; } return c / n; }
  if (m.kind === 'p1') { const l = []; for (let k = 0; k < f.data.length; k += 3) l.push(slum([f.data[k], f.data[k + 1], f.data[k + 2]])); return pct(l, .01); }
  const A = get(m.a), B = get(m.b); if (!A) return null;
  if (m.kind === 'srgb') return mean(A.map(slum));
  if (!B) return null;
  if (m.kind === 'ratio') return mean(A.map(llum)) / mean(B.map(llum));
  if (m.kind === 'wb') { const a = meanRGB(A), b = meanRGB(B); return (a[2] / a[0]) / (b[2] / b[0]); }
  if (m.kind === 'mich') return mich(A) / mich(B);
  if (m.kind === 'sat') return sat(A) / sat(B);
  throw new Error('unknown metric kind ' + m.kind);
};
const hist = f => { const h = new Array(64).fill(0); for (let k = 0; k < f.data.length; k += 3) h[Math.min(63, slum([f.data[k], f.data[k + 1], f.data[k + 2]]) >> 2)]++; const n = f.data.length / 3; return h.map(v => v / n); };
const fmt = v => v === null || v === undefined ? 'n/a' : (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const boxes = (rois, col) => Object.entries(rois || {}).map(([n, [x, y, w, h]]) => `<rect x="${x * 640}" y="${y * 360}" width="${w * 640}" height="${h * 360}" fill="none" stroke="${col}" stroke-width="2"/><text x="${x * 640 + 3}" y="${y * 360 + 13}" font-size="12" font-family="sans-serif" fill="${col}">${esc(n)}</text>`).join('');

export async function run(pairsFile, outDir) {
  const spec = JSON.parse(fs.readFileSync(pairsFile, 'utf8')), base = path.dirname(path.resolve(pairsFile)), res = p => p && path.resolve(base, p);
  fs.mkdirSync(outDir, { recursive: true }); const rows = []; const report = [];
  for (const pr of spec.pairs) {
    const frames = { main: await load(res(pr.game)) }; for (const [k, p] of Object.entries(pr.extra || {})) frames[k] = await load(res(p));
    const crop = path.join(outDir, `crop-${pr.id}.jpg`);
    const photo = pr.photo ? await load(res(pr.photo), pr.photoCrop?.cy ?? .5, crop) : null, pf = photo && { main: photo };
    const ms = (pr.metrics || []).map(m => { const g = evalMetric(m, frames, pr.rois || {}, pr.ignore), p = pf ? evalMetric(m, pf, pr.photoRois || {}, pr.photoIgnore) : null; const k = m.scale ?? 1, gs = g === null ? null : g * k; return { ...m, game: gs, photo: p === null ? null : p * k, pass: gs === null ? null : (m.band ? gs >= m.band[0] && gs <= m.band[1] : null) }; });
    rows.push({ id: pr.id, ms }); const hg = hist(frames.main), hp = photo ? hist(photo) : null;
    const line = (h, col) => `<polyline fill="none" stroke="${col}" stroke-width="2" points="${h.map((v, i) => `${i * 10 + 5},${110 - Math.min(100, v * 700)}`).join(' ')}"/>`;
    const table = ms.map((m, i) => `<text x="12" y="${18 + i * 17}" font-size="13" font-family="monospace" fill="${m.pass === false ? '#ff7a6a' : m.pass ? '#7fe08a' : '#ccc'}">${esc((m.name + '').padEnd(26))} game ${esc(fmt(m.game)).padEnd(8)} photo ${esc(fmt(m.photo)).padEnd(8)} band ${m.band ? esc(m.band.join('..')) : '-'}  ${m.pass === null ? '' : m.pass ? 'PASS' : 'FAIL'}</text>`).join('');
    const th = 130 + Math.max(0, ms.length * 17 + 24 - 130);
    const sheet = sharp({ create: { width: 1280, height: 360 + th, channels: 3, background: '#161616' } }).composite([
      ...(photo ? [{ input: await sharp(crop).resize(640, 360).jpeg().toBuffer(), left: 0, top: 0 }, { input: Buffer.from(`<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">${boxes(pr.photoRois, '#ffd24a')}</svg>`), left: 0, top: 0 }] : []),
      { input: await sharp(res(pr.game)).resize(640, 360, { fit: 'fill' }).jpeg().toBuffer(), left: 640, top: 0 },
      { input: Buffer.from(`<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">${boxes(pr.rois, '#4ad2ff')}</svg>`), left: 640, top: 0 },
      { input: Buffer.from(`<svg width="1280" height="${th}" xmlns="http://www.w3.org/2000/svg"><g>${table}</g><g transform="translate(630,8)"><rect width="640" height="112" fill="#0d0d0d"/>${hp ? line(hp, '#ffd24a') : ''}${line(hg, '#4ad2ff')}<text x="6" y="14" font-size="11" fill="#999" font-family="sans-serif">luma histogram: photo yellow, game cyan</text></g></svg>`), left: 0, top: 360 }]);
    await sheet.jpeg({ quality: 90 }).toFile(path.join(outDir, `${pr.id}.jpg`));
    report.push(`### ${pr.id}${pr.note ? ' - ' + pr.note : ''}\n\n![](${pr.id}.jpg)\n\n| metric | game | photo | band | |\n|---|---|---|---|---|\n` + ms.map(m => `| ${m.name} | ${fmt(m.game)} | ${fmt(m.photo)} | ${m.band ? m.band.join(' .. ') : '-'} | ${m.pass === null ? '' : m.pass ? 'PASS' : 'FAIL'} |`).join('\n') + '\n');
  }
  const all = rows.flatMap(r => r.ms).filter(m => m.pass !== null), ok = all.filter(m => m.pass).length;
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), `# Lookdev report\n\n${ok} of ${all.length} banded metrics in band.\n\n${report.join('\n')}`);
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(rows, null, 1));
  return rows;
}

if (process.argv[2] === 'selftest') {
  const os = await import('node:os'), d = fs.mkdtempSync(path.join(os.tmpdir(), 'ldcmp-'));
  // game: left half sRGB 188 (lin .5), right half 100 (lin ~.127), a clipped 10% stripe at the top; photo: same scene darker overall but the same ratio
  const mk = async (a, b, file, top) => { const buf = Buffer.alloc(W * H * 3); for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const v = i < W / 2 ? a : b, k = (j * W + i) * 3; const c = top && j < H * .1 ? 255 : v; buf[k] = c; buf[k + 1] = c; buf[k + 2] = c; } await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file); };
  await mk(188, 100, path.join(d, 'g.png'), true); await mk(188, 100, path.join(d, 'g2.png'), false); await sharp(path.join(d, 'g2.png')).resize(1500, 1500, { fit: 'fill' }).jpeg().toFile(path.join(d, 'p.jpg'));
  assert.deepEqual(cropBox(1500, 1500, .5), { left: 0, top: 328, width: 1500, height: 844 }); assert.deepEqual(cropBox(2000, 600, .5), { left: 467, top: 0, width: 1067, height: 600 });
  fs.writeFileSync(path.join(d, 'p.json'), JSON.stringify({ pairs: [{ id: 't', game: 'g.png', extra: { s: 'g2.png' }, photo: 'p.jpg', rois: { l: [.1, .3, .3, .4], r: [.6, .3, .3, .4] }, photoRois: { l: [.1, .3, .3, .4], r: [.6, .3, .3, .4] }, ignore: [0, 0, 1, .11],
    metrics: [{ name: 'lr', kind: 'ratio', a: 'l', b: 'r', band: [3.5, 4.5] }, { name: 'lr-extra', kind: 'ratio', a: 's:l', b: 'r', band: [3.5, 4.5] }, { name: 'clip', kind: 'clip', band: [0, .01] }, { name: 'clip-all', kind: 'clip', band: [0, .01] }, { name: 'srgb', kind: 'srgb', a: 'r', band: [99, 101] }, { name: 'wb', kind: 'wb', a: 'l', b: 'r', band: [.99, 1.01] }] }] }));
  const rows = await run(path.join(d, 'p.json'), path.join(d, 'out')), g = Object.fromEntries(rows[0].ms.map(m => [m.name, m]));
  assert(Math.abs(g.lr.game - lin(188) / lin(100)) < .01 && g.lr.pass, 'ratio'); assert(Math.abs(g['lr-extra'].photo ?? g.lr.photo) > 3, 'photo ratio'); assert(Math.abs(g.lr.photo - g.lr.game) < .1, 'photo = game ratio');
  assert.equal(g.clip.game, 0, 'ignore stripe'); assert.equal(g.srgb.game.toFixed(0), '100'); assert(Math.abs(g.wb.game - 1) < 1e-6);
  for (const f of ['t.jpg', 'REPORT.md', 'crop-t.jpg']) assert(fs.existsSync(path.join(d, 'out', f)), f);
  fs.rmSync(d, { recursive: true, force: true }); console.log('selftest ok'); process.exit(0);
}
if (process.argv[2] && process.argv[3]) { const r = await run(process.argv[2], process.argv[3]); const all = r.flatMap(x => x.ms).filter(m => m.pass !== null); console.log(`${all.filter(m => m.pass).length}/${all.length} in band -> ${process.argv[3]}`); }
else if (process.argv[2] !== 'selftest') { console.error('usage: lookdev-compare.mjs <pairs.json> <outDir> | selftest'); process.exit(2); }
