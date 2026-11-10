/**
 * Inline root-topic validation message (#6287, design#167 R8). The server
 * refuses a changed root that breaks these rules (#6338, code
 * INVALID_MQTT_ROOT), and the device and preset forms block Save on one; an
 * unchanged bad root still saves, so here it reads as advice.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { validateMqttRoot } from '../../utils/mqttRootTopic';
import styles from './MqttRootFinder.module.css';

interface MqttRootFieldErrorProps {
  value: string;
  /** Bridge subscription lines are filters, so they only warn. */
  warn?: boolean;
}

export const MqttRootFieldError: React.FC<MqttRootFieldErrorProps> = ({ value, warn = false }) => {
  const { t } = useTranslation();
  const result = validateMqttRoot(value);
  if (result.ok) return null;
  return (
    <p className={warn ? styles.warning : styles.fieldError} role={warn ? 'status' : 'alert'}>
      {t(`mqtt_root_finder.validation.${result.code}`)}
    </p>
  );
};
