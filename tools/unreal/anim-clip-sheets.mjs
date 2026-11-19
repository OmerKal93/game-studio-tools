// Side-view stick-figure clip sheets + numeric checks against a combat animation reference, from anim-clip-dump.py JSON.
// usage: node anim-clip-sheets.mjs <clips.json> <outDir>   (needs sharp: `npm ci` at the repo root)
import fs from 'node:fs'; import path from 'node:path';
import sharp from 'sharp';
const [J, OUT] = process.argv.slice(2); fs.mkdirSync(OUT, { recursive: true });
const clips = JSON.parse(fs.readFileSync(J, 'utf8'));
const sub = (a, b) => a.map((v, i) => v - b[i]); const len = v => Math.hypot(...v);
const f0 = Object.values(clips)[0].frames[0];
let fwd = sub(f0.ball_l, f0.foot_l); fwd[2] = 0; fwd = fwd.map(v => v / len(fwd));   // forward = ankle to toe, horizontal
const lat = [-fwd[1], fwd[0], 0];                                                       // side axis
const proj = (p, o) => { const d = sub(p, o); return [d[0] * fwd[0] + d[1] * fwd[1], d[2], d[0] * lat[0] + d[1] * lat[1]]; };
const BONES = [['pelvis', 'spine_01'], ['spine_01', 'spine_03'], ['spine_03', 'spine_05'], ['spine_05', 'neck_01'], ['neck_01', 'head'],
  ['spine_05', 'upperarm_l'], ['upperarm_l', 'lowerarm_l'], ['lowerarm_l', 'hand_l'], ['spine_05', 'upperarm_r'], ['upperarm_r', 'lowerarm_r'], ['lowerarm_r', 'hand_r'],
  ['pelvis', 'thigh_l'], ['thigh_l', 'calf_l'], ['calf_l', 'foot_l'], ['foot_l', 'ball_l'], ['pelvis', 'thigh_r'], ['thigh_r', 'calf_r'], ['calf_r', 'foot_r'], ['foot_r', 'ball_r']];
