import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { UiIcon } from '../icons';

/**
 * MeshCore Time Sync overview (#6224). MeshCore configures time-sync per node
 * (timeSyncEnabled / interval on each meshcore_node, #4916), unlike the
 * Meshtastic single source-level toggle. This section is a central management
 * surface: it lists every node with time-sync enabled and lets you adjust the
 * interval or turn it off from one place. Enable a node from its detail panel
 * (admin credentials are needed to actually push the clock). Read + per-node
 * config edits only — this section never triggers a sync itself.
 */
interface Props {
  baseUrl: string;
  sourceId: string;
}

interface TimeSyncNode {
  publicKey: string;
  name: string | null;
  intervalMinutes: number | null;
  lastSyncAt: number | null;
}

const MIN_INTERVAL = 60;
const MAX_INTERVAL = 7 * 24 * 60;

export const MeshCoreTimeSyncSection: React.FC<Props> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [nodes, setNodes] = useState<TimeSyncNode[]>([]);
  const [edited, setEdited] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const listUrl = `${baseUrl}/api/sources/${sourceId}/meshcore/automation/time-sync`;

  const fetchNodes = useCallback(async () => {
    try {
      const res = await csrfFetch(listUrl);
      if (!res.ok) return;
      const json = await res.json();
      const rows = json?.data?.nodes;
      if (Array.isArray(rows)) {
        setNodes(rows);
        setEdited({});
      }
    } catch {
      // ignore; keep current list
    }
  }, [csrfFetch, listUrl]);

  useEffect(() => { void fetchNodes(); }, [fetchNodes]);

  const nodeUrl = (publicKey: string) =>
    `${baseUrl}/api/sources/${sourceId}/meshcore/nodes/${publicKey}/time-sync-config`;

  const saveInterval = async (publicKey: string) => {
    const intervalMinutes = edited[publicKey];
    if (intervalMinutes == null) return;
    setBusy(publicKey);
    try {
      const res = await csrfFetch(nodeUrl(publicKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMinutes }),
      });
      if (!res.ok) {
        showToast(t('meshcore.automation.time_sync.save_failed', 'Failed to update time sync'), 'error');
        return;
      }
      showToast(t('meshcore.automation.time_sync.saved', 'Time sync updated'), 'success');
      await fetchNodes();
    } catch {
      showToast(t('meshcore.automation.time_sync.save_failed', 'Failed to update time sync'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const disableNode = async (publicKey: string) => {
    setBusy(publicKey);
    try {
      const res = await csrfFetch(nodeUrl(publicKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      if (!res.ok) {
        showToast(t('meshcore.automation.time_sync.save_failed', 'Failed to update time sync'), 'error');
        return;
      }
      showToast(t('meshcore.automation.time_sync.disabled', 'Time sync disabled for node'), 'success');
      await fetchNodes();
    } catch {
      showToast(t('meshcore.automation.time_sync.save_failed', 'Failed to update time sync'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const numberScope = useNumberInputScope();

  return (
    <NumberInputScope scope={numberScope}>
      <section>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <UiIcon name="time" size={18} />
          {t('meshcore.automation.time_sync.title', 'Time Sync')}
        </h2>
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t(
            'meshcore.automation.time_sync.description',
            'Repeaters with time sync enabled get a periodic clock push. Adjust the interval or turn it off here; enable a node from its detail panel. A sync needs a saved admin password for that node.',
          )}
        </p>

        {nodes.length === 0 ? (
          <p className="setting-description">
            {t('meshcore.automation.time_sync.empty', 'No nodes have time sync enabled on this source.')}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('meshcore.automation.time_sync.node', 'Node')}</th>
                <th>{t('meshcore.automation.time_sync.interval', 'Interval (minutes)')}</th>
                <th>{t('meshcore.automation.time_sync.last_sync', 'Last sync')}</th>
                <th>{t('common.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => {
                const current = edited[n.publicKey] ?? n.intervalMinutes ?? MIN_INTERVAL;
                const dirty = edited[n.publicKey] != null && edited[n.publicKey] !== (n.intervalMinutes ?? MIN_INTERVAL);
                return (
                  <tr key={n.publicKey}>
                    <td>{n.name || `${n.publicKey.substring(0, 12)}…`}</td>
                    <td>
                      <NumberInput
                        min={MIN_INTERVAL}
                        max={MAX_INTERVAL}
                        integer
                        value={current}
                        onChange={(v) => setEdited((prev) => ({ ...prev, [n.publicKey]: v }))}
                        disabled={!canWrite || busy === n.publicKey}
                        className="setting-input"
                      />
                    </td>
                    <td>{n.lastSyncAt ? new Date(n.lastSyncAt).toLocaleString() : t('common.never', 'Never')}</td>
                    <td style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={!canWrite || !dirty || busy === n.publicKey}
                        onClick={() => { void saveInterval(n.publicKey); }}
                      >
                        {t('common.save', 'Save')}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={!canWrite || busy === n.publicKey}
                        onClick={() => { void disableNode(n.publicKey); }}
                      >
                        {t('common.disable', 'Disable')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </NumberInputScope>
  );
};
