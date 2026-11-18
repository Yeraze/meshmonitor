/**
 * Send box for the Unified Messages page (#3045 P2).
 *
 * One click sends one message from one node: the node shown in "Send from",
 * on that node's own channel number. A failed send is never retried; the draft
 * stays and the user decides. The mutation sets `retry: false` and no handler
 * calls it again.
 *
 * P3 (#3045): an optional `target` turns the box into a reply or a tapback to
 * one message. A reply is a normal send with the parent's wire id (MeshCore:
 * an `@[Name]: ` prefix). A tapback sends once, when the user picks an emoji.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import apiService from '../../services/api';
import MessageComposeInput from '../MessageComposeInput';
import { EmojiPickerModal } from '../EmojiPickerModal/EmojiPickerModal';
import { reactionEmojiOptions } from '../MeshCore/meshcoreReactionClient';
import { isReactionEmoji } from '../../utils/meshcoreReactions';
import { useSettingsOptional } from '../../contexts/SettingsContext';
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
  buildUnifiedReactionRequest,
  meshcoreReplyPrefix,
  senderFitsTarget,
  unifiedSendErrorKind,
  type SenderRef,
  type SendBlockedReason,
  type SendTarget,
  type SenderFitReason,
  type TargetMode,
  type UnifiedSendRequest,
} from '../../pages/unifiedSendRequest';
import { meshcoreChannelMaxBytes } from '../../utils/meshcoreMessageLimits';
import { MAX_MESSAGE_BYTES } from '../../server/constants/meshtastic';
import type { MentionCandidate } from '../../utils/mentions';
import type { UnifiedMessage } from '../../pages/unifiedMessageTypes';
import styles from './UnifiedSendComposer.module.css';

const NO_MENTIONS: readonly MentionCandidate[] = [];

interface Props {
  channelName: string;
  draftStore: ComposeDraftStore;
  onSent: () => void;
  /** The message being replied to or reacted to, if any. */
  target?: UnifiedSendTarget | null;
  /** Called after a successful send, and when the user cancels the target. */
  onClearTarget?: () => void;
}

export interface UnifiedSendTarget {
  mode: TargetMode;
  msg: UnifiedMessage;
}

type SendMode = 'send' | 'reply' | 'react';
interface SendVars {
  ref: SenderRef;
  request: UnifiedSendRequest;
  mode: SendMode;
}

const MC_REPLY_PREFIX_RE = /^@\[[^\]]*\]: /;
const NO_TAPBACKS: never[] = [];

