/**
 * MeshCore packet list (#6262): `usePagedPackets` over
 * `/api/sources/:id/meshcore/packets` (keyset cursor, flat) or
 * `/packets/grouped` (offset, collapsed), kept live by the
 * `meshcore:ota-packet` socket event.
 *
 * Live rows: in flat mode with only payload/route/srcHash/pathHash filters,
 * the row is matched client-side (via `deriveMeshCorePacketFields`) and
 * prepended. With a search/sender/time filter, or in grouped mode, a socket
 * event schedules one debounced refresh instead, because the server decides
 * those. With no socket (pop-out without a provider) the list polls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { useCsrfFetch } from './useCsrfFetch';
import { usePagedPackets, type PagedPage, type PagedPageParam } from './usePagedPackets';
import type { MeshCoreOtaPacketEvent } from './useWebSocket';
import { deriveMeshCorePacketFields } from '../utils/meshcorePacketDerived';

export type MeshCorePacketRow = MeshCoreOtaPacketEvent & {
  srcHash?: string | null;
  senderPubKey?: string | null;
  advertName?: string | null;
  /** Observer that heard this copy; null = this source's own radio (#6265). */
  observerId?: string | null;
};

export interface MeshCorePacketFilters {
  payloadType?: number;
  routeType?: number;
  /** Epoch ms lower bound. */
  since?: number;
  search?: string;
  srcHash?: string;
  /** Sender public key (hex prefix). */
  sender?: string;
  pathHash?: string;
}

export interface MeshCorePacketMeta {
  enabled: boolean;
  maxCount: number;
  maxAgeHours: number;
  isIngestSource: boolean;
}

const PAGE_SIZE = 100;
const POLL_MS = 5000;
const LIVE_REFRESH_DEBOUNCE_MS = 1000;

/** Query string shared by list, grouped, export and distribution calls. */
export function meshCoreFilterParams(filters: MeshCorePacketFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.payloadType !== undefined) p.set('payload_type', String(filters.payloadType));
  if (filters.routeType !== undefined) p.set('route_type', String(filters.routeType));
  if (filters.since !== undefined) p.set('since', String(filters.since));
  if (filters.search) p.set('search', filters.search);
  if (filters.srcHash) p.set('src_hash', filters.srcHash);
  if (filters.sender) p.set('sender', filters.sender);
  if (filters.pathHash) p.set('path_hash', filters.pathHash);
  return p;
}

/** True when a live row can be judged client-side (the server would agree). */
function canMatchLive(filters: MeshCorePacketFilters): boolean {
  return !filters.search && !filters.sender;
}

export function liveRowMatches(row: MeshCorePacketRow, filters: MeshCorePacketFilters): boolean {
  if (filters.payloadType !== undefined && row.payloadType !== filters.payloadType) return false;
  if (filters.routeType !== undefined && row.routeType !== filters.routeType) return false;
  if (filters.since !== undefined && row.timestamp < filters.since) return false;
  if (filters.srcHash) {
    const derived = row.srcHash !== undefined ? row.srcHash : deriveMeshCorePacketFields(row.rawHex).srcHash;
    if ((derived ?? '').toLowerCase() !== filters.srcHash.toLowerCase()) return false;
  }
  if (filters.pathHash) {
    const hops = (row.pathHops ?? '').toLowerCase().split(',').map(h => h.trim());
    if (!hops.includes(filters.pathHash.toLowerCase())) return false;
  }
  return true;
}

interface UseMeshCorePacketsOptions {
  baseUrl: string;
  sourceId: string;
  filters: MeshCorePacketFilters;
  grouped: boolean;
  canView?: boolean;
  /** When true, live socket rows are ignored. */
  paused?: boolean;
  socket: Socket | null;
}

export function useMeshCorePackets({
  baseUrl,
  sourceId,
  filters,
  grouped,
  canView = true,
  paused = false,
  socket,
}: UseMeshCorePacketsOptions) {
  const csrfFetch = useCsrfFetch();
  const [meta, setMeta] = useState<MeshCorePacketMeta>({
    enabled: false,
    maxCount: 1000,
    maxAgeHours: 24,
    isIngestSource: false,
  });

  const mcPrefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore`;
  const filtersKey = JSON.stringify(filters);
  const queryKey = useMemo(
    () => ['meshcore-packets', sourceId, grouped ? 'grouped' : 'flat', filtersKey] as const,
    [sourceId, grouped, filtersKey],
  );

  const fetchPage = useCallback(async (pageParam: PagedPageParam, pageSize: number): Promise<PagedPage<MeshCorePacketRow>> => {
    const params = meshCoreFilterParams(filters);
    params.set('limit', String(pageSize));
    if (grouped) {
      params.set('offset', String(Number(pageParam ?? 0)));
    } else if (typeof pageParam === 'string' && pageParam) {
      params.set('cursor', pageParam);
    }
    const res = await csrfFetch(`${mcPrefix}/${grouped ? 'packets/grouped' : 'packets'}?${params.toString()}`);
    if (!res.ok) {
      if (res.status === 429) throw new Error('Too many requests');
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    setMeta(prev => ({
      enabled: typeof data.enabled === 'boolean' ? data.enabled : prev.enabled,
      maxCount: typeof data.maxCount === 'number' ? data.maxCount : prev.maxCount,
      maxAgeHours: typeof data.maxAgeHours === 'number' ? data.maxAgeHours : prev.maxAgeHours,
      isIngestSource: typeof data.isIngestSource === 'boolean' ? data.isIngestSource : prev.isIngestSource,
    }));
    const packets: MeshCorePacketRow[] = Array.isArray(data.packets) ? data.packets : [];
    return {
      packets,
      total: typeof data.total === 'number' ? data.total : packets.length,
      nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
      hasMore: typeof data.hasMore === 'boolean' ? data.hasMore : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #6262 filters tracked by value via filtersKey
  }, [csrfFetch, mcPrefix, grouped, filtersKey]);

  const paged = usePagedPackets<MeshCorePacketRow>({
    queryKey,
    canView,
    pageSize: PAGE_SIZE,
    paging: grouped ? 'offset' : 'cursor',
    fetchPage,
    pollIntervalMs: socket ? false : POLL_MS,
  });

  // Socket handler reads current values through refs so it subscribes once per socket.
  const live = useRef({ filters, grouped, paused, prependLive: paged.prependLive, refresh: paged.refresh });
  live.current = { filters, grouped, paused, prependLive: paged.prependLive, refresh: paged.refresh };

  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onOtaPacket = (evt: MeshCoreOtaPacketEvent) => {
      if (evt.sourceId && evt.sourceId !== sourceId) return;
      const cur = live.current;
      if (cur.paused) return;
      if (!cur.grouped && canMatchLive(cur.filters)) {
        if (liveRowMatches(evt, cur.filters)) cur.prependLive(evt);
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void live.current.refresh();
      }, LIVE_REFRESH_DEBOUNCE_MS);
    };
    socket.on('meshcore:ota-packet', onOtaPacket);
    return () => {
      socket.off('meshcore:ota-packet', onOtaPacket);
      if (timer) clearTimeout(timer);
    };
  }, [socket, sourceId]);

  return { ...paged, meta, setMeta };
}
