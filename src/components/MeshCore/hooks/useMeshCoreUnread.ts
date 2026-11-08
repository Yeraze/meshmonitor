/**
 * useMeshCoreUnread (#3891)
 *
 * Page-level hook that computes whether the MeshCore Channels view and the
 * Node Details (DMs) view have unread messages, so MeshCorePage can render an
 * unread red-dot on the corresponding sidebar icons — even when neither view is
 * currently mounted.
 *
 * Channels: unread is authoritative from the server's per-channel latest
 * message timestamp (`/messages/channel-counts`, polled) compared against the
 * client-side last-read markers; live pool messages are merged in for
 * immediacy. DMs: computed entirely from the in-memory message pool (received
 * messages per peer) vs the DM last-read markers — the same pool the DM view
 * itself groups by peer, so the sidebar dot and the view stay consistent.
 * Rooms (#6261): server `latestReceivedAt` (`/messages/room-stats`, polled) merged
 * with live pool `room_post` receipt times vs the room last-read markers.
 * Muted DM peers and muted rooms light no dot.
 */
import { useEffect, useMemo, useState } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';
import type { MeshCoreMessage } from './useMeshCore';
import type { MeshCoreContact } from '../../../utils/meshcoreHelpers';
import {
  loadChannelLastRead,
  loadDmLastRead,
  loadRoomLastRead,
  subscribeUnreadChanged,
  computeUnreadDmPeers,
  computeUnreadRooms,
  latestRoomReceiptByRoom,
  isChannelPseudoKey,
} from '../meshcoreUnreadStore';
import { meshcoreReceiptTimeMs } from '../../../utils/meshcoreMessageTime';

interface UseMeshCoreUnreadParams {
  baseUrl: string;
  sourceId: string;
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  selfKey: string | undefined;
  enabled: boolean;
  /** Muted channel indices never light the Channels dot (#5487). */
  isChannelMuted?: (channelIdx: number) => boolean;
  /** Muted DM peers / rooms (canonical pubkey) never light a dot (#6261). */
  isDMMuted?: (key: string) => boolean;
}

export interface MeshCoreUnread {
  channels: boolean;
  dms: boolean;
  /** A room has unread posts (#6261). */
  rooms: boolean;
  /** Room public keys with unread posts. */
  unreadRooms: ReadonlySet<string>;
  /** Newest receipt time (ms) per room public key. */
  roomLatest: ReadonlyMap<string, number>;
}

interface RoomStat { roomPublicKey: string; count?: number; latest?: number; latestReceivedAt?: number }

const CHANNEL_POLL_MS = 15000;

