// Unreal Android device loop over adb: install, command line, launch, wait for a log marker, pull logs/CSV, screenshots,
// and `ship`: build -> install -> launch -> "map loaded" in one command. Every device step skips cleanly when no phone is ready.
// usage:
//   node ue-device.mjs devices [--sdk dir]
//   node ue-device.mjs install <apk> [--serial s]
//   node ue-device.mjs cmdline <package> <ProjectName> "<engine args>"     (writes UECommandLine.txt on the device; Development only)
//   node ue-device.mjs launch <package> [--expect regex] [--timeout 120] [--out logcat.txt]
//   node ue-device.mjs pull <package> <ProjectName> <out-dir>              (Saved/Logs, Saved/Profiling, Saved/Screenshots)
//   node ue-device.mjs screencap <out.png>
//   node ue-device.mjs ship <project.uproject> [--map /Game/Map] [--config Development|Shipping] [--archive dir] [--skip-build] [--args "..."] [--max-wait s]
//   node ue-device.mjs selftest
// adb: --sdk, else the project's [/Script/AndroidPlatformEditor.AndroidSDKSettings] SDKPath (ship), else ANDROID_HOME, else %LOCALAPPDATA%\Android\Sdk.
// It never starts, kills or restarts the adb server beyond what adb itself does. Exit 3 = no ready device (unauthorized/offline count as none).
// ship with no device: builds the APK, skips install/launch, and proves "map loaded" in a desktop -game run instead (exit 0, says so).
// Device paths assume bUseExternalFilesDir=True: /sdcard/Android/data/<package>/files/UnrealGame/<Project>/ (LaunchAndroid.cpp; unverified on a phone).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { runUnreal, parseArgs as ueArgs, androidEnvFromIni, UE_ROOT, LOADED } from './ue-run.mjs';

export const NO_DEVICE = 3;

export function parseDevices(text) {
  return text.split(/\r?\n/).filter(l => l && !l.startsWith('List of devices') && !l.startsWith('*'))
    .map(l => { const [serial, state = ''] = l.trim().split(/\s+/); return { serial, state, ready: state === 'device' }; }).filter(d => d.serial);
}
export function pickDevice(devs, serial) {
  if (serial) { const d = devs.find(x => x.serial === serial); return d?.ready ? d : null; }
  const ready = devs.filter(d => d.ready);
  if (ready.length > 1) throw new Error(`several devices (${ready.map(d => d.serial).join(', ')}): pass --serial`);
  return ready[0] ?? null;
}
export const deviceDir = (pkg, project) => `/sdcard/Android/data/${pkg}/files/UnrealGame/${project}`;

export function adbPath(sdk) {
  const root = sdk ?? process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Android/Sdk');
  return path.join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
}

export function parseCli(argv) {
  const o = { pos: [], timeout: 120, config: 'Development' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--sdk') o.sdk = v(); else if (a === '--serial') o.serial = v(); else if (a === '--expect') o.expect = v();
    else if (a === '--timeout') o.timeout = +v(); else if (a === '--out') o.out = v(); else if (a === '--map') o.map = v();
    else if (a === '--config') o.config = v(); else if (a === '--archive') o.archive = v(); else if (a === '--args') o.args = v();
    else if (a === '--skip-build') o.skipBuild = true; else if (a === '--max-wait') o.maxWait = v(); else if (a.startsWith('--')) throw new Error('unknown option ' + a); else o.pos.push(a);
  }
  o.cmd = o.pos.shift();
  assert(['devices', 'install', 'cmdline', 'launch', 'pull', 'screencap', 'ship', 'selftest'].includes(o.cmd), 'usage: see the header of ue-device.mjs');
  assert(['Development', 'Shipping', 'DebugGame', 'Test'].includes(o.config), 'bad --config');
  return o;
}

function adb(o, args, { serial, check = true, encoding = 'utf8' } = {}) {
  const exe = adbPath(o.sdk);
  if (!fs.existsSync(exe)) throw new Error(`no adb at ${exe} (pass --sdk)`);
  const r = spawnSync(exe, [...(serial ? ['-s', serial] : []), ...args], { encoding, maxBuffer: 1 << 28, windowsHide: true });
  if (check && r.status !== 0) throw new Error(`adb ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').toString().trim()}`);
  return r;
}

