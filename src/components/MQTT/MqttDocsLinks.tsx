/**
 * Links from an MQTT settings surface to the website docs (#5013): the setup
 * guide for the common broker and bridge layouts, and the full reference.
 * An optional third link points at the section about the setting on screen.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MQTT_BROKER_DOCS_URL, MQTT_SETUP_GUIDE_URL } from '../../utils/mqttProxyLink';
import styles from './MqttDocsLinks.module.css';

interface MqttDocsLinksProps {
  /** Extra link to the section about this setting. */
  section?: { href: string; label: string };
}

export const MqttDocsLinks: React.FC<MqttDocsLinksProps> = ({ section }) => {
  const { t } = useTranslation();
  return (
    <p className={styles.links}>
      <a href={MQTT_SETUP_GUIDE_URL} target="_blank" rel="noopener noreferrer">
        {t('mqtt_docs.setup_guide', 'MQTT setup guide')}
      </a>
      <span aria-hidden="true">·</span>
      <a href={MQTT_BROKER_DOCS_URL} target="_blank" rel="noopener noreferrer">
        {t('mqtt_docs.reference', 'Broker & bridge reference')}
      </a>
      {section && (
        <>
          <span aria-hidden="true">·</span>
          <a href={section.href} target="_blank" rel="noopener noreferrer">
            {section.label}
          </a>
        </>
      )}
    </p>
  );
};
