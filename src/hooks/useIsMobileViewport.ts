import { useEffect, useState } from 'react';
import { MOBILE_BREAKPOINT_PX } from '../utils/sidebarWidth';

const QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

/**
 * Whether the viewport is at or below the app's mobile breakpoint.
 *
 * Distinct from `useIsDesktop`, which asks about pointer precision
 * (`pointer: fine`) — a touchscreen laptop is "not desktop" by that test but is
 * emphatically not a phone-width viewport. Components that need to mirror a
 * `@media (max-width: 768px)` CSS rule in JS want this hook; the two questions
 * are not interchangeable.
 *
 * Shares `MOBILE_BREAKPOINT_PX` with the sheets so there is one definition of
 * the breakpoint rather than a hardcoded 768 in yet another place.
 */
export function useIsMobileViewport(): boolean {
  const get = () => (typeof window === 'undefined' ? false : window.matchMedia(QUERY).matches);
  const [isMobile, setIsMobile] = useState<boolean>(get);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent | { matches: boolean }) => setIsMobile(e.matches);
    mql.addEventListener('change', handler as EventListener);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener('change', handler as EventListener);
  }, []);

  return isMobile;
}
