// Run Unreal Engine headless: editor Python scripts (commandlet or full editor) and UAT, with a timeout, a log, and polite waiting on a shared lock.
// usage:
//   node ue-run.mjs py <project.uproject> <script.py> [--editor] [--ue-arg -flag]... [--timeout 1800] [--log f] [--yield-lock dir] [--max-wait s] [-- script args]
//   node ue-run.mjs uat [--timeout 7200] [--log f] [--yield-lock dir] -- <RunUAT args...>
//   node ue-run.mjs game <project.uproject> [/Game/Map] [--expect regex]... [--ue-arg -flag]... [--timeout 600] [--log f]
//   node ue-run.mjs cmdlet <project.uproject> <CommandletName> [--timeout 1800] [--log f] [-- commandlet args]   (e.g. WorldPartitionConvertCommandlet)
//   node ue-run.mjs selftest
// py (default): UnrealEditor-Cmd -run=pythonscript (no window, no RHI-heavy work). --editor: UnrealEditor -ExecutePythonScript with -RenderOffscreen
//   (needs the GPU; for Movie Render Queue stills); the script must call unreal.SystemLibrary.quit_editor() itself.
// --max-wait s: stop waiting on the lock after s seconds and run anyway at IDLE CPU priority (inherited by shader workers), so the other job keeps the CPU.
// --low-priority: always run at IDLE priority. --ue-arg: extra engine switch, repeatable (e.g. -featureleveles31 renders through the mobile path).
// uat mode keeps UAT/cook logs in <project>/Saved/UAT (uebp_LogFolder, uebp_EngineSavedFolder), never in the engine folder.
// A Python traceback or "LogPython: Error" in the log fails the run even when Unreal exits 0.
// game: UnrealEditor -game -nullrhi -nosound on the map; passes once every --expect regex has appeared in the log (default: the map
//   finished loading), then stops the game. Fails if the game exits or times out first.
// Locks (mkdir mutexes, taken by this tool only, released on exit; a lock left by a killed run is removed by hand, never automatically):
//   <project dir>/.ue-lock: one Unreal process per working copy, every mode. $UE_HEAVY_LOCK (default <tmpdir>/.ue-heavy-lock): one heavy job per machine (uat always,
//   py with --heavy for stills or shader-heavy work). --lock-wait s (default 3600) gives up with an error naming the lock.
// --yield-lock <dir> (or env UE_YIELD_LOCK; default: none): waits while that directory exists, checking every 30 s, so a heavy Unreal job does not
//   run beside another job (an e2e run, say). It never creates or removes the lock. UE_ROOT overrides the engine folder (default UE 5.8 launcher install).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';

export const UE_ROOT = process.env.UE_ROOT ?? 'C:/Program Files/Epic Games/UE_5.8';
const DEFAULT_LOCK = process.env.UE_YIELD_LOCK || undefined; // optional: another job's lock directory to wait on
export const HEAVY_LOCK = process.env.UE_HEAVY_LOCK ?? path.join(os.tmpdir(), '.ue-heavy-lock');
export const LOADED = 'Bringing World .* up for play';
const MATERIAL_FAIL_G = /[^\n]*Failed to compile Material[^\n]*/g;

