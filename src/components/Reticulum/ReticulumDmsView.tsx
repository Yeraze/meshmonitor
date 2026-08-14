/**
 * ReticulumDmsView — LXMF conversations + message pane for a Reticulum
 * source (#3960 Phase 2 WP5).
 *
 * Layout mirrors MeshCore's DM surface at a high level (conversation list on
 * the left, selected conversation's message stream + composer on the
 * right — `MeshCoreDirectMessagesView`/`MeshCoreMessageStream`) but is a
 * fresh, CSS-module-scoped implementation rather than a reuse of those
 * components: Reticulum conversations have no "contacts" concept (peers are
 * discovered purely from message history via `GET /messages`, WP4), no
 * unread-tracking store, and no route/heard-by metadata — porting the
 * MeshCore components wholesale would drag in machinery that doesn't apply
 * here. Ordering uses `messageOrder.ts` (this directory), the Reticulum
 * analog of MeshCore's `messageOrder.ts`.
 *
 * Direction is derived purely from the active peer hash, without needing
 * this source's own LXMF address: a conversation is always exactly two
 * parties, so `row.fromHash === activePeerHash` is inbound and
 * `row.toHash === activePeerHash` is outbound (see `ReticulumConversation`'s
 * doc in `types/reticulum.ts`).
 *
 * Attachments (`fields.fileAttachments`/`image`/`audio`) render as metadata
 * placeholders only (name/type/size) — the bridge never puts raw attachment
 * bytes on the wire (R3, `_sanitize_lxmf_fields`), and blob transfer is
 * deferred past Phase 2. Reply/thread/reaction markers render as small
 * badges derived from the DB columns (`replyToHash`/`threadHash`) and the
 * sanitized `fields` JSON (`reaction`).
 *
 * Compose is client-side optimistic (build spec §6): submitting shows a
 * local "sending" bubble immediately, before the `POST /messages` round
 * trip resolves. On success the temp bubble is dropped — the real row is
 * already in `messages` by then, appended by `useReticulum.sendMessage`.
 * On failure the temp bubble flips to a "failed" chip instead of
 * disappearing, so a rejected send stays visible. Once a real row exists,
 * further delivery-state transitions (sent/delivered/failed) arrive via the
 * `reticulum:delivery-state:updated` socket event the hook already
 * subscribes to — this view only ever renders `messages` as given.
 */
import React, { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ReticulumConversation,
  ReticulumDestinationRow,
  ReticulumIdentity,
  ReticulumMessageRow,
} from '../../types/reticulum';
import type { SendReticulumMessageInput } from './hooks/useReticulum';
import { useSettings } from '../../contexts/SettingsContext';
import { formatTimeOrDate } from '../../utils/datetime';
import { UiIcon, type UiIconName } from '../icons';
import styles from './ReticulumDmsView.module.css';

export interface ReticulumDmsViewProps {
  sourceId: string;
  conversations: ReticulumConversation[];
  conversationsLoading?: boolean;
  activePeerHash: string | null;
  messages: ReticulumMessageRow[];
  messagesLoading?: boolean;
  hasMoreMessages?: boolean;
  /** This source's own LXMF identity — used only for the R5 backup note. */
  identity: ReticulumIdentity | null;
  /** Optional — resolves a peer hash to a friendly name from the
   *  destinations list (announce-derived `displayName`). Falls back to a
   *  truncated hash when omitted or when a peer has no destination record
   *  yet (e.g. it's only ever been seen via LXMF, never announced). */
  destinations?: ReticulumDestinationRow[];
  onSelectConversation: (peerHash: string) => void;
  onLoadMoreMessages: () => void;
  onSend: (input: SendReticulumMessageInput) => Promise<ReticulumMessageRow | null>;
}

/** Local optimistic bubble shown between submit and the `POST /messages` response landing. */
interface PendingMessage {
  localId: string;
  content: string;
  createdAt: number;
  failed: boolean;
}

function truncateHash(hash: string, length = 12): string {
  return hash.length > length ? `${hash.substring(0, length)}…` : hash;
}

