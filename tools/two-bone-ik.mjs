// Analytic two-bone IK for three.js bone chains (thigh-calf-foot, upper arm-forearm-hand), in world space.
// usage (import):  import { solveTwoBone, rotateWorld, refresh } from './two-bone-ik.mjs'  (or copy it into your game)
//   solveTwoBone(upper, mid, end, target, pole, soft = .02) -> miss distance (m). Bends `mid` so |upper->end| equals the target
//   distance (soft-clamped near full reach so the knee/elbow never snaps straight), keeps the current bend plane (a straight limb
//   bends toward `pole`, e.g. the body's forward for knees), then swings `upper` onto the target. The chain's world matrices must
//   be current; upper, mid and end are current again on return (other children are left to the renderer's matrix update).
//   Keep the end's animated orientation yourself afterwards if you want it (set its world quaternion back).
// usage (cli):     node two-bone-ik.mjs selftest
import assert from 'node:assert/strict';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';   // studio node_modules

const _s = new Vector3(), _m = new Vector3(), _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _t = new Vector3(), _ab = new Vector3(), _ac = new Vector3(), _ax = new Vector3();
const _q = new Quaternion(), _pq = new Quaternion(), _rq = new Quaternion(), _inv = new Matrix4();
/** World matrix of one node from its parent's current one (no walk up to the scene, no subtree). */
export const refresh = n => { n.updateMatrix(); n.matrixWorld.multiplyMatrices(n.parent.matrixWorld, n.matrix); };
/** Applies a world-space rotation to a bone about its own pivot (parent world matrix current; its own is not updated). */
export function rotateWorld(b, q) { b.parent.matrixWorld.decompose(_m, _pq, _s); b.quaternion.premultiply(_rq.copy(_pq).invert().multiply(q).multiply(_pq)); }
/** Sets a node's world position (parent world matrix current). */
export function setWorldPosition(b, p) { b.position.copy(_m.copy(p).applyMatrix4(_inv.copy(b.parent.matrixWorld).invert())); }
const acos = x => Math.acos(Math.max(-1, Math.min(1, x)));
export function solveTwoBone(upper, mid, end, target, pole, soft = .02) {
  _a.setFromMatrixPosition(upper.matrixWorld); _b.setFromMatrixPosition(mid.matrixWorld); _c.setFromMatrixPosition(end.matrixWorld);
  const lab = _a.distanceTo(_b), lcb = _b.distanceTo(_c), L = lab + lcb, s = soft * L;
  let lat = _a.distanceTo(target);
  if (s > 0 && lat > L - s) lat = L - s + s * (1 - Math.exp(-(lat - (L - s)) / s));
  lat = Math.max(Math.abs(lab - lcb) + 1e-5, Math.min(L - 1e-5, lat));
  _ac.subVectors(_c, _a); _ab.subVectors(_b, _a);
  _ax.crossVectors(_ac, _ab);
  if (_ax.lengthSq() < 1e-8 * _ac.lengthSq() * _ab.lengthSq()) _ax.crossVectors(_ac, pole);
  _ax.normalize();
  const acab0 = _ac.angleTo(_ab), babc0 = _t.subVectors(_a, _b).angleTo(_s.subVectors(_c, _b));
  const acab1 = acos((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat)), babc1 = acos((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb));
  rotateWorld(upper, _q.setFromAxisAngle(_ax, acab1 - acab0)); refresh(upper); refresh(mid);
  rotateWorld(mid, _q.setFromAxisAngle(_ax, babc1 - babc0)); refresh(mid); refresh(end);
  _c.setFromMatrixPosition(end.matrixWorld);
  rotateWorld(upper, _q.setFromUnitVectors(_ac.subVectors(_c, _a).normalize(), _t.subVectors(target, _a).normalize())); refresh(upper); refresh(mid); refresh(end);
  return _c.setFromMatrixPosition(end.matrixWorld).distanceTo(target);
}

