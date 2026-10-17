/**
 * Name History section in Node Details (#5862), shared by the Meshtastic and
 * MeshCore detail panels.
 *
 * Lists a node's renames, newest first, merged across every source the viewer
 * may see the node on. Renders nothing until the node has been renamed at
 * least once, so most panels are unchanged.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { type NodeNameHistoryEntry } from '../services/api';
import { formatDateTime } from '../utils/datetime';
import type { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { UiIcon } from './icons';
import styles from './NodeNameHistory.module.css';

/** Entries shown before "Show all". */
const COLLAPSED_COUNT = 5;

interface NodeNameHistoryProps {
  /** `!aabbccdd`, a decimal nodeNum, or a MeshCore public key. */
  nodeId: string | null | undefined;
  /** The node's current name(s); a change refetches, so a live rename shows up. */
  currentName?: string | null;
  timeFormat?: TimeFormat;
  dateFormat?: DateFormat;
}

function formatName(longName: string | null, shortName: string | null): string {
  if (longName && shortName) return `${longName} (${shortName})`;
  return longName ?? shortName ?? '';
}

export function NodeNameHistory({ nodeId, currentName, timeFormat, dateFormat }: NodeNameHistoryProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<NodeNameHistoryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!nodeId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    apiService.getNodeNameHistory(nodeId)
      .then(result => { if (!cancelled) setEntries(result); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [nodeId, currentName]);

  useEffect(() => { setExpanded(false); }, [nodeId]);

  if (entries.length === 0) return null;

  const shown = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);

  return (
    <div className={styles.section} data-testid="node-name-history">
      <h4 className={styles.title}>{t('node_details.name_history', 'Name History')}</h4>
      <ol className={styles.list}>
        {shown.map(entry => (
          <li key={`${entry.changedAt}-${entry.newLongName}-${entry.newShortName}`} className={styles.entry}>
            <time className={styles.when} dateTime={new Date(entry.changedAt).toISOString()}>
              {formatDateTime(new Date(entry.changedAt), timeFormat, dateFormat)}
            </time>
            <span className={styles.change}>
              <span className={styles.oldName}>{formatName(entry.oldLongName, entry.oldShortName)}</span>
              <UiIcon name="forward" size={12} className={styles.arrow} />
              <span className={styles.newName}>{formatName(entry.newLongName, entry.newShortName)}</span>
            </span>
            {entry.sourceIds.length > 1 && (
              <span className={styles.sources}>
                {t('node_details.name_history_sources', { count: entry.sourceIds.length, defaultValue: 'Seen on {{count}} sources' })}
              </span>
            )}
          </li>
        ))}
      </ol>
      {entries.length > COLLAPSED_COUNT && (
        <button type="button" className={styles.toggle} onClick={() => setExpanded(v => !v)}>
          {expanded
            ? t('node_details.name_history_show_less', 'Show fewer')
            : t('node_details.name_history_show_all', { count: entries.length, defaultValue: 'Show all {{count}}' })}
        </button>
      )}
    </div>
  );
}

export default NodeNameHistory;
