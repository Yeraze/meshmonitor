// @vitest-environment jsdom
/**
 * Source color assignment and CSS-variable resolution.
 *
 * `getSourceColor` is now the single lookup for source tagging — three pages
 * previously carried private copies of the array AND the index/modulo logic,
 * and both had drifted. These pin the assignment rules so a future private
 * copy is a visible behaviour change rather than a silent one.
 *
 * `resolveCssColor` exists because Leaflet paints SVG strokes via the
 * presentation *attribute*, which does not evaluate `var()`. Its var-lookup
 * branch is asserted through a real stylesheet; note jsdom resolves a custom
 * property to its declared token stream and does not perform the cascade's
 * variable substitution, so a var pointing at another var is deliberately not
 * asserted here — that behaviour belongs to a browser, and asserting jsdom's
 * answer would pin the wrong thing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SOURCE_COLORS, getSourceColor, resolveCssColor, resolveSourceColor } from './sourceColors';

const IDS = ['src-a', 'src-b', 'src-c'];

afterEach(() => {
  document.documentElement.style.cssText = '';
});

describe('getSourceColor', () => {
  it('assigns by position, so a source keeps its color as the list is filtered', () => {
    expect(getSourceColor('src-a', IDS)).toBe(SOURCE_COLORS[0]);
    expect(getSourceColor('src-b', IDS)).toBe(SOURCE_COLORS[1]);
    expect(getSourceColor('src-c', IDS)).toBe(SOURCE_COLORS[2]);
  });

  it('falls back to the first slot for an unknown id rather than returning undefined', () => {
    // indexOf gives -1; without the guard this would index off the end and
    // hand Leaflet `undefined` as a stroke.
    expect(getSourceColor('nope', IDS)).toBe(SOURCE_COLORS[0]);
  });

  it('wraps once there are more sources than slots', () => {
    const many = Array.from({ length: SOURCE_COLORS.length + 2 }, (_, i) => `s${i}`);
    expect(getSourceColor(`s${SOURCE_COLORS.length}`, many)).toBe(SOURCE_COLORS[0]);
    expect(getSourceColor(`s${SOURCE_COLORS.length + 1}`, many)).toBe(SOURCE_COLORS[1]);
  });

  it('draws only on the categorical scale', () => {
    for (const c of SOURCE_COLORS) expect(c).toMatch(/^var\(--chart-\d+\)$/);
  });
});

describe('resolveCssColor', () => {
  it('passes a literal color through untouched', () => {
    expect(resolveCssColor('#89b4fa')).toBe('#89b4fa');
    expect(resolveCssColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
  });

  it('resolves a custom property declared on :root', () => {
    document.documentElement.style.setProperty('--chart-1', '#89b4fa');
    expect(resolveCssColor('var(--chart-1)')).toBe('#89b4fa');
  });

  it('returns the var() expression unchanged when the property is undefined', () => {
    // Better than returning '' — an empty stroke silently disappears, whereas
    // the untouched expression is at least traceable in the DOM.
    expect(resolveCssColor('var(--not-defined-anywhere)')).toBe('var(--not-defined-anywhere)');
  });

  it('ignores a var() with a fallback, which its regex deliberately does not match', () => {
    // The anchored pattern only accepts a bare `var(--x)`. Fallbacks are banned
    // on semantic tokens by semanticTokens.test.ts, so this shape should not
    // occur; passing it through unchanged is the safe answer either way.
    expect(resolveCssColor('var(--chart-1, #fff)')).toBe('var(--chart-1, #fff)');
  });
});

describe('resolveSourceColor', () => {
  it('resolves the slot a source maps to', () => {
    document.documentElement.style.setProperty('--chart-2', '#cba6f7');
    expect(resolveSourceColor('src-b', IDS)).toBe('#cba6f7');
  });
});
