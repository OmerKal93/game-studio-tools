// Search and download CC0 assets from Poly Haven and ambientCG by query/id and resolution; registers each file with asset-intake.
// usage:
//   node fetch-asset.mjs search <polyhaven|ambientcg> <query> [--type texture|model|hdri] [--limit 10]
//   node fetch-asset.mjs get <polyhaven|ambientcg> <id> --dest <folder> [--res 1k] [--maps Diffuse,nor_gl,arm] [--format jpg|png] [--unzip] [--no-register]
//   node fetch-asset.mjs selftest [--offline]
// Files land in <dest>/<source>/<id>/ (give a folder outside any repo, e.g. ~/asset-sources/textures). Poly Haven models are
// textures + .gltf + .bin (--maps ignored); ambientCG textures are one zip per resolution (1K-JPG style; --unzip extracts it); ambientCG has no model API.
// Licence is hard-coded CC0-1.0 per source (neither API returns a licence field; both sites are CC0-only by policy: polyhaven.com/license,
// docs.ambientcg.com/license). Re-check those pages quarterly. Poly Haven requires an identifying User-Agent on every call; we send game-studio-fetch/1.0.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export const UA = 'game-studio-fetch/1.0';
const INTAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'asset-intake.mjs');
const PH = 'https://api.polyhaven.com', CG = 'https://ambientcg.com/api/v3/assets';
const PH_TYPE = { texture: 'textures', model: 'models', hdri: 'hdris' }, PH_KIND = { 0: 'hdri', 1: 'texture', 2: 'model' };
const CG_TYPE = { texture: 'material', hdri: 'hdri' };
const SOURCES = {
  polyhaven: { page: id => `https://polyhaven.com/a/${id}`, licenceUrl: 'https://polyhaven.com/license' },
  ambientcg: { page: id => `https://ambientcg.com/a/${id}`, licenceUrl: 'https://docs.ambientcg.com/license/' },
};

// ---- URL building (pure) ----
export const url = {
  phList: (type, cat) => `${PH}/assets?t=${PH_TYPE[type] ?? 'all'}${cat ? `&c=${encodeURIComponent(cat)}` : ''}`,
  phInfo: id => `${PH}/info/${encodeURIComponent(id)}`,
  phFiles: id => `${PH}/files/${encodeURIComponent(id)}`,
  cgSearch: (q, type, limit = 10) => `${CG}?q=${encodeURIComponent(q)}${CG_TYPE[type] ? `&type=${CG_TYPE[type]}` : ''}&limit=${limit}&include=title,downloads`,
  cgById: id => `${CG}?id=${encodeURIComponent(id)}&include=title,downloads`,
};

