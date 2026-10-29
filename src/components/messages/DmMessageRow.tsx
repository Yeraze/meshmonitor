/**
 * One row of the Meshtastic DM conversation (MessagesTab), memoized.
 *
 * Moved out of MessagesTab's inline `.map` so a poll redraws only the rows
 * whose message, reactions, quoted parent, sender name or translation changed.
 * Props compare by value (`messageRowPropsEqual`); the callbacks arrive as one
 * stable `actions` object and the name lookups as a `names` object that only
 * changes when a node's name does. Markup is unchanged from the inline version.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshMessage } from '../../types/message';
import type { TimeFormat, DateFormat } from '../../contexts/SettingsContext';
import type { MeshProtocol } from '../../utils/meshProtocol';
import type { MentionRenderOptions } from '../../utils/linkRenderer';
import { renderMessageWithLinks } from '../../utils/linkRenderer';
import { formatMessageTime } from '../../utils/datetime';
import HopCountDisplay from '../HopCountDisplay';
import LinkPreview from '../LinkPreview';
import { MessageStatusIndicator } from '../MessageStatusIndicator';
import { SenderAvatar } from '../SenderAvatar';
import { TranslatedMessage, type TranslatedMessageState } from '../translation/TranslatedMessage';
import { UiIcon } from '../icons';
import UnreadDivider from './UnreadDivider';
import protocolStripe from './ProtocolStripe.module.css';
import { isOwnMessage, messageRowPropsEqual } from './messageRowSupport';

/** Node-name lookups. A new object only when some node's name changes. */
export interface MessageRowNames {
  token: object;
  name: (nodeId: string) => string;
  short: (nodeId: string) => string;
  label: (nodeId: string) => string;
}

/** Row callbacks, one stable object for the life of the list. */
export interface MessageRowActions {
  senderClick: (nodeId: string, event?: React.MouseEvent | React.KeyboardEvent) => void;
  relayClick: (msg: MeshMessage, direction?: 'sent' | 'received') => void;
  resend: (msg: MeshMessage) => void;
  reply: (msg: MeshMessage) => void;
  emoji: (msg: MeshMessage) => void;
  translate: (msgId: string, text: string, targetLang?: string) => void;
  dismissTranslation: (msgId: string) => void;
  remove: (msg: MeshMessage) => void;
  tapback: (emoji: string, msg: MeshMessage) => void;
  showDetails: (msg: MeshMessage) => void;
}

export interface DmMessageRowProps {
  msg: MeshMessage;
  isMine: boolean;
  /** Date label shown above the row, or null for none. */
  dateSeparator: string | null;
  showUnreadDivider: boolean;
  reactions: MeshMessage[];
  repliedMessage: MeshMessage | null;
  /** Sender status for the avatar badge (#5645). */
  senderStatus?: string;
  /** #4880 sender colour, unset for monochrome / own / unknown sender. */
  senderBackground?: string;
  senderTextColor?: string;
  currentNodeId: string;
  canWrite: boolean;
  txDisabled: boolean;
  txDisabledTooltip?: string;
  canTranslate: boolean;
  translation?: TranslatedMessageState;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  /** Today's date string: a new day redraws the "today" time labels. */
  today: string;
  meshProtocol: MeshProtocol;
  mentionOptions: MentionRenderOptions;
  names: MessageRowNames;
  actions: MessageRowActions;
}

