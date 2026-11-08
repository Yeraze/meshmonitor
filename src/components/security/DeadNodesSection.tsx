import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { NumberInput } from '../common/NumberInput';
import api from '../../services/api';
import { getHardwareModelName } from '../../utils/hardwareModel';
import { logger } from '../../utils/logger';
import type { DeadNode } from './securityTypes';
import styles from './DeadNodesSection.module.css';

interface Props {
  nodes: DeadNode[];
  thresholdDays: number;
  sourceId: string;
  isMeshCore: boolean;
  /** The viewer lacks nodes:read on this source: the route answered 403. */
  forbidden?: boolean;
  /** security:write AND nodes:write on this source. */
  canDelete: boolean;
  /** settings:write: the threshold is a per-source setting. */
  canEditThreshold: boolean;
  /** Refetch after a delete or a threshold save. */
  onChanged: () => void | Promise<void>;
}

const MIN_DAYS = 1;
const MAX_DAYS = 365;

function formatLastHeard(t: (k: string, d: string, o?: Record<string, unknown>) => string, lastHeard: number | null): string {
  if (!lastHeard) return t('security.dead_nodes_never', 'Never');
  const days = Math.floor((Math.floor(Date.now() / 1000) - lastHeard) / 86400);
  if (days > 30) {
    return t('security.dead_nodes_months_ago', '{{count}} month(s) ago', { count: Math.floor(days / 30) });
  }
  return t('security.dead_nodes_days_ago', '{{count}} day(s) ago', { count: days });
}

/**
 * Dead nodes for both protocols. Rows and selection key on `nodeKey`
 * (`mt:<n>` / `mc:<pk>`). Never-heard rows are listed but never selected by
 * "Select all"; the viewer ticks them one by one.
 */
