import React, { useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreMessage } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { getMessageDateSeparator, shouldShowDateSeparator } from '../../utils/datetime';
import { getUtf8ByteLength, formatByteCount } from '../../utils/text';
import LinkPreview from '../LinkPreview';
import MeshCoreMessageRouteModal from './MeshCoreMessageRouteModal';
import { UiIcon } from '../icons';

interface MeshCoreMessageStreamProps {
  messages: MeshCoreMessage[];
  contacts?: MeshCoreContact[];
  selfPublicKey?: string;
  emptyText?: string;
  disabled?: boolean;
  onSend: (text: string) => Promise<boolean>;
  onNodeNameClick?: (publicKey: string) => void;
  /** When provided, received channel messages show a Reply button (#3851). The
   *  stream prefills the composer with the `@[Sender]:` mention + focuses it;
   *  the parent uses this callback to send the reply on the message's scope. */
  onReply?: (message: MeshCoreMessage) => void;
  /** When provided, each message row shows a delete action (#3981). The
   *  parent is responsible for confirmation and the actual delete call. */
  onDeleteMessage?: (message: MeshCoreMessage) => void | Promise<void>;
  /** Stable key identifying the current conversation. When it changes, the
   *  stream re-runs its entry scroll (to the first-unread row, or the bottom). */
  conversationKey?: string;
  /** Maximum UTF-8 byte length for a message. Send is blocked when exceeded. */
  maxBytes?: number;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

const MENTION_RE = /@\[([^\]]+)\]/g;

function renderMessageText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    const name = match[1];
    parts.push(
      <span
        key={match.index}
        className="mc-mention"
        title={name}
      >
        @{name}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}

