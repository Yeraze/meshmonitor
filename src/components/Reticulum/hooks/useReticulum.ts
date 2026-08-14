/**
 * useReticulum — poll-based Reticulum state for a single source (#3960
 * Phase 1b WP1), extended in Phase 2 WP5 with LXMF conversations/messages
 * and their Socket.io live updates.
 *
 * Mirrors `useMeshCore`'s hook shape (see
 * `src/components/MeshCore/hooks/useMeshCore.ts`) for the status/
 * destinations/interfaces trio: Phase 1a wired no `reticulum:*` push events
 * (build spec §0 R4, "no realtime") — so unlike `useMeshCore`'s 30s
 * status-only *safety* poll that backs up live push events, this hook's
 * interval is the ONLY refresh mechanism for `status`/`destinations`/
 * `interfaces`/`conversations` alike, and all four refresh together on the
 * same cadence.
 *
 * LXMF messages (Phase 2 WP3/WP4) DO have live push events —
 * `reticulum:message` (an inbound row; server-side self-origin-guarded, so
 * this never fires for our own sends) and `reticulum:delivery-state:updated`
 * (a state transition for one of our own outbound sends) — forwarded over
 * the same Socket.io connection MeshCore uses (`useWebSocketContext`,
 * room-scoped per source via `join-source`, mirroring `useMeshCore`'s
 * push-event effect). Conversation summaries poll; the *active*
 * conversation's message list is fetched on demand (`loadConversation`) and
 * kept live by the two events above.
 *
 * Reads route through `/api/sources/:id/reticulum/*` via `api.get`
 * (`src/services/api.ts`). `ApiService.request()` returns the raw response
 * body and does NOT unwrap the `{success,data}` envelope (CLAUDE.md gotcha)
 * — every response here is unwrapped defensively (`res?.data ?? res`,
 * mirroring `meshcoreDashboardSource` in `dataSources.ts`) so a route that
 * ever changes envelope shape degrades gracefully instead of crashing.
 *
 * `enabled: false` short-circuits all fetches, matching `useMeshCore` — used
 * to honour permission gates that should suppress polling entirely.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../services/api';
import { useWebSocketContext } from '../../../contexts/WebSocketContext';
import { compareReticulumMessages } from '../messageOrder';
import type {
  ReticulumStatus,
  ReticulumDestinationRow,
  ReticulumInterfaceRow,
  ReticulumConversation,
  ReticulumMessageRow,
  ReticulumMessageState,
  ReticulumMessageMethod,
  ReticulumIdentity,
  ReticulumPathRow,
  ReticulumProbeResult,
  ReticulumRemoteStatus,
} from '../../../types/reticulum';

// No Socket.io events exist for status/destinations/interfaces/conversations
// (R4) — this interval is the hook's ONLY refresh mechanism for those, not a
// safety net for missed pushes. An individual conversation's messages DO
// have push events (see the module doc above) and are not part of this poll.
const POLL_INTERVAL_MS = 30000;

/** Default page size for a conversation's message list (mirrors the server's default in `reticulum.ts`'s `listMessages`). */
const DEFAULT_MESSAGE_PAGE_SIZE = 50;

export interface UseReticulumOptions {
  /** Source UUID — all reads/actions are scoped to this source. */
  sourceId: string;
  /** When false, the hook returns initial state and never polls. */
  enabled?: boolean;
}

/** Body for `sendMessage` — mirrors `POST /messages`'s request body (`reticulumRoutes.ts`). */
export interface SendReticulumMessageInput {
  to: string;
  content: string;
  title?: string;
  fields?: Record<string, unknown>;
  method?: 'opportunistic' | 'direct' | 'propagated' | 'paper';
  replyToHash?: string;
}

export interface UseReticulumState {
  status: ReticulumStatus | null;
  destinations: ReticulumDestinationRow[];
  interfaces: ReticulumInterfaceRow[];
  loading: boolean;
  error: string | null;
  /** Re-fetch status + destinations + interfaces + conversations immediately. */
  refresh: () => Promise<void>;
  /** POST /destinations/:hash/favorite. Resolves `true` on success and
   *  optimistically patches the local `destinations` list from the server's
   *  echoed `isFavorite`. */
  toggleFavorite: (destinationHash: string, favorite: boolean) => Promise<boolean>;

  // ---- LXMF messages (Phase 2 WP5) ----------------------------------

