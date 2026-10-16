/**
 * The MeshCore form-view control rules must skip the SectionNav.
 *
 * `.meshcore-form-view button` paints every button in the pane purple, and
 * `.meshcore-form-view input` restyles every text box. Unscoped, they turned
 * the Configuration page's section chips purple and its search box grey,
 * unlike the same nav on Automations and on the Meshtastic tabs (#5855
 * review). jsdom has no cascade, so this reads the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve('src/components/MeshCore/MeshCorePage.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Every selector in the sheet that styles a form control in the form view. */
const controlSelectors = (): string[] =>
  [...css.matchAll(/([^{}]+)\{/g)]
    .flatMap((match) => match[1].split(','))
    .map((selector) => selector.trim())
    .filter((selector) => /^\.meshcore-form-view (button|input|select)\b/.test(selector));

describe('MeshCore form-view controls leave the SectionNav alone', () => {
  it('finds the control rules', () => {
    expect(controlSelectors().length).toBeGreaterThanOrEqual(7);
  });

  it('excludes the nav at zero specificity in every control rule', () => {
    for (const selector of controlSelectors()) {
      expect(selector, selector).toMatch(/:where\(:not\(\.section-nav \*\)\)$/);
    }
  });
});
