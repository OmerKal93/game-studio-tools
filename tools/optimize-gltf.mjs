// Shrink a glTF/GLB for the game: meshopt (EXT_meshopt_compression only) + WebP, then Khronos validate, then before/after bytes.
// usage:
//   node optimize-gltf.mjs <in.glb|gltf> <out.glb> --profile static|skinned [--texture-size 512] [--engine gltf-transform|gltfpack] [--simplify-ratio 0.3] [--keep-nodes 1]
//   node optimize-gltf.mjs selftest
// static  = props: dedup, prune, weld, simplify, join, flatten, instance, meshopt, WebP (max --texture-size, default 512).
// --keep-nodes 1 (static): no join/flatten and no attribute pruning, so named nodes (LOD0/LOD1 groups, variants), one-material-per-node
// meshes and UVs for materials the game assigns at runtime by name (texture-less in the file) all survive.
// skinned = characters: no simplify/join/flatten/instance/palette/resample, so skins and clips survive; still meshopt + WebP (default 1024).
// --engine gltfpack (static only): gltfpack -c -tw [-si R] after a gltf-transform resize; better simplifier. Never -cz: it writes KHR_meshopt_compression,
// which drei/three-stdlib 2.36.1 cannot read. The tool fails if the output contains it (or Draco). Needs studio-local node_modules and bin/gltfpack-1.3.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process'; import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GT = path.join(HOME, 'node_modules/@gltf-transform/cli/bin/cli.js');
const GLTFPACK = path.join(HOME, 'bin/gltfpack-1.3/gltfpack.exe');
const FORBIDDEN = ['KHR_meshopt_compression', 'KHR_draco_mesh_compression'];

const run = (exe, args) => { const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 64e6 }); if (r.error || r.status !== 0) throw new Error(`${path.basename(exe)} ${args[0]} failed: ${r.error ?? (r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n')}`); return r; };
const gt = args => run(process.execPath, [GT, ...args]);

// JSON chunk of a .glb, or the .gltf itself.
export function readJson(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546C67) return JSON.parse(b.toString('utf8'));
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
}

export function gtArgs(profile, inp, out, { textureSize, simplifyRatio, keepNodes } = {}) {
  const common = ['optimize', inp, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', String(textureSize ?? (profile === 'static' ? 512 : 1024)), '--palette', 'false'];
  if (profile === 'static') return [...common, ...(keepNodes ? ['--join', 'false', '--flatten', 'false', '--prune-attributes', 'false'] : []), '--simplify', 'true', ...(simplifyRatio != null ? ['--simplify-ratio', String(simplifyRatio), '--simplify-error', '0.01'] : [])];   // default error 0.0001 makes the ratio a no-op
  if (profile === 'skinned') return [...common, '--simplify', 'false', '--join', 'false', '--flatten', 'false', '--instance', 'false', '--resample', 'false'];
  throw new Error(`--profile must be static or skinned (got '${profile}')`);
}

export function optimize(inp, out, { profile, textureSize, engine = 'gltf-transform', simplifyRatio, keepNodes } = {}) {
  if (!fs.existsSync(inp)) throw new Error(`no such file: ${inp}`);
  if (!out.endsWith('.glb')) throw new Error('<out> must end in .glb');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const before = fs.statSync(inp).size;
  if (engine === 'gltfpack') {
    if (profile !== 'static') throw new Error('--engine gltfpack is for static props only: its quantization and simplifier can damage skins (use gltf-transform for skinned)');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optgltf-'));
    try {
      const n = textureSize ?? 512, mid = path.join(tmp, 'resized.glb');
      gt(['resize', inp, mid, '--width', String(n), '--height', String(n)]);
      run(GLTFPACK, ['-i', mid, '-o', out, '-c', '-tw', ...(simplifyRatio != null ? ['-si', String(simplifyRatio)] : [])]); // -c = EXT; never -cz
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } else if (engine === 'gltf-transform') gt(gtArgs(profile, inp, out, { textureSize, simplifyRatio, keepNodes }));
  else throw new Error(`--engine must be gltf-transform or gltfpack`);
  const used = readJson(out).extensionsUsed ?? [];
  const bad = used.filter(e => FORBIDDEN.includes(e));
  if (bad.length) { fs.rmSync(out); throw new Error(`output uses ${bad.join(', ')}, which drei/three-stdlib 2.36.1 cannot read; output deleted`); }
  const v = run(process.execPath, [GT, 'validate', out]); // exits non-zero on validation errors
  return { before, after: fs.statSync(out).size, extensions: used, validator: v.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim() };
}

function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i]; else o._.push(argv[i]); } return o; }

