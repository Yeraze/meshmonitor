/**
 * Read-only "AEAD" badge for a channel whose ChannelSettings.use_aead is set
 * (#5248 Phase 1). The flag is stored and sent back on every edit, but not
 * editable yet; Phase 2 adds the checkbox.
 */
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './AeadBadge.module.css';

export interface AeadBadgeProps {
  /** Renders nothing unless true. */
  useAead?: boolean | null;
}

export default function AeadBadge({ useAead }: AeadBadgeProps) {
  const { t } = useTranslation();
  if (!useAead) return null;
  const tooltip = t('channels.aead_tooltip');
  return (
    <span className={styles.badge} title={tooltip} aria-label={tooltip} role="img" data-testid="aead-badge">
      <UiIcon name="securityCheck" size={12} />
      {t('channels.aead_badge')}
    </span>
  );
}
