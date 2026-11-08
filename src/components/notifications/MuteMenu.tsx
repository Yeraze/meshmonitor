/**
 * Shared mute menu (#6261). One implementation for every mute surface:
 * Meshtastic channels and DMs, MeshCore channels, DMs and rooms.
 *
 * `variant="button"` renders a bell toggle with a popover; `variant="items"`
 * renders just the menu items, for a dropdown that already exists.
 * Item order: unmute (when muted), indefinitely, 1 hour, 1 week.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { MUTE_DURATIONS } from './muteDurations';
import styles from './MuteMenu.module.css';


export interface MuteMenuProps {
  muted: boolean;
  /** `null` mutes indefinitely; otherwise an epoch-ms expiry. */
  onMute: (muteUntil: number | null) => void | Promise<void>;
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
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

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
      <button type="button" role="menuitem" className={itemClass} onClick={choose(() => onMute(null))}>
        <UiIcon name="muted" size={iconSize ?? 14} /> {t('notifications.mute_indefinite', 'Mute indefinitely')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={choose(() => onMute(Date.now() + MUTE_DURATIONS.hour))}
      >
        <UiIcon name="time" size={iconSize ?? 14} /> {t('notifications.mute_1h', 'Mute for 1 hour')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={choose(() => onMute(Date.now() + MUTE_DURATIONS.week))}
      >
        <UiIcon name="calendar" size={iconSize ?? 14} /> {t('notifications.mute_1w', 'Mute for 1 week')}
      </button>
    </>
  );

  if (variant === 'items') return items;

  const title = muted
    ? t('notifications.mute_channel_active', 'Muted — click to change')
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
