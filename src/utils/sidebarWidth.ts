/**
 * Node-list sidebar sizing rules (issue: mobile node list capped at half width).
 *
 * The Map view's node list is drag-resizable. Its ceiling used to be a flat
 * `window.innerWidth * 0.5` regardless of viewport, which is wrong on a phone:
 * there the list is the primary surface and the map lives behind a toggle, so
 * half the screen is an arbitrary limit on the pane you are actually reading.
 * On a 390px-wide phone it was worse than arbitrary — the 195px ceiling landed
 * *below* the 200px floor, pinning the list to exactly one width.
 */

/** Matches the `@media (max-width: 768px)` breakpoint used across the sheets. */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * Matches the `@media (max-height: 500px) and (orientation: landscape)` block.
 * A landscape phone is wider than MOBILE_BREAKPOINT_PX but is still the mobile
 * layout — App.css collapses the rail to 48px for both conditions, so the width
 * test alone would misclassify it as desktop.
 */
export const MOBILE_LANDSCAPE_MAX_HEIGHT_PX = 500;

/** Narrowest useful node list. */
export const NODE_SIDEBAR_MIN_WIDTH_PX = 200;

/** Fraction of the available area the list may claim on a desktop viewport. */
export const NODE_SIDEBAR_DESKTOP_MAX_FRACTION = 0.5;

/**
 * Whether the viewport is in the app's mobile layout.
 *
 * Deliberately mirrors the two `:root { --sidebar-width: 48px }` media queries
 * in App.css rather than inventing a third definition of "mobile". Keep the two
 * in sync: if those queries change, this changes with them.
 *
 * Note this does NOT catch a 1366x768 laptop (width > 768, height > 500), so
 * desktop keeps its 50% split.
 */
export function isMobileLayout(viewportWidth: number, viewportHeight: number): boolean {
  if (viewportWidth <= MOBILE_BREAKPOINT_PX) return true;
  return viewportHeight <= MOBILE_LANDSCAPE_MAX_HEIGHT_PX && viewportWidth > viewportHeight;
}

/**
 * Largest width the node list may be dragged to.
 *
 * @param availableWidth Width of the split-view container — NOT the viewport.
 *   The container is `position: fixed; left: var(--sidebar-width); right: 0`, so
 *   it already excludes the app rail (48px mobile / 60px desktop). Measuring the
 *   container rather than subtracting a hardcoded rail width keeps this correct
 *   if the rail ever changes.
 * @param mobile Result of isMobileLayout() for the current viewport.
 *
 * Mobile: the whole container, so the list can cover the map entirely.
 * Desktop: half, so the map keeps usable space next to it.
 *
 * Never returns less than the floor — a container narrower than the floor would
 * otherwise produce max < min, which pins the list to a single width.
 */
export function resolveNodeSidebarMaxWidth(availableWidth: number, mobile: boolean): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return NODE_SIDEBAR_MIN_WIDTH_PX;
  }
  const max = mobile
    ? availableWidth
    : Math.round(availableWidth * NODE_SIDEBAR_DESKTOP_MAX_FRACTION);
  return Math.max(NODE_SIDEBAR_MIN_WIDTH_PX, max);
}
