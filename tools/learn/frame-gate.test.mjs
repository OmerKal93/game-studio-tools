import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { gate, decode, metrics, markdown } from './frame-gate.mjs';

// Solid-colour image; the left 8x8 is `rgb`, the rest grey. alpha is a parameter.
function png(rgb, alpha = 255, w = 16, h = 16) {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) { const c = i % w < 8 && ((i / w) | 0) < 8 ? rgb : [100, 100, 100]; p.data.set([...c, alpha], i * 4); }
  return PNG.sync.write(p);
}
const loaderOf = (files) => (f) => decode(files[f]);
const box = { name: 'wall', frame: 'a.png', x: 0, y: 0, w: 8, h: 8 };
const run = (b, base, cand) => gate([b], loaderOf({ 'a.png': base }), loaderOf({ 'a.png': cand }));

test('identical solid boxes pass; values are right', () => {
  const r = run(box, png([180, 150, 120]), png([180, 150, 120]));
  assert.equal(r.failed, false);
  const m = metrics([180, 150, 120]);
  assert.ok(Math.abs(m.luma - (0.2126 * 180 + 0.7152 * 150 + 0.0722 * 120)) < 1e-9);
  assert.equal(m.hue_deg, 30); assert.equal(m.chroma, 60);
  assert.ok(Math.abs(m.g_over_r - 150 / 180) < 1e-9); assert.ok(Math.abs(m.r_over_b - 1.5) < 1e-9);
});

test('a small luma shift inside tolerance passes, outside fails', () => {
  assert.equal(run(box, png([180, 150, 120]), png([182, 152, 122])).failed, false);
  const r = run(box, png([180, 150, 120]), png([200, 170, 140]));
  assert.equal(r.failed, true);
  assert.equal(r.rows.find((x) => x.metric === 'luma').pass, false);
});

test('a shifted hue with the same luma FAILS on hue', () => {
  // olive-ish shift: same-ish brightness, hue rotated 30 -> 60 degrees
  const r = run(box, png([180, 150, 120]), png([165, 165, 100]));
  assert.equal(r.failed, true);
  assert.equal(r.rows.find((x) => x.metric === 'hue_deg').pass, false);
  assert.match(markdown(r), /FAIL/);
});

test('hue delta wraps around 360', () => {
  const r = run(box, png([200, 20, 30]), png([200, 30, 20])); // hue ~ 355 vs ~ 5
  const h = r.rows.find((x) => x.metric === 'hue_deg');
  assert.ok(Math.abs(h.d) < 20);
});

test('alpha-0 PNG still measures its RGB', () => {
  const r = run(box, png([180, 150, 120], 0), png([180, 150, 120], 0));
  assert.equal(r.failed, false);
  assert.ok(r.rows.find((x) => x.metric === 'luma').base > 100);
});

test('near-black frame is rejected as a broken capture', () => {
  const r = run(box, png([180, 150, 120]), png([1, 1, 1]));
  assert.equal(r.failed, true);
  assert.match(r.errors[0], /near-black/);
});

test('a box outside the image is refused with a clear message', () => {
  const r = run({ ...box, x: 12 }, png([180, 150, 120]), png([180, 150, 120]));
  assert.equal(r.failed, true);
  assert.match(r.errors[0], /outside the 16x16 image/);
});

test('per-box tol overrides the default', () => {
  const r = run({ ...box, tol: { luma: 50, hue_deg: 50, chroma: 50, g_over_r: 1, r_over_b: 1 } }, png([180, 150, 120]), png([200, 170, 140]));
  assert.equal(r.failed, false);
});

test('JPEG decodes and measures within JPEG error', () => {
  const raw = { width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4) };
  for (let i = 0; i < 256; i++) raw.data.set([180, 150, 120, 255], i * 4);
  const img = decode(Buffer.from(jpeg.encode(raw, 95).data));
  const m = metrics([img.data[0], img.data[1], img.data[2]]);
  assert.ok(Math.abs(m.luma - 152.9) < 3);
});

test('CLI: exit 1 on a failing box, exit 0 on a passing one, writes --out', () => {
  const d = mkdtempSync(join(tmpdir(), 'fg-'));
  const dirs = ['b', 'c'].map((n) => join(d, n));
  for (const x of dirs) spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(x)})`]);
  writeFileSync(join(dirs[0], 'a.png'), png([180, 150, 120]));
  writeFileSync(join(dirs[1], 'a.png'), png([165, 165, 100]));
  writeFileSync(join(d, 'boxes.json'), JSON.stringify([box]));
  const cli = new URL('./frame-gate.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const bad = spawnSync(process.execPath, [cli, join(d, 'boxes.json'), dirs[0], dirs[1], '--out', join(d, 'r.md')]);
  assert.equal(bad.status, 1);
  const good = spawnSync(process.execPath, [cli, join(d, 'boxes.json'), dirs[0], dirs[0]]);
  assert.equal(good.status, 0);
});

test('an empty or non-array boxes list is refused, not passed', () => {
  const l = loaderOf({ 'a.png': png([180, 150, 120]) });
  assert.throws(() => gate([], l, l), /non-empty/);
  assert.throws(() => gate({}, l, l), /non-empty/);
});

test('a PNG with a tRNS colour key is rejected; the chunk is found after IHDR', () => {
  const b = png([180, 150, 120]);
  const trns = Buffer.concat([Buffer.from([0, 0, 0, 6]), Buffer.from('tRNS'), Buffer.alloc(6), Buffer.alloc(4)]);
  const keyed = Buffer.concat([b.subarray(0, 33), trns, b.subarray(33)]);
  assert.throws(() => decode(keyed), /tRNS colour key not supported/);
});

test('hue is skipped on grey boxes (both chromas < 6) but still checked on coloured ones', () => {
  const g = run(box, png([128, 128, 129]), png([129, 128, 128]));
  assert.equal(g.rows.find((x) => x.metric === 'hue_deg').skip, true);
  assert.equal(g.failed, false);
  assert.match(markdown(g), /SKIP \(grey\)/);
  const c = run(box, png([180, 150, 120]), png([165, 165, 100]));
  assert.equal(c.rows.find((x) => x.metric === 'hue_deg').skip, false);
});

test('baseline and candidate of different size fail', () => {
  const r = run(box, png([180, 150, 120]), png([180, 150, 120], 255, 32, 32));
  assert.equal(r.failed, true);
  assert.match(r.errors[0], /frames must match in size/);
  assert.equal(run(box, png([180, 150, 120]), png([180, 150, 120], 255, 32, 16)).failed, true); // width only
  assert.equal(run(box, png([180, 150, 120]), png([180, 150, 120], 255, 16, 32)).failed, true); // height only
});

test('each frame is decoded once per side however many boxes use it', () => {
  let n = 0;
  const f = png([180, 150, 120]);
  const l = () => { n++; return decode(f); };
  const r = gate([box, { ...box, name: 'b2', x: 8 }, { ...box, name: 'b3', y: 8 }], l, l);
  assert.equal(n, 2);
  assert.equal(r.rows.length, 15);
});

test('CLI: bad boxes.json is a tool error, exit 2', () => {
  const d = mkdtempSync(join(tmpdir(), 'fg-'));
  writeFileSync(join(d, 'boxes.json'), '[]');
  const cli = new URL('./frame-gate.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  assert.equal(spawnSync(process.execPath, [cli, join(d, 'boxes.json'), d, d]).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, join(d, 'nope.json'), d, d]).status, 2);
});
