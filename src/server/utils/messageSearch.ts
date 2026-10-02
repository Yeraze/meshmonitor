/**
 * Permission-scoped message search shared by the session route
 * (`GET /api/messages/search`) and the API-token route
 * (`GET /api/v1/sources/:sourceId/messages/search`).
 *
 * Every query is scoped in SQL to the sources and channels the caller may
 * read (#5517): Meshtastic-family sources search the `messages` table,
 * MeshCore sources search `meshcore_messages`, connected or not.
 *
 * Results are Meshtastic matches (newest first) followed by MeshCore matches;
 * `offset` pages through that concatenated list. Dates are epoch ms.
 */
import type { User } from '../../types/auth.js';
import type { MessageSourceScope, MeshCoreMessageScope, DbMeshCoreMessage } from '../../db/repositories/index.js';
import databaseService, { type DbMessage } from '../../services/database.js';
import { isAnyMeshCoreSourceType } from '../../utils/nodeTypeCategory.js';
import {
  resolveReadableMeshtasticChannels,
  resolveReadableMeshcoreScope,
  intersectChannels,
} from './messageSourceAccess.js';

export type MessageSearchScope = 'all' | 'channels' | 'dms' | 'meshcore';

export interface MessageSearchParams {
  query: string;
  caseSensitive: boolean;
  scope: MessageSearchScope;
  /** Requested channel numbers; `undefined` = no narrowing. */
  channels?: number[];
  fromNodeId?: string;
  startDate?: number;
  endDate?: number;
  limit: number;
  offset: number;
}

/** One hit: a stored row tagged with the table it came from. */
export type MessageSearchHit =
  | (DbMessage & { sourceId?: string; source: 'standard' })
  | (DbMeshCoreMessage & { source: 'meshcore' });

export type ParsedMessageSearch =
  | { ok: true; params: MessageSearchParams }
  | { ok: false; message: string };

/** Parse the shared search query string (`q`, `scope`, `limit`, ...). */
export function parseMessageSearchQuery(query: Record<string, unknown>): ParsedMessageSearch {
  const { q, caseSensitive, scope, channels, fromNodeId, startDate, endDate, limit, offset } = query;

  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return { ok: false, message: 'Search query parameter "q" is required' };
  }

  let channelFilter: number[] | undefined;
  if (channels && typeof channels === 'string') {
    channelFilter = channels.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    if (channelFilter.length === 0) channelFilter = undefined;
  }

  return {
    ok: true,
    params: {
      query: q.trim(),
      caseSensitive: caseSensitive === 'true',
      scope: ((scope as string) || 'all') as MessageSearchScope,
      channels: channelFilter,
      fromNodeId: typeof fromNodeId === 'string' && fromNodeId.length > 0 ? fromNodeId : undefined,
      startDate: startDate ? parseInt(startDate as string) : undefined,
      endDate: endDate ? parseInt(endDate as string) : undefined,
      limit: Math.min(parseInt(limit as string) || 50, 100),
      offset: Math.max(0, parseInt(offset as string) || 0),
    },
  };
}

/**
 * Run a search over `sourceId` (or every source when omitted), returning only
 * what `user` may read.
 */
export async function searchReadableMessages(
  user: User | null | undefined,
  sourceId: string | undefined,
  params: MessageSearchParams,
): Promise<{ results: MessageSearchHit[]; total: number }> {
  const allSources = await databaseService.sources.getAllSources();
  const targetSources = sourceId ? allSources.filter(s => s.id === sourceId) : allSources;

  const results: MessageSearchHit[] = [];
  let total = 0;
  let standardTotal = 0;

  // Meshtastic-family sources (the `messages` table).
  if (params.scope !== 'meshcore') {
    const scopes: MessageSourceScope[] = [];
    for (const source of targetSources) {
      if (isAnyMeshCoreSourceType(source.type)) continue;
      const readable = await resolveReadableMeshtasticChannels(user, source.id);
      scopes.push({ sourceId: source.id, channels: intersectChannels(readable, params.channels) });
    }

    // An empty scope list means zero rows; the repository never widens it.
    const searchResult = await databaseService.searchMessagesAsync({
      query: params.query,
      caseSensitive: params.caseSensitive,
      scope: params.scope,
      scopes,
      fromNodeId: params.fromNodeId,
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit,
      offset: params.offset,
    });

    results.push(...searchResult.messages.map(m => ({ ...m, source: 'standard' as const })));
    standardTotal = searchResult.total;
    total += searchResult.total;
  }

  // MeshCore sources (the `meshcore_messages` table), connected or not.
  if (params.scope === 'all' || params.scope === 'meshcore') {
    const meshcoreScopes: MeshCoreMessageScope[] = [];
    for (const source of targetSources) {
      if (!isAnyMeshCoreSourceType(source.type)) continue;
      const readable = await resolveReadableMeshcoreScope(user, source.id);
      meshcoreScopes.push({
        sourceId: source.id,
        channels: intersectChannels(readable.channels, params.channels),
        includeDms: readable.includeDms,
      });
    }
    const meshcoreResult = await databaseService.meshcore.searchMessages({
      query: params.query,
      caseSensitive: params.caseSensitive,
      scopes: meshcoreScopes,
      fromPublicKey: params.fromNodeId,
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit - results.length,
      offset: Math.max(0, params.offset - standardTotal),
    });
    total += meshcoreResult.total;
    results.push(...meshcoreResult.messages.map(m => ({ ...m, source: 'meshcore' as const })));
  }

  return { results, total };
}
