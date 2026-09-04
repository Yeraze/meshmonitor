import { useEffect, useState } from 'react';
import { MOBILE_BREAKPOINT_PX, MOBILE_LAYOUT_MEDIA_QUERY } from '../utils/sidebarWidth';

const QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

/** Shared plumbing: track one media query and re-render when it flips. */
function useMediaQuery(query: string): boolean {
  const get = () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches);
  const [matches, setMatches] = useState<boolean>(get);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent | { matches: boolean }) => setMatches(e.matches);
    mql.addEventListener('change', handler as EventListener);
    setMatches(mql.matches);
    return () => mql.removeEventListener('change', handler as EventListener);
  }, [query]);

  return matches;
}

/**
 * Whether the viewport is at or below the app's mobile breakpoint.
 *
 * Distinct from `useIsDesktop`, which asks about pointer precision
 * (`pointer: fine`) — a touchscreen laptop is "not desktop" by that test but is
 * emphatically not a phone-width viewport. Components that need to mirror a
 * `@media (max-width: 768px)` CSS rule in JS want this hook; the two questions
 * are not interchangeable.
 *
 * Width ONLY. A phone in landscape is 844 or 915 CSS pixels wide, so this
 * returns false there — which is correct for a component whose CSS is also
 * width-only, and wrong for one that follows the shell's small-screen
 * definition. Those want `useIsMobileLayoutViewport` below (#5060).
 *
 * Shares `MOBILE_BREAKPOINT_PX` with the sheets so there is one definition of
 * the breakpoint rather than a hardcoded 768 in yet another place.
 */
export function useIsMobileViewport(): boolean {
  return useMediaQuery(QUERY);
}

/**
 * Whether the viewport is in the app shell's *mobile layout* — narrow in either
 * orientation, i.e. `(max-width: 768px)` OR a short landscape screen.
 *
 * The JS twin of `isMobileLayout()` and of the two-clause media query the
 * sheets use. Prefer this over `useIsMobileViewport` whenever the component's
 * own CSS carries the landscape clause, so the JS and the CSS cannot disagree
 * about what "mobile" means on a rotated phone (#5060).
 */
export function useIsMobileLayoutViewport(): boolean {
  return useMediaQuery(MOBILE_LAYOUT_MEDIA_QUERY);
}
