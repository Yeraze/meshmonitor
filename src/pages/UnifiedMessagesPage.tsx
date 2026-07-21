/**
 * Unified Messages Page
 *
 * Cross-source message feed. Features:
 *  - Channel selector driven by /api/unified/channels (name-based so the same
 *    "Primary" channel collapses across sources even if they use different
 *    slot numbers for it).
 *  - Infinite scroll via TanStack `useInfiniteQuery` with a `before` timestamp
 *    cursor — correct under streaming inserts (offset pagination would skew).
 *  - Server-side dedup: the same mesh packet received by multiple sources
 *    returns as ONE entry with a `receptions[]` array. Clicking a message
 *    opens a modal that pivots that array into a per-source reception table
 *    (hops / SNR / RSSI / rxTime), which is the whole point of the unified
 *    view — you can see where the signal actually landed.
 *  - Reactions (emoji tapbacks) are hidden from the main feed and rendered as
 *    small bubbles on their parent message, matching MessagesTab behavior.
 *  - Reply threading shows a quoted preview of the parent when `replyId` is
 *    set, resolved from the already-loaded page cache.
 *  - Source filter: optional dropdown that narrows to messages heard by a
 *    specific source (client-side — the server-side dedup already bundled all
 *    receptions, so this is a pure view filter).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { appBasename } from '../init';
import { renderMessageWithLinks } from '../utils/linkRenderer';
import { formatSenderLabel } from '../utils/nodeHelpers';
import { foldUnifiedMessagePages } from '../utils/unifiedMessageAccumulator';
import LinkPreview from '../components/LinkPreview';
import '../styles/unified.css';
import { UiIcon } from '../components/icons';
import { resolveReplyPreview } from '../utils/replyPreview';

type TFn = (key: string, options?: Record<string, unknown>) => string;

// ── Types ────────────────────────────────────────────────────────────────

interface Reception {
  sourceId: string;
  sourceName: string;
  /** Source protocol/type, e.g. 'meshtastic_tcp' | 'mqtt_bridge' | 'meshcore'. */
  sourceType?: string;
  hopStart: number | null;
  hopLimit: number | null;
  rxSnr: number | null;
  rxRssi: number | null;
  rxTime: number | null;
  timestamp: number;
}

interface UnifiedMessage {
  dedupKey: string;
  packetId: number | null;
  requestId: number | null;
  fromNodeNum: number;
  fromNodeId: string;
  fromNodeLongName?: string;
  fromNodeShortName?: string;
  toNodeNum: number;
  toNodeId: string;
  channel: number;
  channelName: string;
  text: string;
  emoji: number | null;
  replyId: number | null;
  timestamp: number; // canonical device time (earliest heard) — for display
  createdAt: number; // earliest server DB arrival time — for ordering / pagination cursor (#3122)
  receptions: Reception[];
}

interface UnifiedChannel {
  name: string;
  sources: Array<{ sourceId: string; sourceName: string; channelNumber: number }>;
}

/** A device channel sharing its key with a differently-named Channel Database
 *  (server-decryption) entry (#3644). */
