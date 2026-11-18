/**
 * Shared mute menu (#6261). One implementation for every mute surface:
 * Meshtastic channels and DMs, MeshCore channels, DMs and rooms.
 *
 * `variant="button"` renders a bell toggle with a popover; `variant="items"`
 * renders just the menu items, for a dropdown that already exists.
 * Item order: unmute (when muted), indefinitely, 1 hour, 1 week, then the
 * "Still alert on @mentions" checkbox when `mentionOption` is set (#6490).
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { MUTE_DURATIONS } from './muteDurations';
import styles from './MuteMenu.module.css';


export interface MuteMenuProps {
  muted: boolean;
  /**
   * `null` mutes indefinitely; otherwise an epoch-ms expiry. With
   * `mentionOption`, the second argument is the "still alert on mentions" choice.
   */
  onMute: (muteUntil: number | null, allowMentions?: boolean) => void | Promise<void>;
  onUnmute: () => void | Promise<void>;
  /** 'button' = bell + popover; 'items' = menu items for an existing dropdown. */
  variant?: 'button' | 'items';
  /** Fired after any choice. */
  onDone?: () => void;
  /** Accessible name / title of the bell. Default `notifications.mute_channel`. */
  label?: string;
  iconSize?: number;
  /** Replaces the default bell button look (e.g. `btn btn-secondary`). */
  buttonClassName?: string;
  buttonStyle?: React.CSSProperties;
  /** Replaces the default item look (e.g. `actions-menu-item`). */
  itemClassName?: string;
  /** Open the popover toward the left edge instead of the right. */
  alignRight?: boolean;
  /**
   * #6490: show the "Still alert on @mentions" checkbox. Only for venues that
   * raise mention alerts (MeshCore channels and rooms).
   */
  mentionOption?: boolean;
  /** The active mute's `allowMentions`. */
  allowMentions?: boolean;
  /** Changes `allowMentions` on the active mute, keeping its expiry. */
  onAllowMentionsChange?: (allowMentions: boolean) => void | Promise<void>;
}

export const MuteMenu: React.FC<MuteMenuProps> = ({
  muted,
  onMute,
  onUnmute,
  variant = 'button',
  onDone,
  label,
  iconSize,
  buttonClassName,
  buttonStyle,
  itemClassName,
  alignRight,
  mentionOption = false,
  allowMentions = false,
  onAllowMentionsChange,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [exceptMentions, setExceptMentions] = useState(allowMentions);
  useEffect(() => setExceptMentions(allowMentions), [allowMentions]);
  const mute = (until: number | null) => (mentionOption ? onMute(until, exceptMentions) : onMute(until));

  const choose = (action: () => void | Promise<void>) => async () => {
    setOpen(false);
    await action();
    onDone?.();
  };

  const itemClass = itemClassName ?? styles.muteMenuItem;
  const items = (
    <>
      {muted && (
        <button type="button" role="menuitem" className={itemClass} onClick={choose(onUnmute)}>
          <UiIcon name="unmute" size={iconSize ?? 14} /> {t('notifications.unmute', 'Unmute')}
        </button>
      )}
      <button type="button" role="menuitem" className={itemClass} onClick={choose(() => mute(null))}>
        <UiIcon name="muted" size={iconSize ?? 14} /> {t('notifications.mute_indefinite', 'Mute indefinitely')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={choose(() => mute(Date.now() + MUTE_DURATIONS.hour))}
      >
        <UiIcon name="time" size={iconSize ?? 14} /> {t('notifications.mute_1h', 'Mute for 1 hour')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={choose(() => mute(Date.now() + MUTE_DURATIONS.week))}
      >
        <UiIcon name="calendar" size={iconSize ?? 14} /> {t('notifications.mute_1w', 'Mute for 1 week')}
      </button>
      {mentionOption && (
        <label className={itemClass}>
          <input
            type="checkbox"
            role="menuitemcheckbox"
            aria-checked={exceptMentions}
            checked={exceptMentions}
            onChange={(e) => {
              const next = e.target.checked;
              setExceptMentions(next);
              // Already muted: apply now. Otherwise the next duration uses it.
              if (muted) void onAllowMentionsChange?.(next);
            }}
          />
          {t('notifications.mute_allow_mentions', 'Still alert on @mentions')}
        </label>
      )}
    </>
  );

  if (variant === 'items') return items;

  const title = muted
    ? (mentionOption && allowMentions
      ? t('notifications.mute_except_mentions_active', 'Muted except @mentions — click to change')
      : t('notifications.mute_channel_active', 'Muted — click to change'))
    : (label ?? t('notifications.mute_channel', 'Mute notifications'));

  return (
    <div className={styles.muteWrap}>
      <button
        type="button"
        className={buttonClassName ?? `${styles.muteButton} ${muted ? styles.active : ''}`}
        style={buttonStyle}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        aria-label={title}
      >
        <UiIcon name={muted ? 'muted' : 'notifications'} size={iconSize ?? 15} />
      </button>
      {open && (
        <>
          <div className={styles.muteBackdrop} onClick={() => setOpen(false)} />
          <div className={`${styles.muteMenu} ${alignRight ? styles.alignRight : ''}`} role="menu">
            {items}
          </div>
        </>
      )}
    </div>
  );
};

/** Muted-conversation marker for list rows. */
export const MutedIndicator: React.FC<{ size?: number }> = ({ size = 13 }) => {
  const { t } = useTranslation();
  const text = t('notifications.muted', 'Notifications muted');
  return (
    <span className={styles.mutedIcon} title={text} aria-label={text}>
      <UiIcon name="muted" size={size} />
    </span>
  );
};