const idle = clips.MM_CombatIdle.frames;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const metrics = {};
for (const [name, c] of Object.entries(clips)) {
  const F = c.frames, rel = (fr, b) => proj(fr[b], fr.pelvis);
  const reachL = Math.max(...F.map(fr => Math.abs(proj(fr.hand_l, fr.spine_03)[0])));
  const lowL = F.filter(fr => fr.hand_l[2] < fr.pelvis[2]).length / F.length;
  const bow = Math.max(...F.map(fr => { const v = proj(fr.neck_01, fr.pelvis); return Math.atan2(Math.abs(v[0]), v[1]) * 180 / Math.PI; }));
  const idleHand = ['hand_l', 'hand_r'].map(b => rel(idle[0], b));
  const endD = Math.max(...['hand_l', 'hand_r'].map((b, i) => len(sub(rel(F.at(-1), b), idleHand[i]))));
  const hr = F.map(fr => rel(fr, 'hand_r')); const ext = Math.max(...hr.map(h => h[0]));
  const zr = [Math.min(...hr.map(h => h[1])), Math.max(...hr.map(h => h[1]))];
  const lr = [Math.min(...hr.map(h => h[2])), Math.max(...hr.map(h => h[2]))];
  const feetDrift = Math.max(...['foot_l', 'foot_r'].map(b => Math.abs(Math.min(...F.map(fr => fr[b][2])) - Math.min(...F.map(fr => fr[b][2])) + Math.abs(F.at(-1)[b][2] - F[0][b][2]))));
  const footLift = Math.max(...['foot_l', 'foot_r'].map(b => Math.max(...F.map(fr => fr[b][2])) - Math.min(...F.map(fr => fr[b][2]))));
  metrics[name] = { len: +c.length.toFixed(2), shieldReachCm: +reachL.toFixed(0), shieldBelowPelvisFrac: +lowL.toFixed(2), maxBowDeg: +bow.toFixed(0), endHandDistFromGuardCm: +endD.toFixed(0),
    swordHandForwardCm: +ext.toFixed(0), swordHandZrangeCm: zr.map(v => +v.toFixed(0)), swordHandLateralRangeCm: lr.map(v => +v.toFixed(0)), maxFootLiftCm: +footLift.toFixed(0) };
}
fs.writeFileSync(path.join(OUT, 'combat-clip-metrics.json'), JSON.stringify(metrics, null, 1));
// sheets: one PNG per clip, 8 frames side by side, hands marked, shield hand (L) blue square, sword hand (R) red circle
const W = 150, H = 230, K = 8;
for (const [name, c] of Object.entries(clips)) {
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * K}" height="${H + 22}"><rect width="100%" height="100%" fill="#f4f1ea"/>`;
  for (let k = 0; k < K; k++) {
    const fr = c.frames[Math.round(k * (c.frames.length - 1) / (K - 1))], ox = k * W + W / 2, oy = H - 14, S = 0.9;
    const P = b => { const p = proj(fr[b], f0.pelvis.map((v, i) => i === 2 ? 0 : v)); return [ox + p[0] * S, oy - p[1] * S]; };
    svg += `<line x1="${k * W}" y1="${oy}" x2="${(k + 1) * W}" y2="${oy}" stroke="#aaa"/>`;
    for (const [a, b] of BONES) { const [x1, y1] = P(a), [x2, y2] = P(b); svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${/_l$|_l'/.test(b) || b.endsWith('_l') ? '#1f5fbf' : '#222'}" stroke-width="3"/>`; }
    const [hx, hy] = P('hand_l'), [rx, ry] = P('hand_r'), [tx, ty] = P('head');
    svg += `<rect x="${hx - 11}" y="${hy - 11}" width="22" height="22" fill="#1f5fbf" opacity=".6"/><circle cx="${rx}" cy="${ry}" r="6" fill="#c22"/><circle cx="${tx}" cy="${ty - 8}" r="9" fill="none" stroke="#222" stroke-width="2"/>`;
    svg += `<text x="${k * W + 4}" y="${H + 16}" font-size="11" fill="#555">${(c.length * k / (K - 1)).toFixed(2)}s</text>`;
  }
  svg += `<text x="4" y="14" font-size="13" font-family="sans-serif" font-weight="bold">${name}  (${c.length.toFixed(2)}s)  facing right; blue square = shield hand, red = sword hand</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, name + '.png'));
}
console.log(Object.entries(metrics).map(([n, m]) => n + ' ' + JSON.stringify(m)).join('\n'));
// Verdicts against your combat animation reference: hard rules, thresholds are starting values.
const ROLE = { MM_CombatIdle: 'guard idle', MM_Cut_A: 'cut', MM_Cut_B: 'cut', MM_Cut_C: 'cut', MM_Cut_D: 'cut', MM_Slash_A: 'cut', MM_Slash_B: 'cut', MM_Slash_C: 'cut', MM_Slash_D: 'cut', MM_Slash_E: 'cut',
  MM_Block: 'block', MM_BlockIdle: 'block', MM_BlockImpact: 'perfect-block impact', MM_HitReact_A: 'hit react', MM_HitReact_B: 'hit react', MM_HitReact_C: 'hit react', MM_Kick: 'kick', MM_Death_A: 'fall' };
const rows = [];
for (const [n, m] of Object.entries(metrics)) {
  const role = ROLE[n], why = [], kind = role.split(' ')[0];
  const holds = ['guard idle', 'block'].includes(role) && n !== 'MM_Block';
  if (kind !== 'fall') {
    const bowMax = role === 'hit react' ? 35 : role === 'kick' ? 35 : 30;
    if (m.maxBowDeg > bowMax) why.push(`bows ${m.maxBowDeg} deg (max ${bowMax})`);
    if (role === 'cut' && m.shieldBelowPelvisFrac > 0.1) why.push(`shield drops below the hips in ${Math.round(m.shieldBelowPelvisFrac * 100)}% of frames`);
    if (m.shieldReachCm > 60 && role !== 'hit react') why.push(`shield out at ${m.shieldReachCm} cm from the chest (reference: close to the body)`);
    if (['cut', 'hit react', 'perfect-block impact'].includes(role) && m.endHandDistFromGuardCm > 15) why.push(`ends ${m.endHandDistFromGuardCm} cm from the guard pose`);
    if (role !== 'kick' && m.maxFootLiftCm > 40) why.push(`a foot lifts ${m.maxFootLiftCm} cm (leap or flip, not a step)`);
    if (role === 'cut' && m.len > 2.2) why.push(`${m.len}s long (cut is 0.25-0.5 s plus recovery)`);
  } else why.push('fall: not judged in this set');
  rows.push(`| ${n} | ${role} | ${kind === 'fall' ? 'n/a' : why.length ? 'GAP' : 'USABLE'} | ${m.len} | ${why.join('; ') || 'passes the numeric rules; judge the sheet'} |`);
}
fs.writeFileSync(path.join(OUT, 'combat-clip-verdicts.md'), '| clip | role | verdict | s | reasons (vs the combat reference) |\n|---|---|---|---|---|\n' + rows.join('\n') + '\n');
console.log(rows.join('\n'));
