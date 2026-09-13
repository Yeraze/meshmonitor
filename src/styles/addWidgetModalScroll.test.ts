/**
 * Regression tests for the Add Widget picker being unscrollable (#5191).
 *
 * `.add-widget-modal` caps itself at `max-height: 80vh` and sets
 * `overflow: hidden`, so anything past that cap is clipped. The content region
 * inside it, `.add-widget-modal-content`, declared no overflow of its own — so
 * the clipped remainder was not scrollable, merely gone. Every widget below the
 * fold was unreachable, which on a ~390px-wide phone is everything after the
 * first few cards.
 *
 * Two things make the fix work, and both are asserted here because either one
 * alone silently does nothing:
 *
 *  - `overflow-y: auto` on the content region, so it scrolls rather than
 *    handing its overflow to the clipped parent; and
 *  - `min-height: 0` on that same region. A flex child defaults to
 *    `min-height: auto`, which refuses to shrink below its content — the
 *    overflow would be pushed straight back out to the parent and `overflow-y`
 *    would have no effect. This is the same class of trap as the `1fr` →
 *    `minmax(auto, 1fr)` min-content floor in #5093.
 *
 * Asserted at EVERY viewport, not just mobile. The defect is not
 * orientation-specific — a long enough list overflows 80vh on a desktop too —
 * and the #5051/#5053/#5054/#5060 family is a standing reminder that a
 * `max-width`-gated fix switches itself off on rotation. Note also that
 * Dashboard.css declares its `@media` blocks ABOVE these rules, so a mobile
 * override added there would be shadowed by the later base rule; keeping the
 * fix unconditional sidesteps that ordering hazard entirely.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createResolver,
  type Viewport,
  PORTRAIT_PHONE,
  LANDSCAPE_PHONE,
  LANDSCAPE_BIG_PHONE,
  LANDSCAPE_SMALL_PHONE,
  DESKTOP,
} from './cssCascadeResolver';

const css = readFileSync(resolve('src/components/Dashboard.css'), 'utf-8');
const resolveCss = createResolver(css);

const ALL_VIEWPORTS: Array<[string, Viewport]> = [
  ['portrait phone', PORTRAIT_PHONE],
  ['landscape phone', LANDSCAPE_PHONE],
  ['landscape big phone', LANDSCAPE_BIG_PHONE],
  ['landscape small phone', LANDSCAPE_SMALL_PHONE],
  ['desktop', DESKTOP],
];

describe('Add Widget picker scrolls to every widget (#5191)', () => {
  it.each(ALL_VIEWPORTS)(
    '.add-widget-modal-content scrolls its own overflow at %s',
    (_label, vp) => {
      expect(resolveCss('.add-widget-modal-content', 'overflow-y', vp)).toBe('auto');
    }
  );

  it.each(ALL_VIEWPORTS)(
    '.add-widget-modal-content zeroes its flex min-height floor at %s',
    (_label, vp) => {
      // Without this the region cannot shrink below its content, so the
      // overflow returns to the clipped parent and overflow-y does nothing.
      expect(resolveCss('.add-widget-modal-content', 'min-height', vp)).toBe('0');
    }
  );

  it.each(ALL_VIEWPORTS)(
    '.add-widget-modal is a flex column so the content region can flex at %s',
    (_label, vp) => {
      expect(resolveCss('.add-widget-modal', 'display', vp)).toBe('flex');
      expect(resolveCss('.add-widget-modal', 'flex-direction', vp)).toBe('column');
    }
  );

  it('keeps the modal itself clipped, so the scroll belongs to the content region', () => {
    // If the modal stopped hiding its overflow the rounded corners would leak
    // and the page behind would scroll instead — the scroll must live inside.
    expect(resolveCss('.add-widget-modal', 'overflow', DESKTOP)).toBe('hidden');
  });

  it('caps height with a dvh pair so iOS Safari does not overshoot', () => {
    // `vh` on iOS counts the collapsing address bar, so 80vh can exceed what is
    // actually visible. The dvh declaration must WIN (come later), with vh kept
    // as the fallback for browsers that do not support dvh.
    const resolved = resolveCss('.add-widget-modal', 'max-height', DESKTOP);
    expect(resolved).toBe('80dvh');
    expect(css).toContain('max-height: 80vh;');
  });

  it('does not chain the scroll to the page behind the modal', () => {
    expect(resolveCss('.add-widget-modal-content', 'overscroll-behavior', DESKTOP)).toBe('contain');
  });
});
