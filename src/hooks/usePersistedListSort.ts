import { useCallback, useState } from 'react';
import type { SortDirection } from '../types/ui.js';

interface Stored<F extends string> {
  field: F;
  direction: SortDirection;
}

/**
 * A node/DM list sort choice saved in localStorage as `{field, direction}`.
 * A stored field outside `allowed` (or garbage / throwing storage) falls back
 * to `defaults`. Shared by the Meshtastic and MeshCore lists.
 */
export function usePersistedListSort<F extends string>(
  storageKey: string,
  allowed: readonly F[],
  defaults: { field: F; direction: SortDirection }
): {
  field: F;
  direction: SortDirection;
  setField: (f: F) => void;
  toggleDirection: () => void;
} {
  const [state, setState] = useState<Stored<F>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Stored<F>> | null;
        if (parsed && allowed.includes(parsed.field as F)) {
          return {
            field: parsed.field as F,
            direction: parsed.direction === 'desc' ? 'desc' : parsed.direction === 'asc' ? 'asc' : defaults.direction,
          };
        }
      }
    } catch {
      // fall through to defaults
    }
    return { field: defaults.field, direction: defaults.direction };
  });

  const persist = useCallback(
    (next: Stored<F>) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // ignore
      }
    },
    [storageKey]
  );

  const setField = useCallback(
    (field: F) => {
      setState((prev) => {
        const next = { ...prev, field };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const toggleDirection = useCallback(() => {
    setState((prev) => {
      const next = { ...prev, direction: prev.direction === 'asc' ? ('desc' as const) : ('asc' as const) };
      persist(next);
      return next;
    });
  }, [persist]);

  return { field: state.field, direction: state.direction, setField, toggleDirection };
}
