// Run a Blender Python script headless with the studio's portable Blender (bin/blender, 4.5 LTS, GPL-3.0: a tool only, its outputs are ours).
// usage:
//   node blender-run.mjs <script.py> [--timeout 900] [--log <file.log>] [-- <args passed to the script as sys.argv after '--'>]
//   node blender-run.mjs selftest
// Runs `blender --background --factory-startup --python-exit-code 1 --python <script> -- <args>`, so a Python exception exits non-zero.
// Streams Blender's output and writes it to --log (default: a file in the OS temp dir, path printed); kills Blender after --timeout s.
// STUDIO_BLENDER=<blender.exe> overrides the portable copy.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BLENDER = process.env.STUDIO_BLENDER ?? path.join(HOME, 'bin/blender/blender.exe');

export function parseArgs(argv) {
  const dd = argv.indexOf('--'), own = dd < 0 ? argv : argv.slice(0, dd), rest = dd < 0 ? [] : argv.slice(dd + 1);
  const o = { timeout: 900, scriptArgs: rest };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--timeout') o.timeout = +own[++i]; else if (a === '--log') o.log = own[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`); else if (!o.script) o.script = a; else throw new Error(`extra argument ${a}`);
  }
  assert(o.script, 'usage: blender-run.mjs <script.py> [--timeout s] [--log file] [-- args]');
  assert(o.timeout > 0, '--timeout must be > 0');
  return o;
}

// Resolves { code, log, ms }; rejects on timeout or a non-zero exit (the log tail is in the message).
export function runBlender(script, scriptArgs = [], { timeout = 900, log } = {}) {
  if (!fs.existsSync(BLENDER)) throw new Error(`no Blender at ${BLENDER}: unzip the official 4.5 LTS portable zip into bin/blender (recipe assets.md)`);
  if (!fs.existsSync(script)) throw new Error(`no such script: ${script}`);
  log ??= path.join(os.tmpdir(), `blender-run-${path.basename(script, '.py')}-${Date.now()}.log`);
  const args = ['--background', '--factory-startup', '--python-exit-code', '1', '--python', path.resolve(script), '--', ...scriptArgs];
  return new Promise((res, rej) => {
    const t0 = Date.now(), out = fs.createWriteStream(log), p = spawn(BLENDER, args, { windowsHide: true });
    let tail = '';
    const take = d => { out.write(d); process.stdout.write(d); tail = (tail + d).slice(-4000); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const timer = setTimeout(() => { p.kill(); rej(new Error(`Blender timed out after ${timeout} s (log ${log})`)); }, timeout * 1000);
    p.on('error', e => { clearTimeout(timer); rej(e); });
    p.on('close', code => {
      clearTimeout(timer); out.end();
      if (code === 0) res({ code, log, ms: Date.now() - t0 });
      else rej(new Error(`Blender exited ${code} (log ${log})\n${tail.split('\n').slice(-15).join('\n')}`));
    });
  });
}

async function selftest() {
  const o = parseArgs(['a.py', '--timeout', '5', '--', 'x', '--y']);
  assert.deepEqual([o.script, o.timeout, o.scriptArgs], ['a.py', 5, ['x', '--y']]);
  assert.throws(() => parseArgs([]), /usage/); assert.throws(() => parseArgs(['a.py', '--bogus']), /unknown/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-run-selftest-'));
  try {
    const py = path.join(dir, 'cube.py'), glb = path.join(dir, 'cube.glb');
    fs.writeFileSync(py, [
      'import bpy, sys',
      'out = sys.argv[sys.argv.index("--") + 1]',
      'bpy.ops.wm.read_factory_settings(use_empty=True)',
      'bpy.ops.mesh.primitive_cube_add(size=1)',
      'bpy.context.object.name = "selftest_cube"',
      'bpy.ops.export_scene.gltf(filepath=out, export_format="GLB")',
      'print("SELFTEST", bpy.app.version_string)',
    ].join('\n'));
    const r = await runBlender(py, [glb], { timeout: 180, log: path.join(dir, 'cube.log') });
    const b = fs.readFileSync(glb);
    assert.equal(b.readUInt32LE(0), 0x46546C67, 'GLB magic');
    const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
    assert.equal(j.nodes[0].name, 'selftest_cube'); assert.equal(j.meshes.length, 1);
    const ver = fs.readFileSync(r.log, 'utf8').match(/SELFTEST (\S+)/)?.[1];
    // a failing script must fail the run
    const bad = path.join(dir, 'bad.py'); fs.writeFileSync(bad, 'raise RuntimeError("boom")');
    await assert.rejects(runBlender(bad, [], { timeout: 120, log: path.join(dir, 'bad.log') }), /exited 1/);
    console.log(`\nblender-run selftest ok: Blender ${ver}, cube GLB ${b.length} B in ${r.ms} ms; a Python error exits non-zero`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    if (process.argv[2] === 'selftest') return selftest();
    const o = parseArgs(process.argv.slice(2));
    const r = await runBlender(o.script, o.scriptArgs, o);
    console.log(`\nblender-run: ok in ${(r.ms / 1000).toFixed(1)} s, log ${r.log}`);
  })().catch(e => { console.error('error: ' + e.message); process.exit(1); });
}
