import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './HiddenMessageText.module.css';

/** Stands in for message text the server hid from a signed-out viewer (#5156). */
export const HiddenMessageText: React.FC = () => {
  const { t } = useTranslation();
  return (
    <span className={styles.hidden} data-testid="public-hidden-text">
      {t('public_instance.hidden_message')}
    </span>
  );
};

export default HiddenMessageText;
