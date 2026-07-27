// Determinism lint — the guardrail behind the whole fixed-tick refactor.
//
// Engine code must be a pure function of (seed, actions): no wall clock, no
// unseeded randomness, no per-frame scheduling, and no implementation-defined
// transcendentals leaking straight from `Math`. This scanner fails (exit 1) if
// any engine source reaches for one of those. Run via `npm run lint:determinism`
// and in CI alongside the golden-trace check.
//
// It is deliberately zero-dependency: it strips comments and string/template
// literals with a small char scanner (so a module's own prose about
// `Math.random` doesn't trip it), then matches forbidden call sites in the
// remaining code. Not a full parser — but the engine is plain, regex-free code,
// and the golden traces are the real backstop; this just catches the obvious
// nondeterminism early and loudly.

import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Directories whose contents are exempt: tests legitimately generate inputs with
// Math.random and name forbidden APIs; tools (this file included) are not engine
// code and never run inside step().
const EXEMPT_DIRS = new Set(['test', 'tools', 'node_modules']);

// The only file permitted to call the raw transcendentals — it is the wrapper
// that exists so every other module doesn't. It still may not touch the clock or
// randomness, so time/RNG rules below still apply to it.
const TRANSCENDENTAL_WRAPPER = 'mathx.js';

// Wall clock, scheduling, and unseeded randomness — banned everywhere in engine
// code, no exceptions.
const FORBIDDEN_ALWAYS = [
  { re: /\bMath\s*\.\s*random\b/, msg: 'Math.random (use rng.js — the seed lives in sim state)' },
  { re: /\bDate\s*\.\s*now\b/, msg: 'Date.now (engine reads tick count, never the wall clock)' },
  { re: /\bperformance\s*\.\s*now\b/, msg: 'performance.now (engine reads tick count, never the wall clock)' },
  { re: /\bnew\s+Date\b/, msg: 'new Date (engine reads tick count, never the wall clock)' },
  { re: /\brequestAnimationFrame\b/, msg: 'requestAnimationFrame (rendering concern — belongs in the presentation layer)' },
  { re: /\bcancelAnimationFrame\b/, msg: 'cancelAnimationFrame (rendering concern — belongs in the presentation layer)' },
  { re: /\bsetTimeout\b/, msg: 'setTimeout (engine advances by discrete ticks, not timers)' },
  { re: /\bsetInterval\b/, msg: 'setInterval (engine advances by discrete ticks, not timers)' },
];

// Implementation-defined transcendentals — cross-engine bit variance risk, so
// they must route through mathx.js (the sanctioned wrapper). Deterministic Math
// members (imul, floor, ceil, round, abs, min, max, sqrt, sign, trunc) are fine.
const TRANSCENDENTAL_FNS = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'exp', 'expm1', 'pow', 'cbrt', 'hypot',
  'log', 'log2', 'log10', 'log1p',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
];
const FORBIDDEN_TRANSCENDENTAL = {
  re: new RegExp(`\\bMath\\s*\\.\\s*(${TRANSCENDENTAL_FNS.join('|')})\\b`),
  msg: 'raw Math transcendental (route through mathx.js)',
};

// Replace comments and string/template/regex-literal contents with spaces so
// line numbers and offsets are preserved but their text can't match a rule.
function stripNonCode(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | squote | dquote | template | regex
  // Track whether a `/` starts a regex (after operators) or is a divide op.
  let prevSignificant = '';
  const keep = (ch) => out.push(ch);
  const blank = (ch) => out.push(ch === '\n' ? '\n' : ' ');

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; blank(ch); i++; blank(next); i++; continue; }
      if (ch === '/' && next === '*') { state = 'block'; blank(ch); i++; blank(next); i++; continue; }
      if (ch === "'") { state = 'squote'; blank(ch); i++; continue; }
      if (ch === '"') { state = 'dquote'; blank(ch); i++; continue; }
      if (ch === '`') { state = 'template'; blank(ch); i++; continue; }
      if (ch === '/' && regexCanStart(prevSignificant)) { state = 'regex'; blank(ch); i++; continue; }
      keep(ch);
      if (!/\s/.test(ch)) prevSignificant = ch;
      i++;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; keep(ch); i++; continue; }
      blank(ch); i++; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; blank(ch); i++; blank(next); i++; continue; }
      blank(ch); i++; continue;
    }
    if (state === 'squote' || state === 'dquote' || state === 'regex') {
      const closer = state === 'squote' ? "'" : state === 'dquote' ? '"' : '/';
      if (ch === '\\') { blank(ch); i++; if (i < n) { blank(src[i]); i++; } continue; }
      if (ch === closer) { state = 'code'; blank(ch); i++; prevSignificant = closer === '/' ? 'x' : ')'; continue; }
      blank(ch); i++; continue;
    }
    if (state === 'template') {
      // Note: `${ ... }` interpolations are blanked too. That is conservative
      // (a forbidden call inside an interpolation would be missed) but such
      // calls don't belong in engine strings, and false negatives here are
      // caught by the golden traces regardless.
      if (ch === '\\') { blank(ch); i++; if (i < n) { blank(src[i]); i++; } continue; }
      if (ch === '`') { state = 'code'; blank(ch); i++; prevSignificant = ')'; continue; }
      blank(ch); i++; continue;
    }
  }
  return out.join('');
}

// A `/` begins a regex literal (not division) when the previous significant char
// is one after which a value cannot appear — i.e. an operator or opener.
function regexCanStart(prev) {
  if (prev === '') return true;
  return '(,=:[!&|?{};+-*%^~<>'.includes(prev);
}

function collectJsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ENGINE_DIR, full);
    const top = rel.split(/[/\\]/)[0];
    if (statSync(full).isDirectory()) {
      if (EXEMPT_DIRS.has(entry)) continue;
      collectJsFiles(full, acc);
    } else if (entry.endsWith('.js')) {
      if (EXEMPT_DIRS.has(top)) continue;
      acc.push(full);
    }
  }
  return acc;
}

// Scan already-loaded source. Pure and file-system-free so it can be unit
// tested with inline snippets. `isWrapper` exempts the one sanctioned home for
// raw transcendentals (mathx.js).
export function lintSource(raw, { isWrapper = false } = {}) {
  const code = stripNonCode(raw);
  const rules = [...FORBIDDEN_ALWAYS];
  if (!isWrapper) rules.push(FORBIDDEN_TRANSCENDENTAL);

  const violations = [];
  code.split('\n').forEach((line, idx) => {
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (m) violations.push({ line: idx + 1, col: m.index + 1, msg: rule.msg });
    }
  });
  return violations;
}

function lintFile(file) {
  const rel = relative(ENGINE_DIR, file);
  const raw = readFileSync(file, 'utf8');
  const found = lintSource(raw, { isWrapper: rel === TRANSCENDENTAL_WRAPPER });
  return found.map((v) => ({ file: rel, ...v }));
}

function main() {
  const files = collectJsFiles(ENGINE_DIR);
  const all = files.flatMap(lintFile);
  if (all.length === 0) {
    console.log(`determinism lint: clean (${files.length} engine file(s) scanned)`);
    process.exit(0);
  }
  console.error(`determinism lint: ${all.length} violation(s)\n`);
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}:${v.col}  ${v.msg}`);
  }
  console.error('\nEngine code must be a pure function of (seed, actions).');
  process.exit(1);
}

// Run only when invoked directly (`node tools/lint-determinism.js`), not when
// imported by a test.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
