// Phone performance run for a WebView game APK over adb: rAF frame times + game metrics hook + dumpsys gfxinfo, optional Perfetto trace.
// usage:
//   node phone-perf.mjs --pkg <applicationId> --out <folder> [--seconds 30] [--mode android|cdp] [--url <page url with ?e2e=1>] [--perfetto] [--serial <id>] [--port 9222] [--adb <adb.exe>] [--dry-run]
//   node phone-perf.mjs selftest
// --dry-run prints the exact adb commands (and the Playwright calls) without touching a device. Needs the debug APK to call
// WebView.setWebContentsDebuggingEnabled(true) (the game's own change; Chrome says debugging is not tied to the debuggable flag), the phone awake with USB debugging on.
// mode android = Playwright _android (experimental; its own adb connection). mode cdp = adb forward to webview_devtools_remote_<pid> + chromium.connectOverCDP.
// If the page URL had ?e2e=1 the game exposes window.__gameTest; its metrics snapshot (fps, p95, drawCalls, triangles...) goes into PERF.json.
// gfxinfo times the app's HWUI frames, not the WebGL canvas, so trust the rAF numbers first. Writes PERF.json and PERF.md into --out (outside any repo).
// Never run against someone else's phone without their go-ahead: it installs nothing, but it reads app state and (with --perfetto) writes to /data/local/tmp and /data/misc/perfetto-traces.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const DEFAULT_ADB = process.env.ADB || 'adb'; // on PATH, or set ADB=<path to adb>
const TRACE_ON_DEVICE = '/data/misc/perfetto-traces/studio.perfetto-trace';

// Perfetto config (text proto): CPU scheduling and frequency, GPU frequency, frame timeline, gfx/view/webview atrace for the app. Tune once on the real phone.
export function perfettoConfig(pkg, seconds) {
  const ev = ['sched/sched_switch', 'sched/sched_process_exit', 'sched/sched_process_free', 'task/task_newtask', 'task/task_rename', 'power/cpu_frequency', 'power/cpu_idle', 'power/gpu_frequency', 'power/suspend_resume'];
  return `buffers: { size_kb: 65536 fill_policy: DISCARD }
buffers: { size_kb: 4096 fill_policy: DISCARD }
data_sources: { config { name: "linux.process_stats" target_buffer: 1 process_stats_config { scan_all_processes_on_start: true proc_stats_poll_ms: 1000 } } }
data_sources: { config { name: "linux.ftrace" ftrace_config {
${ev.map(e => `  ftrace_events: "${e}"`).join('\n')}
${['gfx', 'view', 'webview', 'input', 'power', 'sm'].map(c => `  atrace_categories: "${c}"`).join('\n')}
  atrace_apps: "${pkg}"
} } }
data_sources: { config { name: "android.surfaceflinger.frametimeline" } }
duration_ms: ${Math.round(seconds * 1000)}
`;
}

// The ordered adb commands for a run. `pid` and `socket` are filled in once known (dry-run shows placeholders).
export function plan(o) {
  const adb = o.adb ?? DEFAULT_ADB, s = o.serial ? ['-s', o.serial] : [], port = o.port ?? 9222;
  const pid = o.pid ?? '<pid>', sock = o.socket ?? `webview_devtools_remote_${pid}`;
  const c = (...a) => [adb, ...s, ...a];
  const steps = [
    { name: 'server', cmd: c('start-server') },
    { name: 'devices', cmd: c('devices', '-l') },
    { name: 'model', cmd: c('shell', 'getprop', 'ro.product.model') },
    { name: 'pid', cmd: c('shell', 'pidof', o.pkg) },
    { name: 'sockets', cmd: c('shell', 'cat', '/proc/net/unix') },
  ];
  if (o.mode === 'cdp') steps.push({ name: 'forward', cmd: c('forward', `tcp:${port}`, `localabstract:${sock}`) });
  steps.push({ name: 'gfx-reset', cmd: c('shell', 'dumpsys', 'gfxinfo', o.pkg, 'reset') });
  if (o.perfetto) steps.push(
    { name: 'perfetto-run', cmd: c('shell', 'perfetto', '--txt', '-c', '-', '-o', TRACE_ON_DEVICE), stdinFile: 'perfetto-config.pbtxt', background: true, note: `config on stdin; runs ${o.seconds}s alongside the sampling` });
  steps.push(
    { name: 'sample', cmd: null, note: `Playwright ${o.mode === 'cdp' ? `chromium.connectOverCDP('http://127.0.0.1:${port}')` : `_android.devices()[0].webView({ pkg: '${o.pkg}' }).page()`}${o.url ? `, page.goto('${o.url}')` : ''}; requestAnimationFrame deltas for ${o.seconds}s; window.__gameTest.metrics snapshot` },
    { name: 'gfxinfo', cmd: c('shell', 'dumpsys', 'gfxinfo', o.pkg, 'framestats') },
    { name: 'battery', cmd: c('shell', 'dumpsys', 'battery') });
  if (o.perfetto) steps.push({ name: 'perfetto-pull', cmd: c('pull', TRACE_ON_DEVICE, path.join(o.out ?? '.', 'trace.perfetto-trace')), note: 'open it at https://ui.perfetto.dev' });
  if (o.mode === 'cdp') steps.push({ name: 'unforward', cmd: c('forward', '--remove', `tcp:${port}`) });
  return steps;
}

