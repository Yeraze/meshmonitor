/**
 * Colour guard for the Notifications page (#5592).
 *
 * The page carried ~60 inline hex literals chosen for a dark theme, so a light
 * theme rendered dark panels with pale text. The colours now live in
 * `NotificationsTab.module.css` on semantic role tokens. These tests keep a
 * literal from coming back, in either file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tsx = readFileSync(resolve('src/components/NotificationsTab.tsx'), 'utf8');
const css = readFileSync(resolve('src/components/NotificationsTab.module.css'), 'utf8');

/** hex (`#abc` … `#aabbccdd`), `rgb()` / `rgba()`, `hsl()` / `hsla()`. */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;

/**
 * Drop comments, which cite issues as `#5493` and would read as hex.
 * A `//` only opens a comment at line start or after whitespace, so the `//`
 * in a URL string does not swallow the rest of its line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function literalsIn(source: string): string[] {
  return stripComments(source)
    .split('\n')
    .flatMap((line) => (line.match(COLOR_LITERAL) ? [line.trim()] : []));
}

describe('NotificationsTab colours (#5592)', () => {
  it('the guard itself catches each literal shape', () => {
    expect(literalsIn("a: '#1e1e2e'")).toHaveLength(1);
    expect(literalsIn("border: '1px solid #3a3a3a'")).toHaveLength(1);
    expect(literalsIn("a: 'rgba(0, 0, 0, 0.5)'")).toHaveLength(1);
    expect(literalsIn("a: 'hsl(210 50% 40%)'")).toHaveLength(1);
    expect(literalsIn("href=\"https://example.com\" style={{ color: '#fff' }}")).toHaveLength(1);
    // Not colours: an issue reference in a comment, a newline entity, a token.
    expect(literalsIn('// per source (#5493)')).toEqual([]);
    expect(literalsIn('{/* waypoints (#4750) */}')).toEqual([]);
    expect(literalsIn('placeholder="Hi&#10;Help"')).toEqual([]);
    expect(literalsIn("color: 'var(--color-text)'")).toEqual([]);
  });

  it('has no colour literal in the component', () => {
    expect(literalsIn(tsx)).toEqual([]);
  });

  it('has no colour literal in its CSS module', () => {
    expect(literalsIn(css)).toEqual([]);
  });

  it('takes every colour in the CSS module from a role token', () => {
    const declarations = [...stripComments(css).matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)];
    expect(declarations.length).toBeGreaterThan(20);
    const untokened = declarations
      .filter(([, , value]) => !/var\(--color-[a-z0-9-]+\)/.test(value))
      .map(([decl]) => decl);
    expect(untokened).toEqual([]);
  });

  it('defines every class the component asks the module for', () => {
    const defined = new Set([...stripComments(css).matchAll(/\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]));
    const used = new Set([...tsx.matchAll(/styles\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
    // And nothing left behind in the sheet that the page no longer uses.
    expect([...defined].filter((name) => !used.has(name))).toEqual([]);
  });
});
