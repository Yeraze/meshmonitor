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
 */
import { useEffect, useMemo, useState } from 'react';
import { useCsrfFetch } from '../../../hooks/useCsrfFetch';
import type { MeshCoreMessage } from './useMeshCore';
import type { MeshCoreContact } from '../../../utils/meshcoreHelpers';
import {
  loadChannelLastRead,
  loadDmLastRead,
  subscribeUnreadChanged,
  computeUnreadDmPeers,
  isChannelPseudoKey,
} from '../meshcoreUnreadStore';

interface UseMeshCoreUnreadParams {
  baseUrl: string;
  sourceId: string;
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  selfKey: string | undefined;
  enabled: boolean;
}

export interface MeshCoreUnread {
  channels: boolean;
  dms: boolean;
}

const CHANNEL_POLL_MS = 15000;

export function useMeshCoreUnread({
  baseUrl,
  sourceId,
  messages,
  contacts,
  selfKey,
  enabled,
}: UseMeshCoreUnreadParams): MeshCoreUnread {
  const csrfFetch = useCsrfFetch();
  const [channelIndices, setChannelIndices] = useState<number[]>([]);
  const [channelLatest, setChannelLatest] = useState<Record<number, number>>({});
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

  // Merge live pool channel messages (explicit `channel-<idx>` keys) into the
  // polled timestamps so a just-arrived channel message flips the dot without
  // waiting for the next poll.
  const channelLatestEffective = useMemo(() => {
    const map: Record<number, number> = { ...channelLatest };
    for (const m of messages) {
      const key = isChannelPseudoKey(m.toPublicKey)
        ? m.toPublicKey
        : isChannelPseudoKey(m.fromPublicKey)
          ? m.fromPublicKey
          : null;
      if (!key) continue;
      const idx = parseInt(key.slice('channel-'.length), 10);
      if (Number.isInteger(idx)) map[idx] = Math.max(map[idx] ?? 0, m.timestamp);
    }
    return map;
  }, [channelLatest, messages]);

  const channels = useMemo(() => {
    void readTick; // cache-bust: re-read localStorage markers when a marker changes
    if (!sourceId) return false;
    const lastRead = loadChannelLastRead(sourceId);
    return Object.entries(channelLatestEffective).some(
      ([idx, ts]) => ts > (lastRead[Number(idx)] ?? 0),
    );
  }, [sourceId, channelLatestEffective, readTick]);

  const dms = useMemo(() => {
    void readTick; // cache-bust: re-read localStorage markers when a marker changes
    if (!sourceId) return false;
    const dmLastRead = loadDmLastRead(sourceId);
    return computeUnreadDmPeers({ messages, contacts, selfKey, dmLastRead }).size > 0;
  }, [sourceId, messages, contacts, selfKey, readTick]);

  return { channels, dms };
}