const quote = a => /[\s"]/.test(a) ? JSON.stringify(a) : a;
export const show = step => step.cmd ? `${step.cmd.map(quote).join(' ')}${step.stdinFile ? ` < ${step.stdinFile}` : ''}` : `(node) ${step.note}`;

// ---- parsers / maths (pure) ----
export function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))] : NaN; }
export function frameStats(deltasMs) {
  const d = deltasMs.slice(1).filter(x => x > 0).sort((a, b) => a - b); // first delta spans startup
  const sum = d.reduce((a, b) => a + b, 0);
  return { frames: d.length, fps: +(1000 * d.length / sum).toFixed(1), p50: +pct(d, 50).toFixed(2), p95: +pct(d, 95).toFixed(2), p99: +pct(d, 99).toFixed(2), maxMs: +d.at(-1).toFixed(1), over33ms: d.filter(x => x > 33.4).length };
}
export function parseSocket(unixText, pid) { // /proc/net/unix lines end with @webview_devtools_remote_<pid>
  const names = [...unixText.matchAll(/@(webview_devtools_remote_\d+)/g)].map(m => m[1]);
  return names.find(n => n.endsWith(`_${pid}`)) ?? null;
}
export function parseGfxinfo(t) {
  const num = re => { const m = t.match(re); return m ? +m[1] : null; };
  return { total: num(/Total frames rendered: (\d+)/), janky: num(/Janky frames: (\d+)/), p50: num(/50th percentile: (\d+)ms/), p90: num(/90th percentile: (\d+)ms/), p95: num(/95th percentile: (\d+)ms/), p99: num(/99th percentile: (\d+)ms/) };
}
export const parseBattery = t => { const m = t.match(/temperature: (\d+)/); return m ? +m[1] / 10 : null; };

function adbRun(step, input) { const [exe, ...a] = step.cmd; const r = spawnSync(exe, a, { encoding: 'utf8', input, timeout: 120000 }); if (r.status !== 0) throw new Error(`${show(step)} failed: ${(r.stderr || r.error || '').toString().trim()}`); return r.stdout; }

async function execute(o) {
  fs.mkdirSync(o.out, { recursive: true });
  const cfgPath = path.join(o.out, 'perfetto-config.pbtxt'); if (o.perfetto) fs.writeFileSync(cfgPath, perfettoConfig(o.pkg, o.seconds));
  const run = name => adbRun(plan({ ...o, pid: o.pid, socket: o.socket }).find(s => s.name === name));
  run('server'); const devices = run('devices'); if (!/\tdevice\b/.test(devices)) throw new Error(`no authorised device from adb:\n${devices}`);
  const model = run('model').trim();
  o.pid = run('pid').trim().split(/\s+/)[0]; if (!o.pid) throw new Error(`${o.pkg} is not running: start the debug APK first`);
  o.socket = parseSocket(run('sockets'), o.pid);
  if (!o.socket) throw new Error(`no webview_devtools_remote_${o.pid} socket: the debug build must call WebView.setWebContentsDebuggingEnabled(true)`);
  const steps = plan(o); const get = n => steps.find(s => s.name === n);
  if (o.mode === 'cdp') adbRun(get('forward'));
  adbRun(get('gfx-reset'));
  let perfetto = null;
  if (o.perfetto) { const { spawn } = await import('node:child_process'); const [exe, ...a] = get('perfetto-run').cmd; perfetto = new Promise(res => { const p = spawn(exe, a, { stdio: ['pipe', 'ignore', 'pipe'] }); p.stdin.end(fs.readFileSync(cfgPath)); p.on('close', res); }); }
  const pw = await import('playwright-core'); let deltas, hook = null, closer;
  try {
    let page;
    if (o.mode === 'cdp') { const b = await pw.chromium.connectOverCDP(`http://127.0.0.1:${o.port}`); closer = () => b.close(); page = b.contexts()[0].pages()[0]; }
    else { const [dev] = await pw._android.devices(); const wv = await dev.webView({ pkg: o.pkg }); closer = () => dev.close(); page = await wv.page(); }
    if (o.url) await page.goto(o.url);
    deltas = await page.evaluate(secs => new Promise(res => { const d = []; let last = performance.now(); const end = last + secs * 1000; const f = t => { d.push(t - last); last = t; t < end ? requestAnimationFrame(f) : res(d); }; requestAnimationFrame(f); }), o.seconds);
    hook = await page.evaluate(() => { const m = window.__gameTest?.metrics; return m ? Object.fromEntries(Object.entries(m).filter(([, v]) => ['number', 'string', 'boolean'].includes(typeof v))) : null; });
  } finally { await closer?.(); }
  const gfx = parseGfxinfo(adbRun(get('gfxinfo'))), tempC = parseBattery(adbRun(get('battery')));
  if (perfetto) { await perfetto; adbRun(get('perfetto-pull')); }
  if (o.mode === 'cdp') adbRun(get('unforward'));
  const result = { pkg: o.pkg, device: model, seconds: o.seconds, mode: o.mode, at: new Date().toISOString(), raf: frameStats(deltas), hook: hook ?? 'window.__gameTest missing (load the page with ?e2e=1)', gfxinfo: gfx, batteryTempC: tempC, trace: o.perfetto ? path.join(o.out, 'trace.perfetto-trace') : null };
  fs.writeFileSync(path.join(o.out, 'PERF.json'), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(o.out, 'PERF.md'), `# Phone perf: ${o.pkg} on ${model}\n\n${result.at}, ${o.seconds}s, mode ${o.mode}\n\n- rAF: ${result.raf.fps} fps, p50 ${result.raf.p50} ms, p95 ${result.raf.p95} ms, p99 ${result.raf.p99} ms, ${result.raf.over33ms} frames over 33 ms\n- gfxinfo (HWUI, not WebGL): ${gfx.total} frames, ${gfx.janky} janky, p95 ${gfx.p95} ms\n- battery temperature: ${tempC} C\n- game metrics: \`${JSON.stringify(result.hook)}\`\n${result.trace ? `- Perfetto: ${result.trace} (ui.perfetto.dev)\n` : ''}`);
  console.log(JSON.stringify(result, null, 1));
}

