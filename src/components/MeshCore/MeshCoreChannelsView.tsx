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

const lastReadStorageKey = (sourceId: string) =>
  `meshmonitor-meshcore-channel-lastread-${sourceId}`;
const SORT_UNREAD_FIRST_KEY = 'meshmonitor-meshcore-channel-sort-unread-first';

/** Read the persisted per-channel last-read map for a source (idx → ms). */
function loadLastRead(sourceId: string): Record<number, number> {
  if (!sourceId) return {};
  try {
    const raw = localStorage.getItem(lastReadStorageKey(sourceId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<number, number>) : {};
  } catch {
    return {};
  }
}

export const MeshCoreChannelsView: React.FC<MeshCoreChannelsViewProps> = ({
  messages,
  contacts,
  status,
  actions,
  baseUrl,
  sourceId,
  onNodeNameClick,
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
  const [lastRead, setLastRead] = useState<Record<number, number>>(() => loadLastRead(sourceId));
  // Live mirror of `lastRead` so the channel-entry snapshot (#3810) can read the
  // pre-read marker without re-subscribing to every marker change.
  const lastReadRef = useRef(lastRead);
  lastReadRef.current = lastRead;
  // Pre-read marker snapshotted at channel entry, captured BEFORE the
  // mark-on-view effect advances it. Used to locate the first-unread message so
  // the stream can scroll there on entry (#3810).
  const [entryReadTs, setEntryReadTs] = useState<number>(0);
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
    setLastRead(loadLastRead(sourceId));
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
    setLastRead(prev => {
      if ((prev[idx] ?? 0) >= ts) return prev;
      const next = { ...prev, [idx]: ts };
      try {
        localStorage.setItem(lastReadStorageKey(sourceId), JSON.stringify(next));
      } catch {
        /* storage full / disabled — unread state is best-effort */
      }
      return next;
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
    (async () => {
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
    (async () => {
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
  useEffect(() => {
    if (!status?.connected) return;
    let cancelled = false;
    (async () => {
      try {
        const def = await actions.getDefaultScope();
        if (!cancelled) setDefaultScope(def ?? '');
      } catch {
        /* non-fatal — the override still works without a baseline */
      }
    })();
    return () => { cancelled = true; };
  }, [status?.connected, actions]);

  // Load the global saved-regions catalog (#3770) for the override suggestions.
  // This is a cheap local DB read (no radio traffic), so it's safe to run on
  // mount / source change regardless of connection state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await actions.fetchSavedRegions();
        if (!cancelled && rows) setSavedRegions(rows.map(r => r.name));
      } catch {
        /* non-fatal — suggestions are optional */
      }
    })();
    return () => { cancelled = true; };
  }, [actions, sourceId]);

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
    if (regionsDiscoveredRef.current) return;
    regionsDiscoveredRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await actions.discoverRegions();
        if (!cancelled && res?.regions) setDiscoveredRegions(res.regions);
      } catch {
        regionsDiscoveredRef.current = false; // allow a retry on next open
        /* non-fatal — suggestions are optional */
      }
    })();
    return () => { cancelled = true; };
  }, [showScopeOverride, status?.connected, actions]);

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
    (async () => {
      try {
        const url = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/messages/channel/${idx}?limit=200`;
        const response = await csrfFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) {
          setHistory(data?.success && Array.isArray(data.data) ? (data.data as MeshCoreMessage[]) : []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to fetch MeshCore channel messages:', err);
          setHistory([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, active.id, csrfFetch, status?.connected]);

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
    return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
  }, [history, messages, activeFilter]);

  // Snapshot the active channel's pre-read marker on channel entry, BEFORE the
  // mark-on-view effect below advances it (effects run in declaration order, so
  // this one wins). Depends only on `active.id` so a later backlog load / mark
  // doesn't clobber the snapshot. This is the boundary used to find the first
  // unread message for the entry scroll (#3810).
  useEffect(() => {
    setEntryReadTs(lastReadRef.current[active.id] ?? 0);
  }, [active.id]);

  // The oldest unread message for this channel (timestamp strictly newer than
  // the entry-read snapshot). Passed to the stream so it scrolls there on entry;
  // `undefined` (everything already read) ⇒ the stream falls back to bottom.
  const firstUnreadId = useMemo(() => {
    return filtered.find(m => m.timestamp > entryReadTs)?.id;
  }, [filtered, entryReadTs]);

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
              {sortUnreadFirst ? '★' : '☆'}
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
              ◀ {t('common.back', 'Back')}
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
                  className="mc-scope-override-clear"
                  onClick={() => { setOverrideScope(null); setShowScopeOverride(false); }}
                  title={t('meshcore.scope.override_clear', 'Use channel scope')}
                >
                  ✕
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
        <MeshCoreMessageStream
          messages={filtered}
          contacts={contacts}
          selfPublicKey={selfKey}
          disabled={!connected || !canSend}
          emptyText={t('meshcore.no_messages', 'No messages on this channel yet')}
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
          firstUnreadId={firstUnreadId}
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
