/**
 * Per-node telemetry-retrieval config panel for the MeshCore per-node
 * detail view.
 *
 * Mounts inside the DM/contact detail pane of `MeshCoreDirectMessagesView`
 * when a peer with a real 64-hex pubkey is selected. Fetches the current
 * `(enabled, intervalMinutes)` for the (sourceId, publicKey) pair from
 * `/api/sources/:id/meshcore/nodes/:publicKey/telemetry-config` and
 * PATCHes back to the same endpoint on save. Gated by `configuration:write`
 * per the PR #3019 pattern — read-only users see the current values but
 * the controls are disabled and an explanation banner is shown.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';

interface MeshCoreNodeTelemetryConfigProps {
  /** Frontend basename (e.g. '' or '/meshmonitor'). */
  baseUrl: string;
  /** Owning source id (UUID). */
  sourceId: string;
  /** 64-char hex pubkey of the remote MeshCore node. */
  publicKey: string;
}

interface TelemetryConfigState {
  enabled: boolean;
  intervalMinutes: number;
  lastRequestAt: number | null;
}

const DEFAULT_CFG: TelemetryConfigState = {
  enabled: false,
  intervalMinutes: 60,
  lastRequestAt: null,
};

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 24 * 60;

export const MeshCoreNodeTelemetryConfig: React.FC<MeshCoreNodeTelemetryConfigProps> = ({
  baseUrl,
  sourceId,
  publicKey,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const canWriteConfig = hasPermission('configuration', 'write');

  const [cfg, setCfg] = useState<TelemetryConfigState>(DEFAULT_CFG);
  const [intervalDraft, setIntervalDraft] = useState<string>('60');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/nodes/${encodeURIComponent(publicKey)}/telemetry-config`;

  // Refetch whenever the selected node or source changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);
    (async () => {
      try {
        const response = await csrfFetch(endpoint);
        const data = await response.json();
        if (cancelled) return;
        if (data.success && data.data) {
          const next: TelemetryConfigState = {
            enabled: Boolean(data.data.enabled),
            intervalMinutes: typeof data.data.intervalMinutes === 'number' ? data.data.intervalMinutes : 60,
            lastRequestAt: data.data.lastRequestAt ?? null,
          };
          setCfg(next);
          setIntervalDraft(String(next.intervalMinutes));
        } else {
          setError(data.error || t('meshcore.telemetry_config.load_error', 'Failed to load config'));
        }
      } catch (_err) {
        if (!cancelled) {
          setError(t('meshcore.telemetry_config.load_error', 'Failed to load config'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, csrfFetch, t]);

  const save = async (patch: { enabled?: boolean; intervalMinutes?: number }) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await csrfFetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await response.json();
      if (data.success && data.data) {
        setCfg({
          enabled: Boolean(data.data.enabled),
          intervalMinutes: typeof data.data.intervalMinutes === 'number' ? data.data.intervalMinutes : 60,
          lastRequestAt: data.data.lastRequestAt ?? null,
        });
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1800);
      } else {
        setError(data.error || t('meshcore.telemetry_config.save_error', 'Failed to save'));
      }
    } catch (_err) {
      setError(t('meshcore.telemetry_config.save_error', 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = (next: boolean) => {
    setCfg((prev) => ({ ...prev, enabled: next }));
    void save({ enabled: next });
  };

  const handleIntervalCommit = () => {
    const n = parseInt(intervalDraft, 10);
    if (!Number.isFinite(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) {
      setIntervalDraft(String(cfg.intervalMinutes));
      setError(t('meshcore.telemetry_config.interval_range', `Interval must be between ${MIN_INTERVAL} and ${MAX_INTERVAL} minutes`));
      return;
    }
    if (n === cfg.intervalMinutes) return;
    void save({ intervalMinutes: n });
  };

  return (
    <div className="node-details-block">
      <div className="node-details-header">
        <h3 className="node-details-title">
          {t('meshcore.telemetry_config.title', 'Telemetry Retrieval')}
        </h3>
      </div>

      <p className="hint" style={{ marginBottom: '0.75rem' }}>
        {t(
          'meshcore.telemetry_config.hint',
          'Periodically request telemetry from this node over RF. A 60-second minimum spacing is enforced across all scheduled mesh ops on this source.',
        )}
      </p>

      {!canWriteConfig && (
        <div
          className="meshcore-empty-state"
          style={{ marginBottom: '0.75rem', color: 'var(--ctp-yellow)' }}
          role="status"
        >
          {t(
            'meshcore.config.permission_denied',
            "You don't have permission to change configuration for this source.",
          )}
        </div>
      )}

      {loading ? (
        <div className="meshcore-empty-state">{t('meshcore.telemetry_config.loading', 'Loading…')}</div>
      ) : (
        <div className="node-details-grid">
          <div className="node-detail-card">
            <div className="node-detail-label">
              {t('meshcore.telemetry_config.enabled_label', 'Retrieval')}
            </div>
            <div className="node-detail-value">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={(e) => handleToggle(e.target.checked)}
                  disabled={!canWriteConfig || saving}
                  aria-label={t('meshcore.telemetry_config.enabled_label', 'Retrieval')}
                />
                <span>
                  {cfg.enabled
                    ? t('meshcore.telemetry_config.on', 'On')
                    : t('meshcore.telemetry_config.off', 'Off')}
                </span>
              </label>
            </div>
          </div>

          <div className="node-detail-card">
            <div className="node-detail-label">
              {t('meshcore.telemetry_config.interval_label', 'Interval (minutes)')}
            </div>
            <div className="node-detail-value">
              <input
                type="number"
                min={MIN_INTERVAL}
                max={MAX_INTERVAL}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                onBlur={handleIntervalCommit}
                disabled={!canWriteConfig || saving}
                style={{ width: '6rem' }}
              />
            </div>
          </div>

          {cfg.lastRequestAt && (
            <div className="node-detail-card node-detail-card-2col">
              <div className="node-detail-label">
                {t('meshcore.telemetry_config.last_request', 'Last request')}
              </div>
              <div className="node-detail-value">
                {new Date(cfg.lastRequestAt).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="meshcore-empty-state" style={{ marginTop: '0.5rem', color: 'var(--ctp-red)' }} role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div className="meshcore-empty-state" style={{ marginTop: '0.5rem', color: 'var(--ctp-green)' }} role="status">
          {t('meshcore.telemetry_config.saved', 'Saved.')}
        </div>
      )}
    </div>
  );
};
