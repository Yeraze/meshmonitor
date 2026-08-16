/**
 * Public-key mismatch warning (#4738).
 *
 * Replaces a bare "This node is a security risk" — a warning alarming enough
 * to worry about, too vague to act on, and identical whether or not the user
 * had anything at stake.
 *
 * Structured as what changed / why it matters / what to do, with severity
 * driven by the user's own exposure (see `assessKeyMismatch`). Details sit
 * behind a disclosure so the banner stays scannable for the many users who
 * will see the low-severity case and correctly move on.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons/UiIcon';
import { assessKeyMismatch, type KeyMismatchContext } from '../../utils/keyMismatchGuidance';
import styles from './KeyMismatchWarning.module.css';

export interface KeyMismatchWarningProps extends KeyMismatchContext {
  /** Device-reported specifics, shown verbatim when present. */
  details?: string;
  /** Rendered inside the banner (e.g. the existing Clear button). */
  children?: React.ReactNode;
}

export default function KeyMismatchWarning({
  sentDirectMessageCount,
  hasAdministered,
  details,
  children,
}: KeyMismatchWarningProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const guidance = assessKeyMismatch({ sentDirectMessageCount, hasAdministered });
  const high = guidance.severity === 'high';

  return (
    <div
      className={`${styles.keyMismatch} ${high ? styles.keyMismatchHigh : styles.keyMismatchLow}`}
      data-testid="key-mismatch-warning"
      data-severity={guidance.severity}
      role={high ? 'alert' : 'status'}
    >
      <div className={styles.keyMismatchHead}>
        <span className={styles.keyMismatchTitle}>
          <UiIcon name={high ? 'alert' : 'info'} />{' '}
          {t(guidance.headlineKey)}
          {/* The severity is stated, not just colour-coded — colour alone is
              not available to every user and carries no meaning on its own. */}
          <span className={styles.keyMismatchBadge}>
            {high ? t('key_mismatch.severity_high') : t('key_mismatch.severity_low')}
          </span>
        </span>
        {children}
      </div>

      <p className={styles.keyMismatchRisk}>{t(guidance.riskKey)}</p>

      <button
        type="button"
        className={styles.keyMismatchToggle}
        aria-expanded={open}
        data-testid="key-mismatch-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t('key_mismatch.hide_actions') : t('key_mismatch.show_actions')}
      </button>

      {open && (
        <ul className={styles.keyMismatchActions} data-testid="key-mismatch-actions">
          {guidance.actionKeys.map((k) => <li key={k}>{t(k)}</li>)}
        </ul>
      )}

      {/* Device-reported specifics last: useful for a support thread, noise
          for the decision the user is actually making. */}
      {open && details && (
        <p className={styles.keyMismatchDetails} data-testid="key-mismatch-details">{details}</p>
      )}
    </div>
  );
}
