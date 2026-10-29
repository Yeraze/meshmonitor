/**
 * One row of a Meshtastic channel conversation (ChannelsTab), memoized.
 *
 * Same contract as `DmMessageRow`: props compare by value, callbacks arrive
 * as one stable `actions` object, and the name lookups as a `names` object
 * that changes only when a node's name does, so a poll redraws only the rows
 * that changed. Markup is unchanged from the inline version.
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
import { SenderAvatar, SenderNameButton } from '../SenderAvatar';
import { TranslatedMessage, type TranslatedMessageState } from '../translation/TranslatedMessage';
import { UiIcon } from '../icons';
import UnreadDivider from './UnreadDivider';
import protocolStripe from './ProtocolStripe.module.css';
import { isOwnMessage, messageRowPropsEqual } from './messageRowSupport';
import type { MessageRowActions, MessageRowNames } from './DmMessageRow';

export interface ChannelMessageRowProps {
  msg: MeshMessage;
  isMine: boolean;
  dateSeparator: string | null;
  showUnreadDivider: boolean;
  reactions: MeshMessage[];
  repliedMessage: MeshMessage | null;
  senderStatus?: string;
  currentNodeId: string;
  /** `channel_N:write` on the open channel. */
  canWrite: boolean;
  /** Device channel (0-7): reply/resend/react apply. Channel Database rows are read-only. */
  isDeviceChannel: boolean;
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

function ChannelMessageRowImpl({
  msg,
  isMine,
  dateSeparator,
  showUnreadDivider,
  reactions,
  repliedMessage,
  senderStatus,
  currentNodeId,
  canWrite,
  isDeviceChannel,
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
}: ChannelMessageRowProps) {
  const { t } = useTranslation();
  const currentDate = new Date(msg.timestamp);

  return (
    <>
      {dateSeparator !== null && (
        <div className="date-separator">
          <span className="date-separator-text">{dateSeparator}</span>
        </div>
      )}
      {/* Red "New messages" line, directly above the
          oldest message unseen at entry (#4607). */}
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
          />
        )}
        <div className="message-content">
          {!isMine && (
            <SenderNameButton
              name={names.name(msg.from)}
              title={t('channels.sender_click_title', { name: names.name(msg.from) })}
              onActivate={e => actions.senderClick(msg.from, e)}
            />
          )}
          {msg.replyId && (
            <div className="replied-message">
              <div className="reply-arrow"><UiIcon name="reply" size={14} /></div>
              <div className="reply-content">
                {repliedMessage ? (
                  <>
                    <div className="reply-from">{names.short(repliedMessage.from)}</div>
                    <div className="reply-text">{repliedMessage.text || t('channels.empty_message')}</div>
                  </>
                ) : (
                  <div className="reply-text" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                    {t('channels.message_unavailable')}
                  </div>
                )}
              </div>
            </div>
          )}
          <div
            className={`message-bubble ${isMine ? 'mine' : 'theirs'}${msg.spoofSuspected ? ' spoofed' : ''} ${protocolStripe.stripe}`}
            data-protocol={meshProtocol}
          >
            {msg.spoofSuspected && (
              <div
                className="message-spoof-warning"
                title={t('channels.spoof_warning_title', 'This message claims to be from your node but arrived over RF — someone may be impersonating your node.')}
              >
                <UiIcon name="alert" size={15} /> {t('channels.spoof_warning', 'Possible impersonation of your node')}
              </div>
            )}
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
                    onClick={() => actions.relayClick(msg, isMine ? 'sent' : 'received')}
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
                {reactions.map(reaction => {
                  // #4243: show WHO reacted inline. The short
                  // name was already resolved here for the
                  // tooltip, but a hover-only affordance is
                  // unusable on touch and invisible at a glance.
                  const reactorName = names.short(reaction.from);
                  // Reaction chips stay clickable even when txDisabled: they are
                  // also the read affordance for "who reacted" (hover tooltip +
                  // inline name), and disabling them would hide that read-only
                  // info. A re-tap while TX is off surfaces the 409 via the
                  // handleSendTapback failure-branch toast (App.tsx) instead of
                  // being pre-emptively blocked here (epic #4294 Phase 2, §3.2).
                  return (
                    <span
                      key={reaction.id}
                      className={`reaction ${isOwnMessage(reaction, currentNodeId) ? 'mine' : 'theirs'}`}
                      title={t('channels.reaction_tooltip', { name: reactorName })}
                      onClick={() => actions.tapback(reaction.text, msg)}
                    >
                      {reaction.text}
                      {reactorName && (
                        <span className="reaction__author">{reactorName}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {/* Rendered AFTER the bubble (issue #4311): on touch/no-hover
              displays .message-actions sits in normal flow, so keeping it
              between .sender-name and .message-bubble pushed the long name
              away from its own bubble. On hover displays it stays an
              absolutely-positioned overlay (unaffected by DOM order). */}
          {canWrite && (
            <div className="message-actions">
              {/* Hide reply/resend for Channel Database channels (read-only) - device channels are 0-7 */}
              {isDeviceChannel && (
                isMine ? (
                  <button
                    className="resend-button"
                    onClick={() => actions.resend(msg)}
                    title={t('channels.resend_button_title')}
                    aria-label={t('channels.resend_button_title')}
                  >
                    <UiIcon name="refresh" size={15} />
                  </button>
                ) : (
                  <button
                    className="reply-button"
                    onClick={() => actions.reply(msg)}
                    title={t('channels.reply_button_title')}
                    aria-label={t('channels.reply_button_title')}
                  >
                    <UiIcon name="reply" size={15} />
                  </button>
                )
              )}
              {/* Hide emoji reactions for Channel Database channels (read-only) */}
              {isDeviceChannel && (
                <button
                  className="emoji-picker-button"
                  onClick={() => actions.emoji(msg)}
                  disabled={txDisabled}
                  title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : t('channels.emoji_button_title')}
                  aria-label={t('channels.emoji_button_title')}
                >
                  <UiIcon name="reaction" size={15} />
                </button>
              )}
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
                title={t('channels.delete_button_title')}
                aria-label={t('channels.delete_button_title')}
              >
                <UiIcon name="delete" size={15} />
              </button>
            </div>
          )}
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

export const ChannelMessageRow = React.memo(ChannelMessageRowImpl, messageRowPropsEqual);
ChannelMessageRow.displayName = 'ChannelMessageRow';
