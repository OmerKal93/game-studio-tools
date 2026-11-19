// Run a command while holding a directory mutex (for example a `.e2e-lock` folder shared by test runs): mkdir is atomic, so only one holder at a time.
// Waits for the lock (polls every --every seconds, gives up after --wait seconds, exit 9), runs the command, and removes only a lock it
// took itself, also on failure, Ctrl+C or a kill of this process. Use it instead of a hand-written locked.sh: a shared scratch folder lets one
// process overwrite another's running bash script (bash reads scripts as it goes), and `mkdir && x; rmdir` chains release other jobs' locks.
// usage:
//   node locked-run.mjs <lockDir> [--every 30] [--wait 3600] -- <command> [args...]
//   node locked-run.mjs selftest
// The command runs without a shell (on Windows call scripts as `bash x.sh` or `node x.mjs`). Exit: its exit code; 9 when the lock never came free.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const dash = argv.indexOf('--'); assert(dash > 0 && dash < argv.length - 1, 'usage: locked-run.mjs <lockDir> [--every s] [--wait s] -- <command> [args...]');
  const o = { lock: argv[0], every: 30, wait: 3600, cmd: argv.slice(dash + 1) };
  for (let i = 1; i < dash; i++) { if (argv[i] === '--every') o.every = +argv[++i]; else if (argv[i] === '--wait') o.wait = +argv[++i]; else throw new Error('unknown option ' + argv[i]); }
  assert(o.every > 0 && o.wait >= 0, 'bad --every/--wait');
  return o;
}
export function tryLock(dir) { try { fs.mkdirSync(dir); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } }

export async function lockedRun(o, log = console.log) {
  const t0 = Date.now();
  while (!tryLock(o.lock)) {
    if ((Date.now() - t0) / 1000 >= o.wait) { log(`locked-run: ${o.lock} still held after ${o.wait} s, giving up`); return 9; }
    log(`locked-run: ${o.lock} busy, waiting ${o.every} s`); await new Promise(r => setTimeout(r, o.every * 1000));
  }
  let released = false; const release = () => { if (!released) { released = true; try { fs.rmdirSync(o.lock); } catch { /* already gone */ } } };
  const onSig = () => { release(); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig); process.once('exit', release);
  log(`locked-run: holding ${o.lock}: ${o.cmd.join(' ')}`);
  try {
    return await new Promise(res => { const c = spawn(o.cmd[0], o.cmd.slice(1), { stdio: 'inherit' }); c.on('exit', code => res(code ?? 1)); c.on('error', () => res(127)); });
  } finally { release(); process.off('SIGINT', onSig); process.off('SIGTERM', onSig); }
}

if (process.argv[2] === 'selftest') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-run-')), lock = path.join(dir, '.lock'), me = fileURLToPath(import.meta.url), quiet = () => {};
  assert.deepEqual(parseArgs(['L', '--every', '2', '--', 'node', '-v']), { lock: 'L', every: 2, wait: 3600, cmd: ['node', '-v'] });
  assert.throws(() => parseArgs(['L', 'node']));
  // free lock: runs, passes the exit code through, releases
  assert.equal(await lockedRun({ lock, every: .05, wait: 1, cmd: [process.execPath, '-e', 'process.exit(3)'] }, quiet), 3);
  assert(!fs.existsSync(lock), 'released after the command');
  // held by someone else: waits, gives up with 9, and leaves THEIR lock alone
  fs.mkdirSync(lock);
  assert.equal(await lockedRun({ lock, every: .05, wait: .2, cmd: [process.execPath, '-e', ''] }, quiet), 9);
  assert(fs.existsSync(lock), 'never removes a lock it did not take');
  // freed while waiting: takes it then
  setTimeout(() => fs.rmdirSync(lock), 150);
  assert.equal(await lockedRun({ lock, every: .05, wait: 5, cmd: [process.execPath, '-e', 'require("fs").existsSync(process.argv[1])||process.exit(4)', lock] }, quiet), 0);
  assert(!fs.existsSync(lock));
  // as a CLI: the lock is gone after a failing command
  const r = spawnSync(process.execPath, [me, lock, '--every', '0.05', '--', process.execPath, '-e', 'process.exit(5)'], { encoding: 'utf8' });
  assert.equal(r.status, 5); assert(!fs.existsSync(lock));
  fs.rmSync(dir, { recursive: true }); console.log('selftest ok'); process.exit(0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await lockedRun(parseArgs(process.argv.slice(2))));
