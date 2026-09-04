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
 *
 * This is the shell's threshold: below it the nav is a bottom bar. Sidebar.css
 * and SidebarFooter.module.css carry a separate `max-height: 700px` landscape
 * query, but that one compacts the vertical RAIL and is scoped
 * `min-width: 769px` / `min-height: 501px` so it cannot reach into bar
 * territory (#5053). The two describe different things and are allowed to
 * differ; what is not allowed is the rail query overlapping this one.
 *
 * If you change this number, change every
 * `(max-height: 500px) and (orientation: landscape)` block with it — and the
 * `min-height` guard on the rail blocks.
 */
export const MOBILE_LANDSCAPE_MAX_HEIGHT_PX = 500;

/**
 * The shell's definition of "mobile layout", written as a CSS media query.
 *
 * This is the exact condition `isMobileLayout()` implements, and the exact
 * condition the sheets spell out by hand as
 * `(max-width: 768px), (max-height: 500px) and (orientation: landscape)`.
 * Components whose CSS carries that pair of clauses and which ALSO need to know
 * the answer in JS should match against this string rather than re-deriving a
 * third definition — `MapSidebar` reads it for its collapsed-by-default rule
 * (#5060), where a width-only test left the panel open over the map on a
 * landscape phone.
 */
export const MOBILE_LAYOUT_MEDIA_QUERY =
  `(max-width: ${MOBILE_BREAKPOINT_PX}px), ` +
  `(max-height: ${MOBILE_LANDSCAPE_MAX_HEIGHT_PX}px) and (orientation: landscape)`;

/** Narrowest useful node list. */
export const NODE_SIDEBAR_MIN_WIDTH_PX = 200;

/** Fraction of the available area the list may claim on a desktop viewport. */
export const NODE_SIDEBAR_DESKTOP_MAX_FRACTION = 0.5;

/**
 * Whether the viewport is in the app's mobile layout.
 *
 * Deliberately mirrors the two `:root { --sidebar-width: … }` media queries in
 * App.css rather than inventing a third definition of "mobile". Keep the two in
 * sync: if those queries change, this changes with them. (Those blocks now set
 * the width to 0 — the mobile nav is a bottom bar, #4473 phase 2 — but the
 * breakpoints they key off are unchanged.)
 *
 * Note this does NOT catch a 1366x768 laptop (width > 768, height > 500), so
 * desktop keeps its 50% split.
 */
export function isMobileLayout(viewportWidth: number, viewportHeight: number): boolean {
  if (viewportWidth <= MOBILE_BREAKPOINT_PX) return true;
  // `>=` not `>`: CSS `orientation: landscape` counts a square viewport as
  // landscape. The two can only ever disagree at width === height, which also
  // requires height <= 500 and therefore width <= 500 — already caught by the
  // width rule above — so this is about making the "mirrors the CSS" claim
  // exactly true rather than about a reachable case.
  return viewportHeight <= MOBILE_LANDSCAPE_MAX_HEIGHT_PX && viewportWidth >= viewportHeight;
}

/**
 * Largest width the node list may be dragged to.
 *
 * @param availableWidth Width of the split-view container — NOT the viewport.
 *   The container is `position: fixed; left: var(--sidebar-width); right: 0`, so
 *   it already excludes the app rail (0 on mobile, where the nav is a bottom
 *   bar; 60px desktop). Measuring the container rather than subtracting a
 *   hardcoded rail width is exactly what let the mobile rail become a bottom bar
 *   (#4473 phase 2) without touching this function.
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
