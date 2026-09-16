/**
 * Regression test for #5250 — line breaks in message text collapsed to spaces
 * in the Unified Messages view while rendering correctly in the per-source
 * Channel and DM views.
 *
 * The per-source views set `white-space: pre-line` inline
 * (`ChannelsTab.tsx`, `MessagesTab.tsx`). The unified card and details modal
 * styled their text through `unified.css`, which declared only `line-height`
 * and `word-break` — so `white-space` fell back to `normal` and every `\n`
 * rendered as a space. The same message looked different depending on which
 * view you opened it from.
 *
 * jsdom applies neither external stylesheets nor layout, so a render test
 * cannot catch this: the element would have no computed `white-space` either
 * way. These assertions read the stylesheet source instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UNIFIED_CSS = readFileSync(
  fileURLToPath(new URL('./unified.css', import.meta.url)),
  'utf-8'
);

/** Strip comments so prose mentioning a selector isn't parsed as a rule. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Bodies of every *unconditional* `<selector> { ... }` rule — column 0 only, so
 * indented copies inside `@media` blocks and compound selectors like
 * `.x:hover` are excluded.
 */
function rulesFor(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...stripComments(css).matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm'))]
    .map((m) => m[1]);
}

/**
 * Resolve a property the way the cascade does: across rules of equal
 * specificity the LAST declaration wins. Reading only the first would miss a
 * later block quietly overriding the fix.
 */
function effective(bodies: string[], prop: string): string | undefined {
  let winner: string | undefined;
  for (const body of bodies) {
    const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) winner = m[1].trim();
  }
  return winner;
}

describe('Unified Messages preserves line breaks (#5250)', () => {
  it.each([
    ['.unified-msg-card__text', 'the card body'],
    ['.unified-modal__text', 'the details modal body'],
  ])('%s keeps newlines (%s)', (selector) => {
    const bodies = rulesFor(UNIFIED_CSS, selector);
    expect(bodies.length).toBeGreaterThan(0);

    // `pre-line` matches the per-source views: collapse runs of spaces, keep
    // the newlines. `pre-wrap` would also preserve leading indentation, which
    // those views deliberately do not.
    expect(effective(bodies, 'white-space')).toBe('pre-line');
  });

  it('leaves the reply preview on one line', () => {
    // `.unified-reply-preview__text` is a single-line ellipsised quote — its
    // `nowrap` is deliberate, and a blanket "preserve newlines everywhere"
    // change would break it.
    const bodies = rulesFor(UNIFIED_CSS, '.unified-reply-preview__text');
    expect(bodies.length).toBeGreaterThan(0);
    expect(effective(bodies, 'white-space')).toBe('nowrap');
  });
});
