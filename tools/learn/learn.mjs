// Learning loop on Gemini or Claude. Run through the DPAPI wrapper (or just export the API key yourself):
//   powershell -ExecutionPolicy Bypass -File tools\secrets\with-secret.ps1 -Name GOOGLE_AI_API_KEY -Run "node tools\learn\learn.mjs review <checklist.md> <img...> [--out f.md]"
//   ... -Run "node tools\learn\learn.mjs retro [--out f.md]"
//   Claude as second eye: with-secret.ps1 -Name ANTHROPIC_API_KEY -Run "node tools\learn\learn.mjs review <checklist> <img...> --by claude"
// review: pre-review of frames against a round-0 checklist, before a human reviewer.
// retro:  reads ROUNDS.csv + LEARNINGS.md (from the current folder, or LEARN_ROUNDS / LEARN_LEARNINGS), finds repeated lessons that should become a tool or recipe change, and the trend.
// Every call appends tokens to ~/.game-studio-tools/learn-spend.csv (LEARN_LOG overrides). LEARN_CONTEXT describes your game for the reviewer prompt.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';

const MODEL = process.env.LEARN_MODEL || 'gemini-pro-latest';
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function logSpend(task, model, inTok, outTok, thinkTok) {
  const log = process.env.LEARN_LOG || join(homedir(), '.game-studio-tools', 'learn-spend.csv'); // raw outputs stay out of repo trees
  mkdirSync(dirname(log), { recursive: true });
  if (!existsSync(log)) writeFileSync(log, 'utc,task,model,prompt_tokens,output_tokens,thinking_tokens\n');
  appendFileSync(log, `${new Date().toISOString()},${task},${model},${inTok},${outTok},${thinkTok}\n`);
}

export async function gemini(parts, task) {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error('GOOGLE_AI_API_KEY missing: run through tools\\secrets\\with-secret.ps1');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2 } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 400)}`);
  const u = j.usageMetadata ?? {};
  logSpend(task, MODEL, u.promptTokenCount ?? 0, u.candidatesTokenCount ?? 0, u.thoughtsTokenCount ?? 0);
  const text = (j.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('');
  if (!text) throw new Error(`Gemini returned no text (finish: ${j.candidates?.[0]?.finishReason ?? 'none'})`);
  return text;
}

// Second eye on Claude (billed to your Anthropic API account).
// Run through with-secret.ps1 -Name ANTHROPIC_API_KEY. Same prompt and images as Gemini so the two are comparable.
const CLAUDE_MODEL = process.env.LEARN_CLAUDE_MODEL || 'claude-opus-5-5';
export async function claude(parts, task) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing: run through tools\\secrets\\with-secret.ps1');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const content = parts.map(p => p.inline_data
    ? { type: 'image', source: { type: 'base64', media_type: p.inline_data.mime_type, data: p.inline_data.data } }
    : { type: 'text', text: p.text });
  const r = await new Anthropic({ baseURL: 'https://api.anthropic.com' }).beta.messages.create({ // pinned so a stray ANTHROPIC_BASE_URL never receives the key
    model: CLAUDE_MODEL, max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', // a policy decline re-runs on a fallback model in the same call
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content }],
  });
  logSpend(task, r.model, r.usage.input_tokens, r.usage.output_tokens, 0); // Claude bills thinking inside output_tokens
  if (r.stop_reason === 'refusal') throw new Error(`Claude declined (${r.stop_details?.category ?? 'no category'})`);
  const after = r.content.slice(r.content.map(b => b.type).lastIndexOf('fallback') + 1); // drop a declined model's partial text
  const text = after.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error(`Claude returned no text (stop: ${r.stop_reason})`);
  return text;
}

// MRQ PNGs carry alpha 0, so the model sees a black frame : flatten every PNG to RGB JPEG first.
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const img = f => {
  const ext = extname(f).toLowerCase();
  if (!MIME[ext]) throw new Error(`not an image: ${f}`);
  if (ext === '.png') {
    const t = join(tmpdir(), `learn-${process.pid}-${basename(f, ext)}.jpg`);
    const r = spawnSync(existsSync(FFMPEG) ? FFMPEG : 'ffmpeg', ['-loglevel', 'error', '-y', '-i', f, '-vf', 'format=rgb24', '-q:v', '2', t]);
    if (r.status !== 0) throw new Error(`could not flatten ${f}: ${r.stderr}`);
    f = t;
  }
  return { inline_data: { mime_type: MIME[extname(f).toLowerCase()], data: readFileSync(f).toString('base64') } };
};

const REVIEW = `You are the first-pass realism reviewer for ${process.env.LEARN_CONTEXT || 'a phone game'}.
Judge ONLY against the checklist below. For every checklist item give: PASS, FAIL or UNCLEAR, and one line of evidence naming where in which image.
Judge at the size a phone player sees (the image scaled to about 390 px wide); do not fail things only visible at 1:1.
Then list at most 3 problems NOT on the checklist that would read as fake at phone size, marked NEW.
End with one line: VERDICT: PASS or VERDICT: FAIL (n failing items).
Checklist:
`;

const RETRO = `You analyse a game studio's production log to make every build faster and better than the last.
Input: ROUNDS.csv (one row per review round) and LEARNINGS.md (one lesson per line).
Write, in short markdown:
1. Trend: rounds and hours per task, and whether they fall over time. Say plainly if there is too little data.
2. Repeated lessons: lessons that say the same thing in different words (cite their dates). For each, the ONE concrete change that would stop it recurring: a tool (name it and say what it checks), a recipe step, or a rule. Prefer an automatic check over a written rule.
3. Top 3 changes ranked by rounds saved per hour of work, each with the test that would prove it worked.
Do not invent data. Quote row and line content when you rely on it.
`;

const [cmd, ...rest] = process.argv.slice(2);
const outI = rest.indexOf('--out'); const out = outI >= 0 ? rest.splice(outI, 2)[1] : null;
// Default review is Claude; --by gemini switches the backend.
const byI = rest.indexOf('--by'); const by = byI >= 0 ? rest.splice(byI, 2)[1] : (cmd === 'review' ? 'claude' : 'gemini');
if (!['gemini', 'claude'].includes(by)) { console.error(`--by must be gemini or claude, not ${by}`); process.exit(2); }
if (cmd === 'retro' && by !== 'gemini') { console.error('--by only applies to review'); process.exit(2); }
let text;
if (cmd === 'review') {
  const [checklist, ...imgs] = rest;
  if (!checklist || !imgs.length) throw new Error('usage: review <checklist.md> <img...>');
  text = await (by === 'claude' ? claude : gemini)([{ text: REVIEW + readFileSync(checklist, 'utf8') }, ...imgs.flatMap(f => [{ text: `Image: ${basename(f)}` }, img(f)])], 'review');
} else if (cmd === 'retro') {
  text = await gemini([{ text: RETRO + '\n--- ROUNDS.csv ---\n' + readFileSync(resolve(process.env.LEARN_ROUNDS || 'ROUNDS.csv'), 'utf8') + '\n--- LEARNINGS.md ---\n' + readFileSync(resolve(process.env.LEARN_LEARNINGS || 'LEARNINGS.md'), 'utf8') }], 'retro');
} else {
  console.error('usage: learn.mjs review <checklist.md> <img...> [--by gemini|claude] [--out f] | retro [--out f]'); process.exit(2);
}
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, text); }
console.log(text);
