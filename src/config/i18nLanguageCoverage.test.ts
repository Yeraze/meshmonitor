/**
 * @vitest-environment jsdom
 *
 * Language-selector vs. locale-file drift guard.
 *
 * `AVAILABLE_LANGUAGES` is hand-maintained (shipping a translation is an
 * editorial call), while Weblate adds locale files continuously. The two drift,
 * and the drift is invisible: nothing breaks, a finished translation simply
 * never appears in the picker.
 *
 * That is not hypothetical. Traditional Chinese reached ~99% translated and
 * stayed unselectable until an outside contributor noticed (#4742), and Polish
 * reached ~89% the same way. Both were one-line fixes nobody knew were needed.
 *
 * Coverage is measured as NON-EMPTY values, not key presence. Weblate writes
 * every key into every locale file, so key-count coverage reads ~99% for a file
 * that is entirely untranslated — a metric that would call every language ready.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVAILABLE_LANGUAGES } from './i18n';

// Resolved from this file rather than the process cwd, so the guard does not
// depend on where the runner happens to be invoked from (review, #4748).
const LOCALE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/locales');

/**
 * Non-empty share at or above which a translation is considered shippable.
 *
 * The exact number matters little: the corpus is strongly bimodal — actively
 * translated locales sit above 80%, dormant ones below 1% — so anything in the
 * wide gap separates them. 50% is chosen because below it the UI is
 * majority-English anyway, which is arguably worse than offering English.
 */
const READY_THRESHOLD_PCT = 50;

/**
 * Listed locales currently BELOW the threshold.
 *
 * These predate the policy. Removing a language people may already be using is
 * a product decision, not a lint fix, so they are pinned here rather than
 * silently dropped: if one improves past the threshold, or another sub-threshold
 * language is added, this test fails and a human decides.
 */
const KNOWN_PARTIAL = ['de', 'es'];  // keep alphabetical — compared order-sensitively

/**
 * Every leaf string in a locale object, keyed by dotted path.
 *
 * Recursive rather than top-level-only. `en.json` is mostly flat but carries a
 * nested `map` group, and a flat pass had two problems: it made English score
 * 99.98% against itself, and — the reason this recurses instead of just
 * skipping non-strings — any nested group added later would be silently
 * excluded from every locale's score, so a badly-translated section could hide
 * inside a passing number (review, #4748).
 */
function leafStrings(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[path] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, leafStrings(v as Record<string, unknown>, path));
    }
  }
  return out;
}

function coveragePct(): Record<string, number> {
  const en = leafStrings(JSON.parse(readFileSync(join(LOCALE_DIR, 'en.json'), 'utf8')));
  const keys = Object.keys(en);
  const out: Record<string, number> = {};
  for (const file of readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'))) {
    const code = file.replace(/\.json$/, '');
    const d = leafStrings(JSON.parse(readFileSync(join(LOCALE_DIR, file), 'utf8')));
    const nonEmpty = keys.filter((k) => typeof d[k] === 'string' && d[k].trim() !== '').length;
    out[code] = (100 * nonEmpty) / keys.length;
  }
  return out;
}

const listed = new Set(AVAILABLE_LANGUAGES.map((l) => l.code));

describe('language selector covers the translations that are ready', () => {
  it('reads a plausible corpus', () => {
    // Guards the guard: a path or parsing mistake returning nothing would make
    // every assertion below vacuously pass.
    const cov = coveragePct();
    expect(Object.keys(cov).length).toBeGreaterThan(5);
    expect(cov.en).toBe(100);
    // Nested groups are counted, so the corpus is larger than the flat key set.
    expect(Object.keys(leafStrings(JSON.parse(readFileSync(join(LOCALE_DIR, 'en.json'), 'utf8')))).length)
      .toBeGreaterThan(1000);
  });

  it('has a listed language actually clearing the threshold', () => {
    // Otherwise a corpus-wide collapse would leave every assertion here passing
    // for the wrong reason: nothing "ready but unlisted", because nothing ready
    // (review, #4748).
    const cov = coveragePct();
    expect(cov.pl).toBeGreaterThanOrEqual(READY_THRESHOLD_PCT);
  });

  it('lists every locale that has reached the readiness threshold', () => {
    const cov = coveragePct();
    const readyButUnlisted = Object.entries(cov)
      .filter(([code, pct]) => pct >= READY_THRESHOLD_PCT && !listed.has(code))
      .map(([code, pct]) => `${code} (${pct.toFixed(1)}%)`);

    expect(
      readyButUnlisted,
      'These translations are ready but not offered in the language selector. ' +
      'Add them to AVAILABLE_LANGUAGES in src/config/i18n.ts.',
    ).toEqual([]);
  });

  it('pins which listed languages are still substantially untranslated', () => {
    // Not a failure in itself — but it should never change silently. Users
    // selecting these get a mostly-English UI.
    const cov = coveragePct();
    const partial = Object.keys(cov)
      .filter((code) => listed.has(code) && cov[code] < READY_THRESHOLD_PCT)
      .sort();

    expect(
      partial,
      'A listed language crossed the threshold (remove it from KNOWN_PARTIAL) ' +
      'or a substantially untranslated one was added (confirm that is intended).',
    ).toEqual(KNOWN_PARTIAL);
  });

  it('has a locale file for every language it offers', () => {
    // The inverse drift: offering a language whose file was renamed or removed
    // would 404 at runtime and silently fall back to English.
    const cov = coveragePct();
    const missing = [...listed].filter((code) => !(code in cov));
    expect(missing, 'Listed languages with no locale file.').toEqual([]);
  });
});
