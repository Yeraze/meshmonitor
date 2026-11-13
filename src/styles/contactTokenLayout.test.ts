/**
 * #6370 browser review: layout of the MeshCore Share contact picker and the
 * composer + menu.
 *
 * jsdom has no layout, so each fix is pinned by resolving the real sheet at
 * the viewport the bug was seen on (same approach as review4173P7aLayout).
 *  - 844x390: the list's vh cap outgrew the short modal (nested scroll, last
 *    row clipped). 390x844: the cap stopped the list well short of the modal.
 *    Fix: the modal is a fixed-height flex column and the list takes the rest.
 *  - Filtering re-centred the modal (search box jumped): its height is fixed.
 *  - "Share my contact info" wrapped in the + menu.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  topLevelBlocks,
  mediaMatches,
  PORTRAIT_PHONE,
  LANDSCAPE_PHONE,
  DESKTOP,
  type Viewport,
} from './cssCascadeResolver';

/** `(selector, property, viewport) => value | null`, source order decides. */
function sheet(path: string) {
  const blocks = topLevelBlocks(readFileSync(resolve(path), 'utf-8'));
  return (selector: string, property: string, vp: Viewport): string | null => {
    let winner: string | null = null;
    for (const block of blocks) {
      if (block.condition !== null && !mediaMatches(block.condition, vp)) continue;
      const ruleRe = /([^{}]+)\{([^}]*)\}/g;
      let rule: RegExpExecArray | null;
      while ((rule = ruleRe.exec(block.body)) !== null) {
        const selectors = rule[1].split(',').map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' '));
        if (!selectors.includes(selector)) continue;
        const declRe = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g');
        let decl: RegExpExecArray | null;
        while ((decl = declRe.exec(rule[2])) !== null) winner = decl[1].trim();
      }
    }
    return winner;
  };
}

const VIEWPORTS = [
  ['390x844 portrait', PORTRAIT_PHONE],
  ['844x390 landscape', LANDSCAPE_PHONE],
  ['desktop', DESKTOP],
] as const;

describe('Share contact picker: one scroll area that fills the modal', () => {
  const css = sheet('src/components/MeshCore/MeshCoreContactToken.module.css');

  it.each(VIEWPORTS)('at %s the modal is a non-scrolling flex column', (_label, vp) => {
    expect(css('.pickerModal.pickerModal', 'display', vp)).toBe('flex');
    expect(css('.pickerModal.pickerModal', 'flex-direction', vp)).toBe('column');
    expect(css('.pickerModal.pickerModal', 'overflow', vp)).toBe('hidden');
    expect(css('.pickerModal :global(.modal-body)', 'flex', vp)).toBe('1 1 auto');
    expect(css('.pickerModal :global(.modal-body)', 'min-height', vp)).toBe('0');
    expect(css('.pickerModal :global(.modal-body)', 'display', vp)).toBe('flex');
  });

  it.each(VIEWPORTS)('at %s the list takes the remaining height with no vh cap', (_label, vp) => {
    expect(css('.pickerList', 'flex', vp)).toBe('1 1 auto');
    expect(css('.pickerList', 'min-height', vp)).toBe('0');
    expect(css('.pickerList', 'overflow-y', vp)).toBe('auto');
    expect(css('.pickerList', 'max-height', vp)).toBeNull();
    expect(css('.search', 'flex-shrink', vp)).toBe('0');
  });

  it.each([['844x390 landscape', LANDSCAPE_PHONE], ['desktop', DESKTOP]] as const)(
    'at %s pins the height to the 80vh cap, so filtering never re-centres the modal',
    (_label, vp) => {
      expect(css('.pickerModal.pickerModal', 'height', vp)).toBe('calc(80vh - var(--keyboard-inset, 0px))');
    },
  );

  it('leaves a portrait phone to the shared full-screen modal height (no competing rule)', () => {
    expect(css('.pickerModal.pickerModal', 'height', PORTRAIT_PHONE)).toBeNull();
    const modal = sheet('src/components/common/Modal.css');
    expect(modal('.modal-overlay .modal-content', 'height', PORTRAIT_PHONE)).toBe('calc(100dvh - var(--keyboard-inset, 0px))');
  });
});

describe('composer + menu entries stay on one line', () => {
  const css = sheet('src/components/ComposeInsertMenu.module.css');

  it.each(VIEWPORTS)('at %s labels do not wrap and the menu fits the screen', (_label, vp) => {
    expect(css('.itemLabel', 'white-space', vp)).toBe('nowrap');
    expect(css('.itemLabel', 'text-overflow', vp)).toBe('ellipsis');
    expect(css('.menu', 'width', vp)).toBe('max-content');
    expect(css('.menu', 'max-width', vp)).toBe('min(20rem, calc(100vw - 2rem))');
    expect(css('.menu', 'right', vp)).toBe('0');
  });
});
