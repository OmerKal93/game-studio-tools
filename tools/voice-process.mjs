// Voice-over pipeline: one long take per character -> per-line WAVs -> processed mono Opus .ogg.
// usage:
//   node voice-process.mjs split <take.(m4a|wav|ogg|mp3)> --keys k1,k2,... --out <dir> [--strings <strings.he.ts|json>] [--min-silence 1.2] [--db -38] [--cps 11]
//       Cuts speech between silences (120 ms padding), maps segments to keys in script order, writes <key>.wav + split-report.json.
//       More segments than keys = retakes: a dynamic programme gives every key a run of segments and keeps the LAST of the run, scored by
//       how close its length is to the expected one (non-space characters of the line in --strings / cps; cps is re-fitted from the first pass).
//       Fewer segments than keys, or a kept length off by more than 2.5x, is flagged in the report ("flags", "confidence"); never guessed silently.
//   node voice-process.mjs voice <in.wav> --profile <name> --out <file.ogg> [--profiles <json>]
//       HPF 80 Hz, afftdn, rubberband pitch/formant, EQ, optional grit/compression/room, two-pass loudnorm (-18 LUFS, -1.5 dBTP), mono Opus 36 kbps.
//       Profiles live in voice-profiles.json next to this file.
//   node voice-process.mjs measure <file>        spectral centroid (Hz) and median F0 (Hz)
//   node voice-process.mjs calibrate             run every profile on a synthetic male voice and print centroid / F0 shift
//   node voice-process.mjs selftest
// Needs bin/ffmpeg.exe (rubberband, silencedetect, loudnorm, afftdn). --out belongs outside any repo until the take is intaken (assets.md).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || path.join(HOME, 'bin', 'ffmpeg.exe'), FFPROBE = process.env.FFPROBE || path.join(HOME, 'bin', 'ffprobe.exe'); // bin/ is git-ignored; or set FFMPEG / FFPROBE
const PROFILES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'voice-profiles.json');
const PAD = 0.12, MIN_SEG = 0.25, RETAKE_COST = 0.35, MAX_RATIO = 2.5;

const ff = (args, o = {}) => { const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', ...args], { encoding: o.raw ? 'buffer' : 'utf8', maxBuffer: 1 << 29 }); if (r.status !== 0 && !o.soft) throw new Error('ffmpeg failed: ' + String(r.stderr).slice(-600)); return r; };
const duration = f => +spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim();
const probe = f => { const j = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate', '-of', 'json', f], { encoding: 'utf8' }).stdout).streams[0]; return { codec: j.codec_name, channels: j.channels, rate: +j.sample_rate, duration: duration(f) }; };

// ---------- measurement (numbers instead of ears) ----------
export function pcm(file, rate = 16000) { const b = ff(['-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { raw: true }).stdout; return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4))); }
function fft(re, im) { // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const c = Math.cos(a * k), s = Math.sin(a * k), u = i + k, v = u + len / 2, xr = re[v] * c - im[v] * s, xi = re[v] * s + im[v] * c;
      re[v] = re[u] - xr; im[v] = im[u] - xi; re[u] += xr; im[u] += xi;
    }
  }
}
const frames = (x, n, hop) => { const out = []; for (let i = 0; i + n <= x.length; i += hop) out.push(x.subarray(i, i + n)); return out; };
const rms = f => Math.sqrt(f.reduce((s, v) => s + v * v, 0) / f.length);
/** Spectral centroid (Hz, 50-8000) of the power spectrum summed over loud frames; median autocorrelation F0 (Hz) of voiced frames. */
export function measure(file) {
  const rate = 16000, x = pcm(file, rate), N = 1024, fr = frames(x, N, 512), e = fr.map(rms), gate = Math.max(...e) * 0.2;
  const P = new Float64Array(N / 2); let used = 0;
  for (let i = 0; i < fr.length; i++) {
    if (e[i] < gate) continue; used++;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < N; k++) re[k] = fr[i][k] * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / N));
    fft(re, im); for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
  }
  let num = 0, den = 0; for (let k = 1; k < N / 2; k++) { const f = k * rate / N; if (f < 50 || f > 8000) continue; num += f * P[k]; den += P[k]; }
  const f0s = [];
  for (let i = 0; i < fr.length; i++) {
    if (e[i] < gate) continue; const f = fr[i], lo = Math.floor(rate / 450), hi = Math.floor(rate / 70); let r0 = 0; for (const v of f) r0 += v * v;
    let best = 0, bl = 0; for (let l = lo; l <= hi; l++) { let s = 0; for (let k = 0; k + l < N; k++) s += f[k] * f[k + l]; if (s > best) { best = s; bl = l; } }
    if (best / r0 > 0.45) f0s.push(rate / bl);
  }
  f0s.sort((a, b) => a - b);
  return { centroid: den ? num / den : 0, f0: f0s.length ? f0s[f0s.length >> 1] : 0, frames: used };
}
const loud = f => { const r = ff(['-i', f, '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']); const s = String(r.stderr); return JSON.parse(s.slice(s.lastIndexOf('{'), s.lastIndexOf('}') + 1)); };

