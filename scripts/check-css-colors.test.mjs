/**
 * Unit tests for the pure functions in check-css-colors.mjs (#5594).
 * No filesystem involved — only countCssColors(), exemptLines() and compare().
 */
import { describe, it, expect } from 'vitest';
import { countCssColors, exemptLines, compare } from './check-css-colors.mjs';

describe('countCssColors()', () => {
  it('counts hex, rgb and hsl literals in declaration values', () => {
    const css = `
.a { color: #fff; }
.b { border: 1px solid #3a3a3a; }
.c { box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3); }
.d { background: hsl(210 50% 40%); }
.e { background-color: hsla(210, 50%, 40%, 0.5); }
`;
    expect(countCssColors(css)).toEqual({ count: 5, lines: [2, 3, 4, 5, 6] });
  });

  it('counts each literal in a value, on the line it sits on', () => {
    const css = `.a {
  background: linear-gradient(
    #000,
    rgba(1, 2, 3, 0.4) 50%,
    #fff
  );
}`;
    expect(countCssColors(css)).toEqual({ count: 3, lines: [3, 4, 5] });
  });

  it('gives a repeated literal its own line each time', () => {
    const css = `.a {
  background: linear-gradient(
    #fff,
    transparent,
    #fff
  );
}`;
    expect(countCssColors(css)).toEqual({ count: 2, lines: [3, 5] });
  });

  it('skips custom-property definitions', () => {
    const css = `
:root[data-theme='latte'] {
  --color-bg: #eff1f5;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.12);
  --seq-1: color-mix(in srgb, var(--color-accent) 20%, var(--color-surface));
}
.a { --local-tint: #abcdef; color: var(--local-tint); }
`;
    expect(countCssColors(css).count).toBe(0);
  });

  it('passes tokens, keywords and token-derived colours', () => {
    const css = `
.a {
  color: var(--color-text);
  background: transparent;
  border: 1px solid currentColor;
  outline-color: inherit;
  background-color: color-mix(in srgb, var(--color-info) 15%, var(--color-surface));
  box-shadow: 0 0 4px rgb(from var(--color-accent) r g b / 50%);
}`;
    expect(countCssColors(css).count).toBe(0);
  });

  it('ignores selectors, at-rule preludes, comments and url()', () => {
    const css = `
/* was #1e1e2e before the tokens landed */
#add, #face:hover, a[href="#fff"] { color: var(--color-text); }
@media (min-width: 600px) { #abc { margin: 0; } }
.icon { background-image: url("data:image/svg+xml;utf8,<svg fill='#ffffff'/>"); }
.mask { mask: url(#fade); }
`;
    expect(countCssColors(css).count).toBe(0);
  });

  it('is not thrown by a semicolon or brace inside a string or url', () => {
    const css = `
.a { content: "; } #fff {"; color: #111; }
.b { background: url(data:image/png;base64,AAAA) #222; }
`;
    expect(countCssColors(css)).toEqual({ count: 2, lines: [2, 3] });
  });

  it('counts the last declaration of a block with no trailing semicolon', () => {
    expect(countCssColors('.a { margin: 0; color: #fff }').count).toBe(1);
  });

  it('counts declarations nested in at-rules', () => {
    const css = `@media (prefers-color-scheme: dark) {
  .a { color: #eee; }
}`;
    expect(countCssColors(css)).toEqual({ count: 1, lines: [2] });
  });

  it('honours a color-ok marker on the same line or the line above', () => {
    const css = `
.a { color: #fff; /* color-ok: #5594 print sheet is always white */ }
.b {
  /* color-ok: #5594 brand mark colour is fixed */
  fill: #ff6600;
  stroke: #000;
}`;
    expect(countCssColors(css)).toEqual({ count: 1, lines: [6] });
  });

  it('rejects a color-ok marker with no issue reference or no reason', () => {
    const css = `
.a { color: #fff; /* color-ok */ }
.b { color: #fff; /* color-ok: because */ }
.c { color: #fff; /* color-ok: #5594 */ }
`;
    expect(countCssColors(css).count).toBe(3);
  });
});

describe('exemptLines()', () => {
  it('covers the next line only when the marker stands alone', () => {
    const css = `.a { color: #fff; } /* color-ok: #1 trailing */
.b { color: #000; }
/* color-ok: #2 standalone */
.c { color: #111; }`;
    expect([...exemptLines(css)].sort()).toEqual([1, 3, 4]);
  });
});

describe('compare()', () => {
  it('passes when counts equal the baseline', () => {
    expect(compare({ 'src/a.css': 2 }, { 'src/a.css': 2 })).toEqual({ failures: [], advisories: [] });
  });

  it('fails when a count rises, naming the lines', () => {
    const { failures } = compare({ 'src/a.css': 3 }, { 'src/a.css': 2 }, { 'src/a.css': [4, 9, 12] });
    expect(failures).toEqual(['FAIL src/a.css: css-color 2→3 (lines 4, 9, 12)']);
  });

  it('fails for a file the baseline has never seen', () => {
    const { failures } = compare({ 'src/New.module.css': 1 }, {}, { 'src/New.module.css': [7] });
    expect(failures).toEqual(['FAIL src/New.module.css: css-color 0→1 (lines 7)']);
  });

  it('advises, without failing, when a count falls or a file goes clean', () => {
    const { failures, advisories } = compare({ 'src/a.css': 1 }, { 'src/a.css': 4, 'src/b.css': 2 });
    expect(failures).toEqual([]);
    expect(advisories).toEqual(['src/a.css: css-color 4→1', 'src/b.css: css-color 2→0']);
  });
});
