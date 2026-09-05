/**
 * A miniature CSS cascade resolver, for tests only.
 *
 * jsdom implements neither layout nor media queries, so a render test cannot
 * see a responsive bug: the element is in the DOM either way. Grepping the
 * sheet for a substring is no better — it proves a rule was *written*, not that
 * it *wins* at a given viewport, and every bug in this family (#5053, #5054,
 * #5060) was a rule that existed and lost.
 *
 * So instead: parse the real sheet, keep only the blocks whose media condition
 * matches a concrete viewport, and report the last declaration standing. That
 * is enough to assert resolved geometry at "iPhone 13 rotated" and to catch a
 * later edit that reorders two same-specificity blocks.
 *
 * Deliberately small. It understands the media-feature grammar these sheets
 * actually use (max/min-width, max/min-height, orientation, comma = OR) and
 * assumes every rule touching a given selector has equal specificity, so source
 * order alone decides. Both hold across the sheets it is pointed at; if one
 * stops holding, the test that relies on it should say so loudly rather than
 * this file growing a specificity engine.
 *
 * Extracted from `dashboardMobileDrawer.test.ts` (#5058) when `MapSidebar`
 * needed the same machinery (#5060).
 */

export interface Viewport {
  width: number;
  height: number;
  /**
   * User preference, not a dimension. Defaults to "no-preference" — the
   * browser default — so a sheet that carries a `prefers-reduced-motion`
   * block (AppHeader.css does) resolves rather than throwing (#5051).
   */
  prefersReducedMotion?: boolean;
}

/** Evaluates the small media-feature grammar these sheets actually use. */
export function mediaMatches(condition: string, vp: Viewport): boolean {
  // A comma-separated list is an OR of conjunctions.
  return condition.split(',').some((clause) => {
    const features = clause.split(/\s+and\s+/).map((f) => f.trim());
    return features.every((feature) => {
      const m = feature.match(/\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)/);
      if (!m) throw new Error(`unsupported media feature: ${feature}`);
      const [, name, value] = m;
      switch (name) {
        case 'max-width':
          return vp.width <= Number(value.replace('px', ''));
        case 'min-width':
          return vp.width >= Number(value.replace('px', ''));
        case 'max-height':
          return vp.height <= Number(value.replace('px', ''));
        case 'min-height':
          return vp.height >= Number(value.replace('px', ''));
        case 'orientation':
          // CSS counts a square viewport as landscape.
          return value === 'landscape' ? vp.width >= vp.height : vp.height > vp.width;
        case 'prefers-reduced-motion':
          return value === 'reduce'
            ? vp.prefersReducedMotion === true
            : vp.prefersReducedMotion !== true;
        default:
          throw new Error(`unsupported media feature: ${name}`);
      }
    });
  });
}

/** Strips comments and splits the sheet into (mediaCondition | null, body) blocks. */
export function topLevelBlocks(source: string): Array<{ condition: string | null; body: string }> {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Array<{ condition: string | null; body: string }> = [];
  let i = 0;
  while (i < clean.length) {
    const braceAt = clean.indexOf('{', i);
    if (braceAt === -1) break;
    const prelude = clean.slice(i, braceAt).trim();
    // Walk to the matching close brace.
    let depth = 0;
    let j = braceAt;
    for (; j < clean.length; j++) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}' && --depth === 0) break;
    }
    const body = clean.slice(braceAt + 1, j);
    if (prelude.startsWith('@media')) {
      blocks.push({ condition: prelude.slice('@media'.length).trim(), body });
    } else if (prelude.startsWith('@')) {
      // Other at-rules (@keyframes, @supports) are not needed by these tests.
    } else {
      blocks.push({ condition: null, body: `${prelude} {${body}}` });
    }
    i = j + 1;
  }
  return blocks;
}

/**
 * Binds a resolver to one sheet.
 *
 * @returns `(selector, property, viewport) => resolved value | null`
 */
export function createResolver(css: string) {
  const blocks = topLevelBlocks(css);

  return function resolveDeclaration(
    selector: string,
    property: string,
    vp: Viewport
  ): string | null {
    let winner: string | null = null;
    const wanted = new RegExp(
      `(^|\\})\\s*${selector.replace(/[.\\[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
      'g'
    );
    for (const block of blocks) {
      if (block.condition !== null && !mediaMatches(block.condition, vp)) continue;
      wanted.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = wanted.exec(block.body)) !== null) {
        const decl = m[2].match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
        if (decl) winner = decl[1].trim();
      }
    }
    return winner;
  };
}

/** Concrete devices the responsive regressions were reported on. */
export const PORTRAIT_PHONE: Viewport = { width: 390, height: 844 }; // iPhone 13
export const LANDSCAPE_PHONE: Viewport = { width: 844, height: 390 }; // iPhone 13, rotated
export const LANDSCAPE_BIG_PHONE: Viewport = { width: 915, height: 412 }; // Pixel 7, rotated
export const LANDSCAPE_SMALL_PHONE: Viewport = { width: 667, height: 375 }; // iPhone SE, rotated
export const DESKTOP: Viewport = { width: 1440, height: 900 };
