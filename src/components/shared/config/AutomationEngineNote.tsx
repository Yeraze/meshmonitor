/**
 * AutomationEngineNote — a soft pointer from a built-in automation section
 * (Auto Acknowledge, Auto Announce, Timer Triggers, Geofence Triggers) to the
 * Automation Engine, which can build the same thing.
 *
 * Hidden unless an enclosing AutomationEngineNoteContext says the viewer can
 * read the global `automations` resource (the same gate as the sidebar link).
 * Also hidden outside a Router, since the link navigates with react-router.
 */
import React, { useContext } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import styles from './AutomationEngineNote.module.css';
import { AutomationEngineNoteContext } from './automationEngineNoteContext';

const ENGINE_PATH = '/automations';

export const AutomationEngineNote: React.FC = () => {
  const { t } = useTranslation();
  const inRouterContext = useInRouterContext();
  const visible = useContext(AutomationEngineNoteContext);

  if (!visible || !inRouterContext) return null;

  return (
    <p className={styles.note}>
      <UiIcon name="bot" size={14} />
      <Link to={ENGINE_PATH} className={styles.link}>
        {t('automation.engine_note', 'You can also build this in the Automation Engine.')}
      </Link>
    </p>
  );
};

export default AutomationEngineNote;
