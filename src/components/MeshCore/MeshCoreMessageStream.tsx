import React, { useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreMessage } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { getMessageDateSeparator, shouldShowDateSeparator } from '../../utils/datetime';
import LinkPreview from '../LinkPreview';

interface MeshCoreMessageStreamProps {
  messages: MeshCoreMessage[];
  contacts?: MeshCoreContact[];
  selfPublicKey?: string;
  emptyText?: string;
  disabled?: boolean;
  onSend: (text: string) => Promise<boolean>;
  onNodeNameClick?: (publicKey: string) => void;
  /** Stable key identifying the current conversation. When it changes, the
   *  stream scrolls to the bottom. */
  conversationKey?: string;
  /** When set, replaces the send bar with this notice text (e.g. for node
   *  types that cannot receive DMs). */
  readOnlyNotice?: string;
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
  conversationKey,
  readOnlyNotice,
}) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // Message ids whose "heard repeaters" list (#3700) is expanded.
  const [expandedHeardBy, setExpandedHeardBy] = useState<Set<string>>(new Set());
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

  // Scroll to bottom whenever the conversation changes.
  const prevKeyRef = useRef(conversationKey);
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    prevKeyRef.current = conversationKey;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }, [conversationKey]);

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

  const handleSend = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
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
              <span>↓</span> {t('channels.jump_to_bottom', 'Jump to Bottom')}
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
              <div className={`mc-message-row ${outgoing ? 'outgoing' : ''}`}>
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
                      {m.deliveryStatus === 'delivered' ? ' ✓✓'
                        : m.deliveryStatus === 'failed' ? ' ✗'
                        : m.deliveryStatus === 'sent' ? ' ✓'
                        : ' …'}
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
                      {' 📡 '}{m.heardBy.length}
                    </button>
                  )}
                </span>
              </div>
              <div className="mc-message-text">{renderMessageText(m.text)}</div>
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
      {readOnlyNotice ? (
        <div className="meshcore-readonly-notice">
          {readOnlyNotice}
        </div>
      ) : (
        <div className="meshcore-send-bar">
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('meshcore.type_message', 'Type a message…')}
            disabled={disabled || sending}
            maxLength={230}
          />
          <button
            onClick={() => void handleSend()}
            disabled={disabled || sending || !draft.trim()}
          >
            {sending ? t('meshcore.sending', 'Sending…') : t('meshcore.send', 'Send')}
          </button>
        </div>
      )}
    </div>
  );
};