/** `fields` is stored as a JSON string (or null) — parse defensively, never throw on malformed data. */
function parseFields(fields: string | null): Record<string, unknown> | null {
  if (!fields) return null;
  try {
    const parsed: unknown = JSON.parse(fields);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

interface AttachmentMeta {
  name: string;
  type: string;
  size: number | null;
}

/** Best-effort size extraction from a sanitized field value — either the bridge's `{bytesLength}` placeholder (long payloads) or a hex-encoded short byte string (see `_sanitize_lxmf_fields`/`_jsonify_field_value`). */
function sizeOfSanitizedValue(value: unknown): number | null {
  if (value && typeof value === 'object' && 'bytesLength' in (value as Record<string, unknown>)) {
    const n = (value as Record<string, unknown>).bytesLength;
    return typeof n === 'number' ? n : null;
  }
  if (typeof value === 'string') return Math.floor(value.length / 2);
  return null;
}

/** Extracts attachment metadata placeholders from a parsed `fields` bag (`fileAttachments`/`image`/`audio` — see `_FIELD_NAMES` in the bridge). Never surfaces raw bytes — only name/type/size, per R3. */
function extractAttachments(fields: Record<string, unknown> | null): AttachmentMeta[] {
  if (!fields) return [];
  const out: AttachmentMeta[] = [];
  const fileAttachments = fields.fileAttachments;
  if (Array.isArray(fileAttachments)) {
    for (const entry of fileAttachments) {
      if (Array.isArray(entry) && entry.length >= 1) {
        const [name, payload] = entry;
        out.push({
          name: typeof name === 'string' && name.length > 0 ? name : 'file',
          type: 'file',
          size: sizeOfSanitizedValue(payload),
        });
      }
    }
  }
  for (const [key, type] of [['image', 'image'], ['audio', 'audio']] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    const payload = Array.isArray(value) ? value[value.length - 1] : value;
    out.push({ name: type, type, size: sizeOfSanitizedValue(payload) });
  }
  return out;
}

function formatBytes(size: number | null): string {
  if (size === null) return '';
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

/** Delivery-state -> {icon, labelKey, fallback} for the chip shown on outgoing messages. */
function deliveryChipFor(state: ReticulumMessageRow['state']): { icon: UiIconName; labelKey: string; fallback: string } {
  switch (state) {
    case 'delivered':
      return { icon: 'checkAll', labelKey: 'reticulum.dms.delivered', fallback: 'Delivered' };
    case 'sent':
      return { icon: 'check', labelKey: 'reticulum.dms.sent', fallback: 'Sent' };
    case 'failed':
      return { icon: 'error', labelKey: 'reticulum.dms.failed', fallback: 'Failed' };
    default:
      return { icon: 'time', labelKey: 'reticulum.dms.sending', fallback: 'Sending…' };
  }
}

export const ReticulumDmsView: React.FC<ReticulumDmsViewProps> = ({
  sourceId,
  conversations,
  conversationsLoading,
  activePeerHash,
  messages,
  messagesLoading,
  hasMoreMessages,
  identity,
  destinations,
  onSelectConversation,
  onLoadMoreMessages,
  onSend,
}) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [sending, setSending] = useState(false);

  // Switching conversations drops any leftover optimistic bubbles from the
  // previously-active peer — they belong to a different message list now.
  useEffect(() => {
    setPending([]);
  }, [activePeerHash]);

  const nameByHash = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of destinations ?? []) {
      if (d.displayName) map.set(d.destinationHash, d.displayName);
    }
    return map;
  }, [destinations]);

  const nameFor = (hash: string): string => nameByHash.get(hash) ?? truncateHash(hash);

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || !activePeerHash || sending) return;
    const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPending(prev => [...prev, { localId, content, createdAt: Date.now(), failed: false }]);
    setDraft('');
    setSending(true);
    try {
      const row = await onSend({ to: activePeerHash, content });
      setPending(prev => (
        row
          ? prev.filter(p => p.localId !== localId)
          : prev.map(p => (p.localId === localId ? { ...p, failed: true } : p))
      ));
    } finally {
      setSending(false);
    }
  };

  const handleComposeKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className={styles.view} data-testid="reticulum-dms-view" data-source-id={sourceId}>
      <aside className={styles.sidebar} data-testid="reticulum-dms-conversations">
        <div className={styles.sidebarHeader}>
          <UiIcon name="messages" size={15} />
          <span>{t('reticulum.dms.conversations', 'Conversations')}</span>
        </div>
        {conversations.length === 0 ? (
          <div className={styles.emptyState} data-testid="reticulum-dms-empty">
            {conversationsLoading
              ? t('reticulum.dms.loading', 'Loading…')
              : t('reticulum.dms.no_conversations', 'No conversations yet.')}
          </div>
        ) : (
          <ul className={styles.conversationList}>
            {conversations.map(c => {
              const active = c.peerHash === activePeerHash;
              return (
                <li key={c.peerHash}>
                  <button
                    type="button"
                    className={`${styles.conversationItem} ${active ? styles.conversationItemActive : ''}`}
                    onClick={() => onSelectConversation(c.peerHash)}
                    title={c.peerHash}
                  >
                    <span className={styles.peerName}>{nameFor(c.peerHash)}</span>
                    <span className={styles.conversationPreview}>{c.lastMessage.content ?? ''}</span>
                    <span className={styles.conversationMeta}>
                      {formatTimeOrDate(new Date(c.lastMessage.timestamp), timeFormat, dateFormat)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className={styles.mainPane}>
        {!activePeerHash ? (
          <div className={styles.emptyState} data-testid="reticulum-dms-no-selection">
            {t('reticulum.dms.select_conversation', 'Select a conversation to view messages.')}
          </div>
        ) : (
          <>
            <header className={styles.mainHeader}>
              <span className={styles.peerName}>{nameFor(activePeerHash)}</span>
              <span className={styles.peerHashFull} title={activePeerHash}>{truncateHash(activePeerHash, 20)}</span>
            </header>

            {identity?.destinationHash && (
              <div className={styles.noteBanner} data-testid="reticulum-dms-identity-note">
                <UiIcon name="key" size={13} />
                <span>
                  {t(
                    'reticulum.dms.identity_backup_note',
                    "This source's LXMF identity lives on the bridge volume — back it up; a fresh bridge without it gets a new address.",
                  )}
                </span>
              </div>
            )}

            <div className={styles.messageList} data-testid="reticulum-dms-messages">
              {hasMoreMessages && (
                <button
                  type="button"
                  className={styles.loadMoreButton}
                  onClick={onLoadMoreMessages}
                  disabled={messagesLoading}
                >
                  {messagesLoading
                    ? t('reticulum.dms.loading', 'Loading…')
                    : t('reticulum.dms.load_older', 'Load older messages')}
                </button>
              )}

              {messages.length === 0 && pending.length === 0 && (
                <div className={styles.emptyState} data-testid="reticulum-dms-no-messages">
                  {messagesLoading
                    ? t('reticulum.dms.loading', 'Loading…')
                    : t('reticulum.dms.no_messages', 'No messages in this conversation yet.')}
                </div>
              )}

              {messages.map(m => {
                const outgoing = m.toHash === activePeerHash;
                const fields = parseFields(m.fields);
                const attachments = extractAttachments(fields);
                const reaction = fields && typeof fields.reaction === 'string' ? fields.reaction : null;
                const chip = deliveryChipFor(m.state);
                return (
                  <div
                    key={m.id}
                    className={`${styles.messageRow} ${outgoing ? styles.messageRowOutgoing : ''}`}
                    data-testid="reticulum-dms-message"
                    data-message-id={m.id}
                  >
                    <div className={styles.bubble}>
                      {(m.replyToHash || m.threadHash) && (
                        <div className={styles.badgeRow}>
                          {m.replyToHash && (
                            <span className={styles.badge} title={m.replyToHash}>
                              <UiIcon name="reply" size={11} /> {t('reticulum.dms.reply_badge', 'Reply')}
                            </span>
                          )}
                          {m.threadHash && (
                            <span className={styles.badge} title={m.threadHash}>
                              <UiIcon name="link" size={11} /> {t('reticulum.dms.thread_badge', 'Thread')}
                            </span>
                          )}
                        </div>
                      )}
                      {m.title && <div className={styles.messageTitle}>{m.title}</div>}
                      <div className={styles.messageContent}>{m.content}</div>
                      {attachments.length > 0 && (
                        <div className={styles.attachments}>
                          {attachments.map((a, idx) => (
                            <span key={`${m.id}-att-${idx}`} className={styles.attachment}>
                              <UiIcon name="file" size={12} />
                              {a.name}
                              {a.size !== null && ` (${formatBytes(a.size)})`}
                            </span>
                          ))}
                        </div>
                      )}
                      {reaction && (
                        <div className={styles.reaction}>
                          <UiIcon name="reaction" size={12} /> {reaction}
                        </div>
                      )}
                      <div className={styles.messageMeta}>
                        <span>{formatTimeOrDate(new Date(m.timestamp), timeFormat, dateFormat)}</span>
                        {outgoing && (
                          <span
                            className={styles.deliveryChip}
                            title={t(chip.labelKey, chip.fallback)}
                            data-testid="reticulum-dms-delivery-chip"
                            data-state={m.state}
                          >
                            <UiIcon name={chip.icon} size={12} />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {pending.map(p => (
                <div key={p.localId} className={`${styles.messageRow} ${styles.messageRowOutgoing}`} data-testid="reticulum-dms-pending-message">
                  <div className={`${styles.bubble} ${styles.bubblePending}`}>
                    <div className={styles.messageContent}>{p.content}</div>
                    <div className={styles.messageMeta}>
                      <span
                        className={styles.deliveryChip}
                        data-testid="reticulum-dms-delivery-chip"
                        data-state={p.failed ? 'failed' : 'sending'}
                        title={p.failed ? t('reticulum.dms.failed', 'Failed') : t('reticulum.dms.sending', 'Sending…')}
                      >
                        <UiIcon name={p.failed ? 'error' : 'time'} size={12} />
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.composeBar}>
              <textarea
                className={styles.composeInput}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleComposeKeyDown}
                placeholder={t('reticulum.dms.compose_placeholder', 'Type a message…')}
                aria-label={t('reticulum.dms.compose_placeholder', 'Type a message…')}
                rows={2}
              />
              <button
                type="button"
                className={styles.sendButton}
                onClick={() => void handleSend()}
                disabled={!draft.trim() || sending}
                aria-label={t('reticulum.dms.send', 'Send')}
              >
                <UiIcon name="send" size={16} />
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default ReticulumDmsView;
