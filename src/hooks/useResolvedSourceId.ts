/**
 * useResolvedSourceId — resolve a CONCRETE sourceId for API calls.
 *
 * Many source-scoped endpoints now REQUIRE a sourceId (they 400 with
 * MISSING_SOURCE_ID otherwise — see the source-id enforcement remediation).
 * In source-specific views `useSource()` already provides one, but in
 * legacy / single-source views it is `null`. This hook fills that gap by
 * falling back to the primary source — the first enabled `meshtastic_tcp`
 * source, else the first enabled source — mirroring the backend's
 * `resolveDefaultSourceForUser`.
 *
 * Returns `undefined` while the source list is still loading; callers should
 * treat that as "not ready yet" and defer the request (e.g. TanStack `enabled`,
 * or an early return) rather than firing without a sourceId.
 */
import { useQuery } from '@tanstack/react-query';
import { useSource } from '../contexts/SourceContext';
import { appBasename } from '../init';

export interface ResolvableSource {
  id: string;
  type: string;
  enabled: boolean;
  createdAt?: number;
}

/** Pure primary-source picker (exported for testing). */
export function pickPrimarySource<T extends ResolvableSource>(sources: T[]): T | undefined {
  const enabled = sources.filter((s) => s.enabled);
  const byCreated = [...enabled].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return byCreated.find((s) => s.type === 'meshtastic_tcp') ?? byCreated[0];
}

/**
 * @returns the active/context sourceId, or the resolved primary sourceId, or
 *          `undefined` while the fallback source list is still loading.
 */
export function useResolvedSourceId(): string | undefined {
  const { sourceId } = useSource();

  // Only fetch the source list when we actually need a fallback.
  const { data: sources } = useQuery<ResolvableSource[]>({
    queryKey: ['sources', 'resolve-primary'],
    queryFn: async () => {
      const res = await fetch(`${appBasename}/api/sources`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to fetch sources: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    enabled: sourceId == null,
  });

  if (sourceId) return sourceId;
  if (!sources) return undefined; // still loading the fallback list
  return pickPrimarySource(sources)?.id;
}