interface ChannelCollisionRow {
  channelId: number;
  channelName: string;
  dbId: number;
  dbName: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const POLL_INTERVAL_MS = 10_000;

const SOURCE_COLORS = [
  'var(--ctp-blue)',
  'var(--ctp-mauve)',
  'var(--ctp-green)',
  'var(--ctp-peach)',
  'var(--ctp-yellow)',
  'var(--ctp-teal)',
  'var(--ctp-pink)',
  'var(--ctp-sapphire)',
];

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * A message is a "reaction" (tapback) if the firmware marked it (emoji=1) OR
 * it replies to something with a body that's just a single emoji char. This
 * matches the detection used in MessagesTab so unified and per-source feeds
 * agree.
 */
const EMOJI_RE = /\p{Extended_Pictographic}/u;

function isReactionMessage(msg: UnifiedMessage): boolean {
  if (msg.emoji === 1) return true;
  if (msg.replyId != null && msg.text) {
    const t = msg.text.trim();
    // Short bodies that look emoji-ish count as reactions.
    if (t.length > 0 && t.length <= 8 && EMOJI_RE.test(t)) return true;
  }
  return false;
}

function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateDivider(timestampMs: number, t: TFn): string {
  const d = new Date(timestampMs);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t('unified.messages.date_today');
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return t('unified.messages.date_yesterday');
  return d.toLocaleDateString();
}

function hopDisplay(start: number | null, limit: number | null, t: TFn): string {
  if (start != null && limit != null) {
    const hops = start - limit;
    if (hops <= 0) return t('unified.messages.hop_direct');
    return t(hops === 1 ? 'unified.messages.hop_count_one' : 'unified.messages.hop_count_other', { count: hops });
  }
  if (start != null) return t('unified.messages.hop_start_only', { value: start });
  if (limit != null) return t('unified.messages.hop_limit_only', { value: limit });
  return '—';
}

// Per-message sender label: "Long Name (SHRT)" (issue #4193) — same
// formatSenderLabel rules as the per-source Messages tab (#4196): no
// duplicate or empty parenthetical. Compact contexts (reply previews,
// reaction chips) keep shortSenderLabel below.
export function senderLabel(msg: Pick<UnifiedMessage, 'fromNodeLongName' | 'fromNodeShortName' | 'fromNodeId' | 'fromNodeNum'>): string {
  return formatSenderLabel(
    msg.fromNodeLongName,
    msg.fromNodeShortName,
    msg.fromNodeId || `!${msg.fromNodeNum.toString(16)}`,
  );
}

export function shortSenderLabel(msg: Pick<UnifiedMessage, 'fromNodeLongName' | 'fromNodeShortName' | 'fromNodeId' | 'fromNodeNum'>): string {
  return msg.fromNodeShortName || msg.fromNodeLongName || msg.fromNodeId || `!${msg.fromNodeNum.toString(16)}`;
}

// ── Component ────────────────────────────────────────────────────────────

export default function UnifiedMessagesPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { authStatus, hasPermission } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;
  // Unified Messages is cross-source: allow whenever the user (including
  // anonymous) has read on messages or any channel on ANY source.
  const canReadAnyMessages =
    isAuthenticated && authStatus?.user?.isAdmin
      ? true
      : hasPermission('messages', 'read', { anySource: true }) ||
        [0, 1, 2, 3, 4, 5, 6, 7].some((n) =>
          hasPermission(`channel_${n}` as keyof import('../types/permission').PermissionSet, 'read', { anySource: true })
        );

  const [selectedChannel, setSelectedChannel] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [statsFor, setStatsFor] = useState<UnifiedMessage | null>(null);

