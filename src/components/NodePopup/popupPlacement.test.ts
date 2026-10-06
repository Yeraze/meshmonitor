import { describe, it, expect } from 'vitest';
import { computePopupPlacement, POPUP_ANCHOR_GAP, POPUP_VIEWPORT_MARGIN } from './popupPlacement';

describe('computePopupPlacement (#5645)', () => {
  it('sits above the trigger when there is room', () => {
    expect(computePopupPlacement({ anchorTop: 500, anchorBottom: 532, popupHeight: 300, viewportHeight: 800 }))
      .toEqual({ side: 'above', top: 500 - POPUP_ANCHOR_GAP - 300 });
  });

  it('flips below when there is no room above', () => {
    expect(computePopupPlacement({ anchorTop: 60, anchorBottom: 92, popupHeight: 300, viewportHeight: 800 }))
      .toEqual({ side: 'below', top: 92 + POPUP_ANCHOR_GAP });
  });

  it('stays above when the popup fits exactly', () => {
    const anchorTop = 300 + POPUP_ANCHOR_GAP + POPUP_VIEWPORT_MARGIN;
    expect(computePopupPlacement({ anchorTop, anchorBottom: anchorTop + 32, popupHeight: 300, viewportHeight: 800 }).side)
      .toBe('above');
  });

  it('flips one pixel short of fitting above', () => {
    const anchorTop = 300 + POPUP_ANCHOR_GAP + POPUP_VIEWPORT_MARGIN - 1;
    expect(computePopupPlacement({ anchorTop, anchorBottom: anchorTop + 32, popupHeight: 300, viewportHeight: 800 }).side)
      .toBe('below');
  });

  it('takes the roomier side and stays on screen when neither side fits', () => {
    const below = computePopupPlacement({ anchorTop: 100, anchorBottom: 132, popupHeight: 300, viewportHeight: 400 });
    expect(below.side).toBe('below');
    expect(below.top).toBe(400 - POPUP_VIEWPORT_MARGIN - 300);

    const above = computePopupPlacement({ anchorTop: 280, anchorBottom: 312, popupHeight: 300, viewportHeight: 400 });
    expect(above.side).toBe('above');
    expect(above.top).toBe(POPUP_VIEWPORT_MARGIN);
  });

  it('never puts the top edge off screen, even for a popup taller than the viewport', () => {
    const placed = computePopupPlacement({ anchorTop: 100, anchorBottom: 132, popupHeight: 900, viewportHeight: 400 });
    expect(placed.top).toBe(POPUP_VIEWPORT_MARGIN);
  });

  it('places an unmeasured (zero-height) popup above', () => {
    expect(computePopupPlacement({ anchorTop: 200, anchorBottom: 232, popupHeight: 0, viewportHeight: 800 }))
      .toEqual({ side: 'above', top: 190 });
  });
});