// ---------- split ----------
export function silences(file, db, minSil) {
  const s = String(ff(['-i', file, '-af', `silencedetect=noise=${db}dB:d=${minSil}`, '-f', 'null', '-']).stderr), out = []; let st = null;
  for (const l of s.split('\n')) { let m; if ((m = l.match(/silence_start: (-?[\d.]+)/))) st = Math.max(0, +m[1]); else if ((m = l.match(/silence_end: ([\d.]+)/)) && st !== null) { out.push([st, +m[1]]); st = null; } }
  return { list: out, openStart: st };
}
export function speechSegments(file, db = -38, minSil = 1.2) {
  const total = duration(file), { list, openStart } = silences(file, db, minSil), segs = []; let cur = 0;
  for (const [a, b] of list) { if (a - cur >= MIN_SEG) segs.push([cur, a]); cur = b; }
  const end = openStart ?? total; if (end - cur >= MIN_SEG) segs.push([cur, end]);
  // a lead-in or tail shorter than minSil is not a silence above, so trim each segment's edges with a finer silence scan
  const fine = silences(file, db, 0.3); if (fine.openStart !== null) fine.list.push([fine.openStart, total]);
  for (const g of segs) for (const [s, e] of fine.list) { if (s <= g[0] + 0.05 && e > g[0] && e < g[1]) g[0] = e; if (e >= g[1] - 0.05 && s < g[1] && s > g[0]) g[1] = s; }
  return { total, segs: segs.filter(g => g[1] - g[0] >= MIN_SEG) };
}
export const expectedSeconds = (text, cps) => text.replace(/\s/g, '').length / cps + 0.3;
/** Assign each key a run of >=1 consecutive segments, keep the last; minimise |ln(kept/expected)| + RETAKE_COST per dropped. Returns [{key, from, kept}] or null. */
export function align(durs, exps) {
  const N = durs.length, K = exps.length; if (N < K) return null;
  const f = Array.from({ length: K + 1 }, () => new Array(N + 1).fill(Infinity)), back = Array.from({ length: K + 1 }, () => new Array(N + 1).fill(-1)); f[0][0] = 0;
  for (let k = 0; k < K; k++) for (let j = 0; j < N; j++) { if (!isFinite(f[k][j])) continue;
    for (let m = j + 1; m <= N; m++) { const c = f[k][j] + Math.abs(Math.log(durs[m - 1] / exps[k])) + RETAKE_COST * (m - 1 - j); if (c < f[k + 1][m]) { f[k + 1][m] = c; back[k + 1][m] = j; } } }
  const out = []; let m = N; for (let k = K; k > 0; k--) { const j = back[k][m]; out.unshift({ from: j, kept: m - 1 }); m = j; }
  return out;
}
export function parseStrings(file) {
  const o = {}; for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*['"]([\w.]+)['"]\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2/); if (m) o[m[1]] = m[3]; } return o;
}
export function split(take, keys, outDir, { db = -38, minSilence = 1.2, strings = null, cps = 11 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const { total, segs } = speechSegments(take, db, minSilence), durs = segs.map(([a, b]) => b - a), flags = [];
  const text = strings ? parseStrings(strings) : {}, haveText = keys.every(k => text[k]);
  if (strings && !haveText) flags.push('strings file lacks: ' + keys.filter(k => !text[k]).join(','));
  let groups = null, usedCps = cps;
  if (segs.length === keys.length) groups = keys.map((_, i) => ({ from: i, kept: i }));
  else if (segs.length > keys.length) {
    if (!haveText) flags.push(`${segs.length} segments for ${keys.length} keys and no --strings: cannot tell retakes apart`);
    else {
      const run = c => align(durs, keys.map(k => expectedSeconds(text[k], c)));
      groups = run(cps); // refit the speaking rate from the first pass and align again
      const rs = groups.map((g, i) => durs[g.kept] / expectedSeconds(text[keys[i]], cps)).sort((a, b) => a - b);
      usedCps = +(cps * rs[rs.length >> 1]).toFixed(2); groups = run(usedCps);
    }
  } else flags.push(`only ${segs.length} segments for ${keys.length} keys: lines are missing or run together (try a lower --min-silence)`);
  const report = { take: path.resolve(take), totalSeconds: +total.toFixed(2), params: { db, minSilence, cps: usedCps, pad: PAD }, segments: segs.map(([a, b], i) => ({ i, start: +a.toFixed(2), end: +b.toFixed(2), seconds: +(b - a).toFixed(2) })), lines: [], flags };
  if (groups) groups.forEach((g, i) => {
    const key = keys[i], [a, b] = segs[g.kept], exp = haveText ? expectedSeconds(text[key], usedCps) : null, dropped = [];
    for (let s = g.from; s < g.kept; s++) dropped.push(s);
    const ratio = exp ? durs[g.kept] / exp : null, lf = [];
    let conf = ratio ? Math.max(0, 1 - Math.abs(Math.log(ratio)) / Math.log(MAX_RATIO)) : 0.6;
    if (dropped.length) { lf.push('retake: dropped segment(s) ' + dropped.join(',')); conf = Math.min(conf, 0.75); if (dropped.some(s => durs[s] > durs[g.kept] * 1.1)) { lf.push('a dropped take is longer than the kept one'); conf = Math.min(conf, 0.45); } }
    if (ratio && (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO)) lf.push(`kept length is ${ratio.toFixed(2)}x the expected one`);
    if (!exp) lf.push('no expected length (no --strings)');
    const prevEnd = g.kept > 0 ? segs[g.kept - 1][1] : 0, nextStart = g.kept + 1 < segs.length ? segs[g.kept + 1][0] : total;
    const s0 = Math.max(a - PAD, (prevEnd + a) / 2), s1 = Math.min(b + PAD, (b + nextStart) / 2), file = path.join(outDir, key + '.wav');
    ff(['-y', '-i', take, '-ss', s0.toFixed(3), '-to', s1.toFixed(3), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', file]);
    report.lines.push({ key, file: path.basename(file), segment: g.kept, start: +s0.toFixed(2), end: +s1.toFixed(2), seconds: +(s1 - s0).toFixed(2), expectedSeconds: exp && +exp.toFixed(2), droppedAsRetake: dropped, confidence: +conf.toFixed(2), flags: lf });
    if (conf < 0.5 || lf.length) flags.push(`${key}: ${lf.join('; ') || 'low confidence'} (confidence ${conf.toFixed(2)})`);
  });
  report.ok = !!groups && report.lines.every(l => l.confidence >= 0.5) && !flags.some(f => !f.includes('retake: dropped'));
  fs.writeFileSync(path.join(outDir, 'split-report.json'), JSON.stringify(report, null, 2));
  return report;
}

// ---------- voice ----------
export function filterChain(p, c) {
  const rb = (st, formant) => `rubberband=pitch=${Math.pow(2, st / 12).toFixed(5)}:formant=${formant}`, fs_ = p.formantSemitones || 0, rest = (p.semitones || 0) - fs_, f = [`highpass=f=${c.highpassHz}`, c.denoise];
  if (fs_) f.push(rb(fs_, 'shifted')); if (Math.abs(rest) > 0.01) f.push(rb(rest, 'preserved'));
  f.push(...(p.eq || [])); if (p.saturate) f.push(p.saturate); f.push(...(p.post || []));
  if (p.reverb) f.push('apad=pad_dur=0.5', p.reverb);
  return f.join(',');
}
export function voice(inFile, profileName, outFile, profilesFile = PROFILES) {
  const cfg = JSON.parse(fs.readFileSync(profilesFile, 'utf8')), p = cfg.profiles[profileName]; if (!p) throw new Error(`unknown profile ${profileName} (have ${Object.keys(cfg.profiles).join(', ')})`);
  const c = cfg.common, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), mid = path.join(tmp, 'mid.wav'), ln = `loudnorm=I=${c.lufs}:TP=${c.tp}:LRA=11`;
  try {
    ff(['-y', '-i', inFile, '-af', filterChain(p, c), '-ac', '1', '-ar', '48000', mid]);
    const m = loud(mid); // pass 1 measures, pass 2 applies it linearly so a short line lands on target
    const af = `${ln}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`;
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    ff(['-y', '-i', mid, '-af', af, '-ac', '1', '-c:a', 'libopus', '-b:a', c.bitrate, '-application', 'voip', outFile]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- synthetic speech (selftest + calibrate) ----------
/** Voiced harmonics through three formant peaks, 4 Hz syllable envelope, slow F0 drift. Mono 16-bit WAV bytes. */
export function synthWav(seconds, f0 = 120, rate = 48000, formants = [[650, 90], [1150, 110], [2500, 200]]) {
  const n = Math.round(seconds * rate), s = new Int16Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, f = f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 0.7 * t)); ph += 2 * Math.PI * f / rate; let v = 0;
    for (let h = 1; h * f < 5000; h++) { const hf = h * f; let a = 0.03; for (const [fc, bw] of formants) a += Math.exp(-0.5 * ((hf - fc) / bw) ** 2); v += a / h ** 0.6 * Math.sin(h * ph); }
    const env = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.5 * Math.min(1, t * 20, (seconds - t) * 20);
    s[i] = Math.max(-32767, Math.min(32767, v * env * 3500 + (Math.random() - 0.5) * 20));
  }
  return s;
}
export function writeWav(file, samples, rate = 48000) {
  const h = Buffer.alloc(44), n = samples.length * 2; h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, n)]));
}
export function calibrate(dir, log = console.log) {
  const src = path.join(dir, 'male.wav'); writeWav(src, synthWav(4, 120)); const base = measure(src), cfg = JSON.parse(fs.readFileSync(PROFILES, 'utf8')), rows = {};
  log(`source: F0 ${base.f0.toFixed(1)} Hz, centroid ${base.centroid.toFixed(0)} Hz`);
  for (const name of Object.keys(cfg.profiles)) {
    const out = path.join(dir, name + '.ogg'); voice(src, name, out); const m = measure(out), st = 12 * Math.log2(m.f0 / base.f0), cr = m.centroid / base.centroid;
    rows[name] = { f0: m.f0, f0Semitones: st, centroid: m.centroid, centroidRatio: cr, out };
    log(`${name.padEnd(8)} F0 ${m.f0.toFixed(1)} Hz (${st >= 0 ? '+' : ''}${st.toFixed(2)} st, profile ${cfg.profiles[name].semitones})  centroid ${m.centroid.toFixed(0)} Hz (x${cr.toFixed(2)})`);
  }
  return { base, rows };
}