// ---- selftest: build fixtures in code (no downloads), optimize, validate, load ----
async function fixture(dir, kind) {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const sharp = (await import('sharp')).default;
  const doc = new Document(), buf = doc.createBuffer(), scene = doc.createScene('s');
  const N = 40, pos = [], uv = [], idx = [];
  for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) { pos.push(x / N - 0.5, Math.sin(x / 5) * Math.cos(y / 5) * 0.1, y / N - 0.5); uv.push(x / N, y / N); }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const a = y * (N + 1) + x, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const nrm = pos.map((_, i) => (i % 3 === 1 ? 1 : 0));
  const noise = Buffer.alloc(1024 * 1024 * 3); for (let i = 0; i < noise.length; i++) noise[i] = (i * 7 + ((i >> 3) * 13)) & 255;
  const png = await sharp(noise, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  const tex = doc.createTexture('t').setImage(new Uint8Array(png)).setMimeType('image/png');
  const mat = doc.createMaterial('m').setBaseColorTexture(tex);
  const mkPrim = () => doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buf))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buf));
  if (kind === 'static') {
    for (let i = 0; i < 2; i++) scene.addChild(doc.createNode('n' + i).setTranslation([i, 0, 0]).setMesh(doc.createMesh('m' + i).addPrimitive(mkPrim())));
  } else {
    const prim = mkPrim(), n = pos.length / 3, j = [], w = [];
    for (let i = 0; i < n; i++) { j.push(i % 2, 0, 0, 0); w.push(1, 0, 0, 0); }
    prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(j)).setBuffer(buf)).setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(w)).setBuffer(buf));
    const j0 = doc.createNode('j0'), j1 = doc.createNode('j1').setTranslation([0, 0.5, 0]); j0.addChild(j1);
    const ibm = doc.createAccessor().setType('MAT4').setArray(new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1, 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-0.5,0,1])).setBuffer(buf);
    const skin = doc.createSkin('sk').addJoint(j0).addJoint(j1).setInverseBindMatrices(ibm);
    const mesh = doc.createNode('body').setMesh(doc.createMesh('bm').addPrimitive(prim)).setSkin(skin);
    scene.addChild(j0).addChild(mesh);
    const times = new Float32Array(Array.from({ length: 60 }, (_, i) => i / 30)), rot = new Float32Array(60 * 4);
    for (let i = 0; i < 60; i++) { const a = Math.sin(i / 8) * 0.5; rot.set([0, 0, Math.sin(a / 2), Math.cos(a / 2)], i * 4); }
    const anim = doc.createAnimation('wave'), samp = doc.createAnimationSampler().setInput(doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buf)).setOutput(doc.createAccessor().setType('VEC4').setArray(rot).setBuffer(buf));
    anim.addSampler(samp).addChannel(doc.createAnimationChannel().setTargetNode(j1).setTargetPath('rotation').setSampler(samp));
  }
  const f = path.join(dir, `${kind}.glb`); await new NodeIO().write(f, doc); return f;
}

// three's loader reads both EXT and KHR meshopt, so the forbidden-extension check above (not this load) guards drei. This proves the data decodes.
async function loadWithThree(file) {
  globalThis.self ??= globalThis;
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} }); // Node has no image decoding; geometry and skins are what we check
  const { GLTFLoader } = await import(pathToFileURL(path.join(HOME, 'node_modules/three/examples/jsm/loaders/GLTFLoader.js')).href);
  const { MeshoptDecoder } = await import(pathToFileURL(path.join(HOME, 'node_modules/three/examples/jsm/libs/meshopt_decoder.module.js')).href);
  await MeshoptDecoder.ready;
  const b = fs.readFileSync(file), loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return new Promise((res, rej) => loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej));
}

