// Procedural sound effects: jsfxr preset (or ffmpeg noise bed) -> WAV -> loudnorm -> mono Opus .ogg -> asset-intake (licence OWN).
// usage:
//   node make-sfx.mjs render --preset <hit|block|click|pickup|footstep-dirt|footstep-stone|footstep-wood> --out <file.ogg> [--seed N] [--bitrate 64k] [--no-register]
//   node make-sfx.mjs noise  --kind <wind|fire> --out <file.ogg> [--seconds 8] [--seed N] [--bitrate 64k] [--no-register]
//   node make-sfx.mjs list | selftest
// Vary a footstep by changing --seed. Needs studio-local node_modules (jsfxr) and bin/ffmpeg.exe. --out belongs outside any repo (assets.md).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process'; import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || path.join(HOME, 'bin', 'ffmpeg.exe'), FFPROBE = process.env.FFPROBE || path.join(HOME, 'bin', 'ffprobe.exe'); // bin/ is git-ignored; or set FFMPEG / FFPROBE
const INTAKE = path.join(HOME, 'tools', 'asset-intake.mjs');
const LOUDNORM = 'loudnorm=I=-18:TP=-1.5:LRA=11'; // assets.md step 4

const mulberry32 = a => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// jsfxr's presets call Math.random; swap in a seeded PRNG while building params so a seed reproduces a sound.
export const PRESETS = ['hit', 'block', 'click', 'pickup', 'footstep-dirt', 'footstep-stone', 'footstep-wood'];
export async function sfxrParams(preset, seed = 1) {
  const { jsfxr } = await import(pathToFileURL(path.join(HOME, 'node_modules/jsfxr/sfxr.mjs')).href);
  const real = Math.random, r = mulberry32(seed); Math.random = r;
  try {
    const p = new jsfxr.Params(); p.sound_vol = 0.25; p.sample_rate = 44100; p.sample_size = 16;
    const f = x => r() * x;
    if (preset === 'hit') p.hitHurt();
    else if (preset === 'click') p.click();
    else if (preset === 'pickup') p.pickupCoin();
    else if (preset === 'block') Object.assign(p, { wave_type: 0, p_base_freq: 0.45 + f(0.1), p_freq_ramp: -0.25, p_env_sustain: 0.03, p_env_decay: 0.22 + f(0.08), p_env_punch: 0.5, p_pha_offset: 0.35, p_pha_ramp: -0.2, p_hpf_freq: 0.15, p_duty: 0.3 });
    else if (preset.startsWith('footstep-')) {
      const k = { dirt: { lpf: 0.35, base: 0.22, hpf: 0 }, stone: { lpf: 0.7, base: 0.4, hpf: 0.12 }, wood: { lpf: 0.5, base: 0.3, hpf: 0.05 } }[preset.slice(9)];
      if (!k) throw new Error(`unknown preset '${preset}'`);
      Object.assign(p, { wave_type: 3, p_base_freq: k.base + f(0.08), p_env_sustain: 0.02 + f(0.03), p_env_decay: 0.12 + f(0.06), p_env_punch: 0.4 + f(0.3), p_lpf_freq: k.lpf + f(0.1), p_hpf_freq: k.hpf });
    } else throw new Error(`unknown preset '${preset}' (${PRESETS.join(', ')})`);
    return p;
  } finally { Math.random = real; }
}
export async function renderWav(preset, seed, wavPath) {
  const { jsfxr } = await import(pathToFileURL(path.join(HOME, 'node_modules/jsfxr/sfxr.mjs')).href);
  const params = await sfxrParams(preset, seed), real = Math.random; Math.random = mulberry32(seed + 1); // noise waves draw random samples at render time too
  try { fs.writeFileSync(wavPath, Buffer.from(new jsfxr.SoundEffect(params).generate().wav)); } finally { Math.random = real; }
}