  /** Conversation summaries (one row per peer, newest-first). Polled on the
   *  same cadence as status/destinations/interfaces. */
  conversations: ReticulumConversation[];
  /** True only while the conversations list's own polled fetch is in flight. */
  conversationsLoading: boolean;
  /** The peer hash passed to the most recent {@link loadConversation} call. */
  activePeerHash: string | null;
  /** Oldest-first messages for `activePeerHash`, kept live by
   *  `reticulum:message` / `reticulum:delivery-state:updated`. */
  messages: ReticulumMessageRow[];
  /** True while the active conversation's message list is being (re)loaded. */
  messagesLoading: boolean;
  /** False once a `before`-cursor page came back shorter than the page size
   *  (no more history), or before {@link loadConversation} has been called. */
  hasMoreMessages: boolean;
  /** Fetch a conversation's most recent messages and make it "active" —
   *  subsequent `reticulum:message`/delivery-state events for this peer
   *  patch `messages` live. Replaces any previously loaded messages. */
  loadConversation: (peerHash: string) => Promise<void>;
  /** Fetch one more (older) page of the active conversation, using the
   *  oldest currently-loaded message's timestamp as the `before` cursor.
   *  No-op when there is no active conversation, a load is already in
   *  flight, or there is no more history. */
  loadMoreMessages: () => Promise<void>;
  /** POST /messages. Returns the persisted row on success (already appended
   *  to `messages`/`conversations` when it belongs to the active peer) or
   *  `null` on failure (`error` is set). */
  sendMessage: (input: SendReticulumMessageInput) => Promise<ReticulumMessageRow | null>;

  /** This source's own LXMF identity — `{destinationHash, displayName}`,
   *  both `null` until the first successful fetch or when disconnected. */
  identity: ReticulumIdentity | null;

  // ---- Path table + fleet monitoring (Phase 4 WP4) -------------------

  /** Path-table snapshot (ordered by hops then destinationHash), polled on
   *  the same cadence as status/destinations/interfaces. */
  paths: ReticulumPathRow[];
  /** Result of the most recent {@link probe} call, or `null` before the
   *  first call. Carries its own `destinationHash`, so a caller rendering
   *  multiple rows can match it back to the row that was probed. */
  probeResult: ReticulumProbeResult | null;
  /** The destination hash currently being probed, or `null` when no probe
   *  is in flight — lets a per-row UI show a loading state for just that row. */
  probingHash: string | null;
  /** POST /paths/probe (rnprobe-style on-demand reachability check). Returns
   *  the result on success (already stored on {@link probeResult}) or `null`
   *  on failure (`error` is set). */
  probe: (destinationHash: string, timeoutS?: number) => Promise<ReticulumProbeResult | null>;
  /** Result of the most recent {@link queryRemoteStatus} call, or `null`
   *  before the first call. Never persisted server-side (on-demand only). */
  remoteStatus: ReticulumRemoteStatus | null;
  /** True while a {@link queryRemoteStatus} call is in flight. */
  remoteStatusLoading: boolean;
  /** GET /remote-status/:hash (remote Transport Node /status + /path query
   *  — the fleet-monitoring surface). Returns the result on success (already
   *  stored on {@link remoteStatus}) or `null` on failure (`error` is set). */
  queryRemoteStatus: (destinationHash: string, timeoutS?: number) => Promise<ReticulumRemoteStatus | null>;
}

/** An endpoint's raw response, before unwrapping the `{success,data}` envelope. */
type Enveloped<T> = { data?: T } | T;

/**
 * Defensive unwrap for the `{success,data}` envelope. `api.get`/`api.post`
 * return the raw body and do not unwrap `data` themselves — see the module
 * doc comment above and CLAUDE.md's `ApiService.request()` gotcha.
 */
function unwrapData<T>(res: Enveloped<T>): T {
  if (res && typeof res === 'object' && 'data' in res && (res as { data?: T }).data !== undefined) {
    return (res as { data: T }).data;
  }
  return res as T;
}

/** `reticulum:message` push payload — an inbound `ReticulumMessageRow` (see `dataEventEmitter.emitReticulumMessage`). */
type ReticulumMessageEvent = ReticulumMessageRow;

/** `reticulum:delivery-state:updated` push payload (see `dataEventEmitter.emitReticulumDeliveryStateUpdated`). */
interface ReticulumDeliveryStateEvent {
  sourceId: string;
  id: string;
  hash: string;
  state: ReticulumMessageState;
  method?: ReticulumMessageMethod | null;
  attempts?: number | null;
}

/** Peer hash of an INBOUND row (`reticulum:message` only ever fires for messages we received — the sender is the peer). */
function inboundPeerHash(row: ReticulumMessageRow): string | null {
  return row.fromHash || null;
}