function device(o) {
  const devs = parseDevices(adb(o, ['devices']).stdout), d = pickDevice(devs, o.serial);
  if (!d) console.log(`ue-device: no ready device (${devs.length ? devs.map(x => `${x.serial}=${x.state}`).join(', ') : 'none attached'}); skipping`);
  return d;
}

// waits for the app's logcat to show `expect`; saves the whole logcat to `out`
function launchAndWait(o, d, pkg) {
  adb(o, ['logcat', '-c'], { serial: d.serial });
  adb(o, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { serial: d.serial });
  const re = new RegExp(o.expect ?? LOADED), t0 = Date.now();
  return new Promise((res, rej) => {
    const p = spawn(adbPath(o.sdk), ['-s', d.serial, 'logcat', '-v', 'time'], { windowsHide: true });
    let buf = '', done = false; const out = o.out && fs.createWriteStream(o.out);
    const finish = (ok, msg) => { if (done) return; done = true; clearTimeout(timer); p.kill(); out?.end(); ok ? res(msg) : rej(new Error(msg)); };
    p.stdout.on('data', c => { out?.write(c); buf = (buf + c).slice(-100000); if (re.test(buf)) finish(true, `ue-device: "${re.source}" after ${((Date.now() - t0) / 1000).toFixed(1)} s`); });
    const timer = setTimeout(() => finish(false, `ue-device: "${re.source}" not in logcat after ${o.timeout} s${o.out ? ` (see ${o.out})` : ''}`), o.timeout * 1000);
  });
}

async function ship(o) {
  const uproject = path.resolve(o.pos[0] ?? ''); assert(uproject.endsWith('.uproject') && fs.existsSync(uproject), 'ship <project.uproject>');
  const dir = path.dirname(uproject), project = path.basename(uproject, '.uproject');
  const ini = fs.readFileSync(path.join(dir, 'Config/DefaultEngine.ini'), 'utf8');
  o.sdk ??= androidEnvFromIni(ini).ANDROID_HOME;
  const pkg = (ini.match(/^PackageName=(.+)$/m) ?? [])[1]?.trim(); assert(pkg, 'no PackageName in DefaultEngine.ini');
  const archive = path.resolve(o.archive ?? path.join(dir, 'Saved', o.config === 'Development' ? 'Archive' : `Archive${o.config}`));
  const wait = o.maxWait ? ['--max-wait', o.maxWait] : []; // passed on to ue-run: stop yielding to the other job after s seconds
  if (!o.skipBuild) {
    const ue = s => s.replace(/\\/g, '/');
    await runUnreal(ueArgs(['uat', ...wait, '--log', path.join(dir, 'Saved/Logs', `ship-${o.config}.log`), '--', 'BuildCookRun', `-project=${ue(uproject)}`, `-unrealexe=${ue(path.join(UE_ROOT, 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'))}`,
      '-platform=Android', '-cookflavor=ASTC', `-clientconfig=${o.config}`, '-build', '-cook', '-stage', '-pak', '-iostore', '-package', '-archive', `-archivedirectory=${ue(archive)}`,
      '-nop4', '-utf8output', '-unattended', '-nocompileeditor', ...(o.config === 'Shipping' ? ['-nodebuginfo'] : [])]));
  }
  const apkDir = path.join(archive, 'Android_ASTC'), apks = fs.existsSync(apkDir) ? fs.readdirSync(apkDir).filter(f => f.endsWith('.apk')) : [];
  assert(apks.length === 1, `expected one APK in ${apkDir}, found ${apks.length}`);
  const apk = path.join(apkDir, apks[0]); console.log(`ue-device: APK ${apk} (${fs.statSync(apk).size} bytes)`);
  const d = device(o);
  if (!d) {
    console.log('ue-device: no device, so install and launch are skipped; checking "map loaded" in a desktop -game run instead');
    await runUnreal(ueArgs(['game', uproject, ...(o.map ? [o.map] : []), ...wait, '--log', path.join(dir, 'Saved/Logs', 'ship-desktop-game.log')]));
    console.log('ue-device: ship done WITHOUT a device (desktop map-load verified; device install/launch not run)');
    return 0;
  }
  adb(o, ['install', '-r', apk], { serial: d.serial });
  if (o.config !== 'Shipping') { // Shipping ignores UECommandLine.txt
    const line = [o.map ?? '', o.args ?? ''].join(' ').trim(), dst = deviceDir(pkg, project);
    adb(o, ['shell', 'mkdir', '-p', dst], { serial: d.serial });
    adb(o, ['shell', `echo '${line.replace(/'/g, '')}' > ${dst}/UECommandLine.txt`], { serial: d.serial });
  }
  o.out ??= path.join(dir, 'Saved/Logs', 'ship-device-logcat.txt');
  console.log(await launchAndWait(o, d, pkg)); console.log('ue-device: ship done on device ' + d.serial); return 0;
}

