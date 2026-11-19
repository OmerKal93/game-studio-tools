// Poke-through check for a skinned garment layer (tabard, cloak) over a skinned body, per clip frame, on the CPU.
// usage:
//   node check-garment.mjs <model.glb> [--material Tabard] [--frames 16] [--max-cm 3] [--spring sx,sz[,billow]]
//   node check-garment.mjs selftest
// Bind pose: each body vertex (not arm/hand/head/neck-dominated) gets the garment triangle straight in front of it (+z, front
// panel) and straight behind it (-z, back panel). Per frame, the body vertex's distance along that triangle's skinned normal
// (outward = the bind side) is its poke; it counts only while the vertex is still under the triangle (in-plane offset < 4 cm).
// Prints per clip the frames' poking-vertex count and worst depth; exits 1 if any frame's worst poke is over --max-cm.
// --spring sx,sz[,billow] (metres): the character-cloth shader's worst case, applied after skinning: d = _cloth^2 x (0.25 sx, 0, dz + side x billow) with dz the forward swing on a front panel and the backward one on a back panel (game physics/char-cloth.ts); checks a garment that carries a _CLOTH attribute, so run it for +-sx and +-sz.
// Reads EXT_meshopt_compression. Mixamo-style bone names (Arm, Hand, Head, Neck) decide which body vertices are skipped.
import fs from 'node:fs'; import assert from 'node:assert/strict';

// Barycentric coordinates of (px, py) in the xy projection of triangle a, b, c; null when degenerate.
export function bary2(a, b, c, px, py) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (Math.abs(d) < 1e-12) return null;
  const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d, l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
  return [l1, l2, 1 - l1 - l2];
}
// Signed distance of p from triangle a, b, c along its normal turned toward `side` (+1: +z, -1: -z), and the in-plane offset
// from the point at barycentrics l.
export function poke(p, a, b, c, l, side) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const len = Math.hypot(...n) || 1; n = n.map(x => x / len);
  if (n[2] * side < 0) n = n.map(x => -x);
  const q = [0, 1, 2].map(k => a[k] * l[0] + b[k] * l[1] + c[k] * l[2]), d = [0, 1, 2].map(k => p[k] - q[k]), s = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  return { depth: s, inPlane: Math.hypot(d[0] - s * n[0], d[1] - s * n[1], d[2] - s * n[2]) };
}
// |z| of the unit normal of triangle a, b, c.
const faceZ = (a, b, c) => { const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; return Math.abs(n[2]) / (Math.hypot(...n) || 1); };
if (process.argv[2] === 'selftest') {
  const A = [0, 0, 0], B = [1, 0, 0], C = [0, 1, 0];
  assert.deepEqual(bary2(A, B, C, 0, 0), [1, 0, 0]); assert.deepEqual(bary2(A, B, C, .25, .25).map(x => +x.toFixed(6)), [.5, .25, .25]); assert.equal(bary2(A, A, A, 0, 0), null); assert.equal(faceZ(A, B, C), 1); assert.equal(faceZ(A, B, [0, 0, 1]), 0);
  const l = bary2(A, B, C, .25, .25);
  assert(Math.abs(poke([.25, .25, .1], A, B, C, l, 1).depth - .1) < 1e-9, 'in front of a front panel = poke');
  assert(Math.abs(poke([.25, .25, -.2], A, B, C, l, 1).depth + .2) < 1e-9, 'behind a front panel = clear');
  assert(Math.abs(poke([.25, .25, -.2], A, B, C, l, -1).depth - .2) < 1e-9, 'behind a back panel = poke');
  assert(Math.abs(poke([.35, .25, 0], A, B, C, l, 1).inPlane - .1) < 1e-9, 'in-plane offset');
  console.log('selftest ok'); process.exit(0);
}