  // ── Channels query ────────────────────────────────────────────────────
  const {
    data: channels = [],
    isLoading: loadingChannels,
    isError: channelsError,
  } = useQuery<UnifiedChannel[]>({
    queryKey: ['unified', 'channels'],
    queryFn: async () => {
      const res = await fetch(`${appBasename}/api/unified/channels`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load channels');
      return res.json();
    },
    staleTime: 60_000,
  });

  // Auto-select the first channel when the list loads if nothing is picked yet.
  useEffect(() => {
    if (!selectedChannel && channels.length > 0) {
      // Prefer a channel literally named "Primary" or "LongFast" if present.
      const preferred = channels.find((c) => /^(primary|longfast)$/i.test(c.name));
      setSelectedChannel(preferred?.name ?? channels[0].name);
    }
  }, [channels, selectedChannel]);

  // ── Channel collisions (#3644) ────────────────────────────────────────
  // A device channel can share its key with a differently-named server-side
  // decryption (Channel Database) entry; matching messages then appear under
  // that entry's tab rather than the device channel. Detect it per source
  // (channel_database is global) so we can warn when the viewed channel may be
  // overshadowed.
  const collisionSourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of channels) for (const src of c.sources) ids.add(src.sourceId);
    return Array.from(ids).sort();
  }, [channels]);

  const { data: channelCollisions = [] } = useQuery<ChannelCollisionRow[]>({
    queryKey: ['unified', 'channel-collisions', collisionSourceIds],
    enabled: canReadAnyMessages && collisionSourceIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const perSource = await Promise.all(
        collisionSourceIds.map(async (sid) => {
          const res = await fetch(
            `${appBasename}/api/channels/collisions?sourceId=${encodeURIComponent(sid)}`,
            { credentials: 'include' },
          );
          if (!res.ok) return [] as ChannelCollisionRow[];
          const json = await res.json();
          return (json.collisions ?? []) as ChannelCollisionRow[];
        }),
      );
      return perSource.flat();
    },
  });

  // Names of channels colliding with the viewed channel — the "other side" of
  // each collision (the entry messages may be landing under, or vice versa).
  const overshadowNames = useMemo(() => {
    if (!selectedChannel) return [] as string[];
    const sel = selectedChannel.trim().toLowerCase();
    const names = new Set<string>();
    for (const c of channelCollisions) {
      const ch = c.channelName.trim().toLowerCase();
      const db = c.dbName.trim().toLowerCase();
      if (ch === sel && c.dbName.trim()) names.add(c.dbName);
      else if (db === sel && c.channelName.trim()) names.add(c.channelName);
    }
    return Array.from(names);
  }, [channelCollisions, selectedChannel]);

  // ── Messages infinite query ───────────────────────────────────────────
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: loadingMessages,
    isError: messagesError,
    refetch,
  } = useInfiniteQuery<UnifiedMessage[], Error>({
    queryKey: ['unified', 'messages', selectedChannel],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (selectedChannel) params.set('channel', selectedChannel);
      params.set('limit', String(PAGE_SIZE));
      if (pageParam !== undefined && pageParam !== null) {
        params.set('before', String(pageParam));
      }
      const res = await fetch(`${appBasename}/api/unified/messages?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load messages');
      return res.json();
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => {
      if (!lastPage || lastPage.length < PAGE_SIZE) return undefined;
      // Cursor uses createdAt (server DB arrival time) so pagination matches
      // the server's createdAt ordering and stays stable under device-clock
      // skew (#3122).
      return lastPage[lastPage.length - 1].createdAt;
    },
    enabled: !!selectedChannel && canReadAnyMessages,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
    // Only poll the first page (newest messages). Don't re-fetch old pages
    // when polling; they're immutable once loaded.
    refetchOnMount: true,
  });

  // ── Accumulate pages into an append-only feed ─────────────────────────
  // The server feed is a capped newest-N window; rendering straight off the
  // latest poll evicts a message once newer traffic pushes it past the window
  // (#3719/#3720). Fold every poll's pages into a persistent map keyed by
  // dedupKey so a message that has been shown stays shown regardless of how the
  // window shifts. Upserts prefer the newest (most-complete) copy; sort is by
  // createdAt (server DB arrival) so device-clock skew can't reorder (#3122).
  const accumulatorRef = useRef<Map<string, UnifiedMessage>>(new Map());
  const accChannelRef = useRef<string>(selectedChannel);
  const allMessages = useMemo<UnifiedMessage[]>(() => {
    // Reset synchronously when the channel changes so feeds never blend.
    if (accChannelRef.current !== selectedChannel) {
      accChannelRef.current = selectedChannel;
      accumulatorRef.current = new Map();
    }
    return foldUnifiedMessagePages(accumulatorRef.current, data?.pages);
  }, [data?.pages, selectedChannel]);

  // ── All distinct sources heard across the loaded set ──────────────────
  const sourcesInView = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of allMessages) {
      for (const r of m.receptions) {
        if (!map.has(r.sourceId)) map.set(r.sourceId, r.sourceName);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [allMessages]);

  const sourceColor = useCallback(
    (sourceId: string) => {
      const idx = sourcesInView.findIndex((s) => s.id === sourceId);
      return SOURCE_COLORS[(idx < 0 ? 0 : idx) % SOURCE_COLORS.length];
    },
    [sourcesInView]
  );

  // ── Apply source filter ───────────────────────────────────────────────
  const filteredMessages = useMemo(() => {
    if (!sourceFilter) return allMessages;
    return allMessages.filter((m) => m.receptions.some((r) => r.sourceId === sourceFilter));
  }, [allMessages, sourceFilter]);

  // Build a quick index by packet id for reply preview + reaction grouping.
  // Meshtastic firmware sets `reply_id` to the parent's meshpacket id, not its
  // requestId — so reactions (tapbacks) and reply previews must look up parents
  // by packet id to match.
  const byPacketId = useMemo(() => {
    const map = new Map<number, UnifiedMessage>();
    for (const m of allMessages) {
      if (m.packetId != null) map.set(m.packetId, m);
    }
    return map;
  }, [allMessages]);

  // Group reactions onto their parent: parent packetId → reactions[]
  const reactionsByParent = useMemo(() => {
    const map = new Map<number, UnifiedMessage[]>();
    for (const m of allMessages) {
      if (!isReactionMessage(m) || m.replyId == null) continue;
      const list = map.get(m.replyId) ?? [];
      list.push(m);
      map.set(m.replyId, list);
    }
    return map;
  }, [allMessages]);

  // Non-reactions only — these drive the main feed.
  const feedMessages = useMemo(
    () => filteredMessages.filter((m) => !isReactionMessage(m)),
    [filteredMessages]
  );

  // ── Scroll container management (chat-style: newest at bottom) ────────
  // The scroll wrapper is the only scroll surface on this page. We manage
  // scrollTop imperatively so that:
  //   • on first load for a channel the user lands at the bottom,
  //   • polling that appends a new tail keeps the user pinned at the bottom
  //     IFF they were already there (otherwise we don't yank them away from
  //     whatever they were reading),
  //   • fetching an older page (prepend) preserves the user's visible spot
  //     by shifting scrollTop by the exact growth in content height.
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef<boolean>(true);
  const prevStateRef = useRef<{ len: number; firstKey: string; scrollHeight: number }>({
    len: 0,
    firstKey: '',
    scrollHeight: 0,
  });

  // Reset bookkeeping when the channel changes so the next render pins
  // to bottom.
  useEffect(() => {
    prevStateRef.current = { len: 0, firstKey: '', scrollHeight: 0 };
    wasAtBottomRef.current = true;
  }, [selectedChannel]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = prevStateRef.current;
    const curLen = feedMessages.length;
    const curFirstKey = feedMessages[0]?.dedupKey ?? '';

    if (curLen === 0) {
      prevStateRef.current = { len: 0, firstKey: '', scrollHeight: 0 };
      return;
    }

    if (prev.len === 0) {
      // Initial load for this channel: pin to the bottom.
      el.scrollTop = el.scrollHeight;
    } else if (curFirstKey !== prev.firstKey) {
      // Prepended older messages from fetchNextPage. Keep the user's current
      // viewpoint stable by shifting scrollTop by the delta in content height.
      el.scrollTop = el.scrollTop + (el.scrollHeight - prev.scrollHeight);
    } else if (wasAtBottomRef.current) {
      // Appended new tail messages from polling. Stick to bottom iff the user
      // was already pinned there.
      el.scrollTop = el.scrollHeight;
    }

    prevStateRef.current = {
      len: curLen,
      firstKey: curFirstKey,
      scrollHeight: el.scrollHeight,
    };
  }, [feedMessages]);

  // ── Infinite scroll sentinel (at the TOP — scrolls up loads older) ────
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // ── Render ────────────────────────────────────────────────────────────

  const openStats = useCallback((msg: UnifiedMessage) => setStatsFor(msg), []);
  const closeStats = useCallback(() => setStatsFor(null), []);

  // Date-divider bookkeeping — walk the feed top-down chronologically
  // (oldest first) so each divider appears on the first message of its day.
  let lastDateLabel = '';

  return (
    <div className="unified-page unified-page--chat">
      <div className="unified-header">
        <button className="unified-header__back" onClick={() => navigate('/', { state: { showList: true } })}>
          {t('unified.back_to_sources')}
        </button>
        <div className="unified-header__title">
          <h1>{t('unified.messages.title')}</h1>
          <p>
            {selectedChannel
              ? t('unified.messages.subtitle_channel', { channel: selectedChannel })
              : t('unified.messages.subtitle_none')}
          </p>
        </div>

        <div className="unified-controls">
          <select
            className="unified-select"
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
            disabled={loadingChannels || channels.length === 0}
            aria-label={t('unified.messages.channel_aria')}
          >
            {channels.length === 0 && <option value="">{t('unified.messages.no_channels')}</option>}
            {channels.map((c) => (
              <option key={c.name} value={c.name}>
                {t('unified.messages.channel_option', { name: c.name, count: c.sources.length })}
              </option>
            ))}
          </select>

          <select
            className="unified-select"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label={t('unified.messages.source_filter_aria')}
          >
            <option value="">{t('unified.messages.all_sources')}</option>
            {sourcesInView.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <button
            className="unified-header__back"
            onClick={() => refetch()}
            disabled={loadingMessages}
            title={t('unified.messages.refresh')}
          >
            ↻
          </button>
        </div>
      </div>

      <div className="unified-scroll" ref={scrollRef} onScroll={handleScroll}>
      <div className="unified-body">
        {!canReadAnyMessages && <div className="unified-empty">{t('unified.messages.sign_in_required')}</div>}
        {canReadAnyMessages && overshadowNames.length > 0 && (
          <div className="unified-warning" role="status">
            <UiIcon name="alert" size={16} /> {t('unified.messages.channel_collision_warning', {
              defaultValue: 'This channel shares its key with "{{names}}" (a Channel Database / device channel under a different name). Messages may be split between those tabs — reconcile the names on the Channels page.',
              names: overshadowNames.join('", "'),
            })}
          </div>
        )}
        {canReadAnyMessages && channelsError && <div className="unified-error">{t('unified.messages.failed_channels')}</div>}
        {canReadAnyMessages && messagesError && <div className="unified-error">{t('unified.messages.failed_messages')}</div>}
        {canReadAnyMessages && loadingMessages && feedMessages.length === 0 && (
          <div className="unified-empty">{t('unified.messages.loading')}</div>
        )}
        {canReadAnyMessages && !loadingMessages && feedMessages.length === 0 && !messagesError && (
          <div className="unified-empty">
            {selectedChannel ? t('unified.messages.empty_channel') : t('unified.messages.choose_channel')}
          </div>
        )}

        {/* Infinite scroll sentinel — at the TOP of the feed. Scroll up to
            here and the intersection observer fires fetchNextPage, which
            prepends older messages while the scroll-position preserving
            useLayoutEffect keeps the user's viewpoint stable. */}
        {feedMessages.length > 0 && (
          <div ref={sentinelRef} className="unified-scroll-sentinel">
            {isFetchingNextPage
              ? t('unified.messages.loading_older')
              : hasNextPage
                ? ''
                : t('unified.messages.history_start')}
          </div>
        )}

        {feedMessages.map((msg) => {
          const dateLabel = formatDateDivider(msg.timestamp, t);
          const showDivider = dateLabel !== lastDateLabel;
          if (showDivider) lastDateLabel = dateLabel;

          const primarySourceId = msg.receptions[0]?.sourceId ?? '';
          const color = sourceColor(primarySourceId);
          const receptionCount = msg.receptions.length;

          const reactions = msg.packetId != null ? reactionsByParent.get(msg.packetId) ?? [] : [];

          // Reply preview: look up parent by packet id (firmware's reply_id
          // points at the parent's meshpacket id, not its requestId).
          const replyPreview = resolveReplyPreview(msg.replyId, byPacketId);

          return (
            <div key={msg.dedupKey}>
              {showDivider && (
                <div className="unified-date-divider">
                  <span>{dateLabel}</span>
                </div>
              )}
              <div
                className="unified-msg-card unified-msg-card--clickable"
                style={{ borderLeftColor: color }}
                onClick={() => openStats(msg)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openStats(msg);
                  }
                }}
              >
                <div className="unified-msg-card__meta">
                  {msg.receptions.map((r) => (
                    <span
                      key={r.sourceId}
                      className="unified-msg-card__source-tag"
                      style={{
                        background: `color-mix(in srgb, ${sourceColor(r.sourceId)} 15%, transparent)`,
                        color: sourceColor(r.sourceId),
                        border: `1px solid color-mix(in srgb, ${sourceColor(r.sourceId)} 35%, transparent)`,
                      }}
                      title={t('unified.messages.heard_by_source', { name: r.sourceName })}
                    >
                      {r.sourceName}
                      {r.sourceType === 'meshcore' && (
                        <span className="unified-msg-card__proto-badge">
                          {t('unified.messages.meshcore_badge', 'MeshCore')}
                        </span>
                      )}
                    </span>
                  ))}
                  {receptionCount > 1 && (
                    <span className="unified-msg-card__reception-count">
                      {t('unified.messages.heard_by_count', { count: receptionCount })}
                    </span>
                  )}
                  <span className="unified-msg-card__sender">{senderLabel(msg)}</span>
                  <span className="unified-msg-card__time">{formatTime(msg.timestamp)}</span>
                </div>

                {replyPreview.kind !== 'none' && (
                  <div className="unified-reply-preview">
                    <span className="unified-reply-preview__arrow">↳</span>
                    {replyPreview.kind === 'resolved' ? (
                      <>
                        <span className="unified-reply-preview__from">
                          {shortSenderLabel(replyPreview.parent)}
                        </span>
                        <span className="unified-reply-preview__text">
                          {replyPreview.parent.text || t('unified.no_text')}
                        </span>
                      </>
                    ) : (
                      // #4245: the parent packet was never received or has since
                      // been purged. Still show the reply box so the message is
                      // recognizable as a reply, rather than silently dropping
                      // replyId and rendering it as an ordinary message.
                      <span className="unified-reply-preview__text unified-reply-preview__text--unknown">
                        {t('unified.messages.unknown_parent', 'Unknown message')}
                      </span>
                    )}
                  </div>
                )}

                <div className="unified-msg-card__text">
                  {msg.text ? renderMessageWithLinks(msg.text) : <em style={{ opacity: 0.4 }}>{t('unified.no_text')}</em>}
                </div>
                {msg.text && <LinkPreview text={msg.text} />}

                {reactions.length > 0 && (
                  <div className="unified-reactions">
                    {reactions.map((r) => (
                      <span key={r.dedupKey} className="unified-reaction" title={senderLabel(r)}>
                        {r.text}
                        <span className="unified-reaction__from">{shortSenderLabel(r)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </div>

      {/* ── Reception stats modal ───────────────────────────────────────── */}
      {statsFor && (
        <div className="unified-modal-overlay" onClick={closeStats}>
          <div className="unified-modal" onClick={(e) => e.stopPropagation()}>
            <div className="unified-modal__header">
              <h3>{t('unified.messages.modal.title')}</h3>
              <button className="unified-modal__close" onClick={closeStats} aria-label={t('unified.close')}>
                ×
              </button>
            </div>
            <div className="unified-modal__body">
              <div className="unified-modal__summary">
                <div className="unified-modal__sender">{senderLabel(statsFor)}</div>
                <div className="unified-modal__text">{statsFor.text || t('unified.no_text')}</div>
                <div className="unified-modal__meta">
                  {t('unified.messages.modal.request_id')}: <code>{statsFor.requestId ?? '—'}</code> · {t('unified.messages.modal.channel')}:{' '}
                  <code>#{statsFor.channelName || statsFor.channel}</code>
                </div>
              </div>

              <table className="unified-modal__table">
                <thead>
                  <tr>
                    <th>{t('unified.messages.modal.col_source')}</th>
                    <th>{t('unified.messages.modal.col_hops')}</th>
                    <th>{t('unified.messages.modal.col_snr')}</th>
                    <th>{t('unified.messages.modal.col_rssi')}</th>
                    <th>{t('unified.messages.modal.col_heard')}</th>
                  </tr>
                </thead>
                <tbody>
                  {statsFor.receptions.map((r) => (
                    <tr key={r.sourceId}>
                      <td>
                        <span
                          className="unified-modal__source-dot"
                          style={{ background: sourceColor(r.sourceId) }}
                        />
                        {r.sourceName}
                      </td>
                      <td>{hopDisplay(r.hopStart, r.hopLimit, t)}</td>
                      <td>{r.rxSnr != null ? `${r.rxSnr.toFixed(1)} dB` : '—'}</td>
                      <td>{r.rxRssi != null ? `${r.rxRssi} dBm` : '—'}</td>
                      <td>{formatTime(r.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
