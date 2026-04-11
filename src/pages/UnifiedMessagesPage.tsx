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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { appBasename } from '../init';
import '../styles/unified.css';

// ── Types ────────────────────────────────────────────────────────────────

interface Reception {
  sourceId: string;
  sourceName: string;
  hopStart: number | null;
  hopLimit: number | null;
  rxSnr: number | null;
  rxRssi: number | null;
  rxTime: number | null;
  timestamp: number;
}

interface UnifiedMessage {
  dedupKey: string;
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
  timestamp: number; // canonical (earliest heard)
  receptions: Reception[];
}

interface UnifiedChannel {
  name: string;
  sources: Array<{ sourceId: string; sourceName: string; channelNumber: number }>;
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

function formatDateDivider(timestampMs: number): string {
  const d = new Date(timestampMs);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

function hopDisplay(start: number | null, limit: number | null): string {
  if (start != null && limit != null) {
    const hops = start - limit;
    if (hops <= 0) return 'direct';
    return `${hops} hop${hops > 1 ? 's' : ''}`;
  }
  if (start != null) return `start ${start}`;
  if (limit != null) return `limit ${limit}`;
  return '—';
}

function senderLabel(msg: UnifiedMessage): string {
  return msg.fromNodeLongName || msg.fromNodeShortName || msg.fromNodeId || `!${msg.fromNodeNum.toString(16)}`;
}

function shortSenderLabel(msg: UnifiedMessage): string {
  return msg.fromNodeShortName || msg.fromNodeLongName || msg.fromNodeId || `!${msg.fromNodeNum.toString(16)}`;
}

// ── Component ────────────────────────────────────────────────────────────

export default function UnifiedMessagesPage() {
  const navigate = useNavigate();
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;

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
      return lastPage[lastPage.length - 1].timestamp;
    },
    enabled: !!selectedChannel && isAuthenticated,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
    // Only poll the first page (newest messages). Don't re-fetch old pages
    // when polling; they're immutable once loaded.
    refetchOnMount: true,
  });

  // ── Flatten + dedup pages by dedupKey ─────────────────────────────────
  const allMessages = useMemo<UnifiedMessage[]>(() => {
    if (!data?.pages) return [];
    const seen = new Set<string>();
    const out: UnifiedMessage[] = [];
    for (const page of data.pages) {
      for (const m of page) {
        if (seen.has(m.dedupKey)) continue;
        seen.add(m.dedupKey);
        out.push(m);
      }
    }
    // Sort desc — polling can bring in new top-of-feed entries that merge with
    // older pages; re-sort defensively so the feed is always monotonic.
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  }, [data?.pages]);

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

  // Build a quick index by requestId for reply preview + reaction grouping.
  const byRequestId = useMemo(() => {
    const map = new Map<number, UnifiedMessage>();
    for (const m of allMessages) {
      if (m.requestId != null) map.set(m.requestId, m);
    }
    return map;
  }, [allMessages]);

  // Group reactions onto their parent: parentRequestId → reactions[]
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

  // ── Infinite scroll sentinel ──────────────────────────────────────────
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
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

  // Date-divider bookkeeping — walk the feed top-down (newest first).
  let lastDateLabel = '';

  return (
    <div className="unified-page">
      <div className="unified-header">
        <button className="unified-header__back" onClick={() => navigate('/')}>
          ← Sources
        </button>
        <div className="unified-header__title">
          <h1>Unified Messages</h1>
          <p>
            {selectedChannel ? `#${selectedChannel}` : 'Select a channel'} · across all accessible sources
          </p>
        </div>

        <div className="unified-controls">
          <select
            className="unified-select"
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
            disabled={loadingChannels || channels.length === 0}
            aria-label="Channel"
          >
            {channels.length === 0 && <option value="">No channels</option>}
            {channels.map((c) => (
              <option key={c.name} value={c.name}>
                #{c.name} ({c.sources.length})
              </option>
            ))}
          </select>

          <select
            className="unified-select"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label="Source filter"
          >
            <option value="">All sources</option>
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
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="unified-body">
        {!isAuthenticated && <div className="unified-empty">Sign in to view messages.</div>}
        {isAuthenticated && channelsError && <div className="unified-error">Failed to load channels.</div>}
        {isAuthenticated && messagesError && <div className="unified-error">Failed to load messages.</div>}
        {isAuthenticated && loadingMessages && feedMessages.length === 0 && (
          <div className="unified-empty">Loading messages…</div>
        )}
        {isAuthenticated && !loadingMessages && feedMessages.length === 0 && !messagesError && (
          <div className="unified-empty">
            {selectedChannel ? 'No messages on this channel yet.' : 'Choose a channel to begin.'}
          </div>
        )}

        {feedMessages.map((msg) => {
          const dateLabel = formatDateDivider(msg.timestamp);
          const showDivider = dateLabel !== lastDateLabel;
          if (showDivider) lastDateLabel = dateLabel;

          const primarySourceId = msg.receptions[0]?.sourceId ?? '';
          const color = sourceColor(primarySourceId);
          const receptionCount = msg.receptions.length;

          const reactions = msg.requestId != null ? reactionsByParent.get(msg.requestId) ?? [] : [];

          // Reply preview: look up parent by requestId.
          const parent = msg.replyId != null ? byRequestId.get(msg.replyId) : undefined;

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
                      title={`Heard by ${r.sourceName}`}
                    >
                      {r.sourceName}
                    </span>
                  ))}
                  {receptionCount > 1 && (
                    <span className="unified-msg-card__reception-count">
                      heard by {receptionCount}
                    </span>
                  )}
                  <span className="unified-msg-card__sender">{senderLabel(msg)}</span>
                  <span className="unified-msg-card__time">{formatTime(msg.timestamp)}</span>
                </div>

                {parent && (
                  <div className="unified-reply-preview">
                    <span className="unified-reply-preview__arrow">↳</span>
                    <span className="unified-reply-preview__from">{shortSenderLabel(parent)}</span>
                    <span className="unified-reply-preview__text">{parent.text || '(no text)'}</span>
                  </div>
                )}

                <div className="unified-msg-card__text">
                  {msg.text || <em style={{ opacity: 0.4 }}>(no text)</em>}
                </div>

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

        {/* Infinite scroll sentinel */}
        {feedMessages.length > 0 && (
          <div ref={sentinelRef} className="unified-scroll-sentinel">
            {isFetchingNextPage
              ? 'Loading older messages…'
              : hasNextPage
                ? ''
                : 'End of history.'}
          </div>
        )}
      </div>

      {/* ── Reception stats modal ───────────────────────────────────────── */}
      {statsFor && (
        <div className="unified-modal-overlay" onClick={closeStats}>
          <div className="unified-modal" onClick={(e) => e.stopPropagation()}>
            <div className="unified-modal__header">
              <h3>Reception details</h3>
              <button className="unified-modal__close" onClick={closeStats} aria-label="Close">
                ×
              </button>
            </div>
            <div className="unified-modal__body">
              <div className="unified-modal__summary">
                <div className="unified-modal__sender">{senderLabel(statsFor)}</div>
                <div className="unified-modal__text">{statsFor.text || '(no text)'}</div>
                <div className="unified-modal__meta">
                  Request ID: <code>{statsFor.requestId ?? '—'}</code> · Channel:{' '}
                  <code>#{statsFor.channelName || statsFor.channel}</code>
                </div>
              </div>

              <table className="unified-modal__table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Hops</th>
                    <th>SNR</th>
                    <th>RSSI</th>
                    <th>Heard</th>
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
                      <td>{hopDisplay(r.hopStart, r.hopLimit)}</td>
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
