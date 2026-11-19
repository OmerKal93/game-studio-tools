// Packs a Mixamo character (FBX Binary, T-pose, with skin) and three of its own clips (FBX, without skin, "In Place") into one
// game GLB: clips renamed Idle_A / Walking_A / Running_A, scaled to a standing height, textures JPEG (base 768 q80, normals
// 512 q85), normals int8 / weights uint8 / joints uint8 / indices uint16 (KHR_mesh_quantization), rotations int16, credit in
// asset.extras.game. No retarget: Mixamo clips play on their own Mixamo rig. Then shrink it with
// tools/optimize-gltf.mjs --profile skinned (EXT_meshopt_compression, never KHR or Draco).
// Check the current Mixamo terms before embedding a baked character in a shipped game; the raw FBX must never be redistributed.
// usage: node prepare-mixamo-npc.mjs <char.fbx> <idle.fbx> <walk.fbx> <run.fbx> <out.glb> --height <m>
//          [--name <title>] [--tint-region <Material>=x0,y0,x1,y1 ...] [--ramp #c0,#c1,... [--keep x0,y0,x1,y1 ...]]
//          [--tabard #field,#trim,#emblem] [--cloth x0,y0,x1,y1,<Bone>,<offsetFracH>,<max>,<Material> ...] [--albedo-floor 0.035]
//        node prepare-mixamo-npc.mjs selftest
// Needs the repo-root node_modules (three, sharp): run `npm ci` first.
// --tint-region: triangles of a textured material whose UV centre falls in the rectangle (fractions of the base-colour image,
// origin top-left; repeat the flag for more rectangles) move to a new material <Material>, and those texels become neutral
// grey (mean 0.75), so the game can tint that material alone (Npcs.tsx) while the face and hands keep their colours.
// --ramp: recolour base-colour texels by luminance onto a colour ramp (darkest 2% -> first stop, brightest 2% -> last), which
// replaces every hue, so blue steel and red/neon accents become e.g. leather and iron. --keep rectangles (face, hair) are left as
// they are, except cool-hued texels in them (hue 170-270 deg, saturation > 0.2: stray armour pixels), which are remapped too.
// --tabard: adds a skinned cloth tabard (material "Tabard", double-sided, own 192x512 texture with trim, belt and a tower emblem)
// to the largest mesh, sized from the Mixamo bones and shaped on the bind-pose body (see tabard() below).
// About 1.4K triangles and 15 KB. Check it with tools/check-garment.mjs.
// _CLOTH: a custom uint8 vertex attribute, 0 = pinned to the skin, 1 = swings freely; the game's
// own cloth code moves vertices by cloth^2 x a per-character spring. The tabard gets it automatically (0 above its belt, 1 at
// the hem). --cloth picks loose cloth on the textured body mesh: vertices whose UV (fractions of the base-colour image, top-left
// origin, same as --keep) lie in the rectangle get weight max x (bone height + offset*H - y) / (that - lowest picked y), so the hem
// moves most. Repeat for more rectangles (hip flaps, cowl). Example (a character with no cloak mesh): hip flaps 0.61,0,1,0.34,Spine,0,1,Body_MAT
// and cowl 0,0.38,0.34,0.86,Neck,0,0.6,Body_MAT (hood above the neck stays 0).
// --albedo-floor F: lift base-colour texels so the 5th percentile of linear luminance is at least F (about 0.035-0.06: dyed wool and
// leather are never black): per channel lin' = lin x (1 - f) + f, f from the percentile. Hue and contrast order are kept.
import fs from 'node:fs'; import assert from 'node:assert/strict'; import { createRequire } from 'node:module';
import { Box3, BufferGeometry, Float32BufferAttribute, Matrix4, Texture, TextureLoader, Vector3 } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
const require = createRequire(import.meta.url);
const sharp = (() => { try { return require('sharp'); } catch { return require(require.resolve('sharp', { paths: [fs.realpathSync('node_modules/.pnpm/node_modules')] })); } })(); // pnpm game tree
globalThis.ProgressEvent ??= class {};
const _warn = console.warn; console.warn = m => { if (!/Z-UP|vertex has more than 4 skinning weights/.test(String(m))) _warn(m); };

// Four skin weights -> uint8 that sum to exactly 255 (the largest takes the rounding error).
const weights255 = w => { const s = w.reduce((x, y) => x + y, 0) || 1, r = w.map(x => Math.round(x / s * 255)); r[r.indexOf(Math.max(...r))] += 255 - r.reduce((x, y) => x + y, 0); return r; };
// Flip xyzw keys onto one hemisphere so linear interpolation never takes the long way round.
const continuous = f => { for (let k = 4; k < f.length; k += 4) if (f[k] * f[k - 4] + f[k + 1] * f[k - 3] + f[k + 2] * f[k - 2] + f[k + 3] * f[k - 1] < 0) for (let c = 0; c < 4; c++) f[k + c] = -f[k + c]; return f; };
const inRect = (regions, x, y) => regions.find(({ rect: [x0, y0, x1, y1] }) => x >= x0 && x < x1 && y >= y0 && y < y1);
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rampAt = (stops, t) => { const f = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), k = f - i; return [0, 1, 2].map(c => stops[i][c] + (stops[i + 1][c] - stops[i][c]) * k); };
const cool = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!mx || d / mx <= 0.2) return false;
  const h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60; return h >= 170 && h <= 270; };
// --tabard: Mixamo bone -> the bone a garment vertex may follow (arm chain -> its shoulder, lower leg -> its thigh, neck/head -> Spine2).
const foldBone = (pre, n) => { const p = n.slice(pre.length), s = /^(Left|Right)/.exec(p)?.[1] ?? '', r = p.slice(s.length);
  return pre + (/^(Arm|ForeArm|Hand)/.test(r) ? s + 'Shoulder' : /^(Leg|Foot|Toe)/.test(r) ? s + 'UpLeg' : /^(Neck|Head|Eye)/.test(r) ? 'Spine2' : p); };
