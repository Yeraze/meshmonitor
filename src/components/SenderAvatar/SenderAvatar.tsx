/**
 * Chat sender avatar, name button and status indicator (#5645).
 *
 * `SenderAvatar` is the 32px `.sender-dot` the channel feed and DM thread
 * already drew, unchanged, plus one corner badge. `SenderNameButton` makes the
 * name beside it a second trigger for the same node popup.
 *
 * ## Corner badge order
 *
 * The avatar has ONE badge slot, top right. Highest first:
 *
 *   1. verified key   (not built yet: pass it as `cornerBadge`)
 *   2. status emoji   (this file)
 *   3. role glyph     (not built yet: would sit below the status emoji)
 *
 * Whatever a caller passes as `cornerBadge` wins the slot and the status emoji
 * is not drawn. That is how a verified-key badge will take priority.
 *
 * ## The status emoji is user content
 *
 * It comes from another radio's status message, so it is rendered as a React
 * text node and never as HTML. It is a small neutral badge whatever the emoji
 * is: a status that starts with an SOS or warning sign gets no alert styling,
 * because anyone can type one. For the same reason it never goes on a map
 * marker (see `markerIcons.statusScopeLock.test.ts`).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { isEmoji } from '../../utils/text';
import { getLeadingEmoji } from '../../utils/statusMessage';
import styles from './SenderAvatar.module.css';

type TriggerEvent = React.MouseEvent | React.KeyboardEvent;

/** Enter or Space activates a `role="button"` element, as on a real button. */
function activateOnKey(onActivate: ((event: TriggerEvent) => void) | undefined) {
  return (event: React.KeyboardEvent) => {
    if (!onActivate) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivate(event);
  };
}

function useStatusLabel(status: string | null | undefined): string {
  const { t } = useTranslation();
  return t('sender_avatar.status_label', 'Status: {{status}}', { status: status ?? '' });
}

export interface SenderAvatarProps {
  /** Short name drawn in the dot. */
  shortName: string;
  /** The node's status message. A leading emoji becomes the corner badge. */
  status?: string | null;
  /** Tooltip for the dot. */
  title?: string;
  /** Opens the node popup. The dot is a keyboard-reachable button when set. */
  onActivate?: (event: TriggerEvent) => void;
  /** Per-node colours (the DM thread tints the dot). */
  style?: React.CSSProperties;
  /** A higher-priority badge for the corner slot. See "Corner badge order". */
  cornerBadge?: React.ReactNode;
}

export const SenderAvatar: React.FC<SenderAvatarProps> = ({
  shortName,
  status,
  title,
  onActivate,
  style,
  cornerBadge,
}) => {
  const statusEmoji = getLeadingEmoji(status);
  const statusLabel = useStatusLabel(status);

  const classes = ['sender-dot', styles.avatar];
  if (onActivate) classes.push('clickable');
  if (isEmoji(shortName)) classes.push('is-emoji');

  return (
    <div
      className={classes.join(' ')}
      title={title}
      style={style}
      {...(onActivate
        ? {
            role: 'button',
            tabIndex: 0,
            'data-node-popup-trigger': '',
            onClick: onActivate,
            onKeyDown: activateOnKey(onActivate),
          }
        : {})}
    >
      {shortName}
      {cornerBadge
        ? <span className={styles.badge} data-testid="sender-avatar-corner-badge">{cornerBadge}</span>
        : statusEmoji && (
          <span
            className={styles.badge}
            role="img"
            aria-label={statusLabel}
            data-testid="sender-avatar-status-badge"
          >
            {statusEmoji}
          </span>
        )}
    </div>
  );
};

export interface SenderNameButtonProps {
  name: string;
  title?: string;
  onActivate: (event: TriggerEvent) => void;
  /** `feed`: the small name above a channel message. `header`: inline in the
   *  DM thread heading, taking the heading's font. */
  variant?: 'feed' | 'header';
}

/** The sender's name as a real button that opens the node popup. */
export const SenderNameButton: React.FC<SenderNameButtonProps> = ({
  name,
  title,
  onActivate,
  variant = 'feed',
}) => (
  <button
    type="button"
    className={variant === 'feed' ? `sender-name ${styles.nameButton}` : `${styles.nameButton} ${styles.headerName}`}
    title={title}
    data-node-popup-trigger=""
    onClick={onActivate}
  >
    {name}
  </button>
);

/**
 * The leading status emoji as one more item in a row's inline indicator strip,
 * for rows with no avatar (the DM list). Renders nothing for a status that
 * does not start with an emoji. Not a button: the row's own click is kept.
 */
export const StatusEmojiIndicator: React.FC<{ status?: string | null; className?: string }> = ({
  status,
  className,
}) => {
  const statusEmoji = getLeadingEmoji(status);
  const statusLabel = useStatusLabel(status);
  if (!statusEmoji) return null;
  return (
    <span
      className={className ? `${className} ${styles.inlineStatus}` : styles.inlineStatus}
      role="img"
      aria-label={statusLabel}
      title={statusLabel}
      data-testid="status-emoji-indicator"
    >
      {statusEmoji}
    </span>
  );
};
