import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './MeshCoreIgnoredRunRow.module.css';

interface MeshCoreIgnoredRunRowProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * One collapsed row standing in for a run of ignored messages (#5408).
 * Clicking it shows the messages; when shown, it offers to hide them again.
 */
export const MeshCoreIgnoredRunRow: React.FC<MeshCoreIgnoredRunRowProps> = ({ count, expanded, onToggle }) => {
  const { t } = useTranslation();
  return (
    <div className={styles.row} data-testid="mc-ignored-run">
      <button type="button" className={styles.toggle} onClick={onToggle} aria-expanded={expanded}>
        <UiIcon name={expanded ? 'visibilityOff' : 'visibility'} size={14} />
        {expanded
          ? t('meshcore.ignore.hide_ignored', { count, defaultValue: 'Hide {{count}} ignored messages' })
          : t('meshcore.ignore.ignored_messages', { count, defaultValue: '{{count}} ignored messages' })}
      </button>
    </div>
  );
};
