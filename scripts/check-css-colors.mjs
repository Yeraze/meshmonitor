#!/usr/bin/env node
// Count-based ratchet for hardcoded colours in stylesheets (#5594).
//
// A hex / rgb() / hsl() literal in a rule keeps one theme's colour under every
// theme; rules should read the `--color-*` role tokens that src/App.css
// defines per theme. This is the stylesheet half of the guardrail — the inline
// style half is the ESLint rule `meshmonitor-ui/no-hardcoded-color`.
//
// Usage:
//   node scripts/check-css-colors.mjs          — CI gate (exits 1 on regressions)
//   node scripts/check-css-colors.mjs --update — regenerate css-color-baseline.json
//
// What counts: each colour literal in a declaration value, in every .css file
// under src/ (CSS modules and the legacy global sheets alike).
//
// What does not:
//   - a custom-property definition (`--color-bg: #1e1e2e;`) — that is where a
//     token gets its value, so the theme blocks in App.css are not violations;
//   - selectors and at-rule preludes (`#root { ... }`);
//   - `url(...)` contents, comments, and colour functions whose arguments read
//     a custom property (`rgb(from var(--color-accent) r g b / 50%)`);
//   - a declaration marked `/* color-ok: #<issue> reason */`, on the same line
//     or on the line above. The issue reference and a reason are required.
//
// Semantics match scripts/lint-ratchet.mjs:
//   current > baseline → FAIL
//   current < baseline → PASS + advisory (run with --update to lock in)
//   file absent from baseline with literals → FAIL
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findColorLiterals } from './eslint-rules/no-hardcoded-color.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASELINE = path.join(ROOT, 'css-color-baseline.json');
const SCAN_DIR = 'src';

const COLOR_OK = /\/\*\s*color-ok:\s*#\d+\s+\S[\s\S]*?\*\//;

/** Replace every character but newlines with a space, so offsets and lines hold. */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Lines exempted by a `color-ok` marker: the marker's own line (trailing
 * comment) and, when the marker stands alone on its line, the line after it.
 *
 * @param {string} css
 * @returns {Set<number>} 1-based line numbers
 */
export function exemptLines(css) {
  const exempt = new Set();
  const lines = css.split('\n');
  lines.forEach((text, i) => {
    if (!COLOR_OK.test(text)) return;
    exempt.add(i + 1);
    if (text.replace(/\/\*[\s\S]*?\*\//g, '').trim() === '') exempt.add(i + 2);
  });
  return exempt;
}

/**
 * Colour literals in the declarations of one stylesheet.
 * Pure function — no IO. Exported for unit tests.
 *
 * @param {string} css
 * @returns {{ count: number, lines: number[] }} one line entry per literal
 */
export function countCssColors(css) {
  const exempt = exemptLines(css);
  const text = css.replace(/\/\*[\s\S]*?\*\//g, blank);

  const lines = [];
  let chunkStart = 0;
  let parens = 0;
  let quote = null;

  const lineAt = (offset) => {
    let line = 1;
    for (let i = 0; i < offset; i++) if (text[i] === '\n') line++;
    return line;
  };

  const declaration = (start, end) => {
    const chunk = text.slice(start, end);
    const colon = chunk.indexOf(':');
    if (colon === -1) return;
    const property = chunk.slice(0, colon).trim();
    if (property === '' || property.startsWith('--')) return;
    // Blank url(...) and quoted strings in place, so neither can pose as a
    // colour and the offsets below still map to source lines.
    const value = chunk
      .slice(colon + 1)
      .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/g, blank)
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, blank);
    const valueStart = start + colon + 1;
    let from = 0;
    for (const literal of findColorLiterals(value)) {
      const at = value.indexOf(literal, from);
      from = at + literal.length;
      const line = lineAt(valueStart + at);
      if (!exempt.has(line)) lines.push(line);
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') parens++;
    else if (ch === ')') parens = Math.max(0, parens - 1);
    else if (parens > 0) continue;
    else if (ch === '{') {
      // Everything since the last boundary was a selector or at-rule prelude.
      chunkStart = i + 1;
    } else if (ch === ';' || ch === '}') {
      declaration(chunkStart, i);
      chunkStart = i + 1;
    }
  }

  return { count: lines.length, lines };
}

/**
 * Compare current counts against a baseline.
 * Pure function — no IO. Exported for unit tests.
 *
 * @param {Record<string, number>} counts  current count per file
 * @param {Record<string, number>} base    baseline count per file
 * @param {Record<string, number[]>} lines line numbers per file
 * @returns {{ failures: string[], advisories: string[] }}
 */
export function compare(counts, base, lines = {}) {
  const failures = [];
  const advisories = [];
  for (const [file, cur] of Object.entries(counts)) {
    const prev = base[file] ?? 0;
    if (cur > prev) {
      failures.push(`FAIL ${file}: css-color ${prev}→${cur} (lines ${lines[file]?.join(', ') ?? '?'})`);
    } else if (cur < prev) {
      advisories.push(`${file}: css-color ${prev}→${cur}`);
    }
  }
  for (const [file, prev] of Object.entries(base)) {
    if (prev > 0 && !(file in counts)) advisories.push(`${file}: css-color ${prev}→0`);
  }
  return { failures, advisories };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (entry.name.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

export function scan(root = ROOT) {
  const counts = {};
  const lines = {};
  for (const file of walk(path.join(root, SCAN_DIR)).sort()) {
    const result = countCssColors(readFileSync(file, 'utf8'));
    if (result.count === 0) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    counts[rel] = result.count;
    lines[rel] = result.lines;
  }
  return { counts, lines };
}

// --- main ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { counts, lines } = scan();

  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`Wrote CSS colour baseline: ${total} literals in ${Object.keys(counts).length} files.`);
    process.exit(0);
  }

  if (!existsSync(BASELINE)) {
    console.error('Missing css-color-baseline.json — run: node scripts/check-css-colors.mjs --update');
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const { failures, advisories } = compare(counts, base, lines);

  if (advisories.length) {
    console.log(
      `\n${advisories.length} stylesheet(s) improved below baseline — run 'node scripts/check-css-colors.mjs --update' to lock in:`,
    );
    advisories.forEach((l) => console.log('  ' + l));
  }

  if (failures.length) {
    failures.forEach((l) => console.error(l));
    console.error('\nCSS colour check FAILED: new hardcoded colours above baseline.');
    console.error('  Use a --color-* role token from src/App.css: var(--color-surface), var(--color-border), ...');
    console.error('  For a colour that is data, not theme: /* color-ok: #<issue> reason */ on or above the line.');
    process.exit(1);
  }

  console.log('CSS colour check OK.');
}