function DmMessageRowImpl({
  msg,
  isMine,
  dateSeparator,
  showUnreadDivider,
  reactions,
  repliedMessage,
  senderStatus,
  senderBackground,
  senderTextColor,
  currentNodeId,
  canWrite,
  txDisabled,
  txDisabledTooltip,
  canTranslate,
  translation,
  timeFormat,
  dateFormat,
  meshProtocol,
  mentionOptions,
  names,
  actions,
}: DmMessageRowProps) {
  const { t } = useTranslation();
  const currentDate = new Date(msg.timestamp);
  const separator = dateSeparator !== null && (
    <div className="date-separator">
      <span className="date-separator-text">{dateSeparator}</span>
    </div>
  );

  if (msg.portnum === 70) {
    return (
      <>
        {separator}
        {showUnreadDivider && <UnreadDivider />}
        <div className="message-item traceroute">
          <div className="message-header">
            <span className="message-from">{names.label(msg.from)}</span>
            <span className="message-time">
              {formatMessageTime(currentDate, timeFormat, dateFormat)}
              <HopCountDisplay
                hopStart={msg.hopStart}
                hopLimit={msg.hopLimit}
                rxSnr={msg.rxSnr}
                rxRssi={msg.rxRssi}
                relayNode={msg.relayNode}
                viaMqtt={msg.viaMqtt}
                viaStoreForward={msg.viaStoreForward}
                xeddsaSigned={msg.xeddsaSigned}
                onClick={() => actions.relayClick(msg)}
              />
            </span>
            <span className="traceroute-badge">{t('messages.traceroute_badge')}</span>
          </div>
          <div className="message-text" style={{ whiteSpace: 'pre-line', fontFamily: 'monospace' }}>
            {renderMessageWithLinks(msg.text)}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {separator}
      {/* Red "New messages" line, directly above the oldest
          message unseen at entry (#4607). */}
      {showUnreadDivider && <UnreadDivider />}
      <div
        className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}
        data-message-id={msg.id}
      >
        {!isMine && (
          <SenderAvatar
            shortName={names.short(msg.from)}
            status={senderStatus}
            title={t('channels.sender_click_title', { name: names.name(msg.from) })}
            onActivate={e => actions.senderClick(msg.from, e)}
            style={senderBackground ? { background: senderBackground, color: senderTextColor } : undefined}
          />
        )}
        <div className="message-content">
          {msg.replyId && (
            <div className="replied-message">
              <div className="reply-arrow">↳</div>
              <div className="reply-content">
                {repliedMessage ? (
                  <>
                    <div className="reply-from">{names.short(repliedMessage.from)}</div>
                    <div className="reply-text">{repliedMessage.text || t('messages.empty_message')}</div>
                  </>
                ) : (
                  <div className="reply-text" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                    {t('messages.message_unavailable')}
                  </div>
                )}
              </div>
            </div>
          )}
          {canWrite && (
            <div className="message-actions">
              {isMine ? (
                <button
                  className="resend-button"
                  onClick={() => actions.resend(msg)}
                  disabled={txDisabled}
                  title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : t('messages.resend_button_title')}
                  aria-label={t('messages.resend_button_title')}
                >
                  ↻
                </button>
              ) : (
                <button
                  className="reply-button"
                  onClick={() => actions.reply(msg)}
                  title={t('messages.reply_button_title')}
                  aria-label={t('messages.reply_button_title')}
                >
                  <UiIcon name="reply" size={15} />
                </button>
              )}
              <button
                className="emoji-picker-button"
                onClick={() => actions.emoji(msg)}
                disabled={txDisabled}
                title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : t('messages.emoji_button_title')}
                aria-label={t('messages.emoji_button_title')}
              >
                <UiIcon name="reaction" size={15} />
              </button>
              {canTranslate && msg.text && (
                <button
                  className="translate-button"
                  onClick={() => actions.translate(msg.id, msg.text)}
                  title={t('messages.translate', 'Translate')}
                  aria-label={t('messages.translate', 'Translate')}
                >
                  <UiIcon name="translate" size={15} />
                </button>
              )}
              <button
                className="delete-button"
                onClick={() => actions.remove(msg)}
                title={t('messages.delete_button_title')}
                aria-label={t('messages.delete_button_title')}
              >
                <UiIcon name="delete" size={15} />
              </button>
            </div>
          )}
          <div
            className={`message-bubble ${isMine ? 'mine' : 'theirs'}${senderBackground ? ' message-bubble--colored' : ''} ${protocolStripe.stripe}`}
            data-protocol={meshProtocol}
            style={senderBackground ? { background: senderBackground, color: senderTextColor } : undefined}
          >
            <div className="message-text-row">
              <div className="message-text" style={{ whiteSpace: 'pre-line' }}>
                {renderMessageWithLinks(msg.text, mentionOptions)}
              </div>
              <div className="message-meta">
                <span className="message-time">
                  {formatMessageTime(currentDate, timeFormat, dateFormat)}
                  <HopCountDisplay
                    hopStart={msg.hopStart}
                    hopLimit={msg.hopLimit}
                    rxSnr={msg.rxSnr}
                    rxRssi={msg.rxRssi}
                    relayNode={msg.relayNode}
                    viaMqtt={msg.viaMqtt}
                    viaStoreForward={msg.viaStoreForward}
                    xeddsaSigned={msg.xeddsaSigned}
                    onClick={() => actions.relayClick(msg)}
                  />
                </span>
              </div>
            </div>
            <LinkPreview text={msg.text} />
            {translation && (
              <TranslatedMessage
                state={translation}
                onDismiss={() => actions.dismissTranslation(msg.id)}
                onRetry={canTranslate ? () => actions.translate(msg.id, msg.text) : undefined}
                onChangeTargetLang={canTranslate ? (newLang) => actions.translate(msg.id, msg.text, newLang) : undefined}
              />
            )}
            {reactions.length > 0 && (
              <div className="message-reactions">
                {/* Reaction chips stay clickable even when txDisabled — see the
                    matching comment in ChannelMessageRow (epic #4294 Phase 2, §3.2/§3.3):
                    they double as the read affordance for "who reacted", and a
                    re-tap while TX is off is caught by the handleSendTapback
                    failure-branch toast in App.tsx rather than pre-emptively blocked. */}
                {reactions.map(reaction => (
                  <span
                    key={reaction.id}
                    className={`reaction ${isOwnMessage(reaction, currentNodeId) ? 'mine' : 'theirs'}`}
                    title={t('messages.reaction_tooltip', { name: names.short(reaction.from) })}
                    onClick={() => actions.tapback(reaction.text, msg)}
                  >
                    {reaction.text}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {isMine && (
          <div className="message-status">
            <MessageStatusIndicator message={msg} onShowDetails={() => actions.showDetails(msg)} />
          </div>
        )}
      </div>
    </>
  );
}

export const DmMessageRow = React.memo(DmMessageRowImpl, messageRowPropsEqual);
DmMessageRow.displayName = 'DmMessageRow';
