/**
 * Client query hook for message translation availability and default settings.
 * `GET /api/settings` returns the non-secret global settings map.
 */
import { useContext } from 'react';
import { useQuery, QueryClient, QueryClientContext } from '@tanstack/react-query';
import apiService from '../services/api';

export interface TranslationClientSettings {
  enabled: boolean;
  defaultLanguage: string;
  defaultOutgoingLanguage: string;
}

const fallbackClient = new QueryClient({
  defaultOptions: {
    queries: {
      enabled: false,
      retry: false,
    },
  },
});

/** Returns the client translation settings from the server. */
export function useTranslationSettings(): TranslationClientSettings {
  const client = useContext(QueryClientContext);

  const { data } = useQuery(
    {
      queryKey: ['settings', 'translation'],
      queryFn: () =>
        apiService.get<{
          translationEnabled?: string;
          translationDefaultLanguage?: string;
          translationDefaultOutgoingLanguage?: string;
        }>('/api/settings'),
      staleTime: 60_000,
      enabled: !!client,
    },
    client || fallbackClient
  );

  return {
    enabled: data?.translationEnabled === 'true',
    defaultLanguage: data?.translationDefaultLanguage || 'en',
    defaultOutgoingLanguage: data?.translationDefaultOutgoingLanguage || 'ja',
  };
}

/** True when the server explicitly set `translationEnabled` to `'true'`. Defaults to false. */
export function useTranslationEnabled(): boolean {
  const { enabled } = useTranslationSettings();
  return enabled;
}