function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { if (!argv[i].startsWith('--')) { o._.push(argv[i]); continue; } const k = argv[i].slice(2); o[k] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } return o; }

function selftest() {
  const base = { pkg: 'com.example.game', seconds: 20, out: 'OUT', mode: 'cdp', port: 9222 };
  const cdp = plan({ ...base, perfetto: true, serial: 'ABC' }).map(show);
  assert.ok(cdp.some(l => l.endsWith('-s ABC forward tcp:9222 localabstract:webview_devtools_remote_<pid>')));
  assert.ok(cdp.some(l => l.includes('shell dumpsys gfxinfo com.example.game framestats')));
  assert.ok(cdp.some(l => l.includes('shell perfetto --txt -c - -o /data/misc/perfetto-traces/studio.perfetto-trace < perfetto-config.pbtxt')));
  assert.ok(cdp.some(l => l.includes('pull /data/misc/perfetto-traces/studio.perfetto-trace')));
  assert.ok(!plan({ ...base, mode: 'android' }).some(s => s.name === 'forward'), 'android mode needs no adb forward');
  assert.ok(!plan(base).some(s => s.name.startsWith('perfetto')), 'perfetto is opt-in');
  assert.match(perfettoConfig('com.example.game', 20), /duration_ms: 20000[\s\S]*$|atrace_apps: "com.example.game"/);
  assert.equal(parseSocket('0000: 2 @webview_devtools_remote_1234\n0000: 2 @webview_devtools_remote_999', 1234), 'webview_devtools_remote_1234');
  assert.equal(parseSocket('nothing', 1234), null);
  const fs60 = frameStats([100, ...Array(98).fill(16.7), 50]);
  assert.equal(fs60.frames, 99); assert.equal(fs60.over33ms, 1); assert.equal(fs60.p50, 16.7); assert.ok(fs60.fps > 55 && fs60.fps < 61);
  assert.deepEqual(parseGfxinfo('Total frames rendered: 120\nJanky frames: 6 (5.00%)\n50th percentile: 8ms\n90th percentile: 12ms\n95th percentile: 16ms\n99th percentile: 30ms'), { total: 120, janky: 6, p50: 8, p90: 12, p95: 16, p99: 30 });
  assert.equal(parseBattery('  temperature: 312\n'), 31.2);
  if (fs.existsSync(DEFAULT_ADB)) { const r = spawnSync(DEFAULT_ADB, ['version'], { encoding: 'utf8' }); assert.equal(r.status, 0, 'adb runs'); console.log('  ' + r.stdout.split('\n')[0]); }
  console.log('phone-perf selftest ok (offline: command plan, parsers, stats; no device was contacted)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2));
  (async () => {
    if (a._[0] === 'selftest') return selftest();
    if (!a.pkg) return console.log('usage: node phone-perf.mjs --pkg <applicationId> --out <folder> [--seconds 30] [--mode android|cdp] [--perfetto] [--dry-run] (see header)');
    const o = { pkg: a.pkg, out: path.resolve(a.out ?? path.join(os.tmpdir(), 'phone-perf')), seconds: +(a.seconds ?? 30), mode: a.mode ?? 'android', url: a.url, perfetto: !!a.perfetto, serial: a.serial, port: +(a.port ?? 9222), adb: a.adb ?? DEFAULT_ADB };
    if (!['android', 'cdp'].includes(o.mode)) throw new Error('--mode must be android or cdp');
    if (a['dry-run']) { for (const s of plan(o)) console.log(show(s)); if (o.perfetto) console.log(`\n# perfetto-config.pbtxt\n${perfettoConfig(o.pkg, o.seconds)}`); return; }
    await execute(o);
  })().catch(e => { console.error('error: ' + e.message); process.exit(1); });
}
