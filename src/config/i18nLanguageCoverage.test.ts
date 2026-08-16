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
import { join, resolve } from 'node:path';
import { AVAILABLE_LANGUAGES } from './i18n';

const LOCALE_DIR = resolve('public/locales');

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
const KNOWN_PARTIAL = ['de', 'es'];

function coveragePct(): Record<string, number> {
  const en = JSON.parse(readFileSync(join(LOCALE_DIR, 'en.json'), 'utf8')) as Record<string, unknown>;
  // Only leaf strings. `en.json` carries one nested group (`map`), and counting
  // it in the denominator made even English score 99.98% — a metric that cannot
  // reach 100 for the reference locale is measuring the wrong thing.
  const keys = Object.keys(en).filter((k) => typeof en[k] === 'string');
  const out: Record<string, number> = {};
  for (const file of readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'))) {
    const code = file.replace(/\.json$/, '');
    const d = JSON.parse(readFileSync(join(LOCALE_DIR, file), 'utf8')) as Record<string, unknown>;
    const nonEmpty = keys.filter((k) => typeof d[k] === 'string' && (d[k] as string).trim() !== '').length;
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
