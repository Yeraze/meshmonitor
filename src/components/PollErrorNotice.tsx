/**
 * Tells the user the server poll is failing when a list it feeds (Nodes,
 * Channels) is empty because of it (#6342). Before this, a failed poll looked
 * the same as an empty mesh. The poll keeps retrying on its own; this only
 * says so.
 */
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import styles from './PollErrorNotice.module.css';

interface PollErrorNoticeProps {
  /** The poll query's error, if its last read failed. */
  error: unknown;
  /** True when the list this notice belongs to has nothing to show. */
  empty: boolean;
}

export default function PollErrorNotice({ error, empty }: PollErrorNoticeProps) {
  const { t } = useTranslation();
  if (!error || !empty) return null;
  return (
    <div className={styles.notice} role="status" aria-live="polite">
      <UiIcon name="alert" size={16} className={styles.icon} />
      <span>{t('poll.load_error')}</span>
    </div>
  );
}
