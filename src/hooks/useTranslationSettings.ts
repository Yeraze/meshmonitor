/**
 * Client query hook for message translation availability and default settings.
 * `GET /api/settings` returns the non-secret global settings map.
 */
import { useContext } from 'react';
import { useQuery, QueryClient, QueryClientContext } from '@tanstack/react-query';
import apiService from '../services/api';
import { AuthContext } from '../contexts/AuthContext';

export interface TranslationClientSettings {
  enabled: boolean;
  canTranslate: boolean;
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

/** Returns the client translation settings from the server along with permission validation. */
export function useTranslationSettings(sourceId?: string | null): TranslationClientSettings {
  const client = useContext(QueryClientContext);
  const auth = useContext(AuthContext);

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

  const enabled = data?.translationEnabled === 'true';
  const isAuthenticated = !!auth?.authStatus?.authenticated;
  const canReadMessages = auth?.hasPermission
    ? auth.hasPermission('messages', 'read', sourceId ? { sourceId } : { anySource: true })
    : false;

  const canTranslate = enabled && isAuthenticated && canReadMessages;

  return {
    enabled,
    canTranslate,
    defaultLanguage: data?.translationDefaultLanguage || 'en',
    defaultOutgoingLanguage: data?.translationDefaultOutgoingLanguage || 'ja',
  };
}

/** True when translation is enabled and the user is authenticated with messages:read permission. */
export function useCanTranslate(sourceId?: string | null): boolean {
  const { canTranslate } = useTranslationSettings(sourceId);
  return canTranslate;
}

/** True when the server explicitly set `translationEnabled` to `'true'`. Defaults to false. */
export function useTranslationEnabled(): boolean {
  const { enabled } = useTranslationSettings();
  return enabled;
}