async function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optgltf-selftest-'));
  try {
    assert.throws(() => gtArgs('prop', 'a', 'b'), /static or skinned/);
    for (const x of gtArgs('skinned', 'a', 'b')) assert.ok(!/^KHR_/.test(x));
    assert.deepEqual(gtArgs('skinned', 'a', 'b').slice(-10), ['--simplify', 'false', '--join', 'false', '--flatten', 'false', '--instance', 'false', '--resample', 'false']);
    assert.throws(() => optimize('x', 'y.glb', { profile: 'static', engine: 'nope' }), /no such file/);
    assert.ok(gtArgs('static', 'a', 'b', { keepNodes: true }).join(' ').includes('--join false --flatten false --prune-attributes false'));
    for (const [kind, engine] of [['static', 'gltf-transform'], ['static', 'gltfpack'], ['skinned', 'gltf-transform']]) {
      if (engine === 'gltfpack' && !fs.existsSync(GLTFPACK)) { console.log('  (skipping gltfpack: bin/gltfpack-1.3 missing)'); continue; }
      const inp = await fixture(dir, kind), out = path.join(dir, `${kind}-${engine}-opt.glb`);
      const r = optimize(inp, out, { profile: kind, textureSize: 256, engine });
      assert.ok(r.after < r.before / 2, `${kind}/${engine}: ${r.before} -> ${r.after} did not shrink by half`);
      assert.ok(r.extensions.includes('EXT_meshopt_compression'), `${kind}/${engine}: no EXT_meshopt_compression`);
      const j = readJson(out);
      assert.ok(!(j.extensionsUsed ?? []).some(e => FORBIDDEN.includes(e)));
      assert.ok((j.images ?? []).every(i => i.mimeType === 'image/webp'), 'textures are WebP');
      const g = await loadWithThree(out);
      let meshes = 0, skinned = 0; g.scene.traverse(o => { if (o.isMesh) meshes++; if (o.isSkinnedMesh) skinned++; });
      assert.ok(meshes >= 1);
      if (kind === 'skinned') {
        assert.equal(skinned, 1, 'skin survived'); assert.equal(g.animations.length, 1, 'clip survived');
        assert.equal(g.animations[0].tracks[0].times.length, 60, 'keyframes not resampled/dropped');
        assert.equal(j.skins[0].joints.length, 2);
      }
      console.log(`  ${kind}/${engine}: ${r.before} -> ${r.after} B (${(100 * r.after / r.before).toFixed(1)}%), ${[...new Set(r.extensions)].join(' ')}; three loaded ${meshes} mesh(es)${kind === 'skinned' ? ', skin + 60-key clip intact' : ''}; validator: ${r.validator.split('\n').filter(l => /error|warn|info|hint|valid/i.test(l)).slice(0, 4).join(' | ') || 'ok'}`);
    }
    console.log('optimize-gltf selftest ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2));
  (async () => {
    if (a._[0] === 'selftest') return selftest();
    if (a._.length < 2 || !a.profile) return console.log('usage: node optimize-gltf.mjs <in> <out.glb> --profile static|skinned [--texture-size N] [--engine gltfpack] [--simplify-ratio R] [--keep-nodes 1]');
    const r = optimize(path.resolve(a._[0]), path.resolve(a._[1]), { profile: a.profile, textureSize: a['texture-size'] && +a['texture-size'], engine: a.engine, simplifyRatio: a['simplify-ratio'] && +a['simplify-ratio'], keepNodes: !!a['keep-nodes'] && a['keep-nodes'] !== '0' });
    console.log(`before ${r.before} B, after ${r.after} B (${(100 * r.after / r.before).toFixed(1)}%)\nextensions: ${r.extensions.join(', ') || '(none)'}\nvalidator:\n${r.validator}`);
  })().catch(e => { console.error('error: ' + e.message); process.exit(1); });
}
