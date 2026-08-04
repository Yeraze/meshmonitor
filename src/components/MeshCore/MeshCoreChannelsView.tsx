/**
 * MeshCoreChannelsView — per-channel message stream for a MeshCore source.
 *
 * Reads the channel list from `/api/channels?sourceId=<sourceId>` (mirrored
 * by `MeshCoreManager.syncChannelsFromDevice` on connect — phase 1 of the
 * MeshCore channels feature). Falls back to a synthetic "Channel 0" entry
 * when no rows are available so the panel doesn't look broken before the
 * first sync completes.
 *
 * Channel messaging on the wire is index-keyed (no per-sender pubkey for
 * channel traffic — the firmware embeds the sender's name in the text body).
 * MeshMonitor synthesises `fromPublicKey = 'channel-${idx}'` on receive
 * (meshcoreManager.ts:561) and `toPublicKey = 'channel-${idx}'` on local
 * send (meshcoreManager.ts:sendMessage, phase 2 addition). The per-channel
 * filter therefore matches either direction.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { MeshCoreMessage, MeshCoreActions, ConnectionStatus } from './hooks/useMeshCore';
import { MeshCoreContact, formatMeshCoreChannelName } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { useAuth } from '../../contexts/AuthContext';
import { loadChannelLastRead, markChannelRead as persistChannelRead } from './meshcoreUnreadStore';
import { compareMeshCoreMessages } from './messageOrder';
import { UiIcon } from '../icons';

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;

interface MeshCoreChannelsViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  baseUrl: string;
  sourceId: string;
  onNodeNameClick?: (publicKey: string) => void;
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2). Plumbed here in WP1; WP3 wires the actual gating (send box
   *  disabled + tooltip, and the region-discovery mount effect's silent
   *  skip). */
  receiveOnly?: boolean;
}

interface ChannelRow {
  id: number;
  name: string;
  /** Persisted per-channel region/scope (#3667). null/'' = no channel scope. */
  scope: string | null;
}

/** Synthesised pseudo-pubkey used to scope channel messages. Must match the
 *  format that meshcoreManager generates server-side (`channel-${idx}`). */
const channelKey = (idx: number) => `channel-${idx}`;

/**
 * Returns the messages that belong to the given channel index.
 *
 *  - Received: `fromPublicKey === channel-${idx}` (synthesised by the manager).
 *  - Locally-sent: `toPublicKey === channel-${idx}` (phase-2 tagging).
 *  - Legacy fallback for channel 0 only: pre-phase-2 outbound channel-0
 *    messages had `toPublicKey === undefined`; treat any message with no
 *    recipient AND no synthesised `channel-N` sender as channel 0 so old
 *    rows still appear in the right tab.
 */
