/**
 * Publishes the sticky section-nav's REAL height as `--section-nav-height`.
 *
 * Sibling of `useAppHeaderHeightVar`, for the same reason and with the same
 * shape. `.section-nav` is `position: sticky` at `top: var(--app-header-height)`
 * (App.css), so it parks in a band directly under the fixed bar and covers
 * anything else that tries to stick into that band — it carries `z-index: 10`.
 *
 * A second sticky element beside it therefore has to clear the bar AND the nav.
 * The bar's height is measured because CSS cannot describe a `height: auto`
 * element; the nav's height needs measuring for a different reason: it is a
 * `flex-wrap: wrap` chip row, so its height is a function of how many chips
 * wrap at the current width. On the Configuration tab that is 29 chips, which
 * renders as three rows at 1500px and fewer as the window widens. No constant
 * can be right at every width.
 *
 * Consumers read it with a `0px` fallback, so a surface that renders no nav —
 * or one that mounts before this hook's first measurement — simply keeps its
 * plain "below the header" offset.
 *
 * Caveat for future consumers: this is the nav's rendered height whatever shape
 * it currently has. ConfigurationTab reshapes it into a left rail on a
 * landscape phone (#5069), where the value is a rail's full column height and
 * means nothing as a downward offset. Today's only consumer — the GPIO Pin
 * Usage sidebar — is `display: none` below 1200px, so it never reads the
 * variable in rail mode.
 */
import { useEffect, type RefObject } from 'react';

/** The custom property "below the header AND the nav" offsets read. */
export const SECTION_NAV_HEIGHT_VAR = '--section-nav-height';

/**
 * Writes `height` onto `root` as `--section-nav-height`, or clears it when the
 * height is not usable so consumers fall back to `0px`.
 *
 * Split out from the hook so the rounding and clear-on-zero rules are testable
 * without a live ResizeObserver, exactly as `publishAppHeaderHeight` is.
 *
 * Zero is not a real measurement — it is what `getBoundingClientRect` reports
 * for a `display: none` element or one read before first layout — and pinning
 * the offset to a stale value would be worse than the fallback.
 */
export function publishSectionNavHeight(root: HTMLElement, height: number): void {
  if (!Number.isFinite(height) || height <= 0) {
    root.style.removeProperty(SECTION_NAV_HEIGHT_VAR);
    return;
  }
  // Round up, for the same reason the header does: a fractional height that
  // rounds DOWN leaves a sliver of the consumer under the nav.
  root.style.setProperty(SECTION_NAV_HEIGHT_VAR, `${Math.ceil(height)}px`);
}

/**
 * Keeps `--section-nav-height` equal to `ref`'s rendered height for as long as
 * the nav is mounted, and hands the variable back on unmount.
 */
export function useSectionNavHeightVar(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = document.documentElement;
    const nav = ref.current;
    if (!nav || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      publishSectionNavHeight(root, nav.getBoundingClientRect().height);
    });
    observer.observe(nav);
    publishSectionNavHeight(root, nav.getBoundingClientRect().height);

    return () => {
      observer.disconnect();
      // Leaving a stale pixel value on <html> would push the next surface that
      // mounts without a nav down by a nav's worth of empty space.
      root.style.removeProperty(SECTION_NAV_HEIGHT_VAR);
    };
  }, [ref]);
}
