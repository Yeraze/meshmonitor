/**
 * MeshCoreLoginProgress (#5400)
 *
 * Live status line for a MeshCore remote login: which attempt is running,
 * how long is left in the current wait (with a bar that drains), and a
 * Cancel button that stays enabled while everything else is locked.
 * Shared by the remote-admin console and the room-server login.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { MeshCoreLoginProgressState } from './hooks/useMeshCoreLoginProgress';
import styles from './MeshCoreLoginProgress.module.css';

interface MeshCoreLoginProgressProps {
  progress: MeshCoreLoginProgressState;
  onCancel: () => void;
}

/** Re-render often enough for the countdown to move smoothly. */
const TICK_MS = 250;

export const MeshCoreLoginProgress: React.FC<MeshCoreLoginProgressProps> = ({ progress, onCancel }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const remainingMs = progress.waitEndsAt !== null ? Math.max(0, progress.waitEndsAt - now) : null;
  const seconds = remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;
  const fraction = remainingMs !== null && progress.waitMs ? remainingMs / progress.waitMs : null;
  const { attempt, maxAttempts } = progress;

  let message: string;
  if (progress.cancelling) {
    message = t('meshcore.loginProgress.cancelling', 'Cancelling…');
  } else if (progress.phase === 'waiting') {
    message = seconds !== null
      ? t('meshcore.loginProgress.waiting', 'Attempt {{attempt}} of {{max}}: waiting for a reply ({{seconds}} s left)', { attempt, max: maxAttempts, seconds })
      : t('meshcore.loginProgress.waiting_no_time', 'Attempt {{attempt}} of {{max}}: waiting for a reply…', { attempt, max: maxAttempts });
  } else if (progress.phase === 'retrying') {
    message = t('meshcore.loginProgress.retrying', 'No reply to attempt {{attempt}}. Trying again in {{seconds}} s ({{next}} of {{max}})…', {
      attempt,
      next: Math.min(attempt + 1, maxAttempts),
      max: maxAttempts,
      seconds: seconds ?? 0,
    });
  } else if (maxAttempts <= 0) {
    message = t('meshcore.loginProgress.starting', 'Sending login…');
  } else {
    message = t('meshcore.loginProgress.sending', 'Attempt {{attempt}} of {{max}}: sending login…', { attempt, max: maxAttempts });
  }

  return (
    <div className={styles.container} role="status" aria-live="polite" data-testid="meshcore-login-progress">
      <div className={styles.row}>
        <UiIcon name={progress.phase === 'retrying' ? 'refresh' : 'timer'} size={16} className={styles.icon} />
        <span className={styles.message}>{message}</span>
        <button
          type="button"
          className={styles.cancel}
          onClick={onCancel}
          disabled={progress.cancelling}
        >
          {t('meshcore.loginProgress.cancel', 'Cancel')}
        </button>
      </div>
      {fraction !== null && !progress.cancelling && (
        <div className={styles.track} aria-hidden="true">
          <div className={styles.bar} style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      )}
    </div>
  );
};
