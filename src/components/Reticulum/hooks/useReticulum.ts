/**
 * useReticulum — poll-based Reticulum state for a single source (#3960
 * Phase 1b WP1).
 *
 * Mirrors `useMeshCore`'s hook shape (see
 * `src/components/MeshCore/hooks/useMeshCore.ts`), minus the Socket.io
 * wiring: Phase 1a wired no `reticulum:*` push events (build spec §0 R4,
 * "no realtime") — so unlike `useMeshCore`'s 30s status-only *safety* poll
 * that backs up live push events, this hook's interval is the ONLY refresh
 * mechanism for `status`/`destinations`/`interfaces` alike, and all three
 * refresh together on the same cadence.
 *
 * Reads route through `/api/sources/:id/reticulum/*` via `api.get`
 * (`src/services/api.ts`). `ApiService.request()` returns the raw response
 * body and does NOT unwrap the `{success,data}` envelope (CLAUDE.md gotcha)
 * — every response here is unwrapped defensively (`res?.data ?? res`,
 * mirroring `meshcoreDashboardSource` in `dataSources.ts`) so a route that
 * ever changes envelope shape degrades gracefully instead of crashing.
 *
 * `enabled: false` short-circuits all fetches, matching `useMeshCore` — used
 * to honour permission gates that should suppress polling entirely.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../services/api';
import type {
  ReticulumStatus,
  ReticulumDestinationRow,
  ReticulumInterfaceRow,
} from '../../../types/reticulum';

// No Socket.io events exist for Reticulum sources (R4) — this interval is
// the hook's ONLY refresh mechanism, not a safety net for missed pushes.
const POLL_INTERVAL_MS = 30000;

export interface UseReticulumOptions {
  /** Source UUID — all reads/actions are scoped to this source. */
  sourceId: string;
  /** When false, the hook returns initial state and never polls. */
  enabled?: boolean;
}

export interface UseReticulumState {
  status: ReticulumStatus | null;
  destinations: ReticulumDestinationRow[];
  interfaces: ReticulumInterfaceRow[];
  loading: boolean;
  error: string | null;
  /** Re-fetch status + destinations + interfaces immediately. */
  refresh: () => Promise<void>;
  /** POST /destinations/:hash/favorite. Resolves `true` on success and
   *  optimistically patches the local `destinations` list from the server's
   *  echoed `isFavorite`. */
  toggleFavorite: (destinationHash: string, favorite: boolean) => Promise<boolean>;
}

/** An endpoint's raw response, before unwrapping the `{success,data}` envelope. */
type Enveloped<T> = { data?: T } | T;

/**
 * Defensive unwrap for the `{success,data}` envelope. `api.get`/`api.post`
 * return the raw body and do not unwrap `data` themselves — see the module
 * doc comment above and CLAUDE.md's `ApiService.request()` gotcha.
 */
function unwrapData<T>(res: Enveloped<T>): T {
  if (res && typeof res === 'object' && 'data' in res && (res as { data?: T }).data !== undefined) {
    return (res as { data: T }).data;
  }
  return res as T;
}

export function useReticulum(options: UseReticulumOptions): UseReticulumState {
  const { sourceId, enabled = true } = options;

  const prefix = `/api/sources/${encodeURIComponent(sourceId)}/reticulum`;

  const [status, setStatus] = useState<ReticulumStatus | null>(null);
  const [destinations, setDestinations] = useState<ReticulumDestinationRow[]>([]);
  const [interfaces, setInterfaces] = useState<ReticulumInterfaceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards state updates from an in-flight poll racing a hook teardown
  // (rapid enable/disable toggling, or unmount mid-fetch).
  const cancelledRef = useRef(false);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (!enabled || !sourceId) return;
    setLoading(true);
    try {
      const [statusRes, destinationsRes, interfacesRes] = await Promise.all([
        api.get<Enveloped<ReticulumStatus>>(`${prefix}/status`),
        api.get<Enveloped<ReticulumDestinationRow[]>>(`${prefix}/destinations`),
        api.get<Enveloped<ReticulumInterfaceRow[]>>(`${prefix}/interfaces`),
      ]);
      if (cancelledRef.current) return;
      setStatus(unwrapData(statusRes));
      setDestinations(unwrapData(destinationsRes) ?? []);
      setInterfaces(unwrapData(interfacesRes) ?? []);
      setError(null);
    } catch (err) {
      if (cancelledRef.current) return;
      console.error('Failed to load Reticulum snapshot:', err);
      setError(err instanceof Error ? err.message : 'Failed to load Reticulum data');
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [enabled, sourceId, prefix]);

  useEffect(() => {
    // The cleanup below runs on every deps change (e.g. an `enabled` flip),
    // not just unmount — reset the flag so a disable→enable cycle doesn't
    // leave state updates permanently suppressed.
    cancelledRef.current = false;
    if (!enabled) return;
    void fetchAll();
    const interval = setInterval(() => { void fetchAll(); }, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [enabled, fetchAll]);

  const toggleFavorite = useCallback(async (destinationHash: string, favorite: boolean): Promise<boolean> => {
    try {
      const res = await api.post<Enveloped<{ destinationHash: string; isFavorite: boolean }>>(
        `${prefix}/destinations/${encodeURIComponent(destinationHash)}/favorite`,
        { favorite },
      );
      const data = unwrapData(res);
      setDestinations(prev => prev.map(d => (
        d.destinationHash === destinationHash
          ? { ...d, isFavorite: data?.isFavorite ?? favorite }
          : d
      )));
      return true;
    } catch (err) {
      console.error('Failed to toggle Reticulum destination favorite:', err);
      setError(err instanceof Error ? err.message : 'Failed to update favorite');
      return false;
    }
  }, [prefix]);

  return {
    status,
    destinations,
    interfaces,
    loading,
    error,
    refresh: fetchAll,
    toggleFavorite,
  };
}
