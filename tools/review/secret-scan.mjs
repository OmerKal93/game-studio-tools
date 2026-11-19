// Secret scan that never prints a secret: reports file:line (or commit:file) and the pattern name only.
// Usage: node secret-scan.mjs <repo-dir> [--history]   |   node secret-scan.mjs --self-test
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PATTERNS = {
  'github-token': /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  'google-api-key': /\bAIza[0-9A-Za-z_-]{30,}\b/,
  'openai-key': /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/,
  'anthropic-key': /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  'aws-key-id': /\bAKIA[0-9A-Z]{16}\b/,
  'slack-token': /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  'private-key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  'jwt': /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/,
  'password-assign': /\b(password|passwd|keystorepassword|keypassword|token|secret)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
};

export function scanText(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of Object.entries(PATTERNS)) if (re.test(line)) hits.push({ line: i + 1, name });
  });
  return hits;
}

if (process.argv.includes('--self-test')) {
  const sample = ['ok line', 'key=AIza' + 'x'.repeat(35), 'gho_' + 'a'.repeat(36), 'password = hunter2hunter2', 'nothing here'].join('\n');
  const hits = scanText(sample).map(h => h.line + ':' + h.name).join(',');
  const want = '2:google-api-key,3:github-token,4:password-assign';
  if (hits !== want) { console.error('secret-scan self-test FAIL: ' + hits); process.exit(1); }
  console.log('secret-scan self-test: PASS (3 hits, values never printed)');
  process.exit(0);
}

const dir = process.argv[2] ?? '.';
// stderr ignored: git diagnostics can echo repo-controlled paths.
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
const nul = s => s.split('\0').filter(Boolean);
let total = 0, unread = 0;
// A path that itself matches a secret pattern is masked, so the report never leaks it.
const safe = p => (scanText(p).length ? '<path-with-secret-pattern>' : p);
const report = (where, h) => { total++; console.log(`${safe(where)}:${h.line}  ${h.name}`); };

if (process.argv.includes('--history')) {
  for (const sha of git('rev-list', '--all').trim().split('\n').filter(Boolean)) {
    for (const f of nul(git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha))) {
      let body; try { body = git('show', `${sha}:${f}`); } catch { unread++; continue; } // deleted in this commit
      for (const h of scanText(body)) report(`${sha.slice(0, 8)}:${f}`, h);
    }
  }
} else {
  // The working tree as it is now, staged or not, for every tracked file.
  for (const f of nul(git('ls-files', '-z'))) {
    let body; try { body = readFileSync(join(dir, f), 'utf8'); } catch { unread++; continue; }
    for (const h of scanText(body)) report(f, h);
  }
}
console.log(`secret-scan: ${total} location(s), ${unread} unreadable; values are never printed`);