/** Peer hash of an OUTBOUND row (a message we sent — the recipient is the peer). */
function outboundPeerHash(row: ReticulumMessageRow): string | null {
  return row.toHash || null;
}

/**
 * Upsert `row` into a conversations list, keyed by `peerHash`, re-sorted
 * newest-first. A duplicate delivery of the SAME message id replaces the
 * summary in place (e.g. a delivery-state-driven state patch); a genuinely
 * older message for a peer that already has a newer summary only bumps the
 * count, so a late/out-of-order event can't regress the displayed preview.
 */
function upsertConversation(
  prev: ReticulumConversation[],
  row: ReticulumMessageRow,
  peerHash: string | null,
): ReticulumConversation[] {
  if (!peerHash) return prev;
  const idx = prev.findIndex(c => c.peerHash === peerHash);
  let next: ReticulumConversation[];
  if (idx === -1) {
    next = [...prev, { peerHash, lastMessage: row, messageCount: 1 }];
  } else {
    const existing = prev[idx];
    if (row.id === existing.lastMessage.id) {
      next = prev.map(c => (c.peerHash === peerHash ? { ...c, lastMessage: row } : c));
    } else if (row.timestamp >= existing.lastMessage.timestamp) {
      next = prev.map(c => (
        c.peerHash === peerHash ? { ...c, lastMessage: row, messageCount: c.messageCount + 1 } : c
      ));
    } else {
      next = prev.map(c => (
        c.peerHash === peerHash ? { ...c, messageCount: c.messageCount + 1 } : c
      ));
    }
  }
  return [...next].sort((a, b) => b.lastMessage.timestamp - a.lastMessage.timestamp);
}

