/**
 * Regression test for #5247 (issue 1) — the short-name badge in the map node
 * popup rendered as black text on dark grey, effectively unreadable.
 *
 * `NodeCardHeader` tints the popup header with the node's list color and sets
 * the badge's text color INLINE to `readableTextColor(<that header color>)`.
 * The badge, meanwhile, carried its own `background: var(--color-surface-hover)`
 * from the stylesheet. So the text color was computed against one background
 * and painted onto a different one. The reported case was a bright green header
 * (→ black text chosen) over the badge's dark grey fill.
 *
 * Making the badge outlined — transparent background, `currentColor` border —
 * removes the second background entirely: the badge sits ON the header color,
 * so the inline text color is correct by construction for any node color and
 * either theme.
 *
 * jsdom applies neither external stylesheets nor color compositing, so a render
 * test cannot catch this. These assertions read the stylesheet source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NODES_CSS = readFileSync(
  fileURLToPath(new URL('./nodes.css', import.meta.url)),
  'utf-8'
);

/** Strip comments so prose naming a selector isn't parsed as a rule. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Bodies of every unconditional (column-0) rule for `selector`. */
function rulesFor(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...stripComments(css).matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm'))]
    .map((m) => m[1]);
}

/** Last declaration wins among same-specificity rules, as the cascade does. */
function effective(bodies: string[], prop: string): string | undefined {
  let winner: string | undefined;
  for (const body of bodies) {
    const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) winner = m[1].trim();
  }
  return winner;
}

describe('node popup short-name badge (#5247)', () => {
  const bodies = rulesFor(NODES_CSS, '.node-popup-subtitle');

  it('has exactly one unconditional rule, so nothing later re-fills it', () => {
    expect(bodies).toHaveLength(1);
  });

  it('is outlined, not filled — no background of its own to fight the header tint', () => {
    // This is the actual bug. Any opaque background here re-introduces the
    // mismatch between the inline text color and what sits behind it.
    expect(effective(bodies, 'background')).toBe('transparent');
    expect(effective(bodies, 'background-color')).toBeUndefined();
  });

  it('borders in currentColor so the outline tracks the inline text color', () => {
    // A fixed border color would drift from the node-color-derived text color
    // and reintroduce a contrast collision on some node colors.
    expect(effective(bodies, 'border')).toMatch(/currentColor/i);
  });
});
