/**
 * Publishes the fixed app header's REAL height as `--app-header-height`.
 *
 * `.app-header` is `position: fixed`, so it is out of flow and every surface
 * below it reserves room by hand. App.css defines `--app-header-height` as
 * `--header-height + env(safe-area-inset-top)` — correct wherever the bar has a
 * deterministic height, and what renders on first paint.
 *
 * It is NOT correct in compact landscape. There `.app-header` is `height: auto`
 * (AppHeader.css) because the 768px mobile compaction block cannot reach a
 * landscape phone — a phone held sideways is *wider* than 768px — so the bar
 * carries desktop-sized content and renders 57-60px against a 40px
 * `--header-height`. Measured on a 852x393 viewport at v4.16.0-rc3: header
 * 0-60px, `.app-main` padding-top 44px, and `document.elementFromPoint()` over
 * the Info tab's heading returned `.app-header`. That is #5070; the same 20px
 * swallowed the node list's collapse control in #5053.
 *
 * CSS cannot express "however tall that element ended up", so this measures it.
 * Doing it here rather than hardcoding a taller landscape constant also means
 * the offsets keep following the bar when its contents change — the header's
 * horizontal layout is under active work (#5051), and a constant would go stale
 * the moment the badge or the back button is resized.
 *
 * Deliberately querying `.app-header` rather than threading a ref through
 * `AppHeader`: the element is rendered unconditionally by the app shell, and a
 * DOM read keeps this concern entirely out of that component.
 */
import { useEffect } from 'react';

/** The custom property every "content starts below the header" offset reads. */
export const APP_HEADER_HEIGHT_VAR = '--app-header-height';

/**
 * Writes `height` onto `root` as `--app-header-height`, or clears the override
 * when the height is not usable so the CSS fallback takes back over.
 *
 * Split out from the hook so the rounding and clear-on-zero rules are testable
 * without a live ResizeObserver.
 *
 * A zero height is not a real measurement — it is what `getBoundingClientRect`
 * reports for a `display: none` element or one measured before first layout —
 * and pinning the offset to 0 would slide every page up under the bar, which is
 * the very bug this exists to prevent. Falling back to the static CSS
 * expression is always safe.
 */
export function publishAppHeaderHeight(root: HTMLElement, height: number): void {
  if (!Number.isFinite(height) || height <= 0) {
    root.style.removeProperty(APP_HEADER_HEIGHT_VAR);
    return;
  }
  // Round up: a fractional height (device pixel ratios produce 57.33px) that
  // rounds DOWN leaves a sliver of content under the bar, which is exactly the
  // symptom being fixed. Half a pixel of extra gap is invisible.
  root.style.setProperty(APP_HEADER_HEIGHT_VAR, `${Math.ceil(height)}px`);
}

export function useAppHeaderHeightVar(): void {
  useEffect(() => {
    const root = document.documentElement;
    if (typeof ResizeObserver === 'undefined') return;

    let observer: ResizeObserver | null = null;
    let stopWaiting: (() => void) | null = null;

    const measure = (header: Element) => {
      publishAppHeaderHeight(root, header.getBoundingClientRect().height);
    };

    const attach = (header: Element) => {
      observer = new ResizeObserver(() => measure(header));
      observer.observe(header);
      measure(header);
    };

    const header = document.querySelector('.app-header');
    if (header) {
      attach(header);
    } else {
      // The shell renders the header unconditionally, so this is a first-paint
      // ordering safety net rather than an expected path. Watch for it instead
      // of leaving the variable on its static fallback forever.
      const mutations = new MutationObserver(() => {
        const late = document.querySelector('.app-header');
        if (!late) return;
        mutations.disconnect();
        stopWaiting = null;
        attach(late);
      });
      mutations.observe(document.body, { childList: true, subtree: true });
      stopWaiting = () => mutations.disconnect();
    }

    return () => {
      stopWaiting?.();
      observer?.disconnect();
      // Hand the variable back to the CSS fallback. Leaving a stale pixel value
      // on <html> would misreport the header height to any surface that mounts
      // without the app shell — the Dashboard, for one.
      root.style.removeProperty(APP_HEADER_HEIGHT_VAR);
    };
  }, []);
}
