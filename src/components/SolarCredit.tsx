import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './SolarCredit.module.css';

/**
 * Compact "Weather data by Open-Meteo.com" credit shown under a chart while
 * its sunlight overlay is drawn. Open-Meteo data is CC BY 4.0 (#6523).
 */
const SolarCredit: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();
  return (
    <div className={className ? `${styles.credit} ${className}` : styles.credit}>
      {t('solar.credit_prefix')}{' '}
      <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
        Open-Meteo.com
      </a>
    </div>
  );
};

export default SolarCredit;
