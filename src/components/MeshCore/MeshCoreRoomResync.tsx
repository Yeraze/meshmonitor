/**
 * "Clear stored posts & re-sync" for one room server (#6579).
 *
 * Deletes the posts MeshMonitor holds for the room on this source and resets
 * the Companion's sync point for it, so the next login pulls every post the
 * room server still has (32 on a stock room server). Companion sources only:
 * a repeater-ingest source keeps no room contact, so the action is shown
 * disabled with the reason. The server allows one clear per room per 30
 * minutes; the time left is shown here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../shared/automation/ConfirmDialog';
import { UiIcon } from '../icons';
import type { ClearRoomPostsResult } from './hooks/useMeshCore';
import styles from './MeshCoreRoomResync.module.css';

/** Fallback when the server did not say (matches ROOM_CLEAR_COOLDOWN_MS). */
const DEFAULT_COOLDOWN_MS = 30 * 60_000;

export interface MeshCoreRoomResyncProps {
  roomName: string;
  /** Only a Companion keeps a room contact (and its sync point). */
  isCompanion: boolean;
  connected: boolean;
  /** Last clear of this room (epoch ms), from the sync config. */
  lastClearAt: number | null;
  cooldownMs?: number;
  onClear: () => Promise<ClearRoomPostsResult>;
  /** Called after a successful clear, with the time the next one is allowed. */
  onCleared: (result: Extract<ClearRoomPostsResult, { success: true }>) => void;
  /** Test seam. */
  now?: () => number;
}

export const MeshCoreRoomResync: React.FC<MeshCoreRoomResyncProps> = ({
  roomName,
  isCompanion,
  connected,
  lastClearAt,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  onClear,
  onCleared,
  now = Date.now,
}) => {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the next clear is allowed: from the stored timestamp, or from a 429.
  const [availableAt, setAvailableAt] = useState<number>(() => (lastClearAt ? lastClearAt + cooldownMs : 0));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setAvailableAt(lastClearAt ? lastClearAt + cooldownMs : 0);
  }, [lastClearAt, cooldownMs]);

  const remainingMs = Math.max(0, availableAt - now());
  void tick;
  useEffect(() => {
    if (remainingMs <= 0) return;
    const id = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(id);
  }, [remainingMs]);

  const handleConfirm = useCallback(async () => {
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await onClear();
      if (result.success) {
        setAvailableAt(result.nextAllowedAt);
        setNotice(result.resyncQueued
          ? t('meshcore.rooms.resync.done_auto', 'Cleared {{count}} stored posts. Auto-sync will log in to pull them again.', { count: result.deleted })
          : t('meshcore.rooms.resync.done_manual', 'Cleared {{count}} stored posts. Log in to pull them again.', { count: result.deleted }));
        onCleared(result);
      } else if (typeof result.retryAfterSeconds === 'number') {
        setAvailableAt(now() + result.retryAfterSeconds * 1000);
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  }, [onClear, onCleared, now, t]);

  if (!isCompanion) {
    return (
      <div className={styles.row}>
        <button type="button" className={styles.button} disabled>
          <UiIcon name="refresh" size={14} /> {t('meshcore.rooms.resync.button', 'Clear stored posts & re-sync')}
        </button>
        <span className={styles.hint}>
          {t('meshcore.rooms.resync.companion_only', 'Only a Companion radio keeps a room contact, so this source cannot re-sync a room.')}
        </span>
      </div>
    );
  }

  const minutes = Math.ceil(remainingMs / 60_000);
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.button}
        disabled={busy || !connected || remainingMs > 0}
        onClick={() => setConfirmOpen(true)}
      >
        <UiIcon name="refresh" size={14} />{' '}
        {busy
          ? t('meshcore.rooms.resync.busy', 'Clearing…')
          : t('meshcore.rooms.resync.button', 'Clear stored posts & re-sync')}
      </button>
      {remainingMs > 0 && (
        <span className={styles.hint} role="status">
          {t('meshcore.rooms.resync.cooldown', 'Available again in {{count}} min', { count: minutes })}
        </span>
      )}
      {notice && <span className={styles.hint}>{notice}</span>}
      {error && <span className={styles.error} role="alert">{error}</span>}
      {confirmOpen && (
        <ConfirmDialog
          title={t('meshcore.rooms.resync.confirm_title', 'Clear stored posts for {{name}}?', { name: roomName })}
          message={t(
            'meshcore.rooms.resync.confirm_body',
            'MeshMonitor deletes the posts it stored for this room on this source and resets the radio’s sync point. The next login pulls only what the room server still holds: 32 posts on a stock room server. Older posts are gone for good. Your own posts stay, and the pulled posts raise no notifications. You can do this once every 30 minutes.',
          )}
          confirmLabel={t('meshcore.rooms.resync.confirm', 'Clear and re-sync')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onConfirm={() => { void handleConfirm(); }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
};

export default MeshCoreRoomResync;