export const DeadNodesSection: React.FC<Props> = ({
  nodes, thresholdDays, sourceId, isMeshCore, forbidden = false, canDelete, canEditThreshold, onChanged,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [days, setDays] = useState(thresholdDays);
  const [daysValid, setDaysValid] = useState(true);
  const [savingDays, setSavingDays] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { setDays(thresholdDays); }, [thresholdDays]);

  // A poll replaces the list; keep ticks for rows that are still there.
  useEffect(() => {
    setSelected(prev => {
      const keys = new Set(nodes.map(n => n.nodeKey));
      const next = new Set([...prev].filter(k => keys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [nodes]);

  const heardKeys = nodes.filter(n => n.lastHeard).map(n => n.nodeKey);
  const allHeardSelected = heardKeys.length > 0 && heardKeys.every(k => selected.has(k));

  const toggle = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const toggleAll = () => setSelected(allHeardSelected ? new Set() : new Set(heardKeys));

  const saveDays = async () => {
    if (!daysValid) return;
    setSavingDays(true);
    setMessage(null);
    try {
      await api.post(`/api/settings?sourceId=${encodeURIComponent(sourceId)}`, { securityDeadNodeDays: String(days) });
      await onChanged();
    } catch (err) {
      logger.error('Error saving dead node threshold:', err);
      setMessage(t('security.mc_dead_nodes_threshold_failed', 'Could not save the threshold.'));
    } finally {
      setSavingDays(false);
    }
  };

  const bulkDelete = async () => {
    if (selected.size === 0) return;
    const warning = isMeshCore
      ? ` ${t('security.mc_dead_nodes_reappear', 'Contacts you delete can re-appear on their next advert.')}`
      : '';
    const confirmed = window.confirm(
      t('security.dead_nodes_confirm_delete', 'Are you sure you want to delete {{count}} node(s)? This cannot be undone.', { count: selected.size }) + warning,
    );
    if (!confirmed) return;
    setDeleting(true);
    setMessage(null);
    try {
      const res = await api.post<{ results?: Array<{ deleted: boolean; error?: string }> }>(
        '/api/security/dead-nodes/bulk-delete',
        { sourceId, nodeKeys: Array.from(selected) },
      );
      const protectedCount = (res?.results ?? []).filter(r => r.error === 'PROTECTED').length;
      if (protectedCount > 0) {
        setMessage(t('security.mc_dead_nodes_protected', '{{count}} node(s) were kept (local node or favourite).', { count: protectedCount }));
      }
      setSelected(new Set());
      await onChanged();
    } catch (err) {
      logger.error('Error bulk deleting dead nodes:', err);
      setMessage(t('security.mc_dead_nodes_delete_failed', 'Delete failed.'));
    } finally {
      setDeleting(false);
    }
  };

  const title = `${t('security.dead_nodes_title', 'Dead Nodes')} (${forbidden ? 0 : nodes.length})`;

  if (forbidden) {
    return (
      <section className={styles.section} data-testid="security-dead-nodes">
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.empty} data-testid="security-dead-nodes-forbidden">
          {t('security.mc_no_node_access', 'You do not have access to this source\'s nodes.')}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.section} data-testid="security-dead-nodes">
      <h3 className={styles.title}>{title}</h3>
      <div className={styles.threshold}>
        <label htmlFor="security-dead-days">{t('security.mc_dead_nodes_threshold', 'Dead after (days)')}</label>
        <NumberInput
          id="security-dead-days"
          integer
          min={MIN_DAYS}
          max={MAX_DAYS}
          className={styles.daysInput}
          value={days}
          disabled={!canEditThreshold}
          onChange={setDays}
          onValidityChange={setDaysValid}
        />
        {canEditThreshold && (
          <button
            type="button"
            className={styles.button}
            onClick={saveDays}
            disabled={savingDays || !daysValid || days === thresholdDays}
          >
            {t('common.save', 'Save')}
          </button>
        )}
      </div>
      {isMeshCore && (
        <p className={styles.warning} data-testid="security-dead-nodes-reappear">
          <UiIcon name="alert" size={14} />{' '}
          {t('security.mc_dead_nodes_reappear', 'Contacts you delete can re-appear on their next advert.')}
        </p>
      )}
      {message && <p className={styles.message} role="status">{message}</p>}
      {nodes.length === 0 ? (
        <p className={styles.empty}>
          {t('security.mc_dead_nodes_empty', 'No dead nodes found. All nodes were heard within the last {{days}} days.', { days: thresholdDays })}
        </p>
      ) : (
        <>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={toggleAll}>
              {allHeardSelected
                ? t('security.dead_nodes_deselect_all', 'Deselect All')
                : t('security.dead_nodes_select_all', 'Select All')}
            </button>
            {selected.size > 0 && canDelete && (
              <button type="button" className={styles.danger} onClick={bulkDelete} disabled={deleting}>
                {deleting
                  ? t('security.dead_nodes_deleting', 'Deleting...')
                  : t('security.dead_nodes_delete_button', 'Delete {{count}} node(s)', { count: selected.size })}
              </button>
            )}
          </div>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.checkCol}></th>
                  <th>{t('security.dead_nodes_name', 'Name')}</th>
                  <th>{t('security.dead_nodes_id', 'ID')}</th>
                  {!isMeshCore && <th>{t('security.dead_nodes_hardware', 'Hardware')}</th>}
                  <th>{t('security.dead_nodes_last_heard', 'Last Heard')}</th>
                  <th>{t('security.dead_nodes_location', 'Location')}</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map(node => (
                  <tr key={node.nodeKey} className={selected.has(node.nodeKey) ? styles.rowSelected : styles.row}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={node.longName || node.shortName || node.nodeId}
                        checked={selected.has(node.nodeKey)}
                        onChange={() => toggle(node.nodeKey)}
                      />
                    </td>
                    <td>
                      {node.longName || node.shortName || <span className={styles.subtle}>{t('security.mc_unknown_name', 'Unknown')}</span>}
                      {node.shortName && node.longName && node.shortName !== node.longName && (
                        <span className={styles.shortName}>({node.shortName})</span>
                      )}
                    </td>
                    <td className={styles.mono}>{isMeshCore ? node.nodeId.slice(0, 12) : node.nodeId}</td>
                    {!isMeshCore && <td>{node.hwModel != null ? getHardwareModelName(node.hwModel) : '-'}</td>}
                    <td>{formatLastHeard(t as never, node.lastHeard)}</td>
                    <td>
                      {node.inDeviceDb ? (
                        <span title={t('security.dead_nodes_in_both', 'In both local and device database')} className={styles.warn}>
                          <UiIcon name="radioSignal" /> {t('security.dead_nodes_local_and_device', 'Local + Device')}
                        </span>
                      ) : (
                        <span title={t('security.dead_nodes_local_only', 'Only in local database')} className={styles.subtle}>
                          <UiIcon name="database" /> {t('security.dead_nodes_local_only_short', 'Local Only')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
};
