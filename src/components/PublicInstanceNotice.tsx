import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import { usePublicInstanceView } from '../hooks/usePublicInstanceView';
import styles from './PublicInstanceNotice.module.css';

/** One-line note for signed-out viewers of a public instance (#5156). */
export const PublicInstanceNotice: React.FC = () => {
  const { t } = useTranslation();
  const view = usePublicInstanceView();
  if (!view.active) return null;
  return (
    <div className={styles.notice} data-testid="public-instance-notice" role="note">
      <span className={styles.icon}><UiIcon name="info" size={16} /></span>
      <span>{t('public_instance.notice')}</span>
    </div>
  );
};

export default PublicInstanceNotice;
