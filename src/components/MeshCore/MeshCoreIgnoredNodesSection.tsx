import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { UiIcon } from '../icons';
import { formatRelativeTime } from '../../utils/datetime';
import { useMeshCoreIgnoredNodes, useRemoveMeshCoreIgnoredNode } from '../../hooks/useMeshCoreFilters';
import styles from './MeshCoreFilters.module.css';

interface MeshCoreIgnoredNodesSectionProps {
  sourceId: string;
}

/**
 * MeshCore Settings: the per-source list of ignored and blocked nodes (#5408).
 * Nodes are added from Node Details; this list shows them (even after the
 * node row is pruned) and takes them off.
 */
export const MeshCoreIgnoredNodesSection: React.FC<MeshCoreIgnoredNodesSectionProps> = ({ sourceId }) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('nodes', 'read');
  const canWrite = hasPermission('nodes', 'write');
  const { data: entries, isLoading, error } = useMeshCoreIgnoredNodes(sourceId, { enabled: canRead });
  const remove = useRemoveMeshCoreIgnoredNode(sourceId);

  if (!canRead) return null;

  return (
    <div className="form-section">
      <h3>{t('meshcore.ignore.nodes_title', 'Ignored and blocked nodes')}</h3>
      <p className={styles.note}>
        {t(
          'meshcore.ignore.nodes_desc',
          'Ignored nodes are hidden and their messages are stored but collapsed, with no notifications, automations or auto-replies. Blocked nodes are hidden and their messages are dropped on receipt. Add a node from its Node Details.',
        )}
      </p>
      <p className={styles.note}>
        {t(
          'meshcore.ignore.spoof_note',
          'Channel messages carry only a sender name, so they are matched by the node’s advert name. Anyone can use that name, and two nodes can share one.',
        )}
      </p>
      {error ? <div className={styles.error} role="alert">{(error as Error).message}</div> : null}
      {isLoading ? (
        <div className={styles.empty}>{t('common.loading', 'Loading…')}</div>
      ) : !entries || entries.length === 0 ? (
        <div className={styles.empty}>{t('meshcore.ignore.nodes_empty', 'No ignored or blocked nodes.')}</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('meshcore.ignore.col_name', 'Name')}</th>
                <th>{t('meshcore.ignore.col_key', 'Key')}</th>
                <th>{t('meshcore.ignore.col_mode', 'Mode')}</th>
                <th>{t('meshcore.ignore.col_hits', 'Hits')}</th>
                <th>{t('meshcore.ignore.col_last_hit', 'Last hit')}</th>
                {canWrite && <th aria-label={t('meshcore.ignore.col_actions', 'Actions')} />}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.publicKey}>
                  <td>{e.name || t('meshcore.ignore.unknown_name', 'Unknown')}</td>
                  <td className={styles.mono} title={e.publicKey}>{e.publicKey.slice(0, 12)}…</td>
                  <td>
                    <span className={`${styles.badge} ${e.mode === 'block' ? styles.badgeBlock : ''}`}>
                      {e.mode === 'block' ? t('meshcore.ignore.mode_block', 'Block') : t('meshcore.ignore.mode_ignore', 'Ignore')}
                    </span>
                  </td>
                  <td>{e.hitCount}</td>
                  <td>{e.lastHitAt ? formatRelativeTime(e.lastHitAt) : t('meshcore.ignore.never', 'Never')}</td>
                  {canWrite && (
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(e.publicKey)}
                        aria-label={t('meshcore.ignore.remove_entry', 'Remove {{name}}', { name: e.name || e.publicKey.slice(0, 12) })}
                      >
                        <UiIcon name="delete" size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {remove.error ? <div className={styles.error} role="alert">{(remove.error as Error).message}</div> : null}
    </div>
  );
};
