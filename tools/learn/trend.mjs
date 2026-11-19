#!/usr/bin/env node
// Usage: node tools/learn/trend.mjs [ROUNDS.csv] --out trend.svg
// Round trend as one self-contained SVG, 390 px wide (phone), generic fonts only. Per task, in date order: rounds (highest round
// number logged; a range like "1-20" counts its upper end, "0 (text)" its leading number) and hours (sum of the readable cells).
// The task named by TREND_BASELINE (default "baseline") is marked BASELINE and its values are drawn as dashed lines through the other tasks.
// Cells that cannot be read are skipped with a warning on stderr.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BASELINE = process.env.TREND_BASELINE || 'baseline'; // the task whose rounds and hours are drawn as the reference

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  rows.unclosedQuote = q; // a quote still open at EOF swallowed the rest of the file
  return rows;
}

const nums = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
// "1-20" -> 20, "0 (about 10 passes)" -> 0, "1 (pre-review, x)" -> 1; the range form is only a leading "a-b" or "a..b".
export function parseRounds(s) {
  const m = String(s).trim().match(/^(\d+)\s*(?:-|\.\.)\s*(\d+)/);
  if (m) return Number(m[2]);
  const n = String(s).trim().match(/^\d+/);
  return n ? Number(n[0]) : null;
}
export function parseHours(s) { const t = String(s).trim(); return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null; }
export const parseDate = (s) => (String(s).match(/\d{4}-\d{2}-\d{2}/) || [null])[0];

// Real rows have unquoted commas inside parentheses ("1 (pre-review, Gemini first pass)"), which shift every later column.
// While a row is longer than the header, glue a cell with an unclosed "(" to the next one.
export function repairRow(r, n) {
  const row = [...r];
  for (let i = 0; i < row.length - 1 && row.length > n; i++)
    while (row.length > n && i < row.length - 1 && (row[i].match(/\(/g) || []).length > (row[i].match(/\)/g) || []).length) row.splice(i, 2, row[i] + ',' + row[i + 1]);
  return row;
}

// Returns {tasks:[{task,date,rounds,hours}], warnings}. Several rows of one task are merged: max rounds, summed hours.
export function readTrend(csvText) {
  const parsed = parseCsv(csvText.replace(/^﻿/, '')); const [head, ...body] = parsed; const warnings = []; const by = new Map();
  if (!head) throw new Error('ROUNDS.csv is empty');
  if (parsed.unclosedQuote) warnings.push('a quote is still open at the end of the file; the rows after it were swallowed into one cell');
  const ix = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  for (const k of ['task', 'round', 'date', 'hours']) if (!(k in ix)) throw new Error(`ROUNDS.csv has no "${k}" column`);
  body.forEach((raw, n) => {
    const r = repairRow(raw, head.length);
    const at = `row ${n + 2} (${r[ix.task] || '?'})`; const task = (r[ix.task] || '').trim();
    if (!task) { warnings.push(`${at}: no task name, skipped`); return; }
    const t = by.get(task) || { task, date: null, rounds: null, hours: null };
    by.set(task, t);
    const rounds = parseRounds(r[ix.round]); const hours = parseHours(r[ix.hours]); const date = parseDate(r[ix.date]);
    if (rounds === null) warnings.push(`${at}: rounds "${r[ix.round]}" unreadable, skipped`); else t.rounds = Math.max(t.rounds ?? 0, rounds);
    if (hours === null) { if ((r[ix.hours] || '').trim()) warnings.push(`${at}: hours "${r[ix.hours]}" unreadable, skipped`); } else t.hours = (t.hours ?? 0) + hours;
    if (date === null) warnings.push(`${at}: date "${r[ix.date]}" unreadable`); else if (!t.date || date < t.date) t.date = date;
  });
  const tasks = [...by.values()].filter((t) => { const ok = t.rounds !== null || t.hours !== null; if (!ok) warnings.push(`task ${t.task}: no readable rounds or hours, skipped`); return ok; });
  // date order; undated tasks last; ties keep file order (sort is stable)
  tasks.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  return { tasks, warnings };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderSvg(tasks) {
  const W = 390, L = 16, BW = W - 2 * L, BLOCK = 118;
  const maxR = Math.max(1, ...tasks.map((t) => t.rounds ?? 0)), maxH = Math.max(1, ...tasks.map((t) => t.hours ?? 0));
  const base = tasks.find((t) => t.task === BASELINE);
  const H = 56 + tasks.length * BLOCK + 8;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">\n<rect width="${W}" height="${H}" fill="#fff"/>\n`;
  s += `<text x="${L}" y="30" font-size="22" font-weight="bold" fill="#111">Rounds and hours per task</text>\n`;
  s += `<text x="${L}" y="48" font-size="14" fill="#444">oldest first; dashed line = baseline</text>\n`;
  tasks.forEach((t, i) => {
    const y0 = 62 + i * BLOCK; const isB = t.task === BASELINE;
    const bar = (y, val, max, color, label, ref) => {
      let o = `<rect x="${L}" y="${y}" width="${BW}" height="22" fill="#eee"/>\n`;
      if (val === null) return o + `<text x="${L + 6}" y="${y + 17}" font-size="16" fill="#666">${label}: no data</text>\n`;
      o += `<rect x="${L}" y="${y}" width="${Math.max(2, (val / max) * BW).toFixed(1)}" height="22" fill="${color}"/>\n`;
      if (ref !== null && !isB) { const rx = L + (ref / max) * BW; o += `<line x1="${rx.toFixed(1)}" y1="${y - 3}" x2="${rx.toFixed(1)}" y2="${y + 25}" stroke="#000" stroke-width="2" stroke-dasharray="4 3"/>\n`; }
      return o + `<text x="${L + 6}" y="${y + 17}" font-size="16" font-weight="bold" fill="#111">${label}: ${val}</text>\n`;
    };
    s += `<text x="${L}" y="${y0 + 16}" font-size="17" font-weight="bold" fill="#111">${esc(t.task.length > 30 ? t.task.slice(0, 29) + '…' : t.task)}${isB ? '  [BASELINE]' : ''}</text>\n`;
    s += `<text x="${L}" y="${y0 + 36}" font-size="14" fill="#444">${esc(t.date ?? 'no date')}</text>\n`;
    s += bar(y0 + 46, t.rounds, maxR, isB ? '#fcd34d' : '#93c5fd', 'rounds', base ? base.rounds : null);
    s += bar(y0 + 78, t.hours, maxH, isB ? '#fcd34d' : '#6ee7b7', 'hours', base ? base.hours : null);
  });
  return s + '</svg>\n';
}

function main(argv) {
  const oi = argv.indexOf('--out');
  const out = oi >= 0 ? argv.splice(oi, 2)[1] : null;
  if (!out) { console.error('usage: trend.mjs [ROUNDS.csv] --out trend.svg'); return 2; }
  try {
    const { tasks, warnings } = readTrend(readFileSync(argv[0] || 'ROUNDS.csv', 'utf8'));
    for (const w of warnings) console.error('warning: ' + w);
    writeFileSync(out, renderSvg(tasks));
    console.log(`wrote ${out}: ${tasks.length} tasks, ${warnings.length} warnings`);
    return 0;
  } catch (e) { console.error('error: ' + e.message); return 2; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
