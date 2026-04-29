import { useEffect, useState } from 'react';

const QUERY = '(pointer: fine)';

/**
 * Returns true on devices whose primary pointer is precise (mouse/trackpad).
 * Reactive to runtime changes (e.g. docking/undocking a 2-in-1).
 */
export function useIsDesktop(): boolean {
  const get = () => (typeof window === 'undefined' ? false : window.matchMedia(QUERY).matches);
  const [isDesktop, setIsDesktop] = useState<boolean>(get);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent | { matches: boolean }) => {
      setIsDesktop(e.matches);
    };
    mql.addEventListener('change', handler as EventListener);
    setIsDesktop(mql.matches);
    return () => mql.removeEventListener('change', handler as EventListener);
  }, []);

  return isDesktop;
}
