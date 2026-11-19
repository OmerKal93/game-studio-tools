// Headless three.js look-test of a character GLB under the game's own noon and dusk lighting (the NOON/DUSK lighting rows are copied from the game; edit them to match yours).
// usage:
//   node render-people-ingame.mjs <model.glb> <outDir> [--clip Idle_A] [--t 0.4] [--views front,three,face] [--size 480x640] [--yaw 0]
//   node render-people-ingame.mjs selftest
// Writes <outDir>/<model>-<view>-<noon|dusk>.png. Lighting: directional sun (colour, intensity, elevation, azimuth of the game table) with a 2048 shadow map, a
// hemisphere light, a RoomEnvironment at the game's environment intensity (the game bakes a real probe; this is the nearest portable stand-in), ACES at the
// game's exposure, a flagstone-grey floor. No post stack, no baked lightmap, no SMAA: this is the game's lighting on the model, not the whole game frame.
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import { createServer } from 'node:http'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(HOME, 'package.json'));

export function parseArgs(argv) {
  const o = { clip: 'Idle_A', t: 0.4, views: ['front', 'three', 'face'], size: [480, 640], yaw: 0, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { assert(i + 1 < argv.length, `${a} needs a value`); return argv[++i]; };
    if (a === '--clip') o.clip = v(); else if (a === '--t') o.t = +v(); else if (a === '--views') o.views = v().split(',');
    else if (a === '--size') o.size = v().split('x').map(Number); else if (a === '--yaw') o.yaw = +v();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`); else o.pos.push(a);
  }
  [o.model, o.out] = o.pos; assert(o.model && o.out, 'usage: render-people-ingame.mjs <model.glb> <outDir> [options]');
  return o;
}
if (process.argv[2] === 'selftest') {
  const o = parseArgs(['a.glb', 'out', '--clip', 'Walking_A', '--t', '0.2', '--views', 'front,face', '--size', '100x200']);
  assert.deepEqual([o.model, o.out, o.clip, o.t, o.views, o.size], ['a.glb', 'out', 'Walking_A', 0.2, ['front', 'face'], [100, 200]]);
  assert.throws(() => parseArgs(['a.glb']), /usage/); assert.throws(() => parseArgs(['a', 'b', '--x']), /unknown/);
  console.log('selftest ok'); process.exit(0);
}
const o = parseArgs(process.argv.slice(2));
const { chromium } = require('playwright-core');
const THREE = path.dirname(path.dirname(require.resolve('three')));
const [W, H] = o.size;
// the game's rows (Atmosphere.tsx): el/az degrees, az from +z toward +x
const TOD = {
  noon: { el: 55, az: -45, sun: '#fff2df', sunI: 3.2, hSky: '#bfd4ea', hGnd: '#5d5243', hI: 1.05, envI: 0.6, exp: 0.8, sky: '#9dbbe0' },
  dusk: { el: 7, az: 200, sun: '#ffb27a', sunI: 1.2, hSky: '#a99cc0', hGnd: '#5a4636', hI: 0.42, envI: 0.3, exp: 1.3, sky: '#6e5d86' },
};
const page = `<!doctype html><html><body style="margin:0;background:#222"><canvas id=c></canvas>
<script type=importmap>{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type=module>
import * as T from 'three'; import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'; import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const TOD = ${JSON.stringify(TOD)}, W = ${W}, H = ${H};
const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('/model.glb');
const r = new T.WebGLRenderer({ canvas: c, antialias: true, preserveDrawingBuffer: true }); r.setPixelRatio(1); r.setSize(W, H, false);
r.outputColorSpace = T.SRGBColorSpace; r.toneMapping = T.ACESFilmicToneMapping; r.shadowMap.enabled = true; r.shadowMap.type = T.PCFSoftShadowMap;
const env = new T.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
const m = g.scene; m.rotation.y = ${o.yaw} * Math.PI / 180;
m.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; for (const x of [n.material].flat()) { if (x.alphaMap || (x.map && x.transparent)) { x.alphaTest = 0.4; x.transparent = false; x.depthWrite = true; x.side = T.DoubleSide; } x.envMapIntensity = 1; } } });
const clip = g.animations.find(a => a.name === ${JSON.stringify(o.clip)});
if (clip) { const mx = new T.AnimationMixer(m); mx.clipAction(clip).play(); mx.setTime(${o.t}); }
m.updateMatrixWorld(true);
const box = new T.Box3().setFromObject(m, true), h = box.max.y - box.min.y, cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
const head = new T.Vector3(cx, box.min.y + h * 0.935, cz);
window.render = (tod, view) => {
  const P = TOD[tod], scene = new T.Scene(); scene.background = new T.Color(P.sky); scene.add(m);
  scene.environment = env; scene.environmentIntensity = P.envI; r.toneMappingExposure = P.exp;
  const e = P.el * Math.PI / 180, a = P.az * Math.PI / 180, dir = new T.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
  const sun = new T.DirectionalLight(P.sun, P.sunI); sun.position.copy(dir).multiplyScalar(12); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 30 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; scene.add(sun);
  scene.add(new T.HemisphereLight(P.hSky, P.hGnd, P.hI));
  const fl = new T.Mesh(new T.PlaneGeometry(30, 30), new T.MeshStandardMaterial({ color: '#7a7468', roughness: 0.92 })); fl.rotation.x = -Math.PI / 2; fl.receiveShadow = true; scene.add(fl);
  const cam = new T.PerspectiveCamera(view === 'face' ? 18 : 30, W / H, 0.05, 80);
  const yaw = view === 'three' ? 35 : view === 'face3' ? 30 : 0, ya = yaw * Math.PI / 180;
  if (view.startsWith('face')) { const d = 1.5; cam.position.set(head.x + Math.sin(ya) * d, head.y + 0.03, head.z + Math.cos(ya) * d); cam.lookAt(head.x, head.y - 0.01, head.z); }
  else { const d = h * 2.9; cam.position.set(cx + Math.sin(ya) * d, box.min.y + h * 0.55, cz + Math.cos(ya) * d); cam.lookAt(cx, box.min.y + h * 0.5, cz); }
  r.render(scene, cam); scene.remove(m); return 'ok';
};
window.ready = true;
</script></body></html>`;
const server = createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  const f = u === '/model.glb' ? o.model : u.startsWith('/three/') ? path.join(THREE, u.slice(7)) : undefined;
  if (!f || !fs.existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' }).end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
try {
  const pg = await browser.newPage(); pg.on('pageerror', e => console.error(e.message)); pg.on('console', m => m.type() === 'error' && console.error(m.text()));
  await pg.goto(`http://127.0.0.1:${server.address().port}/`); await pg.waitForFunction(() => window.ready, null, { timeout: 90000 });
  fs.mkdirSync(o.out, { recursive: true });
  for (const tod of ['noon', 'dusk']) for (const view of o.views) {
    await pg.evaluate(([t, v]) => window.render(t, v), [tod, view]);
    const file = path.join(o.out, `${path.basename(o.model, '.glb')}-${view}-${tod}.png`);
    await (await pg.$('#c')).screenshot({ path: file }); console.log('wrote', file);
  }
} finally { await browser.close(); server.close(); }