export function useReticulum(options: UseReticulumOptions): UseReticulumState {
  const { sourceId, enabled = true } = options;
  const { state: wsState } = useWebSocketContext();
  const socket = wsState.socket;

  const prefix = `/api/sources/${encodeURIComponent(sourceId)}/reticulum`;

  const [status, setStatus] = useState<ReticulumStatus | null>(null);
  const [destinations, setDestinations] = useState<ReticulumDestinationRow[]>([]);
  const [interfaces, setInterfaces] = useState<ReticulumInterfaceRow[]>([]);
  const [conversations, setConversations] = useState<ReticulumConversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<ReticulumIdentity | null>(null);
  const [paths, setPaths] = useState<ReticulumPathRow[]>([]);
  const [probeResult, setProbeResult] = useState<ReticulumProbeResult | null>(null);
  const [probingHash, setProbingHash] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<ReticulumRemoteStatus | null>(null);
  const [remoteStatusLoading, setRemoteStatusLoading] = useState(false);

  const [activePeerHash, setActivePeerHash] = useState<string | null>(null);
  const [messages, setMessages] = useState<ReticulumMessageRow[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  // Mirrors activePeerHash for use inside socket callbacks without
  // re-subscribing the socket effect on every conversation switch.
  const activePeerHashRef = useRef<string | null>(null);
  useEffect(() => { activePeerHashRef.current = activePeerHash; }, [activePeerHash]);

  // Guards state updates from an in-flight poll racing a hook teardown
  // (rapid enable/disable toggling, or unmount mid-fetch).
  const cancelledRef = useRef(false);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (!enabled || !sourceId) return;
    setLoading(true);
    setConversationsLoading(true);
    try {
      const [statusRes, destinationsRes, interfacesRes, conversationsRes, pathsRes] = await Promise.all([
        api.get<Enveloped<ReticulumStatus>>(`${prefix}/status`),
        api.get<Enveloped<ReticulumDestinationRow[]>>(`${prefix}/destinations`),
        api.get<Enveloped<ReticulumInterfaceRow[]>>(`${prefix}/interfaces`),
        api.get<Enveloped<ReticulumConversation[]>>(`${prefix}/messages`),
        api.get<Enveloped<ReticulumPathRow[]>>(`${prefix}/paths`),
      ]);
      if (cancelledRef.current) return;
      setStatus(unwrapData(statusRes));
      setDestinations(unwrapData(destinationsRes) ?? []);
      setInterfaces(unwrapData(interfacesRes) ?? []);
      setConversations(unwrapData(conversationsRes) ?? []);
      setPaths(unwrapData(pathsRes) ?? []);
      setError(null);
    } catch (err) {
      if (cancelledRef.current) return;
      console.error('Failed to load Reticulum snapshot:', err);
      setError(err instanceof Error ? err.message : 'Failed to load Reticulum data');
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
        setConversationsLoading(false);
      }
    }
  }, [enabled, sourceId, prefix]);

  useEffect(() => {
    // The cleanup below runs on every deps change (e.g. an `enabled` flip),
    // not just unmount — reset the flag so a disable→enable cycle doesn't
    // leave state updates permanently suppressed.
    cancelledRef.current = false;
    if (!enabled) return;
    void fetchAll();
    const interval = setInterval(() => { void fetchAll(); }, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [enabled, fetchAll]);

  // Own LXMF identity — fetched once (not on the 30s poll; it never changes
  // while the source stays connected to the same bridge identity file, R5)
  // and re-fetched whenever `enabled`/`sourceId` change.
  useEffect(() => {
    if (!enabled || !sourceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<Enveloped<ReticulumIdentity>>(`${prefix}/identity`);
        if (!cancelled) setIdentity(unwrapData(res));
      } catch (err) {
        console.error('Failed to load Reticulum identity:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, sourceId, prefix]);

  const toggleFavorite = useCallback(async (destinationHash: string, favorite: boolean): Promise<boolean> => {
    try {
      const res = await api.post<Enveloped<{ destinationHash: string; isFavorite: boolean }>>(
        `${prefix}/destinations/${encodeURIComponent(destinationHash)}/favorite`,
        { favorite },
      );
      const data = unwrapData(res);
      setDestinations(prev => prev.map(d => (
        d.destinationHash === destinationHash
          ? { ...d, isFavorite: data?.isFavorite ?? favorite }
          : d
      )));
      return true;
    } catch (err) {
      console.error('Failed to toggle Reticulum destination favorite:', err);
      setError(err instanceof Error ? err.message : 'Failed to update favorite');
      return false;
    }
  }, [prefix]);

  const loadConversation = useCallback(async (peerHash: string): Promise<void> => {
    if (!sourceId) return;
    setActivePeerHash(peerHash);
    setMessagesLoading(true);
    try {
      const res = await api.get<Enveloped<ReticulumMessageRow[]>>(
        `${prefix}/messages/${encodeURIComponent(peerHash)}?limit=${DEFAULT_MESSAGE_PAGE_SIZE}`,
      );
      const rows = unwrapData(res) ?? [];
      setMessages(rows.slice().sort(compareReticulumMessages));
      setHasMoreMessages(rows.length >= DEFAULT_MESSAGE_PAGE_SIZE);
      setError(null);
    } catch (err) {
      console.error('Failed to load Reticulum conversation:', err);
      setError(err instanceof Error ? err.message : 'Failed to load conversation');
    } finally {
      setMessagesLoading(false);
    }
  }, [sourceId, prefix]);

  const loadMoreMessages = useCallback(async (): Promise<void> => {
    if (!activePeerHash || !hasMoreMessages || messagesLoading) return;
    const oldest = messages[0];
    if (!oldest) return;
    setMessagesLoading(true);
    try {
      const res = await api.get<Enveloped<ReticulumMessageRow[]>>(
        `${prefix}/messages/${encodeURIComponent(activePeerHash)}?before=${oldest.timestamp}&limit=${DEFAULT_MESSAGE_PAGE_SIZE}`,
      );
      const rows = unwrapData(res) ?? [];
      setMessages(prev => {
        const seen = new Set(prev.map(m => m.id));
        const merged = [...rows.filter(r => !seen.has(r.id)), ...prev];
        return merged.sort(compareReticulumMessages);
      });
      setHasMoreMessages(rows.length >= DEFAULT_MESSAGE_PAGE_SIZE);
    } catch (err) {
      console.error('Failed to load older Reticulum messages:', err);
      setError(err instanceof Error ? err.message : 'Failed to load older messages');
    } finally {
      setMessagesLoading(false);
    }
  }, [activePeerHash, hasMoreMessages, messagesLoading, messages, prefix]);

  const sendMessage = useCallback(async (input: SendReticulumMessageInput): Promise<ReticulumMessageRow | null> => {
    try {
      const res = await api.post<Enveloped<ReticulumMessageRow>>(`${prefix}/messages`, input);
      const row = unwrapData(res);
      if (row) {
        const peer = outboundPeerHash(row);
        if (peer && peer === activePeerHashRef.current) {
          setMessages(prev => (
            prev.some(m => m.id === row.id) ? prev : [...prev, row].sort(compareReticulumMessages)
          ));
        }
        setConversations(prev => upsertConversation(prev, row, peer));
      }
      setError(null);
      return row ?? null;
    } catch (err) {
      console.error('Failed to send Reticulum message:', err);
      setError(err instanceof Error ? err.message : 'Failed to send message');
      return null;
    }
  }, [prefix]);

  // ---- Path table + fleet monitoring (Phase 4 WP4) --------------------
  // On-demand, imperative helpers (mirroring loadConversation) — NOT part
  // of the 30s poll (build spec §3.6/§4.4: probe/remote-status are live
  // round-trips to the bridge, not DB reads).

  const probe = useCallback(async (destinationHash: string, timeoutS?: number): Promise<ReticulumProbeResult | null> => {
    if (!sourceId) return null;
    setProbingHash(destinationHash);
    try {
      const body: { destinationHash: string; timeoutS?: number } = { destinationHash };
      if (timeoutS !== undefined) body.timeoutS = timeoutS;
      const res = await api.post<Enveloped<ReticulumProbeResult>>(`${prefix}/paths/probe`, body);
      const result = unwrapData(res) ?? null;
      setProbeResult(result);
      setError(null);
      return result;
    } catch (err) {
      console.error('Failed to probe Reticulum destination:', err);
      setError(err instanceof Error ? err.message : 'Failed to probe destination');
      return null;
    } finally {
      setProbingHash(prev => (prev === destinationHash ? null : prev));
    }
  }, [sourceId, prefix]);

  const queryRemoteStatus = useCallback(async (destinationHash: string, timeoutS?: number): Promise<ReticulumRemoteStatus | null> => {
    if (!sourceId) return null;
    setRemoteStatusLoading(true);
    try {
      const qs = timeoutS !== undefined ? `?timeoutS=${encodeURIComponent(String(timeoutS))}` : '';
      const res = await api.get<Enveloped<ReticulumRemoteStatus>>(
        `${prefix}/remote-status/${encodeURIComponent(destinationHash)}${qs}`,
      );
      const result = unwrapData(res) ?? null;
      setRemoteStatus(result);
      setError(null);
      return result;
    } catch (err) {
      console.error('Failed to query Reticulum remote status:', err);
      setError(err instanceof Error ? err.message : 'Failed to query remote status');
      return null;
    } finally {
      setRemoteStatusLoading(false);
    }
  }, [sourceId, prefix]);

  // Push events — join the per-source room and subscribe to the two LXMF
  // events (mirrors useMeshCore's push-event effect). Guarding `!socket`
  // (rather than requiring one) means callers that render before the
  // WebSocketProvider has connected — or a test double with `socket: null`
  // — still get the polled data above; only the live-update layer is absent.
  useEffect(() => {
    if (!enabled || !sourceId || !socket) return;

    const joinRoom = () => { socket.emit('join-source', sourceId); };
    if (socket.connected) joinRoom();
    socket.on('connect', joinRoom);

    const onMessage = (row: ReticulumMessageEvent) => {
      if (row.sourceId !== sourceId) return;
      const peer = inboundPeerHash(row);
      setConversations(prev => upsertConversation(prev, row, peer));
      if (peer && peer === activePeerHashRef.current) {
        setMessages(prev => (
          prev.some(m => m.id === row.id) ? prev : [...prev, row].sort(compareReticulumMessages)
        ));
      }
    };

    const onDeliveryState = (evt: ReticulumDeliveryStateEvent) => {
      if (evt.sourceId !== sourceId) return;
      const patch = (row: ReticulumMessageRow): ReticulumMessageRow => (
        row.id === evt.id
          ? { ...row, state: evt.state, method: evt.method ?? row.method }
          : row
      );
      setMessages(prev => prev.map(patch));
      setConversations(prev => prev.map(c => (
        c.lastMessage.id === evt.id ? { ...c, lastMessage: patch(c.lastMessage) } : c
      )));
    };

    socket.on('reticulum:message', onMessage);
    socket.on('reticulum:delivery-state:updated', onDeliveryState);

    return () => {
      socket.off('connect', joinRoom);
      socket.off('reticulum:message', onMessage);
      socket.off('reticulum:delivery-state:updated', onDeliveryState);
    };
  }, [enabled, sourceId, socket]);

  return {
    status,
    destinations,
    interfaces,
    loading,
    error,
    refresh: fetchAll,
    toggleFavorite,
    conversations,
    conversationsLoading,
    activePeerHash,
    messages,
    messagesLoading,
    hasMoreMessages,
    loadConversation,
    loadMoreMessages,
    sendMessage,
    identity,
    paths,
    probeResult,
    probingHash,
    probe,
    remoteStatus,
    remoteStatusLoading,
    queryRemoteStatus,
  };
}
