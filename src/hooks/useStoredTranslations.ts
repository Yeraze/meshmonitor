/**
 * Stored (shared) message translations for the messages in view (#5520).
 *
 * One `GET /api/translate/stored` per view (at most MAX_IDS ids, the most
 * recent ones). The server never calls a provider for this and omits ids the
 * viewer cannot read, so this is safe for anonymous viewers too.
 */
import { useContext, useMemo } from 'react';
import { useQuery, QueryClient, QueryClientContext } from '@tanstack/react-query';
import apiService from '../services/api';
import type { StoredTranslation } from '../types/translation';

/** Server-side cap on ids per call (`MAX_STORED_TRANSLATION_IDS`). */
export const MAX_STORED_TRANSLATION_IDS = 200;

const EMPTY: Record<string, StoredTranslation> = {};

const fallbackClient = new QueryClient({
  defaultOptions: { queries: { enabled: false, retry: false } },
});

export interface UseStoredTranslationsArgs {
  sourceId: string | null | undefined;
  /** Message ids in display order (oldest first); the newest MAX_IDS are fetched. */
  messageIds: string[];
  lang: string | null | undefined;
  enabled: boolean;
}

export function useStoredTranslations({
  sourceId,
  messageIds,
  lang,
  enabled,
}: UseStoredTranslationsArgs): Record<string, StoredTranslation> {
  const client = useContext(QueryClientContext);

  const ids = useMemo(() => {
    const unique = [...new Set(messageIds.filter(Boolean))];
    return unique.slice(-MAX_STORED_TRANSLATION_IDS);
  }, [messageIds]);
  const idsKey = ids.join(',');

  const active = enabled && !!client && !!sourceId && !!lang && ids.length > 0;

  const { data } = useQuery(
    {
      queryKey: ['translations', 'stored', sourceId, lang, idsKey],
      queryFn: () => apiService.getStoredTranslations(sourceId as string, lang as string, ids),
      enabled: active,
      staleTime: 60_000,
      retry: false,
    },
    client || fallbackClient
  );

  return active && data ? data : EMPTY;
}
