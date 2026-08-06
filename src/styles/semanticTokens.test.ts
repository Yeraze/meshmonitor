/**
 * Semantic color tokens (issue #4567).
 *
 * The app used to consume raw Catppuccin palette names (`--ctp-blue`) directly,
 * so a custom theme could only restyle a role if the role happened to share a
 * name with the swatch wired to it. `App.css` now defines a role layer
 * (`--color-error: var(--ctp-red)`) that components consume instead.
 *
 * These tests pin the two properties that make the layer trustworthy:
 *  1. Every semantic token resolves to a palette var that actually exists in
 *     every theme — otherwise the token silently computes to nothing.
 *  2. No component references a `--color-*` token that is never defined. That
 *     is the exact bug that motivated the issue: SettingsTab referenced
 *     `--color-success` / `--color-error` before anything defined them, so it
 *     silently fell back to a hardcoded hex and ignored the user's theme.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appCss = readFileSync(resolve('src/App.css'), 'utf8');

/** Semantic tokens and the palette var each points at, from the :root block. */
function semanticDefinitions(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(--color-[a-z0-9-]+)\s*:\s*var\((--ctp-[a-z0-9-]+)\)/g;
  for (const m of appCss.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** Palette vars defined inside a given `:root[data-theme='x']` block. */
function paletteVarsInThemeBlocks(): { theme: string; vars: Set<string> }[] {
  const blocks: { theme: string; vars: Set<string> }[] = [];
  const re = /:root\[data-theme='([^']+)'\]\s*\{([^}]*)\}/g;
  for (const m of appCss.matchAll(re)) {
    const vars = new Set<string>();
    for (const v of m[2].matchAll(/(--ctp-[a-z0-9-]+)\s*:/g)) vars.add(v[1]);
    blocks.push({ theme: m[1], vars });
  }
  return blocks;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.claude') continue;
      walk(full, out);
    } else if (/\.(css|tsx|ts)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('semantic color tokens (#4567)', () => {
  const defs = semanticDefinitions();

  it('defines a role layer at all', () => {
    expect(defs.size).toBeGreaterThan(10);
    // The two roles the issue called out as referenced-but-undefined.
    expect(defs.has('--color-success')).toBe(true);
    expect(defs.has('--color-error')).toBe(true);
  });

  it('points every token at a palette var that exists in every theme', () => {
    const themes = paletteVarsInThemeBlocks();
    expect(themes.length).toBeGreaterThan(5);

    const missing: string[] = [];
    for (const [token, palette] of defs) {
      for (const { theme, vars } of themes) {
        // --ctp-accent-text is defined once on the base :root, not per theme.
        if (palette === '--ctp-accent-text') continue;
        if (!vars.has(palette)) missing.push(`${token} -> ${palette} (missing in ${theme})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has no component referencing an undefined --color-* token', () => {
    // Guards the original defect: a `var(--color-foo)` nobody defines resolves
    // to nothing and the element silently loses its theming.
    const dangling = new Set<string>();
    for (const file of walk(resolve('src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/var\((--color-[a-z0-9-]+)/g)) {
        if (!defs.has(m[1])) dangling.add(`${m[1]} (${file.replace(resolve('.') + '/', '')})`);
      }
    }
    expect(Array.from(dangling)).toEqual([]);
  });

  it('keeps the user-facing theme schema unchanged', () => {
    // The whole point of the indirection: users still author the 26 palette
    // keys they always have. If a semantic token ever needs to be authored
    // directly, that is a schema change and a migration — not a silent edit.
    const themeValidation = readFileSync(resolve('src/utils/themeValidation.ts'), 'utf8');
    expect(themeValidation).not.toMatch(/--color-|'color-(success|error|accent)'/);
  });
});