export const MeshCoreMessageStream: React.FC<MeshCoreMessageStreamProps> = ({
  messages,
  contacts,
  selfPublicKey,
  emptyText,
  disabled,
  onSend,
  onNodeNameClick,
  onReply,
  onDeleteMessage,
  conversationKey,
  maxBytes = 130,
}) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // Message ids whose "heard repeaters" list (#3700) is expanded.
  const [expandedHeardBy, setExpandedHeardBy] = useState<Set<string>>(new Set());
  // Message whose relay-hash chain was clicked — opens the route-detail modal
  // that expands each hash to the matching repeater name.
  const [routeDetail, setRouteDetail] = useState<MeshCoreMessage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const toggleHeardBy = useCallback((id: string) => {
    setExpandedHeardBy(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // MeshCore inbound messages carry `pubkey_prefix` (typically 6-byte / 12-char
  // hex) in `fromPublicKey`, while contacts are keyed by full pubkey. Match by
  // prefix so the friendly name resolves regardless of length.
  const nameForKey = useMemo(() => {
    const exact = new Map<string, MeshCoreContact>();
    const list = contacts ?? [];
    for (const c of list) {
      if (c.publicKey) exact.set(c.publicKey, c);
    }
    return (key: string): string | null => {
      if (!key) return null;
      const hit = exact.get(key) ?? list.find(c => c.publicKey && c.publicKey.startsWith(key));
      if (!hit) return null;
      return hit.advName || hit.name || null;
    };
  }, [contacts]);

  const fullKeyFor = useMemo(() => {
    const list = contacts ?? [];
    const exact = new Set(list.map(c => c.publicKey).filter(Boolean));
    return (key: string): string => {
      if (!key) return key;
      if (exact.has(key)) return key;
      const hit = list.find(c => c.publicKey && c.publicKey.startsWith(key));
      return hit?.publicKey ?? key;
    };
  }, [contacts]);

  const contactKeyForName = useMemo(() => {
    const list = contacts ?? [];
    return (name: string): string | null => {
      if (!name) return null;
      const lower = name.toLowerCase();
      const hit = list.find(c =>
        (c.advName && c.advName.toLowerCase() === lower) ||
        (c.name && c.name.toLowerCase() === lower));
      return hit?.publicKey ?? null;
    };
  }, [contacts]);

  // Entry scroll: on conversation entry, land at the BOTTOM (newest messages).
  // A channel's backlog is fetched ASYNCHRONOUSLY, so `messages` is often empty
  // when `conversationKey` first flips — scrolling then would fire against empty
  // content and leave the viewport stranded. So we defer until messages are
  // present, and only run it once per conversationKey (re-arming when the key
  // changes). `entryScrollRef` tracks which key we've handled.
  const entryScrollRef = useRef<{ key: string | undefined; done: boolean }>({
    key: conversationKey,
    done: false,
  });
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const state = entryScrollRef.current;
    if (state.key !== conversationKey) {
      // New conversation — re-arm the entry scroll.
      state.key = conversationKey;
      state.done = false;
    }
    if (state.done) return;
    // Wait for the (possibly async) backlog before committing the entry scroll.
    if (messages.length === 0) return;
    state.done = true;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }, [conversationKey, messages.length]);

  // Auto-scroll on new messages only when the user is already near the bottom.
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (isNearBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages.length]);

  const handleScroll = useCallback(() => {
    const container = listRef.current;
    if (!container) return;
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    setShowJumpToBottom(!isNearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = listRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, []);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Reuse the shared composer byte-count helpers (same as the Meshtastic
  // channel/DM composers) so counting + warning thresholds + display stay in
  // one place. Only the per-context limit differs (channel 130 / scoped 120 /
  // DM 150), passed in via maxBytes.
  const byteLen = useMemo(() => getUtf8ByteLength(draft), [draft]);
  const byteCounter = useMemo(() => formatByteCount(byteLen, maxBytes), [byteLen, maxBytes]);
  const overLimit = byteLen > maxBytes;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const refocusRef = useRef(false);

  useEffect(() => {
    if (!sending && refocusRef.current) {
      refocusRef.current = false;
      if (!disabled) inputRef.current?.focus();
    }
  }, [sending, disabled]);

  const handleSend = async () => {
    if (!draft.trim() || sending || overLimit) return;
    setSending(true);
    refocusRef.current = true;
    const ok = await onSend(draft);
    setSending(false);
    if (ok) setDraft('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // Reply to a channel message (#3851): prefill the composer with the MeshCore
  // `@[Sender]:` mention, focus it (caret at end), and let the parent send on
  // the originating message's scope via onReply.
  const handleReply = useCallback((m: MeshCoreMessage) => {
    const name = (m.fromName ?? nameForKey(m.fromPublicKey) ?? '').trim();
    setDraft(name ? `@[${name}]: ` : '');
    onReply?.(m);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }
    });
  }, [nameForKey, onReply]);

  return (
    <div className="meshcore-message-stream">
      <div className="meshcore-message-list" ref={listRef} style={{ position: 'relative' }}>
        {showJumpToBottom && (
          <div
            style={{
              position: 'sticky',
              top: '0.5rem',
              zIndex: 10,
              display: 'flex',
              justifyContent: 'center',
              marginBottom: '0.5rem',
            }}
          >
            <button
              className="jump-to-bottom-btn"
              onClick={scrollToBottom}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: 'var(--ctp-blue)',
                border: 'none',
                borderRadius: '20px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                color: 'var(--ctp-base)',
                fontWeight: 'bold',
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <UiIcon name="sortDescending" size={16} /> {t('channels.jump_to_bottom', 'Jump to Bottom')}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="meshcore-empty-state">
            {emptyText ?? t('meshcore.no_messages', 'No messages')}
          </div>
        ) : messages.map((m, idx) => {
          const currentDate = new Date(m.timestamp);
          const prevDate = idx > 0 ? new Date(messages[idx - 1].timestamp) : null;
          const showSeparator = shouldShowDateSeparator(prevDate, currentDate);
          const outgoing = !!selfPublicKey && m.fromPublicKey === selfPublicKey;
          const friendlyName = outgoing ? null : nameForKey(m.fromPublicKey);
          const fromLabel = outgoing
            ? t('meshcore.you', 'You')
            : m.fromName ?? friendlyName ?? `${m.fromPublicKey.substring(0, 8)}…`;
          const isChannel = m.fromPublicKey.startsWith('channel-');
          const clickTarget = isChannel
            ? (m.fromName ? contactKeyForName(m.fromName) : null)
            : fullKeyFor(m.fromPublicKey);
          const canClick = !outgoing && onNodeNameClick && clickTarget;
          return (
            <React.Fragment key={m.id}>
              {showSeparator && (
                <div className="mc-date-separator">
                  <span className="mc-date-separator-text">
                    {getMessageDateSeparator(currentDate)}
                  </span>
                </div>
              )}
              <div className={`mc-message-row ${outgoing ? 'outgoing' : ''}`} data-message-id={m.id}>
              <div className="mc-message-header">
                {canClick ? (
                  <button
                    className="mc-message-from mc-message-from-link"
                    title={isChannel ? m.fromName : m.fromPublicKey}
                    onClick={() => onNodeNameClick(clickTarget)}
                  >
                    {fromLabel}
                  </button>
                ) : (
                  <span className="mc-message-from" title={outgoing ? undefined : m.fromPublicKey}>
                    {fromLabel}
                  </span>
                )}
                <span className="mc-message-meta">
                  <span className="mc-message-time">
                  {formatTime(m.timestamp)}
                  {outgoing && m.deliveryStatus && (
                    <span
                      className={`mc-delivery-status mc-delivery-${m.deliveryStatus}`}
                      title={
                        m.deliveryStatus === 'delivered'
                          ? `Delivered (${m.roundTripMs}ms)`
                          : m.deliveryStatus === 'failed'
                            ? 'Delivery failed'
                            : m.deliveryStatus === 'sent'
                              ? 'Sent, awaiting confirmation'
                              : 'Sending…'
                      }
                    >
                      <UiIcon
                        name={m.deliveryStatus === 'delivered'
                          ? 'checkAll'
                          : m.deliveryStatus === 'failed'
                            ? 'error'
                            : m.deliveryStatus === 'sent'
                              ? 'check'
                              : 'time'}
                        size={13}
                      />
                    </span>
                  )}
                  {outgoing && m.heardBy && m.heardBy.length > 0 && (
                    <button
                      type="button"
                      className="mc-heard-by-badge"
                      title={t('meshcore.heard_by_tooltip', 'Repeaters that relayed this message')}
                      aria-expanded={expandedHeardBy.has(m.id)}
                      onClick={() => toggleHeardBy(m.id)}
                    >
                      <UiIcon name="radioSignal" size={13} /> {m.heardBy.length}
                    </button>
                  )}
                  </span>
                  {onReply && isChannel && !outgoing && (
                    <button
                      type="button"
                      className="mc-message-reply"
                      title={t('meshcore.reply', 'Reply (mentions sender, replies on this scope)')}
                      aria-label={t('meshcore.reply', 'Reply')}
                      onClick={() => handleReply(m)}
                    >
                      <UiIcon name="reply" size={15} />
                    </button>
                  )}
                  {onDeleteMessage && (
                    <button
                      type="button"
                      className="mc-message-delete"
                      title={t('meshcore.delete_message', 'Delete this message')}
                      aria-label={t('meshcore.delete_message', 'Delete this message')}
                      onClick={() => { void onDeleteMessage(m); }}
                    >
                      <UiIcon name="delete" size={15} />
                    </button>
                  )}
                </span>
              </div>
              <div className="mc-message-text">{renderMessageText(m.text)}</div>
              {!outgoing && typeof m.hopCount === 'number' && (
                <div className="mc-message-route" title={t('meshcore.route_tooltip', 'How this message reached you')}>
                  {m.hopCount === 0 ? (
                    <><UiIcon name="location" size={13} /> {t('meshcore.route_direct', 'direct')}</>
                  ) : (
                    <><UiIcon name="route" size={13} /> {m.hopCount} {m.hopCount === 1 ? t('meshcore.hop', 'hop') : t('meshcore.hops', 'hops')}</>
                  )}
                  {m.hopCount !== 0 && m.routePath && (
                    <> · <button
                      type="button"
                      className="mc-route-chain-link"
                      title={t('meshcore.route_detail_tooltip', 'Show route details with repeater names')}
                      onClick={() => setRouteDetail(m)}
                    >
                      {m.routePath.split(',').filter(Boolean).map((hop, hopIndex, hops) => (
                        <React.Fragment key={`${hop}-${hopIndex}`}>
                          {hop}{hopIndex < hops.length - 1 && <> <UiIcon name="forward" size={12} /> </>}
                        </React.Fragment>
                      ))}
                    </button></>
                  )}
                </div>
              )}
              {/* Only render the scope row when the message actually carried a
                  scope/region — an unscoped message (scopeCode 0) or one with no
                  scope info shows nothing rather than a "no scope" badge (#3851 follow-up). */}
              {((m.scopeName != null && m.scopeName !== '') || (typeof m.scopeCode === 'number' && m.scopeCode !== 0)) && (
                <div
                  className="mc-message-scope"
                  title={t('meshcore.scope_tooltip', 'The region/scope this message was sent with')}
                >
                  <UiIcon name="encrypted" size={13} /> {m.scopeName
                    ? m.scopeName
                    : `#${(m.scopeCode ?? 0).toString(16).padStart(4, '0')}`}
                </div>
              )}
              {outgoing && m.heardBy && m.heardBy.length > 0 && expandedHeardBy.has(m.id) && (
                <ul className="mc-heard-by-list">
                  {m.heardBy.map(h => (
                    <li key={h.hash} className="mc-heard-by-item">
                      <span className="mc-heard-by-name">{h.name || h.hash}</span>
                      {typeof h.snr === 'number' && (
                        <span className="mc-heard-by-snr"> ({h.snr} dB)</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {m.text && <LinkPreview text={m.text} />}
              </div>
            </React.Fragment>
          );
        })}
      </div>
      <div className="meshcore-send-bar">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('meshcore.type_message', 'Type a message…')}
          disabled={disabled || sending}
        />
        <button
          onClick={() => void handleSend()}
          disabled={disabled || sending || !draft.trim() || overLimit}
        >
          {sending ? t('meshcore.sending', 'Sending…') : t('meshcore.send', 'Send')}
        </button>
      </div>
      {draft.length > 0 && (
        <div className={`meshcore-byte-counter ${byteCounter.className}`}>
          {byteCounter.text}
        </div>
      )}
      {routeDetail && (
        <MeshCoreMessageRouteModal
          message={routeDetail}
          fromLabel={routeDetail.fromName ?? nameForKey(routeDetail.fromPublicKey) ?? `${routeDetail.fromPublicKey.substring(0, 8)}…`}
          contacts={contacts ?? []}
          onClose={() => setRouteDetail(null)}
        />
      )}
    </div>
  );
};
