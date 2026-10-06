/**
 * Vertical placement for the chat NodePopup (#5645).
 *
 * The popup used to sit above its trigger always, with the anchor pushed down
 * to y=320 when there was no room, which covered the trigger. It now flips
 * below when it does not fit above.
 */

/** Gap between the trigger and the popup edge that faces it. */
export const POPUP_ANCHOR_GAP = 10;
/** Least distance kept between the popup and the viewport edge. */
export const POPUP_VIEWPORT_MARGIN = 8;

export interface PopupPlacementInput {
  /** Viewport y of the trigger's top edge. */
  anchorTop: number;
  /** Viewport y of the trigger's bottom edge. */
  anchorBottom: number;
  /** Measured popup height. */
  popupHeight: number;
  viewportHeight: number;
}

export interface PopupPlacement {
  side: 'above' | 'below';
  /** Viewport y for the popup's top edge. */
  top: number;
}

/**
 * Above when it fits (today's behaviour), else below when that fits, else the
 * side with more room, held inside the viewport.
 */
export function computePopupPlacement({
  anchorTop,
  anchorBottom,
  popupHeight,
  viewportHeight,
}: PopupPlacementInput): PopupPlacement {
  const roomAbove = anchorTop - POPUP_ANCHOR_GAP - POPUP_VIEWPORT_MARGIN;
  const roomBelow = viewportHeight - anchorBottom - POPUP_ANCHOR_GAP - POPUP_VIEWPORT_MARGIN;

  if (popupHeight <= roomAbove) {
    return { side: 'above', top: anchorTop - POPUP_ANCHOR_GAP - popupHeight };
  }
  if (popupHeight <= roomBelow) {
    return { side: 'below', top: anchorBottom + POPUP_ANCHOR_GAP };
  }

  // Fits on neither side: take the roomier one and keep the popup on screen.
  // Its top edge wins over its bottom edge, so the header stays in view.
  const side = roomBelow > roomAbove ? 'below' : 'above';
  const wanted = side === 'below'
    ? anchorBottom + POPUP_ANCHOR_GAP
    : anchorTop - POPUP_ANCHOR_GAP - popupHeight;
  const maxTop = viewportHeight - POPUP_VIEWPORT_MARGIN - popupHeight;
  return { side, top: Math.max(POPUP_VIEWPORT_MARGIN, Math.min(wanted, maxTop)) };
}
