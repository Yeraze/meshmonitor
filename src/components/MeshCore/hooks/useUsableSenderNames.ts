/**
 * Load the sender names this user may pick on a source (#6341 P4).
 * `names` is empty when the feature is off, firmware is too old, the user
 * lacks the grant, or the fetch fails, so callers hide the picker on `[]`.
 */
import { useEffect, useState } from 'react';
import type { UsableSenderNames } from './useMeshCore';

export function useUsableSenderNames(
  fetchUsable: () => Promise<UsableSenderNames | null>,
  active: boolean,
): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!active) {
      setNames([]);
      return;
    }
    let cancelled = false;
    void fetchUsable().then(r => {
      if (cancelled) return;
      setNames(r && r.enabled && r.firmwareSupported ? r.allowedNames : []);
    });
    return () => { cancelled = true; };
  }, [fetchUsable, active]);
  return names;
}
