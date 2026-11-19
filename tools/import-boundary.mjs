// Import-boundary check: no module under the guarded folders may reach a forbidden import, directly or through any chain of relative imports.
// Use it to keep deterministic game logic (story state, saves, combat rules) free of physics or rendering, so outcomes never depend on frame timing.
// usage:
//   node import-boundary.mjs <srcRoot> --guard combat,state,content --forbid @react-three/rapier,@dimforge/,ecctrl,physics/ [--json]
//   node import-boundary.mjs selftest
// --guard: folders (relative to srcRoot) whose every .ts/.tsx/.js/.mjs file is a starting point. --forbid: substrings; a bare import
// (package) matches when it starts with one, a relative import matches when its resolved path (relative to srcRoot, forward slashes)
// contains one. `import type` / `export type` lines are ignored (erased at build). Exit 1 and one line per violation with the chain.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import assert from 'node:assert/strict'; import { fileURLToPath } from 'node:url';

const EXT = ['.ts', '.tsx', '.js', '.mjs', '.jsx'];
/** Value imports of a source text: static import/export-from and dynamic import('...'). Type-only imports are skipped. */
export function importsOf(src) {
  const out = [], code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?([^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) if (!m[2]) out.push(m[4]);
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}
function resolveRel(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, ...EXT.map(e => base + e), ...EXT.map(e => path.join(base, 'index' + e)), base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : EXT.includes(path.extname(e.name)) ? [path.join(d, e.name)] : []);
/** Returns [{ start, chain: [files...], hit }] for every guarded file that reaches a forbidden import. */
export function checkBoundaries(root, guard, forbid) {
  root = path.resolve(root); const rel = f => path.relative(root, f).split(path.sep).join('/');
  const bad = (spec, resolved) => forbid.some(f => resolved ? rel(resolved).includes(f) : spec.startsWith(f) || spec.includes('/' + f));
  const violations = [];
  for (const g of guard) {
    const dir = path.join(root, g); if (!fs.existsSync(dir)) throw new Error(`guarded folder not found: ${dir}`);
    for (const start of walk(dir)) {
      const seen = new Set([start]), queue = [[start]];
      while (queue.length) {
        const chain = queue.shift(), file = chain[chain.length - 1];
        for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
          const r = spec.startsWith('.') ? resolveRel(file, spec) : null;
          if (bad(spec, r)) { violations.push({ start: rel(start), chain: chain.map(rel), hit: r ? rel(r) : spec }); continue; }
          if (r && !seen.has(r)) { seen.add(r); queue.push([...chain, r]); }
        }
      }
    }
  }
  return violations;
}
function parse(argv) {
  const o = { guard: [], forbid: [], json: false, pos: [] };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--guard') o.guard = argv[++i].split(','); else if (a === '--forbid') o.forbid = argv[++i].split(','); else if (a === '--json') o.json = true; else if (a.startsWith('--')) throw new Error('unknown option ' + a); else o.pos.push(a); }
  assert(o.pos[0] && o.guard.length && o.forbid.length, 'usage: import-boundary.mjs <srcRoot> --guard a,b --forbid x,y');
  return { ...o, root: o.pos[0] };
}
if (process.argv[2] === 'selftest') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-')), w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  w('state/a.ts', "import { b } from './b';\nimport type { W } from '../physics/world';\n// import x from '../physics/c';\nexport const a = b;");
  w('state/b.ts', "export const b = 1;");
  w('combat/c.ts', "import { u } from '../util';\nexport { u };");
  w('util.ts', "import { p } from './physics/p';\nexport const u = p;");
  w('physics/p.ts', "import { World } from '@dimforge/rapier3d-compat';\nexport const p = 1;");
  w('content/d.tsx', "const m = import('@react-three/rapier');");
  const v = checkBoundaries(d, ['state', 'combat', 'content'], ['@react-three/rapier', '@dimforge/', 'physics/']);
  assert.deepEqual(v.map(x => [x.start, x.hit]).sort(), [['combat/c.ts', 'physics/p.ts'], ['content/d.tsx', '@react-three/rapier']], JSON.stringify(v));
  assert.deepEqual(v.find(x => x.start === 'combat/c.ts').chain, ['combat/c.ts', 'util.ts']);
  assert.deepEqual(importsOf("import type { A } from 'x';\nexport type { B } from 'y';\nimport C, { D } from 'z';\nexport * from './e';\nimport './side';"), ['z', './e', './side']);
  assert.throws(() => parse(['src']), /usage/);
  fs.rmSync(d, { recursive: true, force: true });
  console.log('selftest ok'); process.exit(0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parse(process.argv.slice(2)), v = checkBoundaries(o.root, o.guard, o.forbid);
  if (o.json) console.log(JSON.stringify(v, null, 2)); else for (const x of v) console.log(`FORBIDDEN ${x.chain.join(' -> ')} -> ${x.hit}`);
  console.log(v.length ? `${v.length} boundary violation(s)` : `boundaries hold: ${o.guard.join(', ')} never reach ${o.forbid.join(', ')}`);
  process.exit(v.length ? 1 : 0);
}
