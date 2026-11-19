// Generate an image through the outsourcerer plugin's `image` subcommand (Codex gpt-image-2, billed to the ChatGPT plan, no cash), save it, register as AI-OWN.
// usage:
//   node gen-image.mjs --prompt "<text>" --out <file.png|.webp> [--size 512x512 | 512] [--transparent] [--kind texture] [--model gpt-image] [--no-register] [--dry-run]
//   node gen-image.mjs selftest
// Only the keyless Codex backend is allowed (gpt-image, gpt-image-2, codex-image). nano-banana needs GEMINI_API_KEY and OpenRouter models cost cash, so they are
// refused: ask the owner first, then run the plugin by hand. The plugin takes no size flag; the size goes into the prompt and the result is resized with sharp.
// Plugin: newest version under %USERPROFILE%\.claude\plugins\cache\outsourcerer\ (skills/outsourcerer/scripts/outsourcerer.sh, run with Git Bash).
// Output belongs outside any repo (assets.md). Prompts leave the machine (OpenAI): never put secrets or personal data in them.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const INTAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'asset-intake.mjs');
const FREE_MODELS = ['gpt-image', 'gpt-image-2', 'codex-image'];
const semver = v => v.split('.').map(n => parseInt(n, 10) || 0);
const cmpVer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// Newest plugin version dir under <cache>/outsourcerer/<marketplace>/<version>/ that has the script.
export function findPlugin(cache = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'outsourcerer')) {
  const found = [];
  for (const m of fs.existsSync(cache) ? fs.readdirSync(cache) : [])
    for (const v of fs.readdirSync(path.join(cache, m))) {
      const s = path.join(cache, m, v, 'skills', 'outsourcerer', 'scripts', 'outsourcerer.sh');
      if (fs.existsSync(s)) found.push({ version: v, script: s });
    }
  if (!found.length) throw new Error(`outsourcerer plugin not found under ${cache}`);
  return found.sort((a, b) => cmpVer(a.version, b.version)).at(-1);
}

export function parseSize(s) {
  const m = String(s ?? '512').match(/^(\d{2,4})(?:x(\d{2,4}))?$/i);
  if (!m) throw new Error(`--size must be N or WxH (got '${s}')`);
  const w = +m[1], h = +(m[2] ?? m[1]); if (w > 2048 || h > 2048 || w < 16 || h < 16) throw new Error('--size must be between 16 and 2048');
  return { w, h };
}

export function buildPrompt(prompt, { w, h }, transparent) {
  return `${prompt.trim()}. Composition suited to a ${w}x${h} px image.${transparent ? ' Isolated subject on a fully transparent background.' : ''} No text or watermark.`;
}

export function buildCommand({ plugin, model, prompt, outPng }) {
  if (!FREE_MODELS.includes(model)) throw new Error(`model '${model}' is refused: only the keyless Codex backend (${FREE_MODELS.join(', ')}) is plan-included; others bill cash or need an API key, so ask the owner first`);
  const bash = ['ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData'].map(e => process.env[e] && path.join(process.env[e], e === 'LocalAppData' ? 'Programs' : '', 'Git', 'bin', 'bash.exe')).find(p => p && fs.existsSync(p)) ?? 'bash';
  return { exe: bash, argv: [plugin.script.replaceAll('\\', '/'), 'image', '-m', model, prompt, outPng.replaceAll('\\', '/')] };
}

