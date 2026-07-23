/**
 * useAtakContacts — REST-backed ATAK contacts store for a single source
 * (ATAK/CoT Phase 2, issue #3691).
 *
 * Modeled directly on `useWaypoints`: TanStack Query keyed
 * `['atakContacts', sourceId]`, unwraps `body.data`. No websocket
 * invalidation exists for ATAK contacts (low-volume, always-on) — a fixed
 * 30s `refetchInterval` is the binding decision (spec §2f), matching
 * `staleTime`.
 */
import { useQuery } from '@tanstack/react-query';
import type { AtakContact } from '../types/atakContact';
import { appBasename } from '../init';

function atakContactsApiBase(sourceId: string): string {
  return `${appBasename}/api/sources/${encodeURIComponent(sourceId)}/atak/contacts`;
}

async function fetchAtakContacts(sourceId: string): Promise<AtakContact[]> {
  const res = await fetch(atakContactsApiBase(sourceId), { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load ATAK contacts (HTTP ${res.status})`);
  const body = await res.json();
  return Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
}

export function useAtakContacts(sourceId: string | null | undefined) {
  const enabled = Boolean(sourceId);

  const query = useQuery<AtakContact[]>({
    queryKey: ['atakContacts', sourceId ?? ''],
    queryFn: () => fetchAtakContacts(sourceId as string),
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  return {
    contacts: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
