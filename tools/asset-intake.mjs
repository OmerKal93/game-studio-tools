// Register a third-party asset before any game uses it: licence gate, hash, provenance, one ledger for every project.
// usage:
//   node asset-intake.mjs add --file <path> --source <url> --license <id> --author <name> --kind <model|anim|texture|audio|font|hdri|data|reference>
//                             [--title <t>] [--ships yes|baked|no] [--note <text>]
//   node asset-intake.mjs list [--kind k] [--license id]
//   node asset-intake.mjs selftest
// The register is ../ASSET-REGISTER.json (or the file named by ASSET_REGISTER); it is git-ignored. Copy ASSET-REGISTER.example.json to start one.
// Files stay where they are; the register records their path and sha256.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const REGISTER = process.env.ASSET_REGISTER || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ASSET-REGISTER.json');
// Licences a shipped game may use. `credit`: attribution must appear in the game's credits. `raw`: may the raw file ship?
export const LICENSES = {
  'CC0-1.0':   { credit: false, raw: true },
  'CC-BY-4.0': { credit: true,  raw: true },
  'CC-BY-3.0': { credit: true,  raw: true },
  'OFL-1.1':   { credit: false, raw: true },  // fonts
  'Mixamo':    { credit: false, raw: false }, // Adobe Mixamo: royalty-free in games; raw FBX never ships. Ships baked: retargeted motion, or a baked character mesh inside a game GLB (check the current terms)
  'OWN':       { credit: false, raw: true },  // made in-house (make-sfx.mjs: jsfxr/ffmpeg output)
  'Fab-Standard': { credit: false, raw: false }, // Fab Standard Licence (Megascans and similar): free in games, no credit; raw files never ship standalone
  'AI-OWN':    { credit: false, raw: true },  // AI-generated (gen-image.mjs); note must say "AI-generated, check provider terms"
  // Open geodata (kind 'data'): terrain and positions derived from it ship baked into meshes and layouts
  'Etalab-2.0': { credit: true, raw: true },   // French Licence Ouverte 2.0 (open geodata): any reuse, credit the publisher + date
  'ODbL-1.0':   { credit: true, raw: false },  // OpenStreetMap: a game is a Produced Work (credit "(c) OpenStreetMap contributors"); the database itself never ships
  // Reference images only (look and scale, never in a game): share-alike would bind the game, so these can only be registered --ships no
  'CC-BY-SA-4.0': { credit: true, raw: false, refOnly: true },
  'CC-BY-SA-3.0': { credit: true, raw: false, refOnly: true },
  'PD':           { credit: false, raw: false, refOnly: true },  // public domain (Commons 'Public domain' tag); not CC0, no waiver text
};
const KINDS = ['model', 'anim', 'texture', 'audio', 'font', 'hdri', 'data', 'reference'];

const load = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { assets: [] };
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function addEntry(reg, e) {
  const lic = LICENSES[e.license];
  if (!lic) throw new Error(`licence '${e.license}' is not on the allow list (${Object.keys(LICENSES).join(', ')}); check the terms and add it deliberately`);
  if (!KINDS.includes(e.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  for (const k of ['file', 'source', 'author']) if (!e[k]) throw new Error(`--${k} is required`);
  if (!/^https?:\/\//.test(e.source)) throw new Error('--source must be the URL the asset was downloaded from');
  const ships = e.ships ?? (lic.refOnly ? 'no' : lic.raw ? 'yes' : 'baked');
  if (lic.refOnly && ships !== 'no') throw new Error(`${e.license} is registered for reference only; use --ships no`);
  if (ships === 'yes' && !lic.raw) throw new Error(`${e.license} raw files may not ship; use --ships baked or no`);
  const dup = reg.assets.find(a => a.sha256 === e.sha256);
  if (dup) return { entry: dup, added: false };
  const entry = { id: Math.max(0, ...reg.assets.map(x => x.id)) + 1,   // max + 1, not count + 1: a dropped entry would otherwise repeat an id
                   title: e.title ?? path.basename(e.file), kind: e.kind, file: e.file, sha256: e.sha256,
    bytes: e.bytes, source: e.source, author: e.author, license: e.license, credit: lic.credit, ships, note: e.note ?? '',
    added: new Date().toISOString().slice(0, 10) };
  reg.assets.push(entry);
  return { entry, added: true };
}

function args(argv) { const o = {}; for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1]; return o; }

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'add') {
  const a = args(rest), file = path.resolve(a.file ?? '');
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const reg = load(REGISTER);
  const { entry, added } = addEntry(reg, { ...a, file, sha256: sha256(file), bytes: fs.statSync(file).size });
  if (added) fs.writeFileSync(REGISTER, JSON.stringify(reg, null, 1) + '\n');
  console.log(JSON.stringify({ ...entry, isNew: added }));
} else if (cmd === 'list') {
  const a = args(rest);
  for (const e of load(REGISTER).assets.filter(e => (!a.kind || e.kind === a.kind) && (!a.license || e.license === a.license)))
    console.log(`#${e.id} ${e.kind.padEnd(7)} ${e.license.padEnd(9)} ${e.ships.padEnd(5)} ${e.title}  <${e.source}>  ${e.file}`);
} else if (cmd === 'selftest') {
  const reg = { assets: [] }, base = { file: 'x', source: 'https://example.org/x', author: 'a', kind: 'audio', sha256: 'h', bytes: 1 };
  assert.equal(addEntry(reg, { ...base, license: 'CC0-1.0' }).added, true);
  assert.equal(addEntry(reg, { ...base, license: 'CC0-1.0' }).added, false, 'same hash is not added twice');
  assert.throws(() => addEntry(reg, { ...base, sha256: 'k', license: 'CC-BY-NC-4.0' }), /allow list/);
  assert.throws(() => addEntry(reg, { ...base, sha256: 'm', license: 'Mixamo', ships: 'yes' }), /may not ship/);
  assert.equal(addEntry(reg, { ...base, sha256: 'n', license: 'Mixamo' }).entry.ships, 'baked');
  assert.throws(() => addEntry(reg, { ...base, sha256: 'p', license: 'CC0-1.0', source: 'my desktop' }), /URL/);
  assert.throws(() => addEntry(reg, { ...base, sha256: 'q', license: 'CC-BY-SA-4.0', ships: 'baked' }), /reference only/);
  assert.equal(addEntry(reg, { ...base, sha256: 'r', license: 'PD' }).entry.ships, 'no');
  assert.equal(addEntry(reg, { ...base, sha256: 's', kind: 'data', license: 'ODbL-1.0' }).entry.ships, 'baked');
  assert.equal(addEntry(reg, { ...base, sha256: 't', kind: 'data', license: 'Etalab-2.0' }).entry.credit, true);
  assert.equal(addEntry({ assets: [{ id: 1 }, { id: 7 }] }, { ...base, sha256: 'u', license: 'CC0-1.0' }).entry.id, 8, 'new id is max + 1 when ids have gaps');
  console.log('asset-intake selftest ok');
} else {
  console.log('usage: node asset-intake.mjs add|list|selftest (see header)');
}
