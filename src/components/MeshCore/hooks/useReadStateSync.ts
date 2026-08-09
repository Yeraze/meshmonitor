/**
 * useReadStateSync (#4607)
 *
 * Bridges the fetch-free `meshcoreUnreadStore` module to the server-side
 * `conversation_read_state` table. Mounted once by `MeshCorePage`: it installs
 * a transport and pulls this user's watermarks for the active source into the
 * store's synchronous cache.
 *
 * Kept separate from the store so the store stays a plain module (no React, no
 * fetch) that every conversation view can read during render, and so tests can
 * exercise the marker logic without a network stub.
 *
 * Uses `apiService` rather than `useCsrfFetch` deliberately: ApiService reads
 * the CSRF token from sessionStorage itself, so this hook adds no context
 * requirement to `MeshCorePage` (which several tests render without a
 * CsrfProvider). Note that ApiService returns the raw body, so the `ok(res,
 * data)` envelope is unwrapped here.
 *
 * Everything is best-effort. A 403 (anonymous session, or no `messages:read`
 * on this source) or an unreachable server leaves the store on its
 * localStorage-only path rather than breaking the unread UI.
 */
import { useEffect } from 'react';
import apiService from '../../../services/api';
import {
  configureReadStateTransport,
  hydrateReadState,
  type MeshCoreReadKind,
} from '../meshcoreUnreadStore';

export function useReadStateSync({ sourceId }: { sourceId: string }): void {
  useEffect(() => {
    if (!sourceId) return;

    configureReadStateTransport({
      async load(id: string) {
        const body = await apiService.get<{
          data?: Record<MeshCoreReadKind, Record<string, number>>;
        }>(`/api/read-state?sourceId=${encodeURIComponent(id)}`);
        return body?.data ?? null;
      },
      async save(id: string, kind: MeshCoreReadKind, conversationKey: string, lastReadAt: number) {
        await apiService.post('/api/read-state', {
          sourceId: id,
          kind,
          conversationKey,
          lastReadAt,
        });
      },
    });

    void hydrateReadState(sourceId);

    return () => {
      // Leaving the MeshCore page must not leave a transport bound to a source
      // that is no longer mounted; the next mount installs a fresh one.
      configureReadStateTransport(null);
    };
  }, [sourceId]);
}