async function main(o) {
  if (o.cmd === 'ship') return ship(o);
  if (o.cmd === 'devices') { const devs = parseDevices(adb(o, ['devices']).stdout); console.log(JSON.stringify(devs)); return devs.some(d => d.ready) ? 0 : NO_DEVICE; }
  const d = device(o); if (!d) return NO_DEVICE;
  const [a, b, c] = o.pos, s = { serial: d.serial };
  if (o.cmd === 'install') adb(o, ['install', '-r', a], s);
  else if (o.cmd === 'cmdline') { adb(o, ['shell', 'mkdir', '-p', deviceDir(a, b)], s); adb(o, ['shell', `echo '${(c ?? '').replace(/'/g, '')}' > ${deviceDir(a, b)}/UECommandLine.txt`], s); }
  else if (o.cmd === 'launch') console.log(await launchAndWait(o, d, a));
  else if (o.cmd === 'pull') { fs.mkdirSync(c, { recursive: true }); for (const sub of ['Saved/Logs', 'Saved/Profiling', 'Saved/Screenshots']) adb(o, ['pull', `${deviceDir(a, b)}/${b}/${sub}`, c] /* <base>/UnrealGame/<P>/<P>/Saved: unverified on a phone */, { ...s, check: false }); }
  else if (o.cmd === 'screencap') fs.writeFileSync(a, adb(o, ['exec-out', 'screencap', '-p'], { ...s, encoding: 'buffer' }).stdout);
  console.log(`ue-device: ${o.cmd} ok on ${d.serial}`); return 0;
}

function selftest() {
  const devs = parseDevices('List of devices attached\r\nAB12\tdevice\r\nCD34\tunauthorized\r\nEF56\toffline\r\n\r\n');
  assert.deepEqual(devs.map(d => [d.serial, d.ready]), [['AB12', true], ['CD34', false], ['EF56', false]]);
  assert.equal(pickDevice(devs).serial, 'AB12'); assert.equal(pickDevice(devs, 'CD34'), null, 'unauthorized counts as no device');
  assert.equal(pickDevice(parseDevices('List of devices attached\n\n')), null, 'none attached');
  assert.equal(pickDevice(parseDevices('* daemon started successfully\nList of devices attached\n')), null, 'daemon banner ignored');
  assert.throws(() => pickDevice(parseDevices('List of devices attached\nA\tdevice\nB\tdevice\n')), /--serial/);
  assert.equal(deviceDir('com.x.y', 'MyGame'), '/sdcard/Android/data/com.x.y/files/UnrealGame/MyGame');
  assert.match(adbPath('C:/S'), /platform-tools[\\/]adb/);
  const o = parseCli(['ship', 'P.uproject', '--map', '/Game/M', '--config', 'Shipping', '--skip-build']);
  assert.equal(o.cmd, 'ship'); assert.equal(o.map, '/Game/M'); assert.equal(o.config, 'Shipping'); assert.ok(o.skipBuild);
  assert.throws(() => parseCli(['ship', '--config', 'Fast']), /bad --config/); assert.throws(() => parseCli(['nope']));
  console.log('ue-device selftest ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseCli(process.argv.slice(2));
  if (o.cmd === 'selftest') selftest();
  else main(o).then(code => process.exit(code ?? 0), e => { console.error(e.message); process.exit(1); });
}