function buildChannelFilter(channelIdx: number): (m: MeshCoreMessage) => boolean {
  const key = channelKey(channelIdx);
  return (m) => {
    if (m.fromPublicKey === key) return true;
    if (m.toPublicKey === key) return true;
    if (channelIdx === 0 && !m.toPublicKey && !m.fromPublicKey.startsWith('channel-')) {
      return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// Unread tracking (#3703)
//
// MeshCore messages are NOT covered by the Meshtastic server-side read-tracking
// system (`read_messages` table joins the Meshtastic `messages` table only), so
// we track the operator's per-channel last-read marker client-side in
// localStorage, scoped by sourceId. A channel is "unread" when its latest
// persisted message timestamp is newer than the stored last-read marker. This
// keeps the feature lightweight (no new per-user DB schema) while answering the
// request: surface channels with new messages without opening each one.
// ---------------------------------------------------------------------------

// Per-channel last-read markers live in the shared unread store
// (meshcoreUnreadStore) so the sidebar red-dot (#3891) and this view's list
// badges read/write the same source of truth and stay in sync.
const SORT_UNREAD_FIRST_KEY = 'meshmonitor-meshcore-channel-sort-unread-first';

export const MeshCoreChannelsView: React.FC<MeshCoreChannelsViewProps> = ({
  messages,
  contacts,
  status,
  actions,
  baseUrl,
  sourceId,
  onNodeNameClick,
  receiveOnly = false,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const canSend = hasPermission('messages', 'write');

  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [mobileShowContent, setMobileShowContent] = useState(false);
  // Per-channel backlog for the *active* channel, fetched independently of the
  // shared `messages` pool so each channel shows its own history (not a slice
  // of the global recent-tail). Live updates still arrive via `messages` and
  // are merged in below.
  const [history, setHistory] = useState<MeshCoreMessage[]>([]);
  // Infinite-scroll pagination for the active channel's history (#4460): does
  // an older page exist beyond `history`, and is one currently being fetched.
  // Reset alongside `history` on every channel switch/reconnect.
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  // Mirrors `history` so `loadOlderHistory` always reads the current backlog
  // length (as the fetch offset) without depending on `history` and thereby
  // getting a fresh callback identity on every page load.
  const historyRef = useRef<MeshCoreMessage[]>([]);
  historyRef.current = history;
  // Guards `loadOlderHistory` against a stale response landing after the
  // operator has already switched channels.
  const activeChannelIdxRef = useRef<number>(0);
  // Accurate persisted message count per channel index (for the list badges),
  // so a quiet channel doesn't read as empty next to a busy one just because
  // the shared pool's recent-tail happened to exclude it.
  const [counts, setCounts] = useState<Record<number, number>>({});
  // Latest persisted message timestamp per channel index (#3703), fetched
  // alongside `counts`. Compared against the per-channel last-read marker to
  // decide which channels show an unread indicator.
  const [latestTimestamps, setLatestTimestamps] = useState<Record<number, number>>({});
  // Per-channel last-read marker (idx → ms), persisted in localStorage scoped by
  // sourceId. Seeded from storage on mount/source change.
  const [lastRead, setLastRead] = useState<Record<number, number>>(() => loadChannelLastRead(sourceId));
  // Live mirror of `lastRead` so the channel-entry snapshot (#3810) can read the
  // pre-read marker without re-subscribing to every marker change.
  const lastReadRef = useRef(lastRead);
  lastReadRef.current = lastRead;
  // Optional "channels with unread first" ordering (#3703), persisted globally.
  const [sortUnreadFirst, setSortUnreadFirst] = useState<boolean>(
    () => localStorage.getItem(SORT_UNREAD_FIRST_KEY) === 'true',
  );
  // Per-message scope/region override (#3701). `null` means "no override —
  // use the channel's resolved scope". A string is a one-off override applied
  // to the NEXT send only; it is never persisted to the channel row. Reset on
  // channel switch so the override doesn't leak across channels.
  const [overrideScope, setOverrideScope] = useState<string | null>(null);
  const [showScopeOverride, setShowScopeOverride] = useState(false);
  // Source default scope (#3667) — used as the displayed default when a channel
  // has no scope of its own, so the operator can see what scope a normal send
  // would use before deciding to override it.
  const [defaultScope, setDefaultScope] = useState<string>('');
  // Region names served by nearby repeaters (#3667 phase 3) for the datalist
  // suggestions on the override input.
  const [discoveredRegions, setDiscoveredRegions] = useState<string[]>([]);
  // User-saved regions catalog (#3770) — also offered as scope-override
  // suggestions so the operator can pick a known region without typing it.
  const [savedRegions, setSavedRegions] = useState<string[]>([]);
  // Guard so region discovery — which emits active radio traffic — runs at most
  // once per mount, and only after the operator signals intent by opening the
  // scope-override control. We must NOT re-discover on every reconnect (#3704
  // review): status flapping would flood the mesh with discovery requests.
  const regionsDiscoveredRef = useRef(false);

  useEffect(() => {
    const onResize = () => {
      if (!isMobileViewport()) setMobileShowContent(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Re-seed the last-read map when the source changes (the map is per-source).
  useEffect(() => {
    setLastRead(loadChannelLastRead(sourceId));
  }, [sourceId]);

  // Persist the sort preference whenever it changes.
  useEffect(() => {
    localStorage.setItem(SORT_UNREAD_FIRST_KEY, String(sortUnreadFirst));
  }, [sortUnreadFirst]);

  // Mark a channel read up to `ts`, persisting to localStorage. Never moves the
  // marker backwards. `ts` defaults to now so opening an empty/quiet channel
  // still clears any stale unread state.
  const markChannelRead = useCallback((idx: number, ts: number = Date.now()) => {
    if (!sourceId) return;
    // Persist through the shared store (writes localStorage + notifies the
    // sidebar dot). Keep the local React state in sync for this view's badges.
    persistChannelRead(sourceId, idx, ts);
    setLastRead(prev => {
      if ((prev[idx] ?? 0) >= ts) return prev;
      return { ...prev, [idx]: ts };
    });
  }, [sourceId]);

  const handleSelectChannel = useCallback((idx: number) => {
    setSelectedIdx(idx);
    if (isMobileViewport()) setMobileShowContent(true);
  }, []);

  // Reply to a channel message (#3851): the stream prefills the `@[Sender]:`
  // mention; here we set the send scope to the originating message's scope so
  // the answer floods to the same region. The override widget is revealed so
  // the operator can see/edit the scope before sending.
  const handleReply = useCallback((m: MeshCoreMessage) => {
    if (m.scopeName?.trim()) {
      setOverrideScope(m.scopeName);
      setShowScopeOverride(true);
    } else if (m.scopeCode === 0) {
      setOverrideScope(''); // arrived explicitly unscoped → reply unscoped
      setShowScopeOverride(true);
    }
    // else: scoped-but-unknown (scopeCode > 0, no resolvable name) or no scope
    // info — the region name isn't recoverable from the HMAC transport code, so
    // we can't replicate it; leave the scope as-is (channel / source default).
  }, []);

  // Fetch the synced channel list for this source. We use /api/channels/all
  // (rather than /api/channels) so MeshCore rows with idx > 7 aren't dropped
  // by the legacy Meshtastic-shaped 0-7 filter on the basic endpoint. The
  // /all endpoint still goes through the per-row permission gate.
  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    setLoadingChannels(true);
    void (async () => {
      try {
        const url = `${baseUrl}/api/channels/all?sourceId=${encodeURIComponent(sourceId)}`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.json();
        const rows: ChannelRow[] = Array.isArray(raw)
          ? raw
              .filter((c: any) => typeof c?.id === 'number')
              .map((c: any) => ({
                id: c.id as number,
                name: String(c.name ?? ''),
                scope: typeof c?.scope === 'string' && c.scope ? c.scope : null,
              }))
              .sort((a, b) => a.id - b.id)
          : [];
        if (!cancelled) setChannels(rows);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to fetch MeshCore channels:', err);
          setChannels([]);
        }
      } finally {
        if (!cancelled) setLoadingChannels(false);
      }
    })();
    return () => { cancelled = true; };
  // Status connected→disconnected→connected transitions trigger a re-fetch so a
  // freshly-synced channel list shows up without a full page reload.
  }, [baseUrl, sourceId, csrfFetch, status?.connected]);

  // Always include a synthetic "Channel 0" placeholder when the device hasn't
  // reported any channels yet — keeps the view usable on first connect, and
  // gives the user something to chat in if the firmware ships with a default
  // primary channel that hasn't been read yet.
  const displayChannels: ChannelRow[] = useMemo(() => {
    if (channels.length > 0) return channels;
    return [{ id: 0, name: t('meshcore.channels.public_fallback', 'Public'), scope: null }];
  }, [channels, t]);

  // Keep `selectedIdx` valid if channels change underneath us.
  useEffect(() => {
    if (displayChannels.length === 0) return;
    if (!displayChannels.some(c => c.id === selectedIdx)) {
      setSelectedIdx(displayChannels[0].id);
    }
  }, [displayChannels, selectedIdx]);

  // Fetch accurate per-channel message counts for the list badges whenever the
  // channel set changes or the source (re)connects.
  const channelIdsKey = displayChannels.map(c => c.id).join(',');
  useEffect(() => {
    if (!sourceId || !channelIdsKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/messages/channel-counts?channels=${encodeURIComponent(channelIdsKey)}`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled && data?.success) {
          if (data.counts) setCounts(data.counts as Record<number, number>);
          if (data.latestTimestamps) {
            setLatestTimestamps(data.latestTimestamps as Record<number, number>);
          }
        }
      } catch (err) {
        if (!cancelled) console.error('Failed to fetch MeshCore channel counts:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, channelIdsKey, csrfFetch, status?.connected]);

  const active = displayChannels.find(c => c.id === selectedIdx) ?? displayChannels[0];
  const activeFilter = useMemo(() => buildChannelFilter(active.id), [active.id]);

  // The scope a *normal* send on the active channel would assert: the channel's
  // own scope, else the source default, else unscoped. Used as the override
  // field's default/placeholder so the operator overrides from a known baseline.
  const resolvedScope = (active.scope && active.scope.trim()) || defaultScope.trim() || '';

  // Load the source default scope when (re)connected so the override control can
  // show the baseline. This is a cheap local DB read (no radio traffic), so it's
  // safe to re-run on reconnect.
  //
  // Depend on the specific action function, not the whole `actions` object —
  // `useMeshCore` returns a fresh `actions` object literal on every render, so
  // depending on `actions` re-fires this effect (and re-hits the network) on
  // every status/message/node update from the mesh, even with zero user
  // interaction (#3880).
  const { getDefaultScope, fetchSavedRegions, discoverRegions } = actions;

  // Both lookups below exist only to populate the scope-override control, which
  // is a SEND-side affordance. Their routes are `requireAuth()` +
  // `configuration: read`, so firing them for a read-only (or anonymous) viewer
  // is guaranteed to 401 and buys nothing. Gate on `canSend` so the requests are
  // never made rather than made and ignored.
  useEffect(() => {
    if (!canSend || !status?.connected) return;
    let cancelled = false;
    void (async () => {
      try {
        const def = await getDefaultScope();
        if (!cancelled) setDefaultScope(def ?? '');
      } catch {
        /* non-fatal — the override still works without a baseline */
      }
    })();
    return () => { cancelled = true; };
  }, [canSend, status?.connected, getDefaultScope]);

  // Load the global saved-regions catalog (#3770) for the override suggestions.
  // This is a cheap local DB read (no radio traffic), so it's safe to run on
  // mount / source change regardless of connection state.
  useEffect(() => {
    if (!canSend) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchSavedRegions();
        if (!cancelled && rows) setSavedRegions(rows.map(r => r.name));
      } catch {
        /* non-fatal — suggestions are optional */
      }
    })();
    return () => { cancelled = true; };
  }, [canSend, fetchSavedRegions, sourceId]);

  // Union of saved + discovered regions, de-duplicated, for the override
  // datalist. Saved regions come first (operator-curated), then any extra
  // freshly-discovered ones.
  const scopeSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [...savedRegions, ...discoveredRegions]) {
      if (r && !seen.has(r)) { seen.add(r); out.push(r); }
    }
    return out;
  }, [savedRegions, discoveredRegions]);

  // Lazily discover regions for the suggestion datalist ONLY once the operator
  // opens the scope-override control (explicit intent), and at most once per
  // mount. discoverRegions() emits active radio traffic, so we must never tie it
  // to status?.connected — reconnect flapping would flood the mesh (#3704 review).
  useEffect(() => {
    if (!showScopeOverride || !status?.connected) return;
    // Receive-only mode: silently skip — no request, no toast, no error state.
    // Must sit BEFORE the do-not-repeat latch below so turning receive-only
    // back off re-enables discovery the next time the panel is opened (#4547
    // Phase 2 §3.4a).
    if (receiveOnly) return;
    if (regionsDiscoveredRef.current) return;
    regionsDiscoveredRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await discoverRegions();
        if (!cancelled && res?.regions) setDiscoveredRegions(res.regions);
      } catch {
        regionsDiscoveredRef.current = false; // allow a retry on next open
        /* non-fatal — suggestions are optional */
      }
    })();
    return () => { cancelled = true; };
  }, [showScopeOverride, status?.connected, discoverRegions, receiveOnly]);

  // Reset the one-off override when switching channels so it never leaks across
  // channels, and collapse the control back to its unobtrusive default.
  useEffect(() => {
    setOverrideScope(null);
    setShowScopeOverride(false);
  }, [active.id]);

  // Fetch the active channel's backlog from the per-channel endpoint. Re-runs on
  // channel switch and on (re)connect. The shared `messages` pool only carries a
  // global recent-tail, so this is what makes each channel's full history show.
  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    const idx = active.id;
    activeChannelIdxRef.current = idx;
    // A fresh channel/reconnect always starts pagination over from the newest
    // page — any in-flight load-older for the previous channel is now stale.
    setHasMoreHistory(false);
    setLoadingOlderHistory(false);
    void (async () => {
      try {
        // The initial page is intentionally larger than a load-older page
        // (200 vs. loadOlderHistory's 100 below) — worth front-loading more
        // on first open since it's the one fetch every channel visit pays
        // for, while later pages are opportunistic and don't need to match.
        const url = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/messages/channel/${idx}?limit=200`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) {
          setHistory(data?.success && Array.isArray(data.data) ? (data.data as MeshCoreMessage[]) : []);
          setHasMoreHistory(Boolean(data?.hasMore));
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to fetch MeshCore channel messages:', err);
          setHistory([]);
          setHasMoreHistory(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, active.id, csrfFetch, status?.connected]);

  // Load an older page of the active channel's history (#4460 infinite scroll).
  // Offset is the current backlog length (oldest-first fetch order means the
  // next page picks up right where `history`'s oldest entry leaves off).
  // Idempotent against overlapping calls: bails if a load is already in
  // flight or the channel has no older page.
  const loadOlderHistory = useCallback(() => {
    if (!sourceId || loadingOlderHistory || !hasMoreHistory) return;
    const idx = active.id;
    const offset = historyRef.current.length;
    setLoadingOlderHistory(true);
    void (async () => {
      try {
        const url = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/messages/channel/${idx}?limit=100&offset=${offset}`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        // The operator may have switched channels while this was in flight —
        // discard a response that no longer matches the active channel.
        if (activeChannelIdxRef.current !== idx) return;
        if (data?.success && Array.isArray(data.data)) {
          const older = data.data as MeshCoreMessage[];
          setHistory(prev => {
            const seen = new Set(prev.map(m => m.id));
            const fresh = older.filter(m => !seen.has(m.id));
            return [...fresh, ...prev];
          });
          setHasMoreHistory(Boolean(data.hasMore));
        } else {
          setHasMoreHistory(false);
        }
      } catch (err) {
        console.error('Failed to load older MeshCore channel messages:', err);
        if (activeChannelIdxRef.current === idx) setHasMoreHistory(false);
      } finally {
        if (activeChannelIdxRef.current === idx) setLoadingOlderHistory(false);
      }
    })();
  }, [sourceId, baseUrl, csrfFetch, active.id, hasMoreHistory, loadingOlderHistory]);

  // Merge the fetched backlog with any live messages for this channel (socket
  // pushes land in `messages`). Dedupe by id, letting the live copy win so
  // delivery-status updates (sent → delivered/failed) are reflected, then sort
  // oldest-first for the stream.
  const filtered = useMemo(() => {
    const byId = new Map<string, MeshCoreMessage>();
    for (const m of history) byId.set(m.id, m);
    for (const m of messages) {
      if (activeFilter(m)) byId.set(m.id, m);
    }
    // NOT a raw `timestamp` sort: received messages carry the remote's
    // whole-second `sender_timestamp` while our own sends are ms-precision
    // Date.now(), so a same-second auto-reply sorted BEFORE its own trigger.
    // See ./messageOrder.ts.
    return Array.from(byId.values()).sort(compareMeshCoreMessages);
  }, [history, messages, activeFilter]);

  // Mark the active channel read up to its newest visible message. Runs whenever
  // the active channel's content changes (channel switch, backlog load, or a
  // live message arriving while it's open), so an open channel never shows as
  // unread. Falls back to "now" for an empty channel so opening it still clears
  // any stale marker. On mobile the channel isn't actually being viewed until
  // the operator drills in, so defer marking until the content pane is shown.
  const newestVisibleTs = filtered.length > 0 ? filtered[filtered.length - 1].timestamp : 0;
  useEffect(() => {
    if (isMobileViewport() && !mobileShowContent) return;
    markChannelRead(active.id, newestVisibleTs || Date.now());
  }, [active.id, newestVisibleTs, mobileShowContent, markChannelRead]);

  // Effective latest timestamp per channel: the persisted max from the
  // counts/latest endpoint, bumped by any newer live message in the shared pool
  // so a just-arrived message flags the channel unread before the next refetch.
  const effectiveLatest = useMemo(() => {
    const map: Record<number, number> = { ...latestTimestamps };
    for (const c of displayChannels) {
      const liveMatch = messages.filter(buildChannelFilter(c.id));
      for (const m of liveMatch) {
        if (m.timestamp > (map[c.id] ?? 0)) map[c.id] = m.timestamp;
      }
    }
    return map;
  }, [latestTimestamps, messages, displayChannels]);

  /** A channel is unread when its latest message is newer than its last-read
   *  marker. The currently-active (and viewed) channel is never unread. */
  const isChannelUnread = useCallback((idx: number): boolean => {
    if (idx === active.id && (!isMobileViewport() || mobileShowContent)) return false;
    const latest = effectiveLatest[idx];
    if (!latest) return false;
    return latest > (lastRead[idx] ?? 0);
  }, [active.id, mobileShowContent, effectiveLatest, lastRead]);

  // Channel ordering for the list. Default: by index. "Unread first": unread
  // channels (most recent activity first) then the rest by index (#3703).
  const orderedChannels = useMemo(() => {
    if (!sortUnreadFirst) return displayChannels;
    return [...displayChannels].sort((a, b) => {
      const ua = isChannelUnread(a.id);
      const ub = isChannelUnread(b.id);
      if (ua !== ub) return ua ? -1 : 1;
      if (ua && ub) return (effectiveLatest[b.id] ?? 0) - (effectiveLatest[a.id] ?? 0);
      return a.id - b.id;
    });
  }, [displayChannels, sortUnreadFirst, isChannelUnread, effectiveLatest]);

  const unreadChannelCount = useMemo(
    () => displayChannels.filter(c => isChannelUnread(c.id)).length,
    [displayChannels, isChannelUnread],
  );

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;

  // Per-message delete + whole-channel clear (#3981). Both confirm first.
  //
  // Both MUST also prune `history`, not just await the action. The stream renders
  // `filtered` = merge(history, messages), and the hook's delete/clear only prune
  // the shared `messages` pool — so anything served from the per-channel backlog
  // (#4460), which is nearly everything on this view, was deleted server-side and
  // then immediately re-rendered from `history`. That read as "the delete button
  // does nothing"; verified against the API, the row was already gone from the
  // database while still on screen.
  const handleDeleteMessage = useCallback(async (m: MeshCoreMessage) => {
    if (!window.confirm(t('meshcore.confirm_delete_message', 'Delete this message?'))) return;
    const ok = await actions.deleteMessage(m.id);
    if (ok) {
      setHistory(prev => prev.filter(x => x.id !== m.id));
      setCounts(prev => {
        const current = prev[activeChannelIdxRef.current];
        if (typeof current !== 'number') return prev;
        return { ...prev, [activeChannelIdxRef.current]: Math.max(0, current - 1) };
      });
    }
  }, [actions, t]);
  const handleClearChannel = useCallback(async () => {
    if (!window.confirm(t(
      'meshcore.confirm_clear_channel',
      'Clear all messages on this channel? This cannot be undone.',
    ))) return;
    const ok = await actions.clearChannelMessages(active.id);
    if (ok) {
      setHistory([]);
      setHasMoreHistory(false);
      setCounts(prev => ({ ...prev, [active.id]: 0 }));
    }
  }, [actions, active, t]);

  const mobileClass = mobileShowContent ? 'mobile-show-content' : 'mobile-show-list';

  return (
    <div className={`meshcore-two-pane ${mobileClass}`}>
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.channels', 'Channels')}</span>
          <span className="meshcore-list-pane-header-actions">
            {unreadChannelCount > 0 && (
              <span
                className="mc-channel-unread-total"
                title={t('meshcore.channels.unread_total_title', '{{count}} channel(s) with unread messages', { count: unreadChannelCount })}
              >
                {unreadChannelCount}
              </span>
            )}
            <button
              type="button"
              className={`mc-channel-sort-toggle ${sortUnreadFirst ? 'active' : ''}`}
              onClick={() => setSortUnreadFirst(v => !v)}
              aria-pressed={sortUnreadFirst}
              title={t('meshcore.channels.sort_unread_first', 'Show channels with unread messages first')}
            >
              <UiIcon name={sortUnreadFirst ? 'favorite' : 'favoriteOff'} size={16} />
            </button>
            <span className="pane-count">{displayChannels.length}</span>
          </span>
        </div>
        <div className="meshcore-list-pane-body">
          {loadingChannels && channels.length === 0 && (
            <div className="mc-channel-row" aria-busy="true">
              <div className="mc-channel-row-name">
                {t('meshcore.channels.loading', 'Loading channels…')}
              </div>
            </div>
          )}
          {orderedChannels.map(c => {
            // Accurate persisted count from the counts endpoint. For the active
            // channel, prefer the merged stream length when it's larger so a
            // just-arrived live message bumps the badge before the next refetch.
            const persisted = counts[c.id] ?? messages.filter(buildChannelFilter(c.id)).length;
            const count = c.id === active.id ? Math.max(persisted, filtered.length) : persisted;
            const unread = isChannelUnread(c.id);
            return (
              <button
                key={c.id}
                className={`mc-channel-row ${active.id === c.id ? 'selected' : ''} ${unread ? 'unread' : ''}`}
                onClick={() => handleSelectChannel(c.id)}
              >
                {unread && (
                  <span
                    className="mc-channel-unread-dot"
                    aria-label={t('meshcore.channels.unread_badge', 'Unread messages')}
                    title={t('meshcore.channels.unread_badge', 'Unread messages')}
                  />
                )}
                <div className="mc-channel-row-name">
                  {formatMeshCoreChannelName(
                    c.name,
                    t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: c.id }),
                  )}
                </div>
                <div className="mc-channel-row-meta">
                  {count} {t('meshcore.messages', 'messages')}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="meshcore-main-pane">
        {mobileShowContent && (
          <div className="meshcore-mobile-back-header">
            <button
              type="button"
              className="meshcore-mobile-back-btn"
              onClick={() => setMobileShowContent(false)}
            >
              <UiIcon name="back" size={16} /> {t('common.back', 'Back')}
            </button>
            <span className="meshcore-mobile-back-title">
              {formatMeshCoreChannelName(
                active.name,
                t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: active.id }),
              )}
            </span>
          </div>
        )}
        {canSend && connected && (
          <div className="mc-scope-override">
            {showScopeOverride ? (
              <div className="mc-scope-override-row">
                <label className="mc-scope-override-label" htmlFor={`mc-scope-${active.id}`}>
                  {t('meshcore.scope.override_label', 'Send scope')}
                </label>
                <input
                  id={`mc-scope-${active.id}`}
                  className="mc-scope-override-input"
                  type="text"
                  list="mc-scope-region-suggestions"
                  value={overrideScope ?? ''}
                  placeholder={resolvedScope
                    ? t('meshcore.scope.override_placeholder', 'e.g. {{scope}}', { scope: resolvedScope })
                    : t('meshcore.scope.override_placeholder_unscoped', 'unscoped')}
                  onChange={e => setOverrideScope(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <datalist id="mc-scope-region-suggestions">
                  {scopeSuggestions.map(r => <option key={r} value={r} />)}
                </datalist>
                <button
                  type="button"
                  className={`mc-scope-override-unscoped${overrideScope === '' ? ' active' : ''}`}
                  onClick={() => setOverrideScope('')}
                  aria-pressed={overrideScope === ''}
                  title={t('meshcore.scope.override_unscoped_title', 'Send this message with no region scope (flood)')}
                >
                  {t('meshcore.scope.unscoped', 'Unscoped')}
                </button>
                <button
                  type="button"
                  className="mc-scope-override-clear"
                  onClick={() => { setOverrideScope(null); setShowScopeOverride(false); }}
                  title={t('meshcore.scope.override_clear', 'Use channel scope')}
                >
                  <UiIcon name="close" size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="mc-scope-override-toggle"
                onClick={() => setShowScopeOverride(true)}
                title={t(
                  'meshcore.scope.override_toggle_title',
                  'Send this message under a one-off region/scope override',
                )}
              >
                {t('meshcore.scope.override_toggle', 'Scope: {{scope}}', {
                  scope: resolvedScope || t('meshcore.scope.unscoped', 'unscoped'),
                })}
              </button>
            )}
          </div>
        )}
        {canSend && filtered.length > 0 && (
          <div className="meshcore-conversation-toolbar">
            <button
              type="button"
              className="meshcore-clear-conversation-btn"
              onClick={() => void handleClearChannel()}
              title={t('meshcore.clear_channel', 'Clear channel messages')}
            >
              <UiIcon name="delete" size={15} /> {t('meshcore.clear_channel', 'Clear channel messages')}
            </button>
          </div>
        )}
        <MeshCoreMessageStream
          messages={filtered}
          contacts={contacts}
          selfPublicKey={selfKey}
          disabled={!connected || !canSend || receiveOnly}
          disabledReason={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
          emptyText={t('meshcore.no_messages', 'No messages on this channel yet')}
          onDeleteMessage={canSend ? handleDeleteMessage : undefined}
          onSend={async text => {
            // Pass the one-off scope override only when the operator has opened
            // the control AND typed a value (incl. '' to mean unscoped). When
            // collapsed, omit the arg so the backend resolves the channel /
            // default scope as usual (#3701).
            const ok = showScopeOverride && overrideScope !== null
              ? await actions.sendMessage(text, undefined, active.id, overrideScope)
              : await actions.sendMessage(text, undefined, active.id);
            return ok;
          }}
          onNodeNameClick={onNodeNameClick}
          onReply={handleReply}
          conversationKey={`channel-${active.id}`}
          onLoadOlder={loadOlderHistory}
          hasMoreOlder={hasMoreHistory}
          loadingOlder={loadingOlderHistory}
          maxBytes={
            showScopeOverride && overrideScope !== null && overrideScope !== ''
              ? 120
              : resolvedScope
              ? 120
              : 130
          }
        />
      </div>
    </div>
  );
};