export function useMeshCoreUnread({
  baseUrl,
  sourceId,
  messages,
  contacts,
  selfKey,
  enabled,
  isChannelMuted,
  isDMMuted,
}: UseMeshCoreUnreadParams): MeshCoreUnread {
  const csrfFetch = useCsrfFetch();
  const [channelIndices, setChannelIndices] = useState<number[]>([]);
  const [channelLatest, setChannelLatest] = useState<Record<number, number>>({});
  const [roomStats, setRoomStats] = useState<RoomStat[]>([]);
  // Bumped whenever a last-read marker changes so the memoized unread booleans
  // re-read localStorage (which isn't reactive on its own).
  const [readTick, setReadTick] = useState(0);

  useEffect(() => subscribeUnreadChanged(() => setReadTick((t) => t + 1)), []);

  // Fetch the channel index list once per source — needed to query channel-counts.
  useEffect(() => {
    if (!enabled || !sourceId) {
      setChannelIndices([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/channels/all?sourceId=${encodeURIComponent(sourceId)}`);
        if (!res.ok) return;
        const raw = await res.json();
        if (cancelled) return;
        const idxs = Array.isArray(raw)
          ? raw.filter((c: any) => typeof c?.id === 'number').map((c: any) => c.id as number)
          : [];
        setChannelIndices(idxs);
      } catch {
        /* ignore — no channel dot until reachable */
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, sourceId, baseUrl, csrfFetch]);

  // Poll per-channel latest timestamps.
  useEffect(() => {
    if (!enabled || !sourceId || channelIndices.length === 0) {
      setChannelLatest({});
      return;
    }
    let cancelled = false;
    const fetchLatest = async () => {
      try {
        const q = encodeURIComponent(channelIndices.join(','));
        const res = await csrfFetch(
          `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/messages/channel-counts?channels=${q}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.latestTimestamps) setChannelLatest(data.latestTimestamps as Record<number, number>);
      } catch {
        /* ignore */
      }
    };
    void fetchLatest();
    const id = setInterval(fetchLatest, CHANNEL_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, sourceId, baseUrl, csrfFetch, channelIndices]);

  // Poll per-room latest receipt times (#6261). Same cadence and gate as the
  // channel poll. Rooms are contacts with advType 3 (the Rooms view predicate).
  const roomServers = useMemo(() => contacts.filter((c) => c.advType === 3), [contacts]);
  const hasRooms = roomServers.length > 0;
  useEffect(() => {
    if (!enabled || !sourceId || !hasRooms) {
      setRoomStats([]);
      return;
    }
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const res = await csrfFetch(
          `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/messages/room-stats`,
        );
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        if (body?.success && Array.isArray(body.data)) setRoomStats(body.data as RoomStat[]);
      } catch {
        /* ignore */
      }
    };
    void fetchStats();
    const id = setInterval(fetchStats, CHANNEL_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, sourceId, baseUrl, csrfFetch, hasRooms]);

  // Merge live pool channel messages (explicit `channel-<idx>` keys) into the
  // polled timestamps so a just-arrived channel message flips the dot without
  // waiting for the next poll.
  const channelLatestEffective = useMemo(() => {
    const map: Record<number, number> = { ...channelLatest };
    for (const m of messages) {
      // Ignored messages never count as unread (#5408), nor do reactions (#5759).
      if (m.filtered || m.reactionEmoji) continue;
      const key = isChannelPseudoKey(m.toPublicKey)
        ? m.toPublicKey
        : isChannelPseudoKey(m.fromPublicKey)
          ? m.fromPublicKey
          : null;
      if (!key) continue;
      const idx = parseInt(key.slice('channel-'.length), 10);
      if (Number.isInteger(idx)) map[idx] = Math.max(map[idx] ?? 0, meshcoreReceiptTimeMs(m));
    }
    return map;
  }, [channelLatest, messages]);

  const channels = useMemo(() => {
    void readTick; // cache-bust: re-read localStorage markers when a marker changes
    if (!sourceId) return false;
    const lastRead = loadChannelLastRead(sourceId);
    return Object.entries(channelLatestEffective).some(
      ([idx, ts]) => !isChannelMuted?.(Number(idx)) && ts > (lastRead[Number(idx)] ?? 0),
    );
  }, [sourceId, channelLatestEffective, readTick, isChannelMuted]);

  const dms = useMemo(() => {
    void readTick; // cache-bust: re-read localStorage markers when a marker changes
    if (!sourceId) return false;
    const dmLastRead = loadDmLastRead(sourceId);
    const unread = computeUnreadDmPeers({ messages, contacts, selfKey, dmLastRead });
    for (const peer of unread) if (!isDMMuted?.(peer)) return true;
    return false;
  }, [sourceId, messages, contacts, selfKey, readTick, isDMMuted]);

  const unreadRooms = useMemo(() => {
    void readTick; // cache-bust: re-read localStorage markers when a marker changes
    if (!sourceId) return new Set<string>();
    return computeUnreadRooms({
      messages,
      roomStats,
      rooms: roomServers,
      selfKey,
      roomLastRead: loadRoomLastRead(sourceId),
      isMuted: isDMMuted,
    });
  }, [sourceId, messages, roomStats, roomServers, selfKey, readTick, isDMMuted]);

  const roomLatest = useMemo(
    () => latestRoomReceiptByRoom({ messages, roomStats, rooms: roomServers, selfKey }),
    [messages, roomStats, roomServers, selfKey],
  );

  return { channels, dms, rooms: unreadRooms.size > 0, unreadRooms, roomLatest };
}
