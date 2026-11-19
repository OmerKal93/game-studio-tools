// PreToolUse hook for reviewer subagents: allow only read-only Bash commands.
// Exit 2 blocks the call (stderr goes back to the agent). Run with --self-test to check the rules.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The two review tools are allowed only from this checkout's own tools/review folder, not from any path the agent names.
export const REVIEW_DIR = fileURLToPath(new URL('../review/', import.meta.url)).replaceAll('\\', '/');
const dirRe = REVIEW_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]')
  .replace(/^([A-Za-z]):/, (m, d) => `(?:${m}|[\\\\/]${d})`); // C:/x or the Git Bash form /c/x

const ALLOW = [
  /^git (diff|log|show|status|grep|blame|rev-parse|ls-files|ls-tree|cat-file|merge-base|describe)\b/,
  /^git branch( (--show-current|--list|-a|-r|-v|-vv|--contains \S+|--merged|--no-merged))*$/,
  /^git worktree list\b/,
  new RegExp(`^node ['"]?${dirRe}secret-scan\\.mjs\\b`, 'i'),
  new RegExp(`^bash ['"]?${dirRe}codex-review\\.sh\\b`, 'i'),
  /^(ls|wc|pwd)\b/,
];
// Tests and package scripts run repo code, so reviewers get test output from the orchestrator instead of running it.
// Chaining, redirection, substitution and newlines could smuggle a second command past the allowlist.
const FORBIDDEN = /[;&|`<>\r\n]|\$\(/;
// Git options that write files, read config that runs programs, or swap the executable.
const GIT_BAD = /(^|\s)(--output|--ext-diff|--textconv|-c|--config-env|--exec-path|--upload-pack|-O|--open-files-in-pager)(\s|=|$)/;

export function allowed(cmd) {
  const raw = (cmd ?? '').trim();
  if (!raw || FORBIDDEN.test(raw) || GIT_BAD.test(raw)) return false;
  // `git -C <path> <sub>` is the same read as `git <sub>`.
  const c = raw.replace(/^git -C ("[^"]+"|'[^']+'|\S+) /, 'git ');
  return ALLOW.some(r => r.test(c));
}

if (process.argv.includes('--self-test')) {
  const yes = ['git diff main...HEAD', 'git log --oneline -5', `node ${REVIEW_DIR}secret-scan.mjs .`,
    'git branch --contains abc', 'git branch --show-current', 'ls -la', 'git -C /work/x log --oneline -1', 'git worktree list'];
  const no = ['git commit -m x', 'git push', 'rm -rf x', 'git diff && rm x', 'git log > f', 'echo $(rm x)',
    'git branch -D x', 'git branch newref', 'npm install', 'npm test', 'npx tsc --noEmit', 'node --test tests/', 'node script.mjs',
    'git checkout .', '', 'git -C /work/x push', 'node /elsewhere/tools/review/secret-scan.mjs .', 'git diff --output=f', 'git -c core.pager=x log', 'git diff --ext-diff',
    'git log\nrm x', 'git -C "a;b" log', 'head -c 9 f', 'git grep -O x'];
  const bad = [...yes.filter(c => !allowed(c)).map(c => 'should allow: ' + c), ...no.filter(c => allowed(c)).map(c => 'should block: ' + JSON.stringify(c))];
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  console.log(`readonly-bash self-test: PASS (${yes.length + no.length} cases)`);
  process.exit(0);
}

// Settings-level use: `--reviewers-only` applies the allowlist only to these agent types; everyone else passes.
const REVIEWERS = ['code-reviewer', 'security-reviewer'];
let input;
try { input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}'); }
catch { process.stderr.write('Blocked by readonly-bash: unreadable hook input\n'); process.exit(2); }
if (process.argv.includes('--reviewers-only') && !REVIEWERS.includes(input.agent_type)) process.exit(0);
const cmd = input.tool_input?.command ?? '';
if (!allowed(cmd)) {
  process.stderr.write('Blocked by readonly-bash: reviewers may run only read-only git, ls/wc, secret-scan and codex-review. Ask the orchestrator for test output.\n');
  process.exit(2);
}
process.exit(0);