const run = (exe, args) => { const r = spawnSync(exe, args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${path.basename(exe)} failed: ${(r.stderr || r.error || '').toString().split('\n').slice(-6).join('\n')}`); return r; };
// Noise beds: pure ffmpeg lavfi (anoisesrc seeded). Filter graphs are placeholders to tune by ear.
export function noiseGraph(kind, seconds, seed) {
  if (kind === 'wind') return `anoisesrc=d=${seconds}:c=pink:seed=${seed}:a=0.6,lowpass=f=700,highpass=f=80,tremolo=f=0.2:d=0.7[o]`;
  if (kind === 'fire') return `anoisesrc=d=${seconds}:c=brown:seed=${seed}:a=0.7,lowpass=f=900[a];anoisesrc=d=${seconds}:c=white:seed=${seed + 1}:a=0.4,highpass=f=3500,tremolo=f=13:d=0.95[b];[a][b]amix=inputs=2:normalize=0[o]`;
  throw new Error(`unknown noise kind '${kind}' (wind, fire)`);
}
// Encode any input to loudness-normalised mono Opus. Short clips: pad so loudnorm has a full measurement window, then trim back.
export function encode(input, out, { bitrate = '64k', trim = null, lavfi = null } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  if (trim === 'auto') trim = +run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input]).stdout;
  const af = (trim ? `apad=pad_dur=1,${LOUDNORM},atrim=0:${trim},` : `${LOUDNORM},`) + 'aresample=48000';
  const src = lavfi ? ['-filter_complex', `${lavfi};[o]${af}[n]`, '-map', '[n]'] : ['-i', input, '-af', af];
  run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...src, '-ac', '1', '-c:a', 'libopus', '-b:a', bitrate, out]);
}
export function probe(file) {
  const j = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,channels:format=duration', '-of', 'json', file]).stdout);
  const v = run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).stderr.match(/mean_volume: (-?[\d.]+) dB/);
  return { codec: j.streams[0].codec_name, channels: j.streams[0].channels, duration: +j.format.duration, meanDb: v ? +v[1] : -Infinity };
}

// `runner(argv)` is injectable so the selftest can check the call without touching the real register.
export function register(file, { source, title, note }, runner = a => run(process.execPath, [INTAKE, ...a])) {
  const argv = ['add', '--file', path.resolve(file), '--source', source, '--license', 'OWN', '--author', 'in-house', '--kind', 'audio', '--title', title, '--note', note];
  return runner(argv);
}

function args(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { if (!argv[i].startsWith('--')) continue; const k = argv[i].slice(2); o[k] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; } return o; }

async function main([cmd, ...rest]) {
  const a = args(rest), seed = +(a.seed ?? 1);
  if (cmd === 'list') return console.log(PRESETS.join('\n') + '\nnoise: wind, fire');
  if (cmd === 'render' || cmd === 'noise') {
    if (!a.out || !String(a.out).endsWith('.ogg')) throw new Error('--out <file.ogg> is required');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
    try {
      let desc, source;
      if (cmd === 'render') {
        if (!a.preset) throw new Error('--preset is required');
        const wav = path.join(tmp, 'in.wav'); await renderWav(a.preset, seed, wav);
        encode(wav, a.out, { bitrate: a.bitrate, trim: 'auto' });
        desc = `jsfxr 1.4.1 preset ${a.preset} seed ${seed}`; source = 'https://github.com/chr15m/jsfxr';
      } else {
        const secs = +(a.seconds ?? 8); if (!(secs > 0)) throw new Error('--seconds must be > 0');
        encode(null, a.out, { bitrate: a.bitrate, lavfi: noiseGraph(a.kind, secs, seed) });
        desc = `ffmpeg anoisesrc ${a.kind} bed ${secs}s seed ${seed}`; source = 'https://ffmpeg.org/ffmpeg-filters.html#anoisesrc';
      }
      const info = probe(a.out);
      console.log(JSON.stringify({ out: path.resolve(a.out), bytes: fs.statSync(a.out).size, ...info }));
      if (!a['no-register']) console.log(register(a.out, { source, title: path.basename(a.out), note: `Made in-house: ${desc}, loudnorm -18 LUFS, mono Opus ${a.bitrate ?? '64k'}` }).stdout.trim());
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } else if (cmd === 'selftest') await selftest();
  else console.log('usage: node make-sfx.mjs render|noise|list|selftest (see header)');
}

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-selftest-'));
  try {
    // determinism: same seed, same params; different seed, different params
    const j = async (s, n) => JSON.stringify(await sfxrParams('footstep-dirt', n));
    assert.equal(await j(0, 5), await j(0, 5)); assert.notEqual(await j(0, 5), await j(0, 6));
    const w = n => { const f = path.join(tmp, n); return renderWav('click', 9, f).then(() => fs.readFileSync(f).toString('hex')); };
    assert.equal(await w('a.wav'), await w('b.wav'), 'same seed renders identical audio');
    for (const preset of ['click', 'hit', 'block', 'pickup', 'footstep-stone']) {
      const wav = path.join(tmp, preset + '.wav'), ogg = path.join(tmp, preset + '.ogg');
      await renderWav(preset, 7, wav); encode(wav, ogg, { trim: 'auto' });
      const p = probe(ogg);
      assert.equal(p.codec, 'opus', preset); assert.equal(p.channels, 1, preset);
      assert.ok(p.duration > 0.03 && p.duration < 1.2, `${preset} duration ${p.duration}`);
      assert.ok(p.meanDb > -50, `${preset} is silent (${p.meanDb} dB)`);
      console.log(`  ${preset}: opus mono ${p.duration.toFixed(2)}s mean ${p.meanDb} dB ${fs.statSync(ogg).size} B`);
    }
    const bed = path.join(tmp, 'wind.ogg'); encode(null, bed, { lavfi: noiseGraph('wind', 2, 3) });
    const pb = probe(bed); assert.equal(pb.codec, 'opus'); assert.ok(Math.abs(pb.duration - 2) < 0.2 && pb.meanDb > -50, JSON.stringify(pb));
    console.log(`  wind bed: ${pb.duration.toFixed(2)}s mean ${pb.meanDb} dB`);
    let got; register(bed, { source: 'https://x.org', title: 't', note: 'n' }, a => (got = a, { stdout: '' }));
    assert.deepEqual(got.slice(got.indexOf('--license'), got.indexOf('--license') + 2), ['--license', 'OWN']);
    assert.ok(got.includes('audio') && got.includes(path.resolve(bed)));
    console.log('make-sfx selftest ok');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(e => { console.error('error: ' + e.message); process.exit(1); });
