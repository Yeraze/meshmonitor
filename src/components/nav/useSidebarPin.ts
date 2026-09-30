/**
 * Shared "Pin sidebar" state for every per-source nav (#5481).
 *
 * One global `sidebar-pinned` localStorage key, so switching between a
 * Meshtastic and a MeshCore source never flips the nav mode. When pinned, the
 * nav starts expanded and a nav click does not collapse it.
 */
import { useCallback, useState } from 'react';

export const SIDEBAR_PINNED_KEY = 'sidebar-pinned';

/** Read the stored pin state. Storage can be unavailable (private mode). */
export function readSidebarPinned(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_PINNED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function useSidebarPin(): { isPinned: boolean; togglePin: () => boolean } {
  const [isPinned, setIsPinned] = useState(readSidebarPinned);

  /** Flip and persist the pin; returns the new value. */
  const togglePin = useCallback((): boolean => {
    const next = !isPinned;
    setIsPinned(next);
    try {
      localStorage.setItem(SIDEBAR_PINNED_KEY, String(next));
    } catch {
      // Storage unavailable: the pin still applies for this page view.
    }
    return next;
  }, [isPinned]);

  return { isPinned, togglePin };
}