function targetName(msg: UnifiedMessage): string {
  return msg.fromNodeLongName || msg.fromNodeShortName || msg.fromNodeId;
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

export default function UnifiedSendComposer({ channelName, draftStore, onSent, target = null, onClearTarget }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Set at click time: `isPending` only turns true after a render, so two fast clicks could both pass it.
  const inFlightRef = useRef(false);
  const { data: channels } = useUnifiedSenders(true);
  const tapbackEmojis = useSettingsOptional()?.tapbackEmojis;

  const [pickedSourceId, setPickedSourceId] = useState<string | null>(null);
  const [error, setError] = useState<SendError | null>(null);

  const refs = useMemo(() => sendersForChannel(channels, channelName), [channels, channelName]);
  const eligible = useMemo(() => refs.filter((r) => r.canSend), [refs]);
  const liveBlocked = useMemo(() => refs.filter((r) => !r.canSend && r.sendKind !== null), [refs]);

  // What the target needs. `refs` stays unfiltered above: the sender_changed
  // notice and the return-null check must not react to the target.
  const sendTarget = useMemo<SendTarget | null>(
    () =>
      target
        ? {
            mode: target.mode,
            protocol: target.msg.meshcoreRowRefs !== undefined ? 'meshcore' : 'meshtastic',
            meshcoreRowRefs: target.msg.meshcoreRowRefs,
          }
        : null,
    [target],
  );
  // Listed: refs that fit, plus ones kept only to say why they do not.
  const targetFits = useMemo(
    () =>
      refs
        .map((r) => ({ r, fit: senderFitsTarget(r, sendTarget) }))
        .filter(({ r, fit }) => (fit.fits || fit.reason) && (r.canSend || r.sendKind !== null)),
    [refs, sendTarget],
  );
  const targetEligible = useMemo(
    () => targetFits.filter(({ r, fit }) => r.canSend && fit.fits).map(({ r }) => r),
    [targetFits],
  );

  // A pick made during a target applies to that target only and is never stored.
  const [targetPick, setTargetPick] = useState<{ target: UnifiedSendTarget; sourceId: string } | null>(null);
  const picked = pickedSourceId ? eligible.find((r) => r.sourceId === pickedSourceId) : undefined;
  const targetPicked =
    target && targetPick?.target === target
      ? targetEligible.find((r) => r.sourceId === targetPick.sourceId)
      : undefined;
  const effective: SenderRef | null = target
    ? (targetPicked ?? resolveUnifiedSender(targetEligible, readStoredUnifiedSender(channelName)))
    : (picked ?? resolveUnifiedSender(eligible, readStoredUnifiedSender(channelName)));

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
  const mutation = useMutation<unknown, unknown, SendVars>({
    mutationFn: async ({ request }: SendVars) => apiService.post<unknown>(request.endpoint, request.body),
    retry: false,
    onSettled: () => {
      inFlightRef.current = false;
    },
    onSuccess: (_data, { mode }) => {
      // A tapback never touched the draft.
      if (mode !== 'react') draftStore.set('');
      setError(null);
      onClearTarget?.();
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
        case 'duplicate_reaction':
          text = t('unified.send.error.duplicate_reaction', 'You already sent that reaction from {{source}}.', {
            source: ref.sourceName,
          });
          break;
        case 'reactions_off':
          text = t(
            'unified.send.error.reactions_off',
            'Reactions are turned off on {{source}}. Nothing was sent.',
            { source: ref.sourceName },
          );
          break;
        case 'target_missing':
          text = t('unified.send.error.target_missing', '{{source}} no longer has this message.', {
            source: ref.sourceName,
          });
          break;
        case 'not_reactable':
          text = t('unified.send.error.not_reactable', 'This message cannot take a reaction.');
          break;
        case 'invalid_emoji':
          text = t('unified.send.error.invalid_emoji', 'MeshCore cannot send that emoji.');
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
    if (!text.trim() || inFlightRef.current || !effective || target?.mode === 'react') return;
    let request: UnifiedSendRequest;
    try {
      // A MeshCore reply is plain text; only Meshtastic-wire sends carry the parent id.
      const replyId =
        target?.mode === 'reply' && sendTarget?.protocol === 'meshtastic' ? target.msg.packetId : null;
      request = buildUnifiedSendRequest(effective, text, replyId != null ? { replyId } : undefined);
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : String(err) });
      return;
    }
    inFlightRef.current = true;
    mutation.mutate({ ref: effective, request, mode: target?.mode === 'reply' ? 'reply' : 'send' });
  };

  // Picking an emoji is the one tapback send.
  const handleReact = (emoji: string) => {
    if (!target || target.mode !== 'react' || !effective || inFlightRef.current) return;
    let request: UnifiedSendRequest;
    try {
      request = buildUnifiedReactionRequest(effective, target.msg, emoji);
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : String(err) });
      return;
    }
    inFlightRef.current = true;
    mutation.mutate({ ref: effective, request, mode: 'react' });
  };

  // The picker opens with a react target and stays closed once dismissed.
  const [pickerClosedFor, setPickerClosedFor] = useState<UnifiedSendTarget | null>(null);
  const reactMode = target?.mode === 'react';
  const pickerOpen = !!target && reactMode && !!effective && pickerClosedFor !== target;

  // MeshCore reply: start the draft with `@[Name]: ` and put the caret after it.
  useEffect(() => {
    if (!target || target.mode !== 'reply' || target.msg.meshcoreRowRefs === undefined) return;
    const prefix = meshcoreReplyPrefix(target.msg.fromNodeLongName);
    if (!prefix) return;
    draftStore.set((prev) => prefix + prev.replace(MC_REPLY_PREFIX_RE, ''));
    const timer = setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    return () => clearTimeout(timer);
  }, [target, draftStore]);

  if (eligible.length === 0 && liveBlocked.length === 0) return null;

  const handlePick = (sourceId: string) => {
    setError(null);
    if (target) {
      // Only this target; the channel's stored default stays as it was.
      setTargetPick({ target, sourceId });
      return;
    }
    setPickedSourceId(sourceId);
    writeStoredUnifiedSender(channelName, sourceId);
    setNotice(null);
  };

  const maxBytes = kind === 'meshcore' ? meshcoreChannelMaxBytes(nodeName) : MAX_MESSAGE_BYTES;
  const selectId = `unified-send-from-${channelName}`;
  // One option per source: a source can hold two slots with the same name.
  const listed = (
    target
      ? targetFits.map(({ r, fit }) => ({ r, reason: fit.fits ? undefined : fit.reason }))
      : [...eligible, ...liveBlocked].map((r) => ({ r, reason: undefined as SenderFitReason | undefined }))
  ).filter(({ r }, i, all) => all.findIndex((o) => o.r.sourceId === r.sourceId) === i);
  const fitReasonLabel = (reason: SenderFitReason) =>
    t(`unified.send.reason.${reason}`, reason === 'not_heard' ? 'did not hear this message' : 'reactions are turned off');
  const isMeshCoreTarget = sendTarget?.protocol === 'meshcore';
  const noSenderText = !target
    ? null
    : reactMode
      ? isMeshCoreTarget
        ? t(
            'unified.react.no_sender_meshcore',
            'Only a MeshCore node that heard this message, with reactions on, can react to it',
          )
        : t('unified.react.no_sender', 'No node here can react to this message')
      : t('unified.reply.no_sender', 'No node here can reply to this message');

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
          {listed.map(({ r, reason }) =>
            r.canSend && !reason ? (
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
                  reason: reason && r.canSend ? fitReasonLabel(reason) : reasonLabel(r.sendBlockedReason),
                })}
              </option>
            ),
          )}
        </select>
      </div>
      {target && (
        <div className={styles.banner} role="status">
          <span className={styles.bannerText}>
            {reactMode
              ? t('unified.react.banner', 'Reacting to {{name}}', { name: targetName(target.msg) })
              : t('unified.reply.banner', 'Replying to {{name}}', { name: targetName(target.msg) })}
            <span className={styles.bannerQuote}>{target.msg.text}</span>
          </span>
          {reactMode && effective && (
            <button type="button" className={styles.bannerButton} onClick={() => setPickerClosedFor(null)}>
              <UiIcon name="reaction" />
              {t('unified.react.choose', 'Choose reaction')}
            </button>
          )}
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => onClearTarget?.()}
            aria-label={t('unified.reply.cancel', 'Cancel')}
          >
            <UiIcon name="close" />
          </button>
        </div>
      )}
      {target && !effective && (
        <div className={styles.notice} role="note">
          {noSenderText}
        </div>
      )}
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
          placeholder={
            target?.mode === 'reply'
              ? t('unified.reply.placeholder', 'Reply to {{name}} from {{source}}…', {
                  name: targetName(target.msg),
                  source: effective?.sourceName ?? '',
                })
              : t('unified.send.placeholder', 'Message #{{channel}} from {{source}}…', {
                  channel: channelName.replace(/^#/, ''),
                  source: effective?.sourceName ?? '',
                })
          }
          disabled={!effective || reactMode}
          disabledTitle={t('unified.send.none_can_send', 'No node can send on this channel right now.')}
          onSend={handleSend}
          sendAriaLabel={t('unified.send.send_aria', 'Send message')}
          maxBytes={maxBytes}
          blockSendOverLimit
          allowNewlines={kind !== 'meshcore'}
          sending={mutation.isPending}
        />
      </div>
      {pickerOpen && target && (
        <EmojiPickerModal<UnifiedMessage>
          message={target.msg}
          onSelectEmoji={(emoji) => handleReact(emoji)}
          onClose={() => setPickerClosedFor(target)}
          customEmojis={isMeshCoreTarget ? reactionEmojiOptions(tapbackEmojis) : (tapbackEmojis ?? NO_TAPBACKS)}
          isEmojiAllowed={isMeshCoreTarget ? isReactionEmoji : undefined}
          subtitle={t('unified.react.picker_subtitle', 'Sends from {{source}}', {
            source: effective?.sourceName ?? '',
          })}
        />
      )}
    </div>
  );
}
