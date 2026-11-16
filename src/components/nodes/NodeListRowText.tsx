import React from 'react';
import { useTranslation } from 'react-i18next';
import { getUserDisplayName } from '../../utils/nodeHelpers';
import { formatTime, formatDateTime } from '../../utils/datetime';
import type { TimeFormat, DateFormat } from '../../contexts/SettingsContext';
import importContactStyles from './ImportContactUrlModal.module.css';

interface NodeListNameProps {
  node: {
    nodeNum: number;
    user?: { longName?: string | null; shortName?: string | null; id?: string | null } | null;
    importedAt?: number | null;
    lastHeard?: number | null;
  };
}

/** The name line of a node-list row, with the "Imported" badge (#5317). */
export const NodeListName: React.FC<NodeListNameProps> = ({ node }) => {
  const { t } = useTranslation();
  return (
    <div className="node-longname">
      {getUserDisplayName(node.user, node.nodeNum)}
      {/* #5317: imported from a contact link and not yet heard.
          Drops away on its own once real traffic arrives, since
          that sets lastHeard. */}
      {node.importedAt && !node.lastHeard && (
        <span
          className={importContactStyles.importedBadge}
          title={t('nodes.imported_badge_title', 'Added from a contact link; not heard on the mesh yet')}
        >
          {t('nodes.imported_badge', 'Imported')}
        </span>
      )}
    </div>
  );
};

const isToday = (date: Date): boolean => {
  const today = new Date();
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
};

interface NodeListTimeProps {
  lastHeard?: number | null;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
}

/** The last-heard time of a node-list row. */
export const NodeListTime: React.FC<NodeListTimeProps> = ({ lastHeard, timeFormat, dateFormat }) => {
  const { t } = useTranslation();
  return (
    <div className="node-time">
      {lastHeard ? (() => {
        const date = new Date(lastHeard * 1000);
        return isToday(date)
          ? formatTime(date, timeFormat)
          : formatDateTime(date, timeFormat, dateFormat);
      })() : t('time.never')}
    </div>
  );
};