export function parseArgs(argv) {
  const dd = argv.indexOf('--'), own = dd < 0 ? argv : argv.slice(0, dd), rest = dd < 0 ? [] : argv.slice(dd + 1);
  const o = { mode: 'py', editor: false, timeout: undefined, lock: DEFAULT_LOCK, rest, pos: [], ueArgs: [], expect: [], lockWait: 3600 };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--timeout') o.timeout = +own[++i]; else if (a === '--log') o.log = own[++i]; else if (a === '--yield-lock') o.lock = own[++i];
    else if (a === '--editor') o.editor = true; else if (a === '--ue-arg') o.ueArgs.push(own[++i]); else if (a === '--low-priority') o.low = true; else if (a === '--max-wait') o.maxWait = +own[++i];
    else if (a === '--allow-material-errors') o.allowMat = true;
    else if (a === '--expect') o.expect.push(own[++i]); else if (a === '--heavy') o.heavy = true; else if (a === '--lock-wait') o.lockWait = +own[++i]; else if (a.startsWith('--')) throw new Error(`unknown option ${a}`); else o.pos.push(a);
  }
  // Git Bash turns /Game/X into C:/Program Files/Git/Game/X before node sees it (run with MSYS_NO_PATHCONV=1)
  const mangled = [...own, ...rest].find(a => /[\\/]Git[\\/](Game|Script|Engine)([\\/]|$)/i.test(a));
  if (mangled) throw new Error(`Git Bash rewrote a /Game path to "${mangled}": rerun with MSYS_NO_PATHCONV=1 (or from PowerShell)`);
  if (['uat', 'py', 'game', 'cmdlet', 'selftest'].includes(o.pos[0])) o.mode = o.pos.shift();
  if (o.mode === 'cmdlet') { [o.project, o.cmdlet] = o.pos; assert(o.project && o.cmdlet, 'usage: ue-run.mjs cmdlet <project.uproject> <Commandlet> [-- args]'); }
  if (o.mode === 'py') { [o.project, o.script] = o.pos; assert(o.project && o.script, 'usage: ue-run.mjs py <project.uproject> <script.py> [--editor] [-- args]'); }
  if (o.mode === 'game') { [o.project, o.map] = o.pos; assert(o.project, 'usage: ue-run.mjs game <project.uproject> [map] [--expect regex]'); if (!o.expect.length) o.expect.push(LOADED); }
  if (o.mode === 'uat') { assert(rest.length, 'usage: ue-run.mjs uat -- <RunUAT args>'); o.project = (rest.find(a => /^-project=/i.test(a)) ?? '').replace(/^-project=/i, '').replace(/"/g, '') || undefined; o.heavy = true; }
  o.timeout ??= o.mode === 'uat' ? 7200 : o.mode === 'game' ? 600 : 1800;
  assert(o.timeout > 0, '--timeout must be > 0');
  return o;
}

export function commandFor(o) {
  const bin = p => path.join(UE_ROOT, p);
  // cmd /c with two quoted paths strips the outer quotes ("'C:\Program' is not recognized"): one verbatim /s /c "..." line instead
  const q = s => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
  if (o.mode === 'uat') return { exe: 'cmd.exe', verbatim: true, args: ['/s', '/c', `"${[bin('Engine/Build/BatchFiles/RunUAT.bat'), ...o.rest].map(q).join(' ')}"`] };
  // the engine's own DDC/Zen override switch keeps the derived data cache inside the project, not in %LOCALAPPDATA%
  const ddc = `-LocalDataCachePath=${path.join(path.dirname(path.resolve(o.project)), 'DerivedDataCache')}`;
  const common = [...o.ueArgs, '-unattended', '-nosplash', '-nop4', '-nosourcecontrol', '-stdout', '-FullStdOutLogOutput', '-NoLogTimes', ddc];
  if (o.mode === 'cmdlet') return { exe: bin('Engine/Binaries/Win64/UnrealEditor-Cmd.exe'), args: [path.resolve(o.project), `-run=${o.cmdlet}`, ...o.rest, ...common] };
  if (o.mode === 'game') return { exe: bin('Engine/Binaries/Win64/UnrealEditor.exe'), args: [path.resolve(o.project), ...(o.map ? [o.map] : []), '-game', '-nullrhi', '-nosound', ...common] };
  // forward slashes: with args, -ExecutePythonScript treats backslashes as escapes ("Scripts\ue\x.py" loaded "Scripts/x.py")
  const scriptLine = [path.resolve(o.script).replace(/\\/g, '/'), ...o.rest].map(s => (/\s/.test(s) ? `'${s}'` : s)).join(' ');
  return o.editor
    ? { exe: bin('Engine/Binaries/Win64/UnrealEditor.exe'), args: [path.resolve(o.project), `-ExecutePythonScript=${scriptLine}`, '-RenderOffscreen', '-NoLoadingScreen', ...common] }
    : { exe: bin('Engine/Binaries/Win64/UnrealEditor-Cmd.exe'), args: [path.resolve(o.project), '-run=pythonscript', `-script=${scriptLine}`, ...common] };
}

// UBT's Android SDK check reads [/Script/AndroidPlatformEditor.AndroidSDKSettings] from engine/user config only (not the project), then env vars,
// then Android Studio's own JBR. So uat mode reads the paths from <project>/Config/DefaultEngine.ini and passes them as env to the child only.
export function androidEnvFromIni(text) {
  const sec = text.split(/^\[/m).find(s => s.startsWith('/Script/AndroidPlatformEditor.AndroidSDKSettings]')) ?? '';
  const get = k => (sec.match(new RegExp(`^${k}=\\(Path="([^"]+)"\\)`, 'm')) ?? [])[1];
  const env = {}, sdk = get('SDKPath'), ndk = get('NDKPath'), jdk = get('JavaPath');
  if (sdk) env.ANDROID_HOME = sdk;
  if (ndk) env.NDKROOT = env.NDK_ROOT = ndk;
  if (jdk) env.JAVA_HOME = jdk;
  return env;
}

function childEnv(o) {
  const proj = o.mode === 'uat' ? o.project ?? '' : '';
  const ini = proj && path.join(path.dirname(proj), 'Config/DefaultEngine.ini');
  // UAT logs, cook logs and compiled rules stay in the project: by default they go to %APPDATA% and to Engine\Programs\AutomationTool\Saved
  const saved = proj && path.join(path.dirname(proj), 'Saved/UAT');
  const logs = proj ? { uebp_LogFolder: path.join(saved, 'Logs'), uebp_EngineSavedFolder: saved } : {};
  return { ...process.env, ...logs, ...(ini && fs.existsSync(ini) ? androidEnvFromIni(fs.readFileSync(ini, 'utf8')) : {}) };
}

export async function waitForLock(dir, { every = 30000, log = console.log, maxWait = Infinity } = {}) {
  let waited = 0;
  while (dir && fs.existsSync(dir)) {
    if (waited >= maxWait * 1000) { log(`ue-run: ${dir} still held after ${maxWait} s; running at idle priority`); return -1; } if (waited === 0) log(`ue-run: ${dir} is held by another job; waiting (never taking it)`); await new Promise(r => setTimeout(r, every)); waited += every; }
  return waited;
}

// mkdir is atomic: true when this call created the lock. A note inside says who holds it (for a human clearing a stale lock).
export function tryLock(dir, note = '') {
  try { fs.mkdirSync(dir); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  fs.writeFileSync(path.join(dir, 'owner.txt'), `pid ${process.pid} since ${new Date().toISOString()}\n${note}\n`); return true;
}
export async function acquireLocks(dirs, { wait = 3600, every = 10000, note = '', log = console.log } = {}) {
  const held = [], t0 = Date.now();
  const release = () => { for (const d of held.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } };
  for (const d of dirs) {
    while (!tryLock(d, note)) {
      if (Date.now() - t0 >= wait * 1000) { release(); throw new Error(`ue-run: lock ${d} still held after ${wait} s (see ${d}/owner.txt; remove it by hand only if that process is gone)`); }
      if (Date.now() - t0 < every) log(`ue-run: waiting for lock ${d}`); await new Promise(r => setTimeout(r, every));
    }
    held.push(d);
  }
  return release;
}
export const locksFor = o => [...(o.project ? [path.join(path.dirname(path.resolve(o.project)), '.ue-lock')] : []), ...(o.heavy ? [HEAVY_LOCK] : [])];

// game mode: each --expect regex counts once it has matched, however much log follows (a short window spans chunk boundaries)
export function markerWatch(regexes) {
  const hit = new Set(); let win = '';
  return {
    feed(s) { win = win.slice(-4000) + s; regexes.forEach((r, i) => { if (!hit.has(i) && r.test(win)) hit.add(i); }); return hit.size === regexes.length; },
    missing: () => regexes.filter((_, i) => !hit.has(i)),
  };
}

export const pythonFailed = text => /Traceback \(most recent call last\)|LogPython: Error|Error: Python/.test(text);

// Resolves { code, log, ms }; rejects on timeout, non-zero exit or a Python error in the output.
export async function runUnreal(o) {
  if ((await waitForLock(o.lock, { maxWait: o.maxWait ?? Infinity })) < 0) o.low = true;
  const { exe, args, verbatim } = commandFor(o);
  if (!fs.existsSync(exe) && o.mode !== 'uat') throw new Error(`no Unreal at ${exe} (set UE_ROOT)`);
  const release = await acquireLocks(locksFor(o), { wait: o.lockWait ?? 3600, note: `ue-run ${o.mode} ${o.script ?? o.map ?? ''}` });
  const onSig = () => { release(); process.exit(130); };
  process.once('exit', release); process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  try { return await spawnUnreal(o, exe, args, verbatim); } finally { release(); process.off('SIGINT', onSig); process.off('SIGTERM', onSig); }
}

function spawnUnreal(o, exe, args, verbatim) {
  const log = o.log ?? path.join(os.tmpdir(), `ue-run-${o.mode}-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  return new Promise((res, rej) => {
    const env = childEnv(o);
    if (o.mode === 'uat') console.log(`ue-run: JAVA_HOME=${env.JAVA_HOME} ANDROID_HOME=${env.ANDROID_HOME} NDKROOT=${env.NDKROOT} (child process only)`);
    const t0 = Date.now(), out = fs.createWriteStream(log), p = spawn(exe, args, { windowsHide: true, env, windowsVerbatimArguments: !!verbatim });
    if (o.low) { try { os.setPriority(p.pid, os.constants.priority.PRIORITY_LOW); console.log('ue-run: idle CPU priority'); } catch (e) { console.log('ue-run: could not lower priority: ' + e.message); } }
    let tail = '', bad = false, done = false; const matFails = [];
    const watch = markerWatch(o.mode === 'game' ? o.expect.map(r => new RegExp(r)) : []);
    const take = d => { out.write(d); const s = d.toString(); if (pythonFailed(s)) bad = true;
      // a material that fails to compile renders as the grey WorldGrid checker and is only noticed in review (lessons 2026-11-17/19)
      for (const m of s.match(MATERIAL_FAIL_G) ?? []) if (matFails.length < 5) matFails.push(m.trim());
      // game mode: stop the game once every expected line has appeared (it would otherwise run forever)
      if (o.mode === 'game' && !done) { if (watch.feed(s)) { done = true; console.log('ue-run: every --expect matched; stopping the game'); p.kill(); } } process.stdout.write(s.split('\n').filter(l => /LogPython|Error|error:|BUILD|UAT|Took|ue-run|STEP/.test(l)).map(l => l + '\n').join('')); tail = (tail + s).slice(-6000); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const timer = setTimeout(() => { p.kill(); rej(new Error(`Unreal timed out after ${o.timeout} s (log ${log})`)); }, o.timeout * 1000);
    p.on('error', e => { clearTimeout(timer); rej(e); });
    p.on('close', code => {
      clearTimeout(timer); out.end(); const ms = Date.now() - t0;
      if (matFails.length && !o.allowMat) return rej(new Error(`material compile failed (it would render as the grey checker): ${matFails.join(' | ')}; log ${log}. Fix the material, or pass --allow-material-errors if this is expected`));
      if (o.mode === 'game') { const miss = watch.missing(); return miss.length ? rej(new Error(`game exited (code ${code}) before ${miss.join(', ')} appeared, log ${log}\n${tail.slice(-2500)}`)) : (console.log(`ue-run: game ok in ${(ms / 1000).toFixed(1)} s, log ${log}`), res({ code: 0, log, ms })); }
      // 5.8 --editor runs sometimes crash (0xC0000005) after the last shutdown line; the script's work is saved by then
      if (code !== 0 && !bad && o.editor && /LogExit: Exiting\.\s*$/.test(tail)) { console.log(`ue-run: WARNING exit ${code} after "LogExit: Exiting." (shutdown crash); script output accepted, log ${log}`); return res({ code, log, ms }); }
      if (code !== 0 || bad) rej(new Error(`Unreal ${o.mode} failed (exit ${code}${bad ? ', python error' : ''}) after ${(ms / 1000).toFixed(0)} s, log ${log}\n${tail.slice(-2500)}`));
      else { console.log(`ue-run: ok in ${(ms / 1000).toFixed(1)} s, log ${log}`); res({ code, log, ms }); }
    });
  });
}

async function selftest() {
  let o = parseArgs(['py', 'P.uproject', 's.py', '--', 'a', 'b c']);
  assert.equal(o.mode, 'py'); assert.equal(o.timeout, 1800); assert.deepEqual(o.rest, ['a', 'b c']);
  let c = commandFor(o); assert.match(c.exe, /UnrealEditor-Cmd\.exe$/); assert.ok(c.args.some(a => a.startsWith('-script=') && a.endsWith("a 'b c'")));
  assert.ok(!c.args.find(a => a.startsWith('-script=')).includes('\\'), 'script path uses forward slashes');
  o = parseArgs(['py', 'P.uproject', 's.py', '--editor']); c = commandFor(o); assert.match(c.exe, /UnrealEditor\.exe$/); assert.ok(c.args.includes('-RenderOffscreen'));
  o = parseArgs(['uat', '--', 'BuildCookRun', '-platform=Android']); assert.equal(o.timeout, 7200); assert.match(commandFor(o).args[2], /^"\"C:.*RunUAT.bat\" BuildCookRun -platform=Android"$/);
  assert.throws(() => parseArgs(['py', 'only.uproject']));
  const env = androidEnvFromIni('[URL]\nX=1\n[/Script/AndroidPlatformEditor.AndroidSDKSettings]\nSDKPath=(Path="C:/S")\nNDKPath=(Path="C:/S/ndk/27")\nJavaPath=(Path="C:/J")\n[Other]\nJavaPath=(Path="no")\n');
  assert.deepEqual(env, { ANDROID_HOME: 'C:/S', NDKROOT: 'C:/S/ndk/27', NDK_ROOT: 'C:/S/ndk/27', JAVA_HOME: 'C:/J' });
  assert.ok(pythonFailed('LogPython: Error: boom')); assert.ok(!pythonFailed('LogPython: hello'));
  const lock = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-run-lock-')); setTimeout(() => fs.rmdirSync(lock), 120);
  const waited = await waitForLock(lock, { every: 50, log: () => {} }); assert.ok(waited >= 50 && !fs.existsSync(lock), 'waits for the lock to go and never recreates it');
  assert.equal(await waitForLock(lock, { every: 50 }), 0);
  const held = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-run-held-'));
  assert.equal(await waitForLock(held, { every: 20, maxWait: 0.05, log: () => {} }), -1, 'gives up after --max-wait');
  assert.ok(fs.existsSync(held), 'never removes a lock it did not take'); fs.rmdirSync(held);
  assert.equal(parseArgs(['py', 'P.uproject', 's.py', '--max-wait', '60', '--low-priority']).maxWait, 60);
  assert.ok(commandFor(parseArgs(['py', 'P.uproject', 's.py', '--editor', '--ue-arg', '-featureleveles31'])).args.includes('-featureleveles31'));
  c = commandFor(parseArgs(['cmdlet', 'C:/P/P.uproject', 'WorldPartitionConvertCommandlet', '--', '/Game/M', '-DisableStreaming']));
  assert.match(c.exe, /UnrealEditor-Cmd\.exe$/); assert.deepEqual(c.args.slice(1, 4), ['-run=WorldPartitionConvertCommandlet', '/Game/M', '-DisableStreaming']);
  o = parseArgs(['game', 'C:/P/P.uproject', '/Game/M']); c = commandFor(o);
  assert.deepEqual(o.expect, [LOADED]); assert.equal(o.timeout, 600); assert.ok(c.args.includes('/Game/M') && c.args.includes('-game') && c.args.includes('-nullrhi'));
  assert.deepEqual(locksFor(o), [path.join('C:/P', '.ue-lock')], 'game takes only the project lock');
  assert.deepEqual(locksFor(parseArgs(['uat', '--', 'BuildCookRun', '-project=C:/P/P.uproject'])), [path.join('C:/P', '.ue-lock'), HEAVY_LOCK], 'uat is heavy');
  assert.ok(locksFor(parseArgs(['py', 'C:/P/P.uproject', 's.py', '--heavy'])).includes(HEAVY_LOCK));
  const ld = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-run-locks-')), a = path.join(ld, 'a'), b = path.join(ld, 'b');
  const rel = await acquireLocks([a, b], { log: () => {} }); assert.ok(fs.existsSync(path.join(a, 'owner.txt')) && fs.existsSync(b));
  await assert.rejects(acquireLocks([b], { wait: 0.05, every: 20, log: () => {} }), /still held/, 'a held lock times out with its path');
  rel(); assert.ok(!fs.existsSync(a) && !fs.existsSync(b), 'release removes both');
  fs.mkdirSync(b); await assert.rejects(acquireLocks([a, b], { wait: 0.05, every: 20, log: () => {} }));
  assert.ok(!fs.existsSync(a) && fs.existsSync(b), 'a partial acquire gives back what it took and leaves the other holder alone'); fs.rmSync(ld, { recursive: true });
  const w = markerWatch([/MARK_A/, /MARK_B/]);
  assert.equal(w.feed('x MARK_'), false); assert.equal(w.feed('A y'), false, 'a marker split across chunks still counts');
  assert.equal(w.feed('z'.repeat(300000)), false); assert.deepEqual(w.missing(), [/MARK_B/]); assert.equal(w.feed('MARK_B'), true, 'an early marker stays counted after much log');
  assert.throws(() => parseArgs(['cmdlet', 'P.uproject', 'C', '--', 'C:/Program Files/Git/Game/Maps/M']), /MSYS_NO_PATHCONV/, 'a Git-Bash-mangled /Game path is refused');
  assert.equal(parseArgs(['py', 'P.uproject', 's.py', '--allow-material-errors']).allowMat, true);
  assert.deepEqual('a\nLogShaderCompilers: Error: Failed to compile Material for platform PCD3D_ES31, Default Material will be used\nb'.match(MATERIAL_FAIL_G), ['LogShaderCompilers: Error: Failed to compile Material for platform PCD3D_ES31, Default Material will be used']);
  console.log('ue-run selftest ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  (o.mode === 'selftest' ? selftest() : runUnreal(o)).catch(e => { console.error(e.message); process.exit(1); });
}
