// Contact sheet of a character's clips, rendered headless (Playwright Chromium, d3d11), for the animation/asset review.
// usage:
//   node render-sheet.mjs <model.glb> <outDir> [--clips Idle_A,Walking_A] [--frames 8] [--anims <clips.glb>] [--focus <bonePrefix>]
//                         [--ref <other.glb> [--ref-scale 0.9] [--ref-clip Idle_A]] [--tint <Material>=#rrggbb ...] [--size 220x300] [--yaw 180]
//   node render-sheet.mjs selftest
// One PNG per clip: row 1 three-quarter front (perspective), row 2 side (orthographic, floor grid at y=0, 0.1 m height ticks),
// plus row 3 a close-up of the first bone whose name starts with --focus. --ref draws a second model 0.9 m to the left in
// row 1 (scale comparison). --yaw turns the model (degrees; 180 shows its back, e.g. to review a garment). --tint sets a named material's colour factor (as a game palette would). Reads EXT_meshopt_compression (three's MeshoptDecoder) and WebP. --clips defaults to all clips.
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import { createServer } from 'node:http'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(HOME, 'package.json'));

export function parseArgs(argv) {
  const o = { frames: 8, yaw: 0, refScale: 1, refClip: 'Idle_A', size: [220, 300], tint: {}, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { assert(i + 1 < argv.length, `${a} needs a value`); return argv[++i]; };
    if (a === '--clips') o.clips = v().split(','); else if (a === '--frames') o.frames = Math.max(2, +v()); else if (a === '--anims') o.anims = v();
    else if (a === '--focus') o.focus = v(); else if (a === '--ref') o.ref = v(); else if (a === '--ref-scale') o.refScale = +v(); else if (a === '--ref-clip') o.refClip = v();
    else if (a === '--tint') { const [m, c] = v().split('='); assert(/^#[0-9a-f]{6}$/i.test(c), `--tint ${m}=#rrggbb`); o.tint[m] = c; }
    else if (a === '--yaw') o.yaw = +v(); else if (a === '--size') o.size = v().split('x').map(Number); else if (a.startsWith('--')) throw new Error(`unknown option ${a}`); else o.pos.push(a);
  }
  [o.model, o.out] = o.pos; assert(o.model && o.out, 'usage: render-sheet.mjs <model.glb> <outDir> [options]');
  return o;
}
if (process.argv[2] === 'selftest') {
  const o = parseArgs(['a.glb', 'out', '--clips', 'X,Y', '--frames', '1', '--ref', 'k.glb', '--ref-scale', '0.9', '--size', '100x200', '--tint', 'Cloth=#aabbcc', '--yaw', '180']);
  assert.deepEqual([o.model, o.out, o.clips, o.frames, o.ref, o.refScale, o.size, o.tint, o.yaw], ['a.glb', 'out', ['X', 'Y'], 2, 'k.glb', 0.9, [100, 200], { Cloth: '#aabbcc' }, 180]);
  assert.throws(() => parseArgs(['a.glb']), /usage/); assert.throws(() => parseArgs(['a', 'b', '--bogus']), /unknown/);
  console.log('selftest ok'); process.exit(0);
}
const o = parseArgs(process.argv.slice(2));
const { chromium } = require('playwright-core');
const THREE = path.dirname(path.dirname(require.resolve('three')));
const files = { '/model.glb': o.model, '/anims.glb': o.anims ?? o.model, '/ref.glb': o.ref };
const [W, H] = o.size;
const page = `<!doctype html><html><body style="margin:0;background:#222"><canvas id=c></canvas>
<script type=importmap>{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type=module>
import * as T from 'three'; import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'; import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const L = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), k = await L.loadAsync('/model.glb'), a = await L.loadAsync('/anims.glb');
const W = ${W}, H = ${H}, r = new T.WebGLRenderer({ canvas: c, antialias: true, preserveDrawingBuffer: true }); r.setPixelRatio(1);
r.outputColorSpace = T.SRGBColorSpace; r.toneMapping = T.ACESFilmicToneMapping;
k.scene.traverse(m => { if (m.isMesh) for (const x of [m.material].flat()) { const t = ${JSON.stringify(o.tint)}[x.name]; if (t) x.color.set(t); } });
k.scene.rotation.y = ${o.yaw} * Math.PI / 180;
const scene = new T.Scene(); scene.background = new T.Color('#c9c3b5'); scene.add(k.scene);
scene.add(new T.HemisphereLight('#fff', '#665', 2.2)); const sun = new T.DirectionalLight('#fff', 2.5); sun.position.set(2, 4, 3); scene.add(sun);
const floor = new T.Mesh(new T.PlaneGeometry(8, 8), new T.MeshStandardMaterial({ color: '#8a8070' })); floor.rotation.x = -Math.PI / 2; scene.add(floor);
const grid = new T.GridHelper(8, 16, '#333', '#555'); grid.position.y = 0.001; scene.add(grid);
for (let y = 0.1; y < 2.25; y += 0.1) { const t = new T.Mesh(new T.BoxGeometry(0.02, 0.004, Math.round(y * 10) % 5 ? 0.06 : 0.16), new T.MeshBasicMaterial({ color: '#000' })); t.position.set(0, y, -0.6); scene.add(t); } // side-view height ticks
let ref = null, refMixer = null;
${o.ref ? `{ const g = await L.loadAsync('/ref.glb'); ref = g.scene; ref.scale.setScalar(${o.refScale}); ref.position.x = -0.9; scene.add(ref); refMixer = new T.AnimationMixer(ref); const rc = g.animations.find(x => x.name === ${JSON.stringify(o.refClip)}); if (rc) refMixer.clipAction(rc).play(); refMixer.update(0); }` : ''}
const persp = new T.PerspectiveCamera(32, W / H, .1, 50), ortho = new T.OrthographicCamera(-1.3, 1.3, 2.3, -1.25, .1, 50), close = new T.PerspectiveCamera(30, W / H, .05, 20);
const mixer = new T.AnimationMixer(k.scene);
window.clips = a.animations.map(x => x.name);
window.render = (name, n, focus) => {
  const clip = a.animations.find(x => x.name === name); if (!clip) return 'missing ' + name;
  const rows = focus ? 3 : 2; r.setSize(W * n, H * rows, false); r.setScissorTest(true); mixer.stopAllAction(); const act = mixer.clipAction(clip); act.play();
  for (let i = 0; i < n; i++) {
    act.time = clip.duration * i / (n - 1); mixer.update(0); k.scene.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(k.scene, true), cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    if (ref) ref.visible = true;
    persp.position.set(cx + 2.6 - (ref ? .45 : 0), 1.6, cz + 4.6); persp.lookAt(cx - (ref ? .45 : 0), .85, cz);
    ortho.position.set(cx + 6, 1, cz); ortho.lookAt(cx, 1, cz); ortho.updateProjectionMatrix();
    const views = [[rows - 1, persp, true], [rows - 2, ortho, false]];
    if (focus) { let b; k.scene.traverse(o => { if (!b && o.isBone && o.name.startsWith(focus)) b = o; }); const p = b.getWorldPosition(new T.Vector3());
      close.position.set(p.x + .35, p.y + .05, p.z + .75); close.lookAt(p); views.push([0, close, false]); }
    for (const [row, cam, showRef] of views) { if (ref) ref.visible = showRef; r.setViewport(i * W, row * H, W, H); r.setScissor(i * W, row * H, W, H); r.render(scene, cam); }
  }
  return 'ok ' + clip.duration.toFixed(2) + ' s, box ' + new T.Box3().setFromObject(k.scene, true).max.y.toFixed(3) + ' m';
};
window.ready = true;
</script></body></html>`;
const server = createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  const f = files[u] ?? (u.startsWith('/three/') ? path.join(THREE, u.slice(7)) : undefined);
  if (!f || !fs.existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' }).end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
try {
  const pg = await browser.newPage(); pg.on('pageerror', e => console.error(e.message)); pg.on('console', m => m.type() === 'error' && console.error(m.text()));
  await pg.goto(`http://127.0.0.1:${server.address().port}/`); await pg.waitForFunction(() => window.ready, null, { timeout: 60000 });
  fs.mkdirSync(o.out, { recursive: true });
  for (const name of o.clips ?? await pg.evaluate(() => window.clips)) {
    const r = await pg.evaluate(([n, f, fo]) => window.render(n, f, fo), [name, o.frames, o.focus]); console.log(name, r);
    const file = path.join(o.out, `${path.basename(o.model, '.glb')}-${name}${o.focus ? '-' + o.focus : ''}${o.yaw ? '-yaw' + o.yaw : ''}.png`);
    await (await pg.$('#c')).screenshot({ path: file }); console.log('wrote', file);
  }
} finally { await browser.close(); server.close(); }