// ---------- cli ----------
function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i]; else o._.push(argv[i]); } return o; }
async function main(argv) {
  const [cmd, ...rest] = argv, a = args(rest);
  if (cmd === 'split') {
    if (!a._[0] || !a.keys || !a.out) throw new Error('split <take> --keys k1,k2 --out <dir>');
    const r = split(a._[0], a.keys.split(','), a.out, { db: +(a.db ?? -38), minSilence: +(a['min-silence'] ?? 1.2), strings: a.strings, cps: +(a.cps ?? 11) });
    console.log(`${r.segments.length} segments -> ${r.lines.length}/${a.keys.split(',').length} lines (cps ${r.params.cps}); report: ${path.join(a.out, 'split-report.json')}`);
    for (const f of r.flags) console.log('FLAG ' + f); if (!r.ok) process.exitCode = 3;
  } else if (cmd === 'voice') {
    if (!a._[0] || !a.profile || !a.out) throw new Error('voice <in.wav> --profile <name> --out <file.ogg>');
    voice(a._[0], a.profile, a.out, a.profiles); const p = probe(a.out), l = loud(a.out); console.log(`${a.out}: ${p.codec} ${p.channels}ch ${p.duration.toFixed(2)}s ${(+l.input_i).toFixed(1)} LUFS ${(+l.input_tp).toFixed(1)} dBTP`);
  } else if (cmd === 'measure') { const m = measure(a._[0]); console.log(`centroid ${m.centroid.toFixed(0)} Hz, F0 ${m.f0.toFixed(1)} Hz`); }
  else if (cmd === 'calibrate') { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cal-')); try { calibrate(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } }
  else if (cmd === 'selftest') selftest();
  else console.log('usage: node voice-process.mjs split|voice|measure|calibrate|selftest (see header)');
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-selftest-'));
  try {
    const CPS = 11, text = { 'x.one': 'שלום לך אבא יקר', 'x.two': 'אנחנו צריכים לדבר על המחסן הישן', 'x.three': 'לא', 'x.four': 'תביא את הדלי הגדול מהבאר ותמלא אותו עד הסוף', 'x.five': 'הלכנו' };
    const keys = Object.keys(text), strings = path.join(tmp, 'strings.ts'); fs.writeFileSync(strings, keys.map(k => `  '${k}': '${text[k]}',`).join('\r\n'));
    const secs = k => expectedSeconds(text[k], CPS), rate = 48000;
    const build = (plan, out) => { // plan: [seconds | 'gap']; 2 s silences between bursts, 1 s lead and tail
      const parts = [new Int16Array(rate)]; plan.forEach((d, i) => { parts.push(synthWav(d, 110 + 7 * i)); parts.push(new Int16Array(i === plan.length - 1 ? rate : 2 * rate)); });
      const all = new Int16Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      const wav = out + '.wav'; writeWav(wav, all, rate); ff(['-y', '-i', wav, '-c:a', 'aac', '-b:a', '96k', out + '.m4a']); return out + '.m4a';
    };
    // 1) clean take, 2) a fluffed line (aborted at 40%) followed by the re-read, an extra whole retake of the last line
    const clean = build(keys.map(secs), path.join(tmp, 'clean'));
    const r1 = split(clean, keys, path.join(tmp, 'o1'), { strings, cps: CPS });
    assert.equal(r1.segments.length, 5); assert.equal(r1.lines.length, 5); assert.ok(r1.ok, JSON.stringify([r1.flags, r1.segments, r1.params]));
    for (const l of r1.lines) assert.ok(Math.abs(l.seconds - (secs(l.key) + 2 * PAD)) < 0.35, `${l.key} ${l.seconds} vs ${secs(l.key)}`);
    const plan = [secs('x.one'), secs('x.two') * 0.4, secs('x.two'), secs('x.three'), secs('x.four'), secs('x.five') * 1.5, secs('x.five')];
    const take = build(plan, path.join(tmp, 'retake'));
    const r2 = split(take, keys, path.join(tmp, 'o2'), { strings, cps: CPS });
    assert.equal(r2.segments.length, 7); assert.equal(r2.lines.length, 5);
    assert.deepEqual(r2.lines.map(l => l.segment), [0, 2, 3, 4, 6]); assert.deepEqual(r2.lines.map(l => l.droppedAsRetake), [[], [1], [], [], [5]]);
    assert.ok(r2.lines[1].flags.length && r2.lines[1].confidence <= 0.75, 'a retake is flagged');
    for (const k of keys) assert.ok(fs.statSync(path.join(tmp, 'o2', k + '.wav')).size > 10000);
    assert.ok(Math.abs(r2.lines[1].seconds - (secs('x.two') + 2 * PAD)) < 0.35, 'kept the full re-read, not the aborted one');
    // missing a line: flagged, not guessed
    const short = split(clean, [...keys, 'x.six'], path.join(tmp, 'o3'), { strings, cps: CPS }); assert.equal(short.lines.length, 0); assert.ok(short.flags.length && !short.ok);
    console.log(`  split: clean 5/5, retakes 7 segments -> 5 lines, dropped [1],[5], cps fitted ${r2.params.cps}`);
    // voice: every profile -> mono Opus at target loudness, F0 moved by the profile's semitones
    const cfg = JSON.parse(fs.readFileSync(PROFILES, 'utf8')), { base, rows } = calibrate(tmp, s => console.log('  ' + s));
    for (const [name, r] of Object.entries(rows)) {
      const p = probe(r.out), l = loud(r.out), want = cfg.profiles[name].semitones;
      assert.equal(p.codec, 'opus', name); assert.equal(p.channels, 1, name); assert.ok(Math.abs(+l.input_i - cfg.common.lufs) < 1.5, `${name} ${l.input_i} LUFS`); assert.ok(+l.input_tp < -0.5, `${name} peak ${l.input_tp}`);
      assert.ok(Math.abs(r.f0Semitones - want) < 0.7, `${name} F0 moved ${r.f0Semitones.toFixed(2)} st, wanted ${want}`);
      assert.ok(fs.statSync(r.out).size / p.duration < 6000, `${name} bitrate`);
    }
    assert.ok(rows['bright-high'].centroidRatio > 1.15 && rows['young-thin'].centroidRatio > 1.05 && rows['deep-gruff'].centroidRatio < 0.95, 'centroid moves the right way');
    assert.ok(base.f0 > 100 && base.f0 < 140);
    console.log('voice-process selftest ok');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(e => { console.error('error: ' + e.message); process.exit(1); });