const argv = process.argv.slice(2), o = { material: 'Tabard', frames: 16, maxCm: 3 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--material') o.material = argv[++i]; else if (argv[i] === '--frames') o.frames = +argv[++i]; else if (argv[i] === '--max-cm') o.maxCm = +argv[++i]; else if (argv[i] === '--spring') o.spring = argv[++i].split(',').map(Number);
  else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`); else o.file ??= argv[i];
}
assert(o.file, 'usage: node check-garment.mjs <model.glb> [--material Tabard] [--frames 16] [--max-cm 3] [--spring sx,sz[,billow]]');
const { AnimationMixer, Vector3 } = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'), { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
globalThis.self ??= globalThis; globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} }); // textures are not needed
const buf = fs.readFileSync(o.file);
const g = await new Promise((res, rej) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
const meshes = []; g.scene.traverse(m => m.isSkinnedMesh && meshes.push(m)); g.scene.updateMatrixWorld(true);
const cloth = meshes.find(m => [m.material].flat().some(x => x.name === o.material)), bodies = meshes.filter(m => m !== cloth);
assert(cloth, `no skinned mesh with material ${o.material}`); assert(bodies.length, 'no body mesh');
const v = new Vector3();
const positions = (m, skin) => { const P = m.geometry.attributes.position, out = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) { if (skin) m.getVertexPosition(i, v); else v.fromBufferAttribute(P, i).applyMatrix4(m.bindMatrix); v.applyMatrix4(m.matrixWorld); out.set([v.x, v.y, v.z], i * 3); } return out; };
const CW = cloth.geometry.attributes._cloth; if (o.spring) assert(CW, 'the garment has no _CLOTH attribute');
// The shader's displacement on skinned positions A (in place), see physics/char-cloth.ts: front panels (bind normal +z) swing forward only, back panels back only,
// both sway sideways at 25%, plus the wind billow out of the panel.
const displace = A => {
  const N = cloth.geometry.attributes.normal, [sx, sz, bill = 0] = o.spring, cl = x => Math.max(-1, Math.min(1, x));
  for (let i = 0; i < A.length / 3; i++) {
    const c2 = CW.getX(i) ** 2, side = cl(N.getZ(i) * 3), f = side * .5 + .5, dz = Math.min(sz, 0) * (1 - f) + Math.max(sz, 0) * f;
    A[i * 3] += .25 * sx * c2; A[i * 3 + 2] += (dz + bill * side) * c2;
  }
};
const I = cloth.geometry.index.array, C0 = positions(cloth, false), at = (A, k) => [A[k * 3], A[k * 3 + 1], A[k * 3 + 2]];
// bind pose: frontmost (+z side) / rearmost (-z side) garment triangle over each 1 cm xy cell
const cell = .01, cover = new Map();
for (let t = 0; t < I.length; t += 3) {
  const p = [at(C0, I[t]), at(C0, I[t + 1]), at(C0, I[t + 2])], side = Math.sign(p[0][2] + p[1][2] + p[2][2]) || 1; // the model stands on z = 0, facing +z
  if (faceZ(...p) < .3) continue; // shoulder straps and other near-horizontal parts
  const lo = [0, 1].map(k => Math.floor(Math.min(...p.map(q => q[k])) / cell)), hi = [0, 1].map(k => Math.floor(Math.max(...p.map(q => q[k])) / cell));
  for (let gx = lo[0]; gx <= hi[0]; gx++) for (let gy = lo[1]; gy <= hi[1]; gy++) {
    const l = bary2(...p, (gx + .5) * cell, (gy + .5) * cell); if (!l || l.some(x => x < 0)) continue;
    const z = l[0] * p[0][2] + l[1] * p[1][2] + l[2] * p[2][2], key = `${gx},${gy},${side}`, cur = cover.get(key);
    if (!cur || z * side > cur.z * side) cover.set(key, { z, t, l, side });
  }
}
const pairs = [];
for (const body of bodies) {
  const B0 = positions(body, false), J = body.geometry.attributes.skinIndex, W = body.geometry.attributes.skinWeight, names = body.skeleton.bones.map(b => b.name);
  for (let i = 0; i < B0.length / 3; i++) {
    let d = 0; for (let c = 1; c < 4; c++) if (W.getComponent(i, c) > W.getComponent(i, d)) d = c;
    if (/Arm|Hand|Head|Neck|Eye/.test(names[J.getComponent(i, d)])) continue;
    for (const side of [1, -1]) { const h = cover.get(`${Math.floor(B0[i * 3] / cell)},${Math.floor(B0[i * 3 + 1] / cell)},${side}`); if (h && (B0[i * 3 + 2] - h.z) * side < 0) pairs.push({ body, i, ...h }); }
  }
}
const mixer = new AnimationMixer(g.scene); let worstAll = 0;
for (const clip of g.animations) {
  mixer.stopAllAction(); const act = mixer.clipAction(clip); act.play(); const rows = [];
  for (let f = 0; f < o.frames; f++) {
    act.time = clip.duration * f / o.frames; mixer.update(0); g.scene.updateMatrixWorld(true);
    const C = positions(cloth, true);
    if (o.spring) displace(C);
    const Bs = new Map(bodies.map(b => [b, positions(b, true)])); let n = 0, worst = 0;
    for (const { body, i, t, l, side } of pairs) {
      const r = poke(at(Bs.get(body), i), at(C, I[t]), at(C, I[t + 1]), at(C, I[t + 2]), l, side);
      if (r.depth > .003 && r.inPlane < .04) { n++; worst = Math.max(worst, r.depth); }
    }
    rows.push(`${n}/${(worst * 100).toFixed(1)}`); worstAll = Math.max(worstAll, worst);
  }
  console.log(`${clip.name}: ${pairs.length} body vertices under the garment; per frame poking/worst cm: ${rows.join(' ')}`);
}
console.log(`worst poke ${(worstAll * 100).toFixed(1)} cm (limit ${o.maxCm})`);
process.exit(worstAll * 100 > o.maxCm ? 1 : 0);
