#!/usr/bin/env node
// Count-based ESLint ratchet. Fails if any file's per-rule violation count
// exceeds the checked-in baseline. Regenerate with `--update`.
//
// Usage:
//   node scripts/lint-ratchet.mjs          — CI gate (exits 1 on regressions)
//   node scripts/lint-ratchet.mjs --update — regenerate eslint-baseline.json
//   node scripts/lint-ratchet.mjs --update --rule <ruleId>
//                                          — rewrite that one rule's counts and
//                                            leave every other number alone (use
//                                            when adding a rule, so the baseline
//                                            diff shows the new rule and nothing else)
//
// Semantics:
//   current > baseline → FAIL (new violation)
//   current < baseline → PASS + advisory ("improved — run lint:baseline")
//   file absent from baseline with violations → FAIL (new file must be clean or baselined)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASELINE = path.join(ROOT, 'eslint-baseline.json');
const UPDATE = process.argv.includes('--update');
const RULE_FLAG = process.argv.indexOf('--rule');
const ONLY_RULE = RULE_FLAG === -1 ? null : process.argv[RULE_FLAG + 1];

export function runEslint(cwd = ROOT) {
  let out;
  try {
    out = execFileSync(
      path.join(cwd, 'node_modules', '.bin', 'eslint'),
      ['.', '--format', 'json'],
      { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
    );
  } catch (e) {
    out = e.stdout; // eslint exits non-zero when violations exist; JSON is still on stdout
    if (!out) {
      console.error('eslint failed to produce JSON:', e.message);
      process.exit(2);
    }
  }
  return JSON.parse(out);
}

export function tally(results, root = ROOT) {
  const counts = {}; // relPath -> { ruleId: count }
  const lines = {};  // relPath -> { ruleId: [lineNumbers] }
  for (const f of results) {
    if (!f.messages.length) continue;
    const rel = path.relative(root, f.filePath);
    for (const m of f.messages) {
      const rule = m.ruleId || '(parse)';
      counts[rel] = counts[rel] || {};
      counts[rel][rule] = (counts[rel][rule] || 0) + 1;
      lines[rel] = lines[rel] || {};
      (lines[rel][rule] = lines[rel][rule] || []).push(m.line);
    }
  }
  return { counts, lines };
}

export function sortObj(o) {
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map(k => [
        k,
        o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])
          ? sortObj(o[k])
          : o[k],
      ]),
  );
}

/**
 * Compare current violation counts against a baseline.
 * Pure function — no IO. Exported for unit tests.
 *
 * @param {Record<string, Record<string, number>>} counts  Current tally
 * @param {Record<string, Record<string, number>>} base    Baseline
 * @param {Record<string, Record<string, number[]>>} lines Line numbers per file/rule
 * @returns {{ failures: string[], advisories: string[] }}
 */
export function compare(counts, base, lines = {}) {
  const failures = [];
  const advisories = [];
  for (const [file, rules] of Object.entries(counts)) {
    for (const [rule, cur] of Object.entries(rules)) {
      const prev = base[file]?.[rule] ?? 0;
      if (cur > prev) {
        const lnList = lines[file]?.[rule]?.join(', ') ?? '?';
        failures.push(`FAIL ${file}: ${rule} ${prev}→${cur} (lines ${lnList})`);
      } else if (cur < prev) {
        advisories.push(`${file}: ${rule} ${prev}→${cur}`);
      }
    }
  }
  // Detect baseline files/rules that have dropped to zero entirely
  // (file no longer appears in counts, but baseline had violations).
  for (const [file, rules] of Object.entries(base)) {
    for (const [rule, prev] of Object.entries(rules)) {
      if (prev > 0 && (counts[file]?.[rule] ?? 0) === 0) {
        advisories.push(`${file}: ${rule} ${prev}→0`);
      }
    }
  }
  return { failures, advisories };
}

/**
 * A baseline with one rule's counts replaced by the current tally and every
 * other rule's counts carried over untouched.
 * Pure function — no IO. Exported for unit tests.
 *
 * A plain `--update` rewrites every rule, so it also locks in whatever other
 * rules happen to have improved (or, with stray worktrees on disk, adds their
 * files). Adding a rule should change that rule's numbers only.
 *
 * @param {Record<string, Record<string, number>>} base   Existing baseline
 * @param {Record<string, Record<string, number>>} counts Current tally
 * @param {string} rule                                   The ruleId to rewrite
 * @returns {Record<string, Record<string, number>>}
 */
export function mergeRule(base, counts, rule) {
  const merged = {};
  for (const [file, rules] of Object.entries(base)) {
    const kept = Object.fromEntries(Object.entries(rules).filter(([id]) => id !== rule));
    if (Object.keys(kept).length) merged[file] = kept;
  }
  for (const [file, rules] of Object.entries(counts)) {
    if (rules[rule]) merged[file] = { ...merged[file], [rule]: rules[rule] };
  }
  return merged;
}

// --- main ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { counts, lines } = tally(runEslint());

  if (UPDATE && RULE_FLAG !== -1) {
    if (!ONLY_RULE || ONLY_RULE.startsWith('--')) {
      console.error('--rule needs a ruleId, e.g. --rule meshmonitor-ui/no-hardcoded-color');
      process.exit(2);
    }
    // Read without a prior existsSync(): checking and then writing the same
    // path is a check-then-use race. A missing file surfaces as ENOENT here.
    let existing;
    try {
      existing = JSON.parse(readFileSync(BASELINE, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      console.error('Missing eslint-baseline.json — run: npm run lint:baseline');
      process.exit(2);
    }
    const merged = mergeRule(existing, counts, ONLY_RULE);
    writeFileSync(BASELINE, JSON.stringify(sortObj(merged), null, 2) + '\n');
    const files = Object.values(merged).filter(r => r[ONLY_RULE]);
    const total = files.reduce((n, r) => n + r[ONLY_RULE], 0);
    console.log(`Wrote ${ONLY_RULE}: ${total} in ${files.length} files. Other rules untouched.`);
    process.exit(0);
  }

  if (UPDATE) {
    writeFileSync(BASELINE, JSON.stringify(sortObj(counts), null, 2) + '\n');
    console.log('Wrote baseline for', Object.keys(counts).length, 'files.');
    process.exit(0);
  }

  if (!existsSync(BASELINE)) {
    console.error('Missing eslint-baseline.json — run: npm run lint:baseline');
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));

  const { failures, advisories } = compare(counts, base, lines);

  if (advisories.length) {
    console.log(
      `\n${advisories.length} rule(s) improved below baseline — run 'npm run lint:baseline' to lock in:`,
    );
    advisories.forEach(l => console.log('  ' + l));
  }

  if (failures.length) {
    failures.forEach(l => console.error(l));
    console.error('\nLint ratchet FAILED: new violations above baseline. Fix them or justify via:');
    console.error('  eslint-disable-next-line <rule> -- #<issue> <reason>');
    console.error('  (last resort, reviewer sign-off) npm run lint:baseline');
    process.exit(1);
  }

  console.log('Lint ratchet OK.');
}
