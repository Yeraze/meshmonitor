/**
 * Shared "mark all read" button (#6261). Asks for confirmation once the unread
 * count reaches `confirmThreshold`, so a stray click cannot clear a large backlog.
 */
import React from 'react';
import styles from './MarkAllReadButton.module.css';

export interface MarkAllReadButtonProps {
  onMarkAll: () => void | Promise<void>;
  label: string;
  title?: string;
  unreadCount?: number;
  /** Confirm when `unreadCount` is at least this many. Default 50. */
  confirmThreshold?: number;
  /** Already-translated confirm text; may use {count}. */
  confirmMessage?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export const MarkAllReadButton: React.FC<MarkAllReadButtonProps> = ({
  onMarkAll,
  label,
  title,
  unreadCount,
  confirmThreshold = 50,
  confirmMessage,
  disabled,
  className,
  style,
}) => {
  const handleClick = () => {
    if (unreadCount !== undefined && unreadCount >= confirmThreshold) {
      const text = (confirmMessage ?? 'Mark {count} items as read?').replace('{count}', String(unreadCount));
      if (!window.confirm(text)) return;
    }
    void onMarkAll();
  };
  return (
    <button type="button" className={className ?? styles.markAllRead} style={style} title={title} disabled={disabled} onClick={handleClick}>
      {label}
    </button>
  );
};
