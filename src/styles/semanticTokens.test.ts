/**
 * Semantic color tokens (issue #4567).
 *
 * The app used to consume raw Catppuccin palette names (`--ctp-blue`) directly,
 * so a custom theme could only restyle a role if the role happened to share a
 * name with the swatch wired to it. `App.css` now defines a role layer
 * (`--color-error: var(--color-error)`) that components consume instead.
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

/**
 * The bare `:root { … }` block — where the role and categorical layers are
 * defined. Explicitly NOT the `:root[data-theme='x']` blocks, which define the
 * palette and deliberately never redeclare these tokens.
 *
 * Scoped rather than matched across the whole file so a token accidentally
 * declared inside a theme block reads as MISSING from the layer (which it
 * effectively is — it would only apply under that one theme) instead of being
 * silently counted as a definition.
 */
function rootBlock(): string {
  const m = appCss.match(/:root\s*\{([\s\S]*?)\n\}/);
  return m?.[1] ?? '';
}

/** Semantic tokens and the palette var each points at, from the :root block. */
function semanticDefinitions(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(--color-[a-z0-9-]+)\s*:\s*var\((--ctp-[a-z0-9-]+)\)/g;
  for (const m of rootBlock().matchAll(re)) out.set(m[1], m[2]);
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

/** Palette var -> literal value, per `:root[data-theme='x']` block. */
function paletteValuesInThemeBlocks(): { theme: string; values: Map<string, string> }[] {
  const blocks: { theme: string; values: Map<string, string> }[] = [];
  for (const m of appCss.matchAll(/:root\[data-theme='([^']+)'\]\s*\{([^}]*)\}/g)) {
    const values = new Map<string, string>();
    for (const v of m[2].matchAll(/(--ctp-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      values.set(v[1], v[2].trim().toLowerCase());
    }
    blocks.push({ theme: m[1], values });
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

    // `--ctp-accent-text` is deliberately theme-independent: it is the text
    // color painted ON a bright accent button, fixed at black so the contrast
    // holds whatever the accent becomes. It lives on the base :root and no
    // theme block overrides it, so the per-theme check below cannot apply to
    // it. Rather than skip it silently — which would let a half-finished
    // per-theme override slip through with the test still green — assert the
    // property that actually has to hold: it is defined exactly once, on the
    // base :root.
    const baseRoot = appCss.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(baseRoot).toMatch(/--ctp-accent-text\s*:/);
    const themeBlocksDefiningIt = paletteVarsInThemeBlocks().filter((t) =>
      t.vars.has('--ctp-accent-text'),
    );
    expect(themeBlocksDefiningIt.map((t) => t.theme)).toEqual([]);

    const missing: string[] = [];
    for (const [token, palette] of defs) {
      if (palette === '--ctp-accent-text') continue; // asserted above instead
      for (const { theme, vars } of themes) {
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

  it('has no fallback value on a semantic token', () => {
    // `var(--color-error, #f38ba8)` is dead code: the test above proves every
    // referenced token is defined, so the fallback can never apply. Worse, it
    // hides a hardcoded color that is usually wrong — Sidebar.css carried
    // `var(--color-accent, #2a2a2a)`, a dark grey standing in for the blue
    // accent, and PacketMonitorPanel had `#4a9eff` for the same token. If one
    // ever DID apply, the theme would silently break. Ban the shape outright.
    const offenders: string[] = [];
    for (const file of walk(resolve('src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/var\(\s*(--color-[a-z0-9-]+)\s*,/g)) {
        offenders.push(`${m[1]} in ${file.replace(resolve('.') + '/', '')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the user-facing theme schema unchanged', () => {
    // The whole point of the indirection: users still author the 26 palette
    // keys they always have. If a semantic token ever needs to be authored
    // directly, that is a schema change and a migration — not a silent edit.
    const themeValidation = readFileSync(resolve('src/utils/themeValidation.ts'), 'utf8');
    expect(themeValidation).not.toMatch(/--color-|'color-(success|error|accent)'/);
  });
});

/**
 * Categorical scale (`--chart-N`).
 *
 * Roles and categories answer different questions. A role says what a color
 * MEANS ("this is an error"); a categorical slot only has to be TELLABLE APART
 * from its neighbours. Roles are chosen for meaning and may legitimately
 * collide in hue — which is exactly why category encoding must not borrow
 * them. `SOURCE_COLORS` used to read `[accent, accent-alt, success, caution,
 * …]`, so a theme with a greenish accent rendered sources #1 and #3
 * indistinguishable, and slot 3 implied a source was "succeeding".
 */
describe('categorical scale (--chart-N)', () => {
  /** Chart slots and the palette var each points at, from the :root block. */
  function chartDefinitions(): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of rootBlock().matchAll(/(--chart-\d+)\s*:\s*var\((--ctp-[a-z0-9-]+)\)/g)) {
      out.set(m[1], m[2]);
    }
    return out;
  }

  const chart = chartDefinitions();

  it('defines a contiguous scale', () => {
    expect(chart.size).toBe(8);
    for (let i = 1; i <= 8; i++) {
      expect(chart.has(`--chart-${i}`), `--chart-${i} missing`).toBe(true);
    }
  });

  it('points every slot at a palette var that exists in every theme', () => {
    for (const { theme, vars } of paletteVarsInThemeBlocks()) {
      for (const [slot, paletteVar] of chart) {
        expect(vars.has(paletteVar), `${slot} -> ${paletteVar} undefined in theme '${theme}'`).toBe(true);
      }
    }
  });

  it('gives every slot a distinct palette var', () => {
    const used = [...chart.values()];
    expect(new Set(used).size).toBe(used.length);
  });

  it('resolves slots 1-7 to distinct COLORS in every theme', () => {
    // Distinct palette NAMES is not the property that matters — distinct
    // rendered colors is. The non-Catppuccin themes alias several names onto
    // one value (Nord has no separate teal and sapphire), so an earlier
    // ordering passed the name check above while rendering only six colors in
    // Nord and Gruvbox, with sources 6 and 8 identical. Browser-confirmed.
    //
    // Seven is the most this palette can guarantee; slot 8 is asserted
    // separately below with the collision it is allowed to have.
    const failures: string[] = [];
    for (const { theme, values } of paletteValuesInThemeBlocks()) {
      const seen = new Map<string, number>();
      for (let i = 1; i <= 7; i++) {
        const paletteVar = chart.get(`--chart-${i}`)!;
        const hex = values.get(paletteVar);
        if (!hex) continue; // covered by the "exists in every theme" test
        if (seen.has(hex)) failures.push(`${theme}: --chart-${seen.get(hex)} and --chart-${i} are both ${hex}`);
        else seen.set(hex, i);
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps slot 8 to at most one aliased slot, in a minority of themes', () => {
    // Slot 8 cannot be collision-free — see the App.css comment. Pin how bad
    // it is allowed to get, so a future reshuffle that regresses it (teal
    // aliased in 7 themes; sky in 10) fails rather than passing quietly.
    const themes = paletteValuesInThemeBlocks();
    const eighth = chart.get('--chart-8')!;
    const clashes: string[] = [];
    for (const { theme, values } of themes) {
      const hex = values.get(eighth);
      if (!hex) continue;
      for (let i = 1; i <= 7; i++) {
        if (values.get(chart.get(`--chart-${i}`)!) === hex) clashes.push(`${theme}:${i}`);
      }
    }
    // At most a quarter of themes, and never more than one slot within a theme.
    //
    // This bound is TIGHT, not loose: rosewater aliases in exactly 3 of 15
    // today, and floor(15/4) is 3. A new theme that also aliases it fails
    // here. That is deliberate — it means "the 8th slot got worse, pick a
    // different hue or accept the regression knowingly" — so the message
    // names the offenders rather than just reporting a count, which is all
    // `toBeLessThanOrEqual` would otherwise print.
    const limit = Math.floor(themes.length / 4);
    expect(
      clashes.length,
      `slot 8 aliases in ${clashes.length} theme(s) (limit ${limit}): ${clashes.join(', ')}`,
    ).toBeLessThanOrEqual(limit);
    expect(
      new Set(clashes.map((c) => c.split(':')[0])).size,
      `slot 8 aliases more than one slot within a theme: ${clashes.join(', ')}`,
    ).toBe(clashes.length);
  });

  it('borrows no role token — the scale is independent of meaning', () => {
    // Checked per DECLARATION rather than over a `--chart-1 … --chart-8` span.
    // A span regex depends on the two staying adjacent with nothing in
    // between; reorder the block or drop a `}` into a comment and it matches
    // nothing, at which point `not.toMatch` passes vacuously and only a
    // separate emptiness guard stands between that and a silently dead test.
    // Reading each declaration removes the failure mode instead of guarding it.
    const decls = [...rootBlock().matchAll(/--chart-\d+\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls).toHaveLength(8);
    for (const value of decls) {
      expect(value, `${value} borrows a role token`).not.toMatch(/var\(--color-/);
    }
  });

  it('is what SOURCE_COLORS draws on, with no role tokens or raw palette vars', () => {
    const src = readFileSync(resolve('src/utils/sourceColors.ts'), 'utf8');
    const arr = src.match(/export const SOURCE_COLORS = \[([\s\S]*?)\]/)?.[1] ?? '';
    expect(arr).toMatch(/--chart-1/);
    expect(arr).not.toMatch(/--color-/);
    expect(arr).not.toMatch(/--ctp-/);
  });

  it('has exactly one SOURCE_COLORS definition in the tree', () => {
    // UnifiedMessagesPage and UnifiedTelemetryPage each carried a private copy
    // and they had already drifted apart — Telemetry listed six entries and
    // used `error` in slot four where the others used `caution`, so one source
    // showed up in different colors on different pages and wrapped early past
    // six sources. One definition, or it happens again.
    const defs = walk(resolve('src')).filter((f) =>
      /(export )?const SOURCE_COLORS\s*=/.test(readFileSync(f, 'utf8')),
    );
    expect(defs.map((f) => f.replace(resolve('.') + '/', ''))).toEqual([
      'src/utils/sourceColors.ts',
    ]);
  });
});

/**
 * Sequential scale (`--seq-N`).
 *
 * Magnitude encoding — how far, how many, how dense. Distinct from both roles
 * (what a color MEANS) and categories (merely tellable apart): a sequential
 * step has to READ AS ORDERED. Built with color-mix from the accent so the
 * steps are monotonic by construction and cannot collide the way two palette
 * picks can.
 */
describe('sequential scale (--seq-N)', () => {
  const decls = new Map<string, string>();
  for (const m of rootBlock().matchAll(/(--seq-\d+)\s*:\s*([^;]+);/g)) {
    decls.set(m[1], m[2].trim());
  }

  it('defines a contiguous scale', () => {
    expect(decls.size).toBe(5);
    for (let i = 1; i <= 5; i++) expect(decls.has(`--seq-${i}`), `--seq-${i} missing`).toBe(true);
  });

  it('derives every step from the accent, so a theme change carries through', () => {
    for (const [name, value] of decls) {
      expect(value, `${name} does not reference the accent`).toMatch(/var\(--color-accent\)/);
    }
  });

  it('increases monotonically, which is the whole point of a sequential scale', () => {
    // Steps 1-4 are color-mix percentages; step 5 is the undiluted accent.
    // Reading the percentages proves ordering without needing to render.
    const pct: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const m = decls.get(`--seq-${i}`)!.match(/var\(--color-accent\)\s+(\d+)%/);
      expect(m, `--seq-${i} is not a color-mix percentage`).not.toBeNull();
      pct.push(Number(m![1]));
    }
    expect(pct).toEqual([...pct].sort((a, b) => a - b));
    expect(new Set(pct).size).toBe(pct.length);
    expect(Math.max(...pct)).toBeLessThan(100);
    expect(decls.get('--seq-5')).toBe('var(--color-accent)');
  });

  it('borrows no categorical slot — magnitude and category stay separate', () => {
    for (const [name, value] of decls) {
      expect(value, `${name} borrows a --chart-N slot`).not.toMatch(/var\(--chart-/);
    }
  });

  it('is what the magnitude widgets draw on, with no raw palette vars', () => {
    // These three encoded magnitude with categorical hues and reached past the
    // role layer for the ones no role provided. Pin that they don't again.
    for (const f of [
      'src/components/DistanceDistributionWidget.tsx',
      'src/components/HopDistanceHeatmapWidget.tsx',
    ]) {
      const text = readFileSync(resolve(f), 'utf8');
      expect(text, `${f} still reads a raw palette var`).not.toMatch(/var\(--ctp-/);
      expect(text, `${f} does not use the sequential scale`).toMatch(/var\(--seq-/);
    }
  });

  it('routes the hop histogram through the shared hop scale, not a private list', () => {
    // It IS hops, so it must agree with the map and honour the user's
    // configured gradient rather than hardcoding its own.
    const text = readFileSync(resolve('src/components/HopDistributionWidget.tsx'), 'utf8');
    expect(text).toMatch(/getHopColor\(hop, overlayColors\.hopColors\)/);
    expect(text).not.toMatch(/var\(--ctp-/);
  });
});