// `runner(argv)` injectable for tests.
export function register(file, { prompt, model, kind = 'texture' }, runner = a => { const r = spawnSync(process.execPath, [INTAKE, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`asset-intake failed: ${r.stderr || r.stdout}`); return r.stdout.trim(); }) {
  return runner(['add', '--file', path.resolve(file), '--source', 'https://platform.openai.com/docs/guides/image-generation', '--license', 'AI-OWN', '--author', `AI-generated (${model} via outsourcerer)`, '--kind', kind, '--title', path.basename(file),
    '--note', `AI-generated, check provider terms. Backend ${model}. Prompt: ${prompt.replace(/\s+/g, ' ').slice(0, 300)}`]);
}

function args(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { if (!argv[i].startsWith('--')) { (o._ ??= []).push(argv[i]); continue; } const k = argv[i].slice(2); o[k] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } return o; }

async function generate(a) {
  if (!a.prompt || !a.out) throw new Error('--prompt and --out are required');
  const size = parseSize(a.size), model = a.model ?? 'gpt-image', out = path.resolve(a.out);
  if (!/\.(png|webp)$/i.test(out)) throw new Error('--out must end in .png or .webp');
  const prompt = buildPrompt(a.prompt, size, a.transparent), plugin = findPlugin();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genimg-')), raw = path.join(tmp, 'raw.png');
  const cmd = buildCommand({ plugin, model, prompt, outPng: raw });
  if (a['dry-run']) { console.log(`plugin ${plugin.version}\n${cmd.exe} ${cmd.argv.map(x => JSON.stringify(x)).join(' ')}\nthen resize to ${size.w}x${size.h} -> ${out}`); fs.rmSync(tmp, { recursive: true }); return; }
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = spawnSync(cmd.exe, cmd.argv, { encoding: 'utf8', timeout: 600000 });
    process.stderr.write((r.stderr ?? '').split('\n').slice(-5).join('\n'));
    if (r.status !== 0 || !fs.existsSync(raw)) throw new Error(`image generation failed (exit ${r.status}); stdout: ${(r.stdout ?? '').slice(-400)}`);
    const sharp = (await import('sharp')).default, img = sharp(raw).resize(size.w, size.h, { fit: 'cover' });
    await (/\.webp$/i.test(out) ? img.webp({ quality: 85 }) : img.png({ compressionLevel: 9 })).toFile(out);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(JSON.stringify({ out, bytes: fs.statSync(out).size, backend: model, plugin: plugin.version }));
  if (!a['no-register']) console.log(register(out, { prompt: a.prompt, model, kind: a.kind }));
}

function selftest() {
  // newest version is picked numerically (0.16.0 > 0.9.0), not alphabetically
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genimg-selftest-'));
  try {
    for (const v of ['0.9.0', '0.16.0', '0.15.3']) { const d = path.join(root, 'mkt', v, 'skills', 'outsourcerer', 'scripts'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'outsourcerer.sh'), ''); }
    assert.equal(findPlugin(root).version, '0.16.0');
    assert.throws(() => findPlugin(path.join(root, 'none')), /not found/);
    assert.deepEqual(parseSize('512'), { w: 512, h: 512 }); assert.deepEqual(parseSize('256x128'), { w: 256, h: 128 });
    assert.throws(() => parseSize('9000'), /between/); assert.throws(() => parseSize('big'), /N or WxH/);
    const plugin = findPlugin(root), c = buildCommand({ plugin, model: 'gpt-image', prompt: 'a bread icon', outPng: 'C:\\x\\raw.png' });
    assert.deepEqual(c.argv.slice(1, 4), ['image', '-m', 'gpt-image']); assert.equal(c.argv.at(-1), 'C:/x/raw.png');
    for (const bad of ['nano-banana', 'x-ai/grok-imagine-image-quality']) assert.throws(() => buildCommand({ plugin, model: bad, prompt: 'p', outPng: 'o' }), /refused/);
    assert.match(buildPrompt('a bread icon', { w: 64, h: 64 }, true), /64x64.*transparent/);
    let argv; register('some.png', { prompt: 'a bread icon', model: 'gpt-image' }, a => (argv = a));
    const at = k => argv[argv.indexOf(k) + 1];
    assert.equal(at('--license'), 'AI-OWN'); assert.match(at('--note'), /^AI-generated, check provider terms/); assert.equal(at('--kind'), 'texture');
    console.log('gen-image selftest ok (offline: plugin discovery, size, command, paid-backend refusal, registration argv)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2));
  (a._?.[0] === 'selftest' ? Promise.resolve(selftest()) : a.prompt ? generate(a) : Promise.resolve(console.log('usage: node gen-image.mjs --prompt "<text>" --out <file> [--size 512x512] (see header)')))
    .catch(e => { console.error('error: ' + e.message); process.exit(1); });
}
