/**
 * Regression test for #4478 — the compose "Send message" button rendered as a
 * solid colored rectangle with no visible icon.
 *
 * `App.css` declared `.send-btn` twice at equal specificity. The later block
 * re-declared `padding: 0.75rem 1.5rem` and won the cascade, while `width: 40px`
 * kept coming from the earlier block. With the global `box-sizing: border-box`
 * (src/index.css), 48px of horizontal padding inside a 40px box leaves zero
 * content width, so the flex child — `<UiIcon name="send" size={16} />` — was
 * squeezed to nothing.
 *
 * jsdom implements neither the cascade across stylesheets nor layout, so a
 * rendering test cannot catch this. These assertions read the stylesheet source
 * instead and check the two properties that actually caused the bug: that there
 * is a single unconditional `.send-btn` rule, and that its box model leaves
 * room for the icon.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_CSS = readFileSync(
  fileURLToPath(new URL('../App.css', import.meta.url)),
  'utf-8'
);

/** Size passed to <UiIcon name="send" size={16} /> in ChannelsTab/MessagesTab. */
const SEND_ICON_PX = 16;

/** Strip comments so commentary mentioning `.send-btn` isn't parsed as a rule. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extract the bodies of every *unconditional* `.send-btn { ... }` rule — i.e.
 * ones at column 0, excluding indented copies nested inside `@media` blocks and
 * excluding compound selectors like `.send-btn:hover` / `.send-btn > svg`.
 */
function unconditionalSendBtnRules(css: string): string[] {
  return [...stripComments(css).matchAll(/^\.send-btn\s*\{([^}]*)\}/gm)].map(m => m[1]);
}

/**
 * Resolve a property the way the cascade does: across every matching rule at
 * equal specificity, the *last* declaration wins. Reading only the first rule
 * would miss precisely the bug this file guards — the original stylesheet's
 * first `.send-btn` block had perfectly fine geometry, and the duplicate that
 * broke it came later.
 */
function effectiveDeclaration(bodies: string[], prop: string): string | undefined {
  let winner: string | undefined;
  for (const body of bodies) {
    const match = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (match) winner = match[1].trim();
  }
  return winner;
}

/** Convert a `rem`/`px` CSS length to px, assuming the 16px root font size. */
function toPx(value: string): number {
  const rem = value.match(/^(-?[\d.]+)rem$/);
  if (rem) return parseFloat(rem[1]) * 16;
  const px = value.match(/^(-?[\d.]+)px$/);
  if (px) return parseFloat(px[1]);
  throw new Error(`Unsupported CSS length: ${value}`);
}

describe('.send-btn leaves room for its icon (#4478)', () => {
  it('is declared exactly once, so no later block can silently win the cascade', () => {
    expect(unconditionalSendBtnRules(APP_CSS)).toHaveLength(1);
  });

  it('has horizontal padding that fits inside its fixed width under border-box', () => {
    const bodies = unconditionalSendBtnRules(APP_CSS);

    const width = effectiveDeclaration(bodies, 'width');
    const padding = effectiveDeclaration(bodies, 'padding');
    expect(width).toBeDefined();
    expect(padding).toBeDefined();

    // `padding: <vertical> <horizontal>` — the horizontal component is what
    // eats into the content box on a fixed-width, border-box button.
    const parts = padding!.split(/\s+/);
    const horizontal = toPx(parts.length > 1 ? parts[1] : parts[0]);
    const contentWidth = toPx(width!) - horizontal * 2;

    expect(contentWidth).toBeGreaterThanOrEqual(SEND_ICON_PX);
  });

  it('pins the icon against future padding regressions', () => {
    expect(stripComments(APP_CSS)).toMatch(
      /\.send-btn\s*>\s*svg\s*\{[^}]*flex-shrink:\s*0/
    );
  });
});