function selftest() {
  // A leg under a scaled, rotated parent (Mixamo armatures sit under 0.01 scale and a -90 deg X turn), knee bent forward (+z).
  const rig = new Object3D(); rig.scale.setScalar(.01); rig.rotation.set(-Math.PI / 2, 0, 0); rig.position.set(1, 2, 3);
  const hip = new Object3D(), thigh = new Object3D(), calf = new Object3D(), foot = new Object3D(), toe = new Object3D();
  rig.add(hip); hip.add(thigh); thigh.add(calf); calf.add(foot); foot.add(toe);
  // In the rig's local frame (z up after the -90 deg X turn), 45 cm thigh and calf hanging down, knee 10 cm forward (local -y = world +z).
  hip.position.set(0, 0, 0); calf.position.set(0, -10, -44); foot.position.set(0, 10, -44); toe.position.set(0, -12, -6);
  rig.updateMatrixWorld(true);
  const P = o => new Vector3().setFromMatrixPosition(o.matrixWorld), pole = new Vector3(0, 0, 1), L = P(thigh).distanceTo(P(calf)) + P(calf).distanceTo(P(foot));
  const kneeAhead = () => { const a = P(thigh), c = P(foot), k = P(calf), t = (k.clone().sub(a).dot(c.clone().sub(a))) / c.clone().sub(a).lengthSq(); return k.sub(a.lerp(c, t)).dot(pole); };
  let worst = 0;
  for (const off of [[0, .1, 0], [0, .2, .1], [.05, .25, -.1], [-.08, .05, .15], [0, -.02, .05], [.1, .3, .2]]) {
    const tgt = P(foot).add(new Vector3(...off)); const miss = solveTwoBone(thigh, calf, foot, tgt, pole, 0); worst = Math.max(worst, miss);
    assert(miss < 1e-4, `reachable target ${off}: miss ${miss}`);
    assert(kneeAhead() > 0, `knee stays forward for ${off}`);
    assert(Math.abs(P(thigh).distanceTo(P(calf)) + P(calf).distanceTo(P(foot)) - L) < 1e-6, 'bone lengths unchanged');
    assert(P(toe).distanceTo(new Vector3().setFromMatrixPosition(toe.matrixWorld)) < 1e-9);
  }
  // Out of reach: lands on the line to the target, short by the soft band at most; never NaN.
  const far = P(thigh).add(new Vector3(.3, -2, .2)), miss = solveTwoBone(thigh, calf, foot, far, pole);
  assert(Number.isFinite(miss) && Math.abs(P(thigh).distanceTo(P(foot)) - L) < .02 * L && P(foot).sub(P(thigh)).normalize().dot(far.clone().sub(P(thigh)).normalize()) > .9999, 'unreachable: straight toward the target');
  // A straight limb bends toward the pole.
  const straight = P(thigh).add(new Vector3(0, -L + 1e-6, 0)); solveTwoBone(thigh, calf, foot, straight, pole, 0);
  solveTwoBone(thigh, calf, foot, P(thigh).add(new Vector3(0, -.7 * L, 0)), pole, 0); assert(kneeAhead() > .05, 'a straight leg bends its knee toward the pole');
  // Soft band: continuous knee angle as the target moves through full reach (no snap).
  let prev = null, jump = 0;
  for (let d = .9 * L; d < 1.05 * L; d += .002 * L) { solveTwoBone(thigh, calf, foot, P(thigh).add(new Vector3(0, -d, 0)), pole); const a = calf.quaternion.angleTo(new Quaternion()); if (prev !== null) jump = Math.max(jump, Math.abs(a - prev)); prev = a; }
  assert(jump < .05, `soft IK: knee angle step ${jump.toFixed(3)} rad per 0.2% of reach`);
  console.log(JSON.stringify({ selftest: 'pass', worstReachableMiss: worst, softKneeStepRad: +jump.toFixed(4) }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === 'selftest') selftest(); else { console.log('usage: node two-bone-ik.mjs selftest   (import solveTwoBone, rotateWorld, refresh, setWorldPosition)'); process.exit(1); }
}
