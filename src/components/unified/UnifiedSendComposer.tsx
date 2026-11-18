/**
 * Send box for the Unified Messages page (#3045 P2).
 *
 * One click sends one message from one node: the node shown in "Send from",
 * on that node's own channel number. A failed send is never retried; the draft
 * stays and the user decides. The mutation sets `retry: false` and no handler
 * calls it again.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import apiService from '../../services/api';
import MessageComposeInput from '../MessageComposeInput';
import { UiIcon } from '../icons';
import type { ComposeDraftStore } from '../../contexts/composeDraftStore';
import { useUnifiedSenders, sendersForChannel, UNIFIED_SENDERS_QUERY_KEY } from '../../hooks/useUnifiedSenders';
import { useMeshCoreLocalNodeName } from '../../hooks/useMeshCoreLocalNodeName';
import {
  readStoredUnifiedSender,
  writeStoredUnifiedSender,
  resolveUnifiedSender,
} from '../../pages/unifiedSenderPreference';
import {
  buildUnifiedSendRequest,
  unifiedSendErrorKind,
  type SenderRef,
  type SendBlockedReason,
} from '../../pages/unifiedSendRequest';
import { meshcoreChannelMaxBytes } from '../../utils/meshcoreMessageLimits';
import { MAX_MESSAGE_BYTES } from '../../server/constants/meshtastic';
import type { MentionCandidate } from '../../utils/mentions';
import styles from './UnifiedSendComposer.module.css';

const NO_MENTIONS: readonly MentionCandidate[] = [];

interface Props {
  channelName: string;
  draftStore: ComposeDraftStore;
  onSent: () => void;
}

interface SendError {
  text: string;
}

const REASON_KEYS: Partial<Record<SendBlockedReason, string>> = {
  SOURCE_NOT_CONNECTED: 'not_connected',
  TX_DISABLED: 'tx_disabled',
  MQTT_NATIVE_DISABLED: 'mqtt_native_disabled',
  READ_ONLY: 'read_only',
  NO_ROOT_TOPIC: 'no_root_topic',
  NO_IDENTITY: 'no_identity',
  KEY_UNAVAILABLE: 'key_unavailable',
  UNSUPPORTED_SOURCE: 'unsupported',
};

const REASON_DEFAULTS: Record<string, string> = {
  not_connected: 'not connected',
  tx_disabled: 'transmit is off',
  mqtt_native_disabled: 'MQTT send is turned off',
  read_only: 'broker connection is read-only',
  no_root_topic: 'no MQTT root topic set',
  no_identity: 'no MQTT identity yet',
  key_unavailable: 'channel key unavailable',
  unsupported: 'this node type cannot send',
  unknown: 'cannot send right now',
};

const KIND_DEFAULTS: Record<string, string> = {
  meshtastic: 'Meshtastic',
  mqtt_native: 'MQTT (Meshtastic)',
  meshcore: 'MeshCore',
};

export default function UnifiedSendComposer({ channelName, draftStore, onSent }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Set at click time: `isPending` only turns true after a render, so two fast clicks could both pass it.
  const inFlightRef = useRef(false);
  const { data: channels } = useUnifiedSenders(true);

  const [pickedSourceId, setPickedSourceId] = useState<string | null>(null);
  const [error, setError] = useState<SendError | null>(null);

  const refs = useMemo(() => sendersForChannel(channels, channelName), [channels, channelName]);
  const eligible = useMemo(() => refs.filter((r) => r.canSend), [refs]);
  const liveBlocked = useMemo(() => refs.filter((r) => !r.canSend && r.sendKind !== null), [refs]);

  const picked = pickedSourceId ? eligible.find((r) => r.sourceId === pickedSourceId) : undefined;
  const effective: SenderRef | null =
    picked ?? resolveUnifiedSender(eligible, readStoredUnifiedSender(channelName));

  const kind = effective?.sendKind ?? null;
  const nodeName = useMeshCoreLocalNodeName(effective?.sourceId ?? null, kind === 'meshcore');

  const kindLabel = (k: string | null) => t(`unified.send.kind.${k}`, KIND_DEFAULTS[k ?? ''] ?? '');
  const reasonLabel = (r: SendBlockedReason | null) => {
    const key = (r && REASON_KEYS[r]) || 'unknown';
    return t(`unified.send.reason.${key}`, REASON_DEFAULTS[key]);
  };

  // When the node in use can no longer send, say which node took over.
  const [shown, setShown] = useState<SenderRef | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (effective && shown?.sourceId !== effective.sourceId) {
    setShown(effective);
    if (shown && !eligible.some((r) => r.sourceId === shown.sourceId)) {
      setNotice(
        t('unified.send.sender_changed', '{{previous}} can no longer send here. Now sending from {{current}}.', {
          previous: shown.sourceName,
          current: effective.sourceName,
        }),
      );
    } else {
      setNotice(null);
    }
  }

  // Callbacks live on the hook, not on `mutate`, so a send that finishes after
  // a channel switch still clears its draft and refreshes the list.
  const mutation = useMutation<unknown, unknown, { ref: SenderRef; text: string }>({
    mutationFn: async ({ ref, text }: { ref: SenderRef; text: string }) => {
      const { endpoint, body } = buildUnifiedSendRequest(ref, text);
      return apiService.post<unknown>(endpoint, body);
    },
    retry: false,
    onSettled: () => {
      inFlightRef.current = false;
    },
    onSuccess: () => {
      draftStore.set('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['unified', 'messages', channelName] });
      onSent();
    },
    onError: (err, { ref }) => {
      const errKind = unifiedSendErrorKind(err);
      const e = err as { retryAfterSeconds?: unknown; message?: unknown };
      let text: string;
      switch (errKind) {
        case 'rate_limited':
          text =
            typeof e.retryAfterSeconds === 'number'
              ? t('unified.send.error.rate_limited', 'Sending too fast. Try again in {{seconds}}s.', {
                  seconds: e.retryAfterSeconds,
                })
              : t('unified.send.error.rate_limited_generic', 'Sending too fast. Wait a moment and try again.');
          break;
        case 'tx_disabled':
          text = t('unified.send.error.tx_disabled', 'Transmit is disabled on {{source}}. Nothing was sent.', {
            source: ref.sourceName,
          });
          break;
        case 'not_connected':
          text = t('unified.send.error.not_connected', '{{source}} is not connected. Nothing was sent.', {
            source: ref.sourceName,
          });
          break;
        case 'forbidden':
          text = t(
            'unified.send.error.forbidden',
            'You do not have permission to send on this channel from {{source}}.',
            { source: ref.sourceName },
          );
          break;
        default:
          text = t('unified.send.error.generic', 'Message not sent: {{error}}', {
            error: typeof e.message === 'string' && e.message ? e.message : String(err),
          });
      }
      setError({ text });
      // Rate limits are not a state change; everything else may be.
      if (errKind !== 'rate_limited') {
        void queryClient.invalidateQueries({ queryKey: UNIFIED_SENDERS_QUERY_KEY });
      }
    },
  });

  const handleSend = () => {
    const text = draftStore.get();
    if (!text.trim() || inFlightRef.current || !effective) return;
    inFlightRef.current = true;
    mutation.mutate({ ref: effective, text });
  };

  if (eligible.length === 0 && liveBlocked.length === 0) return null;

  const handlePick = (sourceId: string) => {
    setPickedSourceId(sourceId);
    writeStoredUnifiedSender(channelName, sourceId);
    setError(null);
    setNotice(null);
  };

  const maxBytes = kind === 'meshcore' ? meshcoreChannelMaxBytes(nodeName) : MAX_MESSAGE_BYTES;
  const selectId = `unified-send-from-${channelName}`;
  // One option per source: a source can hold two slots with the same name.
  const listed = [...eligible, ...liveBlocked].filter(
    (r, i, all) => all.findIndex((o) => o.sourceId === r.sourceId) === i,
  );

  return (
    <div className={styles.composer}>
      <div className={styles.senderRow}>
        <label htmlFor={selectId}>{t('unified.send.from_label', 'Send from')}</label>
        <select
          id={selectId}
          className={styles.select}
          value={effective?.sourceId ?? ''}
          onChange={(e) => handlePick(e.target.value)}
        >
          {!effective && (
            <option value="" disabled>
              {t('unified.send.no_sender', 'No sender available')}
            </option>
          )}
          {listed.map((r) =>
            r.canSend ? (
              <option key={r.sourceId} value={r.sourceId}>
                {t('unified.send.option', '{{source}} · {{kind}}', {
                  source: r.sourceName,
                  kind: kindLabel(r.sendKind),
                })}
              </option>
            ) : (
              <option key={r.sourceId} value={r.sourceId} disabled>
                {t('unified.send.option_blocked', '{{source}} — {{reason}}', {
                  source: r.sourceName,
                  reason: reasonLabel(r.sendBlockedReason),
                })}
              </option>
            ),
          )}
        </select>
      </div>
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          <UiIcon name="alert" />
          <span className={styles.errorText}>{error.text}</span>
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => setError(null)}
            aria-label={t('unified.send.error.dismiss', 'Dismiss')}
          >
            <UiIcon name="close" />
          </button>
        </div>
      )}
      <div className="message-input-container">
        <MessageComposeInput
          listId="unified-send-mention-list"
          textareaRef={textareaRef}
          draftStore={draftStore}
          mentionCandidates={NO_MENTIONS}
          homoglyphEnabled={false}
          placeholder={t('unified.send.placeholder', 'Message #{{channel}} from {{source}}…', {
            channel: channelName.replace(/^#/, ''),
            source: effective?.sourceName ?? '',
          })}
          disabled={!effective}
          disabledTitle={t('unified.send.none_can_send', 'No node can send on this channel right now.')}
          onSend={handleSend}
          sendAriaLabel={t('unified.send.send_aria', 'Send message')}
          maxBytes={maxBytes}
          blockSendOverLimit
          allowNewlines={kind !== 'meshcore'}
          sending={mutation.isPending}
        />
      </div>
    </div>
  );
}
