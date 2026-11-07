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
 * MeshCore Remote Telemetry overview (#6224). Per-node like time-sync: the
 * MeshCoreRemoteTelemetryScheduler polls each opt-in node on its own cadence.
 * This central Automation-tab section lists every node with remote telemetry
 * enabled and lets you adjust the interval or turn it off from one place, via
 * the existing per-node /nodes/:publicKey/telemetry-config route plus a new
 * read-only /automation/remote-telemetry list route. It never starts a poll.
 */
interface Props {
  baseUrl: string;
  sourceId: string;
}

interface TelemetryNode {
  publicKey: string;
  name: string | null;
  intervalMinutes: number | null;
  lastRequestAt: number | null;
  lastSuccessAt: number | null;
}

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 7 * 24 * 60;

export const MeshCoreRemoteTelemetrySection: React.FC<Props> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [nodes, setNodes] = useState<TelemetryNode[]>([]);
  const [edited, setEdited] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const listUrl = `${baseUrl}/api/sources/${sourceId}/meshcore/automation/remote-telemetry`;

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
    `${baseUrl}/api/sources/${sourceId}/meshcore/nodes/${publicKey}/telemetry-config`;

  const post = async (publicKey: string, body: { enabled?: boolean; intervalMinutes?: number }, okMsg: string) => {
    setBusy(publicKey);
    try {
      const res = await csrfFetch(nodeUrl(publicKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        showToast(t('meshcore.automation.remote_telemetry.save_failed', 'Failed to update telemetry'), 'error');
        return;
      }
      showToast(okMsg, 'success');
      await fetchNodes();
    } catch {
      showToast(t('meshcore.automation.remote_telemetry.save_failed', 'Failed to update telemetry'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const numberScope = useNumberInputScope();

  return (
    <NumberInputScope scope={numberScope}>
      <section>
        <h2 className="automation-section-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <UiIcon name="activity" size={18} />
          {t('meshcore.automation.remote_telemetry.title', 'Remote Telemetry')}
        </h2>
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t(
            'meshcore.automation.remote_telemetry.description',
            'Nodes with remote telemetry enabled are polled periodically for battery, signal and environment data. Adjust the interval or turn it off here; enable a node from its detail panel.',
          )}
        </p>

        {nodes.length === 0 ? (
          <p className="setting-description">
            {t('meshcore.automation.remote_telemetry.empty', 'No nodes have remote telemetry enabled on this source.')}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('meshcore.automation.remote_telemetry.node', 'Node')}</th>
                <th>{t('meshcore.automation.remote_telemetry.interval', 'Interval (minutes)')}</th>
                <th>{t('meshcore.automation.remote_telemetry.last_success', 'Last data')}</th>
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
                    <td>{n.lastSuccessAt ? new Date(n.lastSuccessAt).toLocaleString() : t('common.never', 'Never')}</td>
                    <td style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={!canWrite || !dirty || busy === n.publicKey}
                        onClick={() => { void post(n.publicKey, { intervalMinutes: edited[n.publicKey] }, t('meshcore.automation.remote_telemetry.saved', 'Telemetry interval updated')); }}
                      >
                        {t('common.save', 'Save')}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={!canWrite || busy === n.publicKey}
                        onClick={() => { void post(n.publicKey, { enabled: false }, t('meshcore.automation.remote_telemetry.disabled', 'Remote telemetry disabled for node')); }}
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
