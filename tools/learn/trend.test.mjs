import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRounds, parseHours, parseCsv, readTrend, renderSvg, BASELINE } from './trend.mjs';

// Synthetic rows in the shape of a real log: a range, a "0 (text)" cell, an unquoted comma inside parentheses, and one task spread over two rows.
const real = [
  'task,lane,round,date,hours,verdict,lesson',
  'baseline,art,1-20,2026-01-03..2026-01-05,38,PASS with fixes,hand-built first',
  'task-a,art,0 (about 10 self-review passes before the rule),2026-01-06,4,open,first try',
  'task-a,art,1 (pre-review, second opinion),2026-01-07,2.5,open,second row of the same task',
  'task-b,tools,2,2026-01-08,3,PASS,"quoted, comma"',
].join('\n') + '\n';

test('messy cells parse', () => {
  assert.equal(parseRounds('1-20'), 20);
  assert.equal(parseRounds('0 (about 10 self-review render passes before the rule)'), 0);
  assert.equal(parseRounds('1 (pre-review, Gemini first pass)'), 1);
  assert.equal(parseRounds('3'), 3);
  assert.equal(parseRounds(''), null);
  assert.equal(parseRounds('n/a'), null);
  assert.equal(parseHours('38'), 38); assert.equal(parseHours('0.5'), 0.5);
  assert.equal(parseHours(''), null); assert.equal(parseHours('about 3'), null);
});

test('quoted commas and newlines survive the CSV parser', () => {
  assert.deepEqual([...parseCsv('a,b\n"x, y","q ""z"""\n')], [['a', 'b'], ['x, y', 'q "z"']]);
});

test('a realistic ROUNDS.csv parses: baseline 20 rounds / 38 h, merged tasks, no crash', () => {
  const { tasks, warnings } = readTrend(real);
  const b = tasks.find((t) => t.task === BASELINE);
  assert.equal(b.rounds, 20); assert.equal(b.hours, 38); assert.equal(b.date, '2026-01-03');
  const taskA = tasks.find((t) => t.task === 'task-a');
  assert.equal(taskA.rounds, 1); assert.equal(taskA.hours, 6.5);
  const rules = tasks.find((t) => t.task === 'task-b');
  assert.equal(rules.rounds, 2); assert.equal(rules.hours, 3);
  assert.equal(tasks[0].task, BASELINE); assert.equal(warnings.length, 0); // oldest first
});

test('unreadable rows are skipped with a warning', () => {
  const { tasks, warnings } = readTrend('task,lane,round,date,hours\nok,x,2,2026-11-18,4\nbad,x,n/a,2026-11-19,\n,x,1,2026-11-19,1\n');
  assert.deepEqual(tasks.map((t) => t.task), ['ok']);
  assert.ok(warnings.length >= 2);
});

test('an unclosed quote warns; a BOM is stripped; an empty file is a clear error', () => {
  const { warnings } = readTrend('task,lane,round,date,hours\nok,x,2,2026-11-18,4\nbad,x,"1,2026-11-19,3\n');
  assert.ok(warnings.some((w) => /quote is still open/.test(w)));
  assert.deepEqual(readTrend('﻿task,lane,round,date,hours\nok,x,2,2026-11-18,4\n').tasks.map((t) => t.task), ['ok']);
  assert.throws(() => readTrend(''), /empty/);
});

test('bar labels are dark text without stroke on light fills', () => {
  const svg = renderSvg(readTrend(real).tasks);
  assert.doesNotMatch(svg, /stroke="#000" stroke-width="0.4"|fill="#fff" /);
  assert.match(svg, /fill="#111">rounds: /);
});

test('SVG is self-contained, 390 wide, marks the baseline', () => {
  const svg = renderSvg(readTrend(real).tasks);
  assert.match(svg, /width="390"/);
  assert.match(svg, /\[BASELINE\]/);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)|@import|<image|href=/);
});