// Keep the 4 largest of a {bone: weight} map, normalised.
const top4 = acc => { const e = Object.entries(acc).sort((a, b) => b[1] - a[1]).slice(0, 4), s = e.reduce((x, [, w]) => x + w, 0) || 1; return e.map(([k, w]) => [+k, w / s]); };
// Tabard cloth texture: field, side/hem/slit trim, belt with buckle, emblem. v runs neck (0) -> hem (1).
const tabardSvg = ([field, trim, emblem], vBelt, vSlit, W = 192, H = 512) => {
  const t = Math.round(W * .07), y = v => Math.round(v * H), tw = W * .4, tx = (W - tw) / 2, t0 = y(.13), t1 = Math.min(y(vBelt - .05), y(.44)), m = tw / 5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${field}"/>
<rect width="${t}" height="${H}" fill="${trim}"/><rect x="${W - t}" width="${t}" height="${H}" fill="${trim}"/><rect y="${H - t}" width="${W}" height="${t}" fill="${trim}"/>
<rect x="${W / 2 - t / 2}" y="${y(vSlit)}" width="${t}" height="${H}" fill="${trim}"/>
<rect x="${tx}" y="${t0 + m}" width="${tw}" height="${t1 - t0 - m}" fill="${emblem}"/>${[0, 2, 4].map(k => `<rect x="${tx + k * m}" y="${t0}" width="${m}" height="${m * 1.2}" fill="${emblem}"/>`).join('')}
<rect x="${W / 2 - m * .5}" y="${t1 - m * 2}" width="${m}" height="${m * 2}" fill="${field}"/><rect x="${W / 2 - m * .35}" y="${t0 + m * 2}" width="${m * .7}" height="${m * 1.1}" fill="${field}"/>
<rect y="${y(vBelt) - 9}" width="${W}" height="18" fill="#2a1d14"/><rect x="${W / 2 - 10}" y="${y(vBelt) - 11}" width="20" height="22" fill="none" stroke="#b8a77a" stroke-width="4"/></svg>`;
};
if (process.argv[2] === 'selftest') {
  for (const [a, b] of [['LeftForeArm', 'LeftShoulder'], ['RightHandIndex2', 'RightShoulder'], ['LeftLeg', 'LeftUpLeg'], ['RightToe_End', 'RightUpLeg'], ['LeftUpLeg', 'LeftUpLeg'], ['HeadTop_End', 'Spine2'], ['LeftEye', 'Spine2'], ['Spine1', 'Spine1'], ['Hips', 'Hips'], ['RightShoulder', 'RightShoulder']]) assert.equal(foldBone('mixamorig', 'mixamorig' + a), 'mixamorig' + b);
  assert.deepEqual(top4({ 1: 2, 2: 1, 3: 1, 4: 0.5, 5: 0.5 }).map(([k]) => k), [1, 2, 3, 4]); assert(Math.abs(top4({ 1: 2, 2: 2 }).reduce((s, [, w]) => s + w, 0) - 1) < 1e-9);
  assert.deepEqual(weights255([0.5, 0.5, 0, 0]), [127, 128, 0, 0]);
  for (const w of [[1, 0, 0, 0], [0.333, 0.333, 0.334, 0], [0.1, 0.2, 0.3, 0.4], [0, 0, 0, 0]]) assert.equal(weights255(w).reduce((a, b) => a + b), 255);
  const q = continuous(Float32Array.of(0, 0, 0, 1, 0, 0, 0, -1, 0, 0.1, 0, -0.99)); assert(q[3] > 0 && q[7] > 0 && q[11] > 0 && q[9] < 0, 'quaternion keys on one hemisphere');
  const R = [{ name: 'A', rect: [0, 0, 0.5, 0.5] }, { name: 'B', rect: [0.5, 0, 1, 1] }];
  assert.equal(inRect(R, 0.1, 0.1).name, 'A'); assert.equal(inRect(R, 0.5, 0.9).name, 'B'); assert.equal(inRect(R, 0.2, 0.7), undefined);
  const st = [hex('#000000'), hex('#808080'), hex('#ffffff')];
  assert.deepEqual(rampAt(st, 0), [0, 0, 0]); assert.deepEqual(rampAt(st, 0.5), [128, 128, 128]); assert.deepEqual(rampAt(st, 2), [255, 255, 255]); assert.deepEqual(rampAt(st, 0.25), [64, 64, 64]);
  assert(cool(30, 40, 90) && !cool(200, 40, 40) && !cool(120, 120, 125) && !cool(220, 170, 140), 'cool hue test');
  console.log('selftest ok'); process.exit(0);
}

const argv = process.argv.slice(2), pos = [], opt = { regions: [] };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--height') opt.height = +argv[++i];
  else if (argv[i] === '--name') opt.name = argv[++i];
  else if (argv[i] === '--ramp') { opt.ramp = argv[++i].split(',').map(h => { assert(/^#[0-9a-f]{6}$/i.test(h), `bad --ramp colour ${h}`); return hex(h); }); assert(opt.ramp.length >= 2, '--ramp needs 2+ colours'); }
  else if (argv[i] === '--tabard') { opt.tabard = argv[++i].split(','); assert(opt.tabard.length === 3 && opt.tabard.every(h => /^#[0-9a-f]{6}$/i.test(h)), '--tabard #field,#trim,#emblem'); }
  else if (argv[i] === '--albedo-floor') opt.floor = +argv[++i];
  else if (argv[i] === '--cloth') { const [x0, y0, x1, y1, bone, off, max, mat] = argv[++i].split(','), q = [x0, y0, x1, y1].map(Number); assert(q.every(Number.isFinite) && bone && Number.isFinite(+off) && +max > 0 && +max <= 1, `bad --cloth ${argv[i]}`); (opt.cloth ??= []).push({ rect: q, bone, off: +off, max: +max, mat }); }
  else if (argv[i] === '--keep') { const q = argv[++i].split(',').map(Number); assert(q.length === 4 && q.every(Number.isFinite), `bad --keep ${argv[i]}`); (opt.keep ??= []).push({ name: 'keep', rect: q }); }
  else if (argv[i] === '--tint-region') { const [n, r] = argv[++i].split('='), q = r.split(',').map(Number); assert(n && q.length === 4 && q.every(Number.isFinite), `bad --tint-region ${argv[i]}`); opt.regions.push({ name: n, rect: q }); }
  else pos.push(argv[i]);
}
const [CHAR, IDLE, WALK, RUN, OUT] = pos;
if (!OUT || !(opt.height > 0.5 && opt.height < 3)) throw new Error('usage: node prepare-mixamo-npc.mjs <char.fbx> <idle.fbx> <walk.fbx> <run.fbx> <out.glb> --height <m> [--name <title>] [--tint-region Mat=x0,y0,x1,y1]');
const CLIPS = { Idle_A: IDLE, Walking_A: WALK, Running_A: RUN };

// ---------- FBX in Node ----------
// Embedded textures: FBXLoader turns each into a blob: URL and hands it to TextureLoader (needs a DOM). Keep the blob instead.
const blobs = new Map(), createURL = URL.createObjectURL;
URL.createObjectURL = b => { const u = createURL(b); blobs.set(u, b); return u; };
TextureLoader.prototype.load = function (url) { const t = new Texture(); t.userData.url = url; return t; };
// shortcut: three 0.186 FBXLoader misreads some Mixamo footers; cut after the top-level node list + 161 zero bytes.
function topLevelEnd(b) { const w = b.readUInt32LE(23) >= 7500 ? 8 : 4, rd = o => w === 8 ? Number(b.readBigUInt64LE(o)) : b.readUInt32LE(o); let o = 27; for (;;) { const end = rd(o); if (end === 0) return o; o = end; } }
function loadFbx(file) { const raw = fs.readFileSync(file), end = topLevelEnd(raw); const buf = Buffer.concat([raw.subarray(0, end), Buffer.alloc(161)]); const g = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''); g.updateMatrixWorld(true); return g; }

const g = loadFbx(CHAR);
// FBXLoader gives every skinned mesh its own copy of a shared bone, nested under the first one with the same name and an
// identity local transform. Keep the outermost bone of each name as the single skeleton node.
const canon = new Map(); g.traverse(o => { if (o.isBone && !(o.parent?.isBone && o.parent.name === o.name)) { assert(!canon.has(o.name), `duplicate bone ${o.name}`); canon.set(o.name, o); } });
g.traverse(o => { if (o.isBone) assert(o.matrixWorld.equals(canon.get(o.name).matrixWorld) || o.matrixWorld.elements.every((x, k) => Math.abs(x - canon.get(o.name).matrixWorld.elements[k]) < 1e-3), `bone copy ${o.name} is not at its original`); });
const box = new Box3().setFromObject(g, true), SCALE = opt.height / (box.max.y - box.min.y);
const meshes = []; g.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
// shortcut: textures become JPEG (no alpha), so alpha-cut materials (eyelashes) are dropped; keep them if a game ever needs close-ups.
const dropped = meshes.filter(m => [m.material].flat().some(x => x.transparent || x.alphaMap)).map(m => m.name);
const body = meshes.filter(m => !dropped.includes(m.name));
assert(body.length, 'no opaque skinned mesh');

// ---------- glTF writer state ----------
const j = { asset: { version: '2.0', generator: 'tools/prepare-mixamo-npc.mjs' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [], meshes: [], skins: [], materials: [], textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], accessors: [], bufferViews: [], animations: [],
  extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'] };
const chunks = []; let offset = 0;
const push = buf => { const pad = (4 - buf.length % 4) % 4, at = offset; chunks.push(buf, Buffer.alloc(pad)); offset += buf.length + pad; return at; };
const addView = (data, target, byteStride) => { const v = { buffer: 0, byteOffset: push(data), byteLength: data.length }; if (target) v.target = target; if (byteStride) v.byteStride = byteStride; j.bufferViews.push(v); return j.bufferViews.length - 1; };
const addAccessor = (arr, componentType, type, count, { target, byteStride, ...extra } = {}) => {
  j.accessors.push({ bufferView: addView(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), target, byteStride), componentType, count, type, ...extra });
  return j.accessors.length - 1;
};
const ARRAY = 34962, ELEMENT = 34963;

// ---------- nodes: root (height scale) -> Mixamo bone tree, plus mesh nodes ----------
j.nodes.push({ name: opt.name ?? CHAR.replace(/^.*[\\/]|\.fbx$/gi, ''), scale: [SCALE, SCALE, SCALE], children: [] });
const nodeOf = new Map();
function addBone(b, parent) {
  const i = j.nodes.length; nodeOf.set(b.name, i);
  const n = { name: b.name, translation: b.position.toArray(), rotation: b.quaternion.toArray() };
  if (b.scale.x !== 1 || b.scale.y !== 1 || b.scale.z !== 1) n.scale = b.scale.toArray();
  j.nodes.push(n); (j.nodes[parent].children ??= []).push(i);
  for (const c of b.children) if (c.isBone && c.name !== b.name) addBone(c, i);
}
for (const b of canon.values()) if (!canon.has(b.parent?.name) || !b.parent?.isBone) addBone(b, 0);
assert.equal(nodeOf.size, canon.size, 'every bone placed');

// ---------- textures ----------
const imageIndex = new Map(), regionColor = new Map();
async function image(tex, normal, regions) {
  const key = tex.userData.url + (normal ? ':n' : ':c');
  if (imageIndex.has(key)) return imageIndex.get(key);
  const src = Buffer.from(await blobs.get(tex.userData.url).arrayBuffer());
  let img = sharp(src).removeAlpha();
  if (regions.length) { // grey the tint rectangles (mean 0.75) so a material colour alone sets their hue
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true }), W = info.width, H = info.height, C = info.channels;
    const inside = (x, y) => inRect(regions, x / W, y / H);
    let sum = 0, n = 0; const lum = new Float32Array(W * H), rgb = {};
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const r = inside(x, y); if (!r) continue; const k = (y * W + x) * C, s = (rgb[r.name] ??= [0, 0, 0, 0]);
      lum[y * W + x] = .2126 * data[k] + .7152 * data[k + 1] + .0722 * data[k + 2]; sum += lum[y * W + x]; n++; for (let c = 0; c < 3; c++) s[c] += data[k + c]; s[3]++; }
    const gain = 0.75 * 255 / (sum / n), lin = v => Math.pow(v, 2.2);
    // Each tint material's own colour factor is its rectangles' mean colour (so it renders close to the source untinted, and
    // optimize-gltf's dedup cannot merge it back into the source material). The game replaces it with its palette colour.
    for (const [name, s] of Object.entries(rgb)) regionColor.set(name, [0, 1, 2].map(c => +Math.min(1, lin(s[c] / s[3] / 255) / lin(0.75)).toFixed(3)).concat(1));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) { const k = (y * W + x) * C, v = Math.min(255, lum[y * W + x] * gain); data[k] = data[k + 1] = data[k + 2] = v; }
    img = sharp(data, { raw: info });
  }
  if (!normal && opt.ramp) { // luminance -> colour ramp outside --keep (see header)
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true }), W = info.width, H = info.height, C = info.channels, keep = opt.keep ?? [];
    const idx = [], lum = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * C; if (inRect(keep, x / W, y / H) && !cool(data[k], data[k + 1], data[k + 2])) continue; idx.push(k); lum.push(.2126 * data[k] + .7152 * data[k + 1] + .0722 * data[k + 2]); }
    const sorted = Float32Array.from(lum).sort(), lo = sorted[Math.floor(sorted.length * .02)], hi = sorted[Math.floor(sorted.length * .98)];
    idx.forEach((k, i) => { const c = rampAt(opt.ramp, (lum[i] - lo) / (hi - lo || 1)); data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; });
    img = sharp(data, { raw: info });
  }
  if (!normal && opt.floor) { // --albedo-floor: affine lift in linear light so p5 reaches the floor
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true }), C = info.channels, n = info.width * info.height, toLin = v => Math.pow(v / 255, 2.2), L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = .2126 * toLin(data[i * C]) + .7152 * toLin(data[i * C + 1]) + .0722 * toLin(data[i * C + 2]);
    const p5 = Float32Array.from(L).sort()[Math.floor(n * .05)], f = Math.max(0, (opt.floor - p5) / (1 - p5));
    if (f > 0) for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[i * C + c] = Math.round(255 * Math.pow(Math.min(1, toLin(data[i * C + c]) * (1 - f) + f), 1 / 2.2));
    console.error(`albedo floor ${opt.floor}: p5 ${p5.toFixed(4)} -> lift ${f.toFixed(4)}`);
    img = sharp(data, { raw: info });
  }
  const size = normal ? 512 : 768;
  const out = await img.resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: normal ? 85 : 80, mozjpeg: true }).toBuffer();
  j.images.push({ bufferView: addView(out), mimeType: 'image/jpeg' }); j.textures.push({ sampler: 0, source: j.images.length - 1 });
  imageIndex.set(key, j.textures.length - 1); return j.textures.length - 1;
}
const materialIndex = new Map();
async function material(m, name = m.name, regions = []) {
  if (materialIndex.has(name)) return materialIndex.get(name);
  // Phong -> metal/rough: Mixamo's diffuse colour factor (0.8 in FBX) is dropped, the texture carries the albedo.
  // shortcut: one roughness for all (specular maps not converted); bake a roughness map if close-ups need it.
  const mat = { name, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: m.shininess > 30 ? 0.35 : 0.8 } };
  if (m.map) mat.pbrMetallicRoughness.baseColorTexture = { index: await image(m.map, false, regions) };
  if (regionColor.has(name)) mat.pbrMetallicRoughness.baseColorFactor = regionColor.get(name);
  if (m.normalMap) mat.normalTexture = { index: await image(m.normalMap, true, []) };
  j.materials.push(mat); materialIndex.set(name, j.materials.length - 1); return j.materials.length - 1;
}

// ---------- --tabard: a skinned cloth layer over the torso (Mixamo rig; no simulation) ----------
// Front and back panels sit an offset outside the bind-pose body (window max of its depth, bridged over hollows, hanging no
// steeper than DRAPE), are joined over the shoulders, and are slit from the crotch down so each flap follows its own thigh.
// Weights come from the nearest body vertices (gaussian over K), with arm, head and lower-leg bones folded onto shoulder, Spine2
// and thigh, so the cloth moves with the torso and thighs only. All lengths are fractions of the body height H.
async function tabard(mesh, geo) {
  const H = box.max.y - box.min.y, P = geo.attributes.position, J = geo.attributes.skinIndex, Wt = geo.attributes.skinWeight;
  const bones = mesh.skeleton.bones.map(b => b.name), PRE = [...canon.keys()][0].replace(/Hips$/, ''), idxOf = new Map(bones.map((n, k) => [n, k]));
  const B = n => { const b = canon.get(PRE + n); assert(b, `--tabard needs bone ${PRE + n}`); return b.getWorldPosition(new Vector3()).applyMatrix4(mesh.bindMatrixInverse); };
  // Body vertices the cloth may rest on / copy from: dominant bone not in an arm or the head.
  const body = [];
  for (let k = 0; k < P.count; k++) {
    let d = 0; for (let c = 1; c < 4; c++) if (Wt.getComponent(k, c) > Wt.getComponent(k, d)) d = c;
    const dom = bones[J.getComponent(k, d)].slice(PRE.length);
    if (/^(Left|Right)?(Arm|ForeArm|Hand|Head|Eye)/.test(dom)) continue;
    body.push({ x: P.getX(k), y: P.getY(k), z: P.getZ(k), k, leg: /^Left(UpLeg|Leg|Foot|Toe)/.test(dom) ? 1 : /^Right(UpLeg|Leg|Foot|Toe)/.test(dom) ? -1 : 0 });
  }
  const cell = .012 * H, grid = new Map(), key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const v of body) { const q = key(v.x, v.y); if (!grid.has(q)) grid.set(q, []); grid.get(q).push(v); }
  const depth = (sg, x, y, rx, ry) => { let best = -Infinity;
    for (let gx = Math.floor((x - rx) / cell); gx <= Math.floor((x + rx) / cell); gx++) for (let gy = Math.floor((y - ry) / cell); gy <= Math.floor((y + ry) / cell); gy++)
      for (const v of grid.get(`${gx},${gy}`) ?? []) if (Math.abs(v.x - x) <= rx && Math.abs(v.y - y) <= ry) best = Math.max(best, sg * v.z);
    return best; };
  const hips = B('Hips'), cx = hips.x, yTop = B('Neck').y - .012 * H, yHem = B('LeftLeg').y + .05 * H, yBelt = hips.y + .02 * H, ySlit = B('LeftUpLeg').y - .07 * H;
  const hwTop = .7 * Math.abs(B('LeftArm').x - cx), hwHem = 1.7 * Math.abs(B('LeftUpLeg').x - cx), neckHalf = .45 * hwTop;
  const R = 28, C = 6, OFF = .014 * H, DRAPE = .35, dy = (yTop - yHem) / R, rs = Math.round((yTop - ySlit) / dy);
  const hw = y => hwTop + (hwHem - hwTop) * Math.min(1, Math.max(0, (yTop - y) / (yTop - yHem)));
  const pos = [], uv = [], side = [], index = [], vOf = y => (yTop - y) / (yTop - yHem);
  const panels = [];
  for (const sg of [1, -1]) { // front (+z), back
    const X = [], Y = [], Z = [], T = [];
    for (let r = 0; r <= R; r++) { X.push([]); Y.push([]); Z.push([]); T.push([]);
      for (let c = 0; c <= 2 * C; c++) {
        const x = cx + (c - C) / C * hw(yTop - r * dy), u = (x - cx) / neckHalf, dip = Math.abs(u) < 1 ? (sg > 0 ? .035 : .015) * H * (1 - u * u) * Math.max(0, 1 - r / 3) : 0, y = yTop - r * dy - dip;
        // dilated depth (wide window), so plate edges and straps do not print through; T: tight depth for the clearance floor
        X[r].push(x); Y[r].push(y); Z[r].push(depth(sg, x, y, .02 * H, .025 * H) + OFF); T[r].push(depth(sg, x, y, .008 * H, .01 * H) + OFF / 2);
      }
      for (let c = 0; c <= 2 * C; c++) if (!Number.isFinite(Z[r][c])) { // no body under it (between the legs): nearest filled column
        for (let d = 1; d <= 2 * C && !Number.isFinite(Z[r][c]); d++) Z[r][c] = Math.max(Z[r][c - d] ?? -Infinity, Z[r][c + d] ?? -Infinity);
        if (!Number.isFinite(Z[r][c])) Z[r][c] = r ? Z[r - 1][c] : sg * hips.z + OFF;
      }
    }
    for (let pass = 0; pass < 3; pass++) { // blur rows and columns, then never closer than the clearance floor
      for (let r = 0; r <= R; r++) Z[r] = Z[r].map((z, c) => ((Z[r][c - 1] ?? z) + 2 * z + (Z[r][c + 1] ?? z)) / 4);
      const Zc = Z.map(row => row.slice()); for (let r = 0; r <= R; r++) for (let c = 0; c <= 2 * C; c++) Z[r][c] = ((Zc[r - 1]?.[c] ?? Zc[r][c]) + 2 * Zc[r][c] + (Zc[r + 1]?.[c] ?? Zc[r][c])) / 4;
    }
    for (let r = 0; r <= R; r++) Z[r] = Z[r].map((z, c) => Math.max(z, T[r][c], r ? Z[r - 1][c] - DRAPE * dy : -Infinity)); // clearance; hang, never cling
    // vertices: one per grid point; the centre column below the slit has a copy per flap
    const at = [];
    for (let r = 0; r <= R; r++) { at.push([]);
      for (let c = 0; c <= 2 * C; c++) {
        const add = s => { pos.push(X[r][c], Y[r][c], sg * Z[r][c]); uv.push(c / (2 * C), vOf(Y[r][c])); side.push(s); return pos.length / 3 - 1; };
        at[r].push(c === C && r >= rs ? [add(-1), add(1)] : add(Math.sign(c - C)));
      }
    }
    const V = (r, c, q) => Array.isArray(at[r][c]) ? at[r][c][q < C ? 0 : 1] : at[r][c];
    for (let r = 0; r < R; r++) for (let c = 0; c < 2 * C; c++) {
      const a = V(r, c, c), b = V(r, c + 1, c), d = V(r + 1, c, c), e = V(r + 1, c + 1, c);
      index.push(...(sg > 0 ? [a, d, e, a, e, b] : [a, e, d, a, b, e]));
    }
    panels.push({ X, Y, Z, at });
  }
  // shoulder straps: front top row -> back top row over the shoulder, outside the neck opening
  const [F, Bk] = panels, NB = 4, strap = [];
  for (let c = 0; c <= 2 * C; c++) {
    if (Math.abs(F.X[0][c] - cx) < neckHalf) { strap.push(null); continue; }
    const x = F.X[0][c], zF = F.Z[0][c], zB = -Bk.Z[0][c], col = [F.at[0][c]];
    for (let t = 1; t < NB; t++) {
      const z = zF + (zB - zF) * t / NB; let top = -Infinity;
      for (const v of body) if (Math.abs(v.x - x) < .012 * H && Math.abs(v.z - z) < .015 * H && v.y < yTop + .1 * H) top = Math.max(top, v.y);
      pos.push(x, Math.max(yTop, top + OFF), z); uv.push(c / (2 * C), 0); side.push(Math.sign(c - C)); col.push(pos.length / 3 - 1);
    }
    col.push(Bk.at[0][c]); strap.push(col);
  }
  for (let c = 0; c < 2 * C; c++) if (strap[c] && strap[c + 1]) for (let t = 0; t < NB; t++) {
    const a = strap[c][t], b = strap[c + 1][t], d = strap[c][t + 1], e = strap[c + 1][t + 1];
    index.push(a, b, e, a, e, d); // outward (up) normal; the material is double-sided anyway
  }
  // skin weights: gaussian over the K nearest body vertices, own leg only on a flap side, bones folded (foldBone)
  const n = pos.length / 3, K = 12, sig2 = 2 * (.025 * H) ** 2, joints = new Uint8Array(n * 4), weights = new Uint8Array(n * 4);
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2], near = [];
    for (const b of body) { if (b.leg && b.leg === -side[v]) continue; const d2 = (b.x - x) ** 2 + (b.y - y) ** 2 + (b.z - z) ** 2;
      if (near.length < K || d2 < near[K - 1][0]) { near.push([d2, b.k]); near.sort((p, q) => p[0] - q[0]); if (near.length > K) near.pop(); } }
    const acc = {};
    for (const [d2, k] of near) { const g = Math.exp(-(d2 - near[0][0]) / sig2);
      for (let c = 0; c < 4; c++) { const w = Wt.getComponent(k, c); if (w > 0) { const bi = idxOf.get(foldBone(PRE, bones[J.getComponent(k, c)])); acc[bi] = (acc[bi] ?? 0) + g * w; } } }
    const t4 = top4(acc), w8 = weights255([0, 1, 2, 3].map(c => t4[c]?.[1] ?? 0));
    for (let c = 0; c < 4; c++) { joints[v * 4 + c] = t4[c]?.[0] ?? 0; weights[v * 4 + c] = w8[c]; }
  }
  const vB = vOf(yBelt), vS = vOf(ySlit) + .5 / R;
  const g2 = new BufferGeometry(); g2.setAttribute('position', new Float32BufferAttribute(pos, 3)); g2.setIndex(index); g2.computeVertexNormals();
  const N = g2.attributes.normal, q = new Int8Array(n * 4);
  for (let k = 0; k < n; k++) q.set([N.getX(k), N.getY(k), N.getZ(k)].map(x => Math.round(x * 127)), k * 4);
  const tex = await sharp(Buffer.from(tabardSvg(opt.tabard, vB, vS))).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  j.images.push({ bufferView: addView(tex), mimeType: 'image/jpeg' }); j.textures.push({ sampler: 0, source: j.images.length - 1 });
  j.materials.push({ name: 'Tabard', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: j.textures.length - 1 }, metallicFactor: 0, roughnessFactor: .95 } });
  const P32 = Float32Array.from(pos), ext = c => [Math.min, Math.max].map(f => f(...Array.from({ length: n }, (_, k) => P32[k * 3 + c])));
  const attributes = {
    POSITION: addAccessor(P32, 5126, 'VEC3', n, { target: ARRAY, min: [0, 1, 2].map(c => ext(c)[0]), max: [0, 1, 2].map(c => ext(c)[1]) }),
    NORMAL: addAccessor(q, 5120, 'VEC3', n, { target: ARRAY, byteStride: 4, normalized: true }),
    TEXCOORD_0: addAccessor(Float32Array.from(uv), 5126, 'VEC2', n, { target: ARRAY }),
    _CLOTH: addAccessor(Uint8Array.from({ length: n }, (_, k) => Math.round(255 * Math.min(1, Math.max(0, (uv[k * 2 + 1] - vB) / (1 - vB))))), 5121, 'SCALAR', n, { target: ARRAY, normalized: true }),
    JOINTS_0: addAccessor(joints, 5121, 'VEC4', n, { target: ARRAY }), WEIGHTS_0: addAccessor(weights, 5121, 'VEC4', n, { target: ARRAY, normalized: true }) };
  triangles += index.length / 3;
  return { attributes, indices: addAccessor(Uint16Array.from(index), 5123, 'SCALAR', index.length, { target: ELEMENT }), material: j.materials.length - 1 };
}

// ---------- meshes and skins ----------
const skinIndex = new Map(); let triangles = 0;
for (const mesh of body) {
  const m = mesh.material; assert(!Array.isArray(m) && !mesh.geometry.groups.length, `${mesh.name}: multi-material meshes are not handled`);
  const geo = mergeVertices(mesh.geometry.clone(), 1e-4); // FBXLoader output is unindexed
  const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv, J = geo.attributes.skinIndex, Wt = geo.attributes.skinWeight, I = geo.index.array, n = P.count;
  assert(n <= 65535, `${mesh.name}: ${n} vertices need uint32 indices`);
  const at = {};
  at.POSITION = addAccessor(Float32Array.from(P.array), 5126, 'VEC3', n, { target: ARRAY, min: [0, 1, 2].map(c => Math.min(...Array.from({ length: n }, (_, k) => P.array[k * 3 + c]))), max: [0, 1, 2].map(c => Math.max(...Array.from({ length: n }, (_, k) => P.array[k * 3 + c]))) });
  const q = new Int8Array(n * 4); // stride must be a multiple of 4
  for (let k = 0; k < n; k++) { const l = Math.hypot(N.getX(k), N.getY(k), N.getZ(k)) || 1; q.set([N.getX(k), N.getY(k), N.getZ(k)].map(x => Math.round(x / l * 127)), k * 4); }
  at.NORMAL = addAccessor(q, 5120, 'VEC3', n, { target: ARRAY, byteStride: 4, normalized: true });
  at.TEXCOORD_0 = addAccessor(Float32Array.from({ length: n * 2 }, (_, i) => i % 2 ? 1 - U.array[i] : U.array[i]), 5126, 'VEC2', n, { target: ARRAY }); // FBX v points up, glTF v down
  if (opt.cloth && m.map) { // --cloth: loose cloth weights from UV rectangles (see header)
    const H = box.max.y - box.min.y, PRE = [...canon.keys()][0].replace(/Hips$/, ''), w = new Float32Array(n);
    for (const { rect: [x0, y0, x1, y1], bone, off, max, mat } of opt.cloth) {
      if (mat && mat !== m.name) continue;
      const b = canon.get(PRE + bone); assert(b, `--cloth needs bone ${PRE + bone}`);
      const top = b.getWorldPosition(new Vector3()).applyMatrix4(mesh.bindMatrixInverse).y + off * H, pick = [];
      for (let k = 0; k < n; k++) { const u = U.getX(k) - Math.floor(U.getX(k)), v = 1 - (U.getY(k) - Math.floor(U.getY(k))); if (!(u >= x0 && u < x1 && v >= y0 && v < y1)) continue;
        let d = 0; for (let c = 1; c < 4; c++) if (Wt.getComponent(k, c) > Wt.getComponent(k, d)) d = c;
        if (!/Foot|Toe|(Left|Right)Leg$/.test(mesh.skeleton.bones[J.getComponent(k, d)].name)) pick.push(k); } // not boots or shins sharing the atlas rows
      if (!pick.length) continue; // another mesh's rectangle
      if (process.env.CLOTH_DEBUG) { const h = {}; for (const k of pick) { let d = 0; for (let c = 1; c < 4; c++) if (Wt.getComponent(k, c) > Wt.getComponent(k, d)) d = c; const key = mesh.skeleton.bones[J.getComponent(k, d)].name.slice(9) + "@" + Math.round(P.getY(k) / H * 10); h[key] = (h[key] ?? 0) + 1; } console.error(JSON.stringify(h)); }
      const low = Math.min(...pick.map(k => P.getY(k))); assert(top > low, `--cloth ${x0},${y0}: ${pick.length} vertices, top ${top} low ${low}`);
      for (const k of pick) w[k] = Math.max(w[k], max * Math.min(1, Math.max(0, (top - P.getY(k)) / (top - low))));
      console.error(`cloth rect ${x0},${y0}: ${pick.length} vertices, hem ${((top - low) / H * 100).toFixed(1)}% H below ${bone}`);
    }
    if (w.some(x => x)) at._CLOTH = addAccessor(Uint8Array.from(w, x => Math.round(x * 255)), 5121, 'SCALAR', n, { target: ARRAY, normalized: true });
  }
  const bones = mesh.skeleton.bones; assert(bones.length <= 256, 'more than 256 joints');
  at.JOINTS_0 = addAccessor(Uint8Array.from(J.array), 5121, 'VEC4', n, { target: ARRAY });
  const w8 = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) w8.set(weights255([Wt.getX(k), Wt.getY(k), Wt.getZ(k), Wt.getW(k)]), k * 4);
  at.WEIGHTS_0 = addAccessor(w8, 5121, 'VEC4', n, { target: ARRAY, normalized: true });
  // Skin: joints are the canonical bones, inverse bind = boneInverse * bindMatrix (as GLTFExporter). Equal skins are shared.
  const joints = bones.map(b => nodeOf.get(b.name)), ibm = new Float32Array(bones.length * 16);
  mesh.skeleton.boneInverses.forEach((inv, k) => new Matrix4().multiplyMatrices(inv, mesh.bindMatrix).toArray(ibm, k * 16));
  const sk = JSON.stringify([joints, Array.from(ibm, x => +x.toFixed(4))]);
  if (!skinIndex.has(sk)) { j.skins.push({ joints, inverseBindMatrices: addAccessor(ibm, 5126, 'MAT4', bones.length), skeleton: nodeOf.get([...canon.keys()][0]) }); skinIndex.set(sk, j.skins.length - 1); }
  // Primitives: one per material; --tint-region rectangles split triangles of the textured material off by UV centre.
  const groups = new Map(), uvAt = (v, c) => U.array[v * 2 + c] - Math.floor(U.array[v * 2 + c]);
  for (let t = 0; t < I.length; t += 3) {
    const cx = (uvAt(I[t], 0) + uvAt(I[t + 1], 0) + uvAt(I[t + 2], 0)) / 3, cy = 1 - (uvAt(I[t], 1) + uvAt(I[t + 1], 1) + uvAt(I[t + 2], 1)) / 3;
    const r = m.map && inRect(opt.regions, cx, cy);
    const name = r ? r.name : m.name; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(I[t], I[t + 1], I[t + 2]);
  }
  const primitives = [];
  for (const [name, idx] of groups) {
    primitives.push({ attributes: at, indices: addAccessor(Uint16Array.from(idx), 5123, 'SCALAR', idx.length, { target: ELEMENT }), material: await material(m, name, m.map ? opt.regions : []) });
    triangles += idx.length / 3;
  }
  if (opt.tabard && mesh === body.reduce((a, b) => b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a)) primitives.push(await tabard(mesh, geo));
  j.meshes.push({ name: mesh.name, primitives });
  // A skinned mesh node ignores its parents, so it sits at the scene root (validator NODE_SKINNED_MESH_NON_ROOT).
  j.nodes.push({ name: mesh.name, mesh: j.meshes.length - 1, skin: skinIndex.get(sk) }); j.scenes[0].nodes.push(j.nodes.length - 1);
}
// Material names the game tints must not collide with the source names.
for (const r of opt.regions) assert(materialIndex.has(r.name), `--tint-region ${r.name} caught no triangles`);

// ---------- animations ----------
const report = {};
for (const [clipName, file] of Object.entries(CLIPS)) {
  const a = loadFbx(file), clip = a.animations.reduce((x, y) => y.tracks.length > x.tracks.length ? y : x);
  const out = { name: clipName, samplers: [], channels: [] }, times = new Map();
  for (const tr of clip.tracks) {
    const [bone, prop] = tr.name.split('.'), node = nodeOf.get(bone);
    if (node === undefined) { report[`${clipName}:skipped`] = [...(report[`${clipName}:skipped`] ?? []), tr.name]; continue; }
    const path = { quaternion: 'rotation', position: 'translation', scale: 'scale' }[prop], nn = j.nodes[node], rest = path === 'rotation' ? nn.rotation : path === 'translation' ? nn.translation : nn.scale ?? [1, 1, 1], w = rest.length, v = tr.values;
    const constant = (tol, ref = rest) => Array.from(v).every((x, k) => Math.abs(x - ref[k % w]) < tol);
    if (path === 'scale') { assert(constant(1e-3), `${clipName}: animated scale on ${bone}`); continue; }
    // Bone lengths: only the hips translate; other bones' translation keys must sit on the character's own rest.
    if (path === 'translation' && node !== nodeOf.get([...canon.keys()][0])) { assert(constant(0.05), `${clipName}: ${bone} translation differs from the character rest (other skeleton?)`); continue; }
    if (path === 'rotation' && constant(1e-5)) continue; // the mixer falls back to the rest pose
    const tkey = Buffer.from(tr.times.buffer, tr.times.byteOffset, tr.times.byteLength).toString('base64');
    if (!times.has(tkey)) times.set(tkey, addAccessor(Float32Array.from(tr.times), 5126, 'SCALAR', tr.times.length, { min: [tr.times[0]], max: [tr.times.at(-1)] }));
    let output;
    if (path === 'rotation') { // continuous sign (no flips through the int16 path), stored as normalized int16
      const f = continuous(Float32Array.from(v));
      output = addAccessor(Int16Array.from(f, x => Math.round(Math.max(-1, Math.min(1, x)) * 32767)), 5122, 'VEC4', tr.times.length, { normalized: true });
    } else output = addAccessor(Float32Array.from(v), 5126, 'VEC3', tr.times.length);
    out.samplers.push({ input: times.get(tkey), output, interpolation: 'LINEAR' });
    out.channels.push({ sampler: out.samplers.length - 1, target: { node, path } });
  }
  const hips = clip.tracks.find(t => t.name === `${[...canon.keys()][0]}.position`);
  if (hips) { const v = hips.values, n = v.length; report[clipName] = { seconds: +clip.duration.toFixed(3), keys: hips.times.length, hipsLoopGapCm: +Math.hypot(v[n - 3] - v[0], v[n - 1] - v[2]).toFixed(2), hipsSwayCm: +Math.max(...Array.from({ length: n / 3 }, (_, k) => Math.hypot(v[k * 3] - v[0], v[k * 3 + 2] - v[2]))).toFixed(2) }; }
  j.animations.push(out);
}
j.asset.extras = { game: {
  credit: `Character and animation: Adobe Mixamo ("${j.nodes[0].name}"; ${Object.values(CLIPS).map(f => f.replace(/^.*[\\/]/, '')).join(', ')}). Used under the Mixamo terms; raw files not redistributed.`,
  clips: Object.fromEntries(Object.entries(CLIPS).map(([k, f]) => [k, f.replace(/^.*[\\/]/, '')])), heightM: opt.height, scale: +SCALE.toFixed(6), sourceHeightCm: +(box.max.y - box.min.y).toFixed(2), droppedMeshes: dropped, tintRegions: opt.regions, ramp: opt.ramp, keep: opt.keep, cloth: opt.cloth, albedoFloor: opt.floor } };

const bin = Buffer.concat(chunks); j.buffers = [{ byteLength: bin.length }];
for (const k of ['skins', 'images', 'textures']) if (!j[k].length) delete j[k];
let js = Buffer.from(JSON.stringify(j)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 32)]);
const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
const ch = (t, d) => { const h = Buffer.alloc(8); h.writeUInt32LE(d.length, 0); h.write(t, 4); return Buffer.concat([h, d]); };
fs.writeFileSync(OUT, Buffer.concat([head, ch('JSON', js), ch('BIN\0', bin)]));
console.log(JSON.stringify({ wrote: OUT, bytes: fs.statSync(OUT).size, triangles, joints: canon.size, materials: j.materials.map(m => m.name), dropped, scale: +SCALE.toFixed(5), sourceHeightCm: +(box.max.y - box.min.y).toFixed(1), clips: report }));