export function makeClient(fetchImpl = fetch) {
  const get = async u => { const r = await fetchImpl(u, { headers: { 'User-Agent': UA } }); if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${u}`); return r; };
  return { json: async u => (await get(u)).json(), bytes: async u => Buffer.from(await (await get(u)).arrayBuffer()) };
}

// `runner(argv)` is injectable so tests never touch the real register.
export function register(file, { source, author, kind, title, note }, runner = a => { const r = spawnSync(process.execPath, [INTAKE, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`asset-intake failed: ${r.stderr || r.stdout}`); return r.stdout.trim(); }) {
  return runner(['add', '--file', path.resolve(file), '--source', source, '--license', 'CC0-1.0', '--author', author, '--kind', kind, '--title', title, '--note', note]);
}

const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const save = (f, b) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); };

export async function search(source, q, { type, limit = 10 } = {}, client = makeClient()) {
  if (source === 'polyhaven') {
    const all = await client.json(url.phList(type)), toks = q.toLowerCase().split(/\s+/).filter(Boolean);
    return Object.entries(all).filter(([id, a]) => { const hay = [id, a.name, ...(a.tags ?? []), ...(a.categories ?? [])].join(' ').toLowerCase(); return toks.every(t => hay.includes(t)); })
      .slice(0, limit).map(([id, a]) => ({ id, name: a.name, kind: PH_KIND[a.type], authors: Object.keys(a.authors ?? {}).join(', '), maxRes: (a.max_resolution ?? []).join('x') }));
  }
  if (source === 'ambientcg') {
    if (type === 'model') throw new Error('ambientCG has no model API here; use polyhaven for models');
    const j = await client.json(url.cgSearch(q, type, limit));
    return j.assets.map(a => ({ id: a.id, name: a.title ?? a.id, kind: type ?? 'texture', authors: 'ambientCG', sizes: Object.fromEntries((a.downloads ?? []).filter(d => /JPG/.test(d.attributes)).map(d => [d.attributes, d.size])) }));
  }
  throw new Error(`source must be polyhaven or ambientcg`);
}

// Returns [{ file, kind, source, author, title, note }] for what was downloaded (already saved).
export async function get(source, id, { dest, res = '1k', maps = 'Diffuse,nor_gl,arm', format = 'jpg', unzip = false } = {}, client = makeClient()) {
  if (!dest) throw new Error('--dest <folder> is required');
  const dir = path.join(dest, source, id), out = [], licNote = `CC0 per ${SOURCES[source].licenceUrl}; fetched by API (${UA}) at ${res}`;
  if (source === 'polyhaven') {
    const info = await client.json(url.phInfo(id)), files = await client.json(url.phFiles(id));
    const kind = PH_KIND[info.type] ?? 'texture', author = Object.keys(info.authors ?? {}).join(', ') || 'Poly Haven', title = info.name ?? id;
    const grab = async (f, rel, entry) => { const b = await client.bytes(entry.url); if (entry.md5 && md5(b) !== entry.md5) throw new Error(`md5 mismatch for ${entry.url}`); const p = path.join(dir, rel); save(p, b); out.push({ file: p, kind, source: SOURCES.polyhaven.page(id), author, title: `${title} (${rel})`, note: `${licNote}; ${rel}` }); };
    if (kind === 'model') {
      const g = files.gltf?.[res]?.gltf; if (!g) throw new Error(`no gltf at ${res} for ${id} (have ${Object.keys(files.gltf ?? {})})`);
      await grab(null, path.basename(new URL(g.url).pathname), g);
      for (const [rel, e] of Object.entries(g.include ?? {})) await grab(null, rel, e);
    } else if (kind === 'hdri') {
      const h = files.hdri?.[res]; const e = h?.hdr ?? h?.exr; if (!e) throw new Error(`no hdri at ${res} for ${id} (have ${Object.keys(files.hdri ?? {})})`);
      await grab(null, path.basename(new URL(e.url).pathname), e);
    } else {
      for (const m of maps.split(',')) {
        const e = files[m]?.[res]; const f = e?.[format] ?? e?.png ?? e?.jpg;
        if (!f) { console.error(`  skip map '${m}': not available at ${res} (maps: ${Object.keys(files).join(', ')})`); continue; }
        await grab(null, path.basename(new URL(f.url).pathname), f);
      }
      if (!out.length) throw new Error(`no requested maps found for ${id} at ${res}`);
    }
  } else if (source === 'ambientcg') {
    const j = await client.json(url.cgById(id)), a = j.assets?.[0]; if (!a) throw new Error(`ambientCG has no asset '${id}'`);
    const want = `${res.toUpperCase()}-${format.toUpperCase()}`, d = a.downloads?.find(x => x.attributes === want);
    if (!d) throw new Error(`no ${want} download for ${id} (have ${a.downloads?.map(x => x.attributes).join(', ')})`);
    const b = await client.bytes(d.url); if (d.size && b.length !== d.size) throw new Error(`size mismatch for ${d.url}: ${b.length} vs ${d.size}`);
    const p = path.join(dir, `${a.id}_${want}.zip`); save(p, b);
    out.push({ file: p, kind: 'texture', source: SOURCES.ambientcg.page(a.id), author: 'ambientCG', title: `${a.title ?? a.id} (${want})`, note: `${licNote}; ${a.id}_${want}.zip` });
    if (unzip) { const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'unzip'; spawnSync(tar, process.platform === 'win32' ? ['-xf', p, '-C', dir] : ['-o', p, '-d', dir]); }
  } else throw new Error('source must be polyhaven or ambientcg');
  return out;
}

function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { if (!argv[i].startsWith('--')) { o._.push(argv[i]); continue; } const k = argv[i].slice(2); o[k] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } return o; }

async function selftest(offline) {
  // 1. URL building
  assert.equal(url.phList('texture'), 'https://api.polyhaven.com/assets?t=textures');
  assert.equal(url.phFiles('Barrel_02'), 'https://api.polyhaven.com/files/Barrel_02');
  assert.equal(url.cgSearch('brick wall', 'texture', 3), 'https://ambientcg.com/api/v3/assets?q=brick%20wall&type=material&limit=3&include=title,downloads');
  assert.equal(url.cgById('Bricks105'), 'https://ambientcg.com/api/v3/assets?id=Bricks105&include=title,downloads');
  // 2. mock fetch: UA is sent, files saved, md5 enforced, registration argv correct
  const tex = Buffer.from('fake-jpg'), seen = [];
  const files = { arm: { '1k': { jpg: { url: 'https://dl.example/t_arm_1k.jpg', md5: md5(tex), size: tex.length } } }, Diffuse: { '1k': { jpg: { url: 'https://dl.example/t_diff_1k.jpg', md5: md5(tex) } } } };
  const mockFetch = async (u, opt) => { seen.push([u, opt?.headers?.['User-Agent']]); const body = u.includes('/info/') ? { type: 1, name: 'Test Rock', authors: { 'Jane Doe': 'All' } } : u.includes('/files/') ? files : null;
    return body ? { ok: true, json: async () => body } : { ok: true, arrayBuffer: async () => tex.buffer.slice(tex.byteOffset, tex.byteOffset + tex.length) }; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-selftest-'));
  try {
    const got = await get('polyhaven', 'test_rock', { dest: dir, res: '1k', maps: 'arm,Diffuse' }, makeClient(mockFetch));
    assert.equal(got.length, 2); assert.ok(seen.every(([, ua]) => ua === 'game-studio-fetch/1.0'), 'every call sends the User-Agent');
    assert.ok(fs.existsSync(path.join(dir, 'polyhaven', 'test_rock', 't_arm_1k.jpg')));
    let argv; register(got[0].file, got[0], a => (argv = a));
    const at = k => argv[argv.indexOf(k) + 1];
    assert.equal(at('--license'), 'CC0-1.0'); assert.equal(at('--author'), 'Jane Doe'); assert.equal(at('--source'), 'https://polyhaven.com/a/test_rock'); assert.equal(at('--kind'), 'texture');
    files.arm['1k'].jpg.md5 = 'bad';
    await assert.rejects(get('polyhaven', 'test_rock', { dest: dir, maps: 'arm' }, makeClient(mockFetch)), /md5 mismatch/);
    await assert.rejects(get('ambientcg', 'x', {}, makeClient(mockFetch)), /dest/);
    console.log('  mock: URLs, User-Agent, md5 check and registration argv ok');
    // 3. one tiny live fetch: Poly Haven aerial_rocks_02 ARM map at 1k (about 200 KB, CC0)
    if (!offline) {
      const live = await get('polyhaven', 'aerial_rocks_02', { dest: dir, res: '1k', maps: 'arm' });
      assert.equal(live.length, 1); const st = fs.statSync(live[0].file);
      assert.ok(st.size > 50e3 && st.size < 2e6, `unexpected size ${st.size}`); assert.equal(live[0].author, 'Rob Tuytel');
      console.log(`  live: ${path.basename(live[0].file)} ${st.size} B, author ${live[0].author}, md5 verified`);
    }
    console.log('fetch-asset selftest ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2)), [cmd, source, q] = a._;
  (async () => {
    if (cmd === 'selftest') return selftest(!!a.offline);
    if (cmd === 'search' && source && q) { for (const r of await search(source, q, { type: a.type, limit: +(a.limit ?? 10) })) console.log(JSON.stringify(r)); return; }
    if (cmd === 'get' && source && q) {
      const got = await get(source, q, { dest: a.dest && path.resolve(a.dest), res: a.res, maps: a.maps, format: a.format, unzip: !!a.unzip });
      for (const g of got) { console.log(g.file); if (!a['no-register']) console.log(register(g.file, g)); }
      return;
    }
    console.log('usage: node fetch-asset.mjs search|get|selftest (see header)');
  })().catch(e => { console.error('error: ' + e.message); process.exit(1); });
}
