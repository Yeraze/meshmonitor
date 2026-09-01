/**
 * Per-node time-sync config panel for the MeshCore per-node detail view
 * (issue #4916).
 *
 * A sibling of `MeshCoreNodeTelemetryConfig` / `MeshCoreNodeNeighboursConfig`:
 * mounts in the DM/contact detail pane of `MeshCoreDirectMessagesView` for a
 * peer with a real 64-hex pubkey, reads/writes `(enabled, intervalMinutes)`
 * for the (sourceId, publicKey) pair from
 * `/api/sources/:id/meshcore/nodes/:publicKey/time-sync-config`, and offers a
 * manual "Sync Now" that hits `/time-sync`.
 *
 * Two things make this panel different from its two siblings, and both are
 * surfaced in the UI rather than left to the logs:
 *
 *  - It REQUIRES a saved admin password. `time` is a mutating firmware verb,
 *    so unlike a telemetry or neighbours read it cannot fall back to a guest
 *    session. The GET reports `hasSavedCredential`; without one, enabling the
 *    schedule would quietly do nothing every cycle, so we warn up front.
 *  - The interval floor is 60 minutes, not 1. One sync costs four packets on
 *    the air (login + reply, then the CLI command + reply), so the cheap-looking
 *    small numbers the other panels accept would be genuinely harmful here.
 *    The server rejects sub-floor values too — this is not a UI-only guard.
 *
 * Edits are gated by `configuration:write`. So is the manual sync, unlike the
 * telemetry/neighbours polls: it mutates the remote device's clock rather than
 * reading from it.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { isTxDisabledBody } from '../../utils/txDisabled';
import { MeshCoreReceiveOnlyNote } from './MeshCoreReceiveOnlyNote';

interface MeshCoreNodeTimeSyncConfigProps {
  /** Frontend basename (e.g. '' or '/meshmonitor'). */
  baseUrl: string;
  /** Owning source id (UUID). */
  sourceId: string;
  /** 64-char hex pubkey of the remote MeshCore node. */
  publicKey: string;
  /** True when this MeshCore source is in strict receive-only mode (#4547). */
  receiveOnly?: boolean;
}

interface TimeSyncConfigState {
  enabled: boolean;
  intervalMinutes: number;
  lastSyncAt: number | null;
  hasSavedCredential: boolean;
}

/** Mirrors MIN/MAX/DEFAULT_INTERVAL_MINUTES in meshcoreTimeSyncScheduler.ts. */
const MIN_INTERVAL = 60;
const MAX_INTERVAL = 7 * 24 * 60;
const DEFAULT_INTERVAL = 720;

const DEFAULT_CFG: TimeSyncConfigState = {
  enabled: false,
  intervalMinutes: DEFAULT_INTERVAL,
  lastSyncAt: null,
  hasSavedCredential: false,
};

/** "12h" / "90m" — intervals here are hours-scale, so raw minutes read poorly. */
function formatInterval(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const MeshCoreNodeTimeSyncConfig: React.FC<MeshCoreNodeTimeSyncConfigProps> = ({
  baseUrl,
  sourceId,
  publicKey,
  receiveOnly = false,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWriteConfig = hasPermission('configuration', 'write');
  // Unlike the telemetry/neighbours polls, a manual sync MUTATES the remote
  // device, so it needs configuration:write to match the backend route.
  const canSync = canWriteConfig;

  const [cfg, setCfg] = useState<TimeSyncConfigState>(DEFAULT_CFG);
  const [intervalDraft, setIntervalDraft] = useState<string>(String(DEFAULT_INTERVAL));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const endpoint = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/nodes/${encodeURIComponent(publicKey)}/time-sync-config`;
  const syncEndpoint = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/nodes/${encodeURIComponent(publicKey)}/time-sync`;

  const applyResponse = (d: Record<string, unknown>): TimeSyncConfigState => ({
    enabled: Boolean(d.enabled),
    intervalMinutes: typeof d.intervalMinutes === 'number' ? d.intervalMinutes : DEFAULT_INTERVAL,
    lastSyncAt: (d.lastSyncAt as number | null) ?? null,
    hasSavedCredential: Boolean(d.hasSavedCredential),
  });

  // Refetch whenever the selected node or source changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);
    setSyncMsg(null);
    void (async () => {
      try {
        const response = await csrfFetch(endpoint);
        const data = await response.json();
        if (cancelled) return;
        if (data.success && data.data) {
          const next = applyResponse(data.data);
          setCfg(next);
          setIntervalDraft(String(next.intervalMinutes));
        } else {
          setError(data.error || t('meshcore.time_sync_config.load_error', 'Failed to load config'));
        }
      } catch (_err) {
        if (!cancelled) {
          setError(t('meshcore.time_sync_config.load_error', 'Failed to load config'));
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
        setCfg(applyResponse(data.data));
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1800);
      } else {
        setError(data.error || t('meshcore.time_sync_config.save_error', 'Failed to save'));
      }
    } catch (_err) {
      setError(t('meshcore.time_sync_config.save_error', 'Failed to save'));
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
      setError(
        t(
          'meshcore.time_sync_config.interval_range',
          `Interval must be between ${MIN_INTERVAL} and ${MAX_INTERVAL} minutes`,
        ),
      );
      return;
    }
    if (n === cfg.intervalMinutes) return;
    void save({ intervalMinutes: n });
  };

  const syncNow = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const response = await csrfFetch(syncEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setSyncMsg({
          kind: 'ok',
          text: t('meshcore.time_sync_config.sync_ok', 'Clock pushed to repeater.'),
        });
        // The server stamped lastTimeSyncAt; reflect it without a refetch.
        setCfg((prev) => ({ ...prev, lastSyncAt: data.data?.syncedAt ?? Date.now() }));
      } else if (isTxDisabledBody(response.status, data)) {
        showToast(
          t(
            'meshcore.receive_only.blocked_toast',
            'Receive-only mode is on for this MeshCore source — nothing was sent.',
          ),
          'warning',
        );
      } else {
        setSyncMsg({
          kind: 'err',
          text: data.error || t('meshcore.time_sync_config.sync_error', 'Time sync failed'),
        });
      }
    } catch (_err) {
      setSyncMsg({ kind: 'err', text: t('meshcore.time_sync_config.sync_error', 'Time sync failed') });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="node-details-block">
      <div className="node-details-header">
        <h3 className="node-details-title">
          {t('meshcore.time_sync_config.title', 'Time Sync')}
        </h3>
      </div>

      <p className="hint" style={{ marginBottom: '0.75rem' }}>
        {t(
          'meshcore.time_sync_config.hint',
          "Periodically push this server's clock to the repeater's RTC, which has no NTP or GPS of its own. Each sync costs four packets on the air (an admin login and its reply, then the time command and its reply), so the minimum interval is 1 hour and the default is 12. Spacing is shared with Telemetry and Neighbours Retrieval, and tracked separately from both.",
        )}
      </p>

      {!canWriteConfig && (
        <div
          className="meshcore-empty-state"
          style={{ marginBottom: '0.75rem', color: 'var(--color-warning)' }}
          role="status"
        >
          {t(
            'meshcore.config.permission_denied',
            "You don't have permission to change configuration for this source.",
          )}
        </div>
      )}

      {!loading && !cfg.hasSavedCredential && (
        <div
          className="meshcore-empty-state"
          style={{ marginBottom: '0.75rem', color: 'var(--color-warning)' }}
          role="status"
        >
          {t(
            'meshcore.time_sync_config.no_credential',
            'No admin password is saved for this node. Setting the clock is an admin operation, so scheduled syncs will fail silently until you log in and save one.',
          )}
        </div>
      )}

      {loading ? (
        <div className="meshcore-empty-state">
          {t('meshcore.time_sync_config.loading', 'Loading…')}
        </div>
      ) : (
        <div className="node-details-grid">
          <div className="node-detail-card">
            <div className="node-detail-label">
              {t('meshcore.time_sync_config.enabled_label', 'Auto time sync')}
            </div>
            <div className="node-detail-value">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={(e) => handleToggle(e.target.checked)}
                  disabled={!canWriteConfig || saving}
                  aria-label={t('meshcore.time_sync_config.enabled_label', 'Auto time sync')}
                />
                <span>
                  {cfg.enabled
                    ? t('meshcore.time_sync_config.on', 'On')
                    : t('meshcore.time_sync_config.off', 'Off')}
                </span>
              </label>
            </div>
          </div>

          <div className="node-detail-card">
            <div className="node-detail-label">
              {t('meshcore.time_sync_config.interval_label', 'Interval (minutes)')}
            </div>
            <div className="node-detail-value">
              <input
                type="number"
                min={MIN_INTERVAL}
                max={MAX_INTERVAL}
                step={60}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                onBlur={handleIntervalCommit}
                disabled={!canWriteConfig || saving}
                aria-label={t('meshcore.time_sync_config.interval_label', 'Interval (minutes)')}
                style={{ width: '6rem' }}
              />
              <span className="hint" style={{ marginLeft: '0.5rem' }}>
                {formatInterval(cfg.intervalMinutes)}
              </span>
            </div>
          </div>

          {cfg.lastSyncAt && (
            <div className="node-detail-card node-detail-card-2col">
              <div className="node-detail-label">
                {t('meshcore.time_sync_config.last_sync', 'Last sync')}
              </div>
              <div className="node-detail-value">
                {new Date(cfg.lastSyncAt).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: '1rem', borderTop: '1px solid var(--color-surface)', paddingTop: '0.75rem' }}>
        <div className="node-details-header">
          <h4 className="node-details-title" style={{ fontSize: '0.95rem' }}>
            {t('meshcore.time_sync_config.sync_title', 'Sync Now')}
          </h4>
        </div>
        <p className="hint" style={{ marginBottom: '0.5rem' }}>
          {t(
            'meshcore.time_sync_config.sync_hint',
            "Push the clock immediately, outside the scheduled interval. Subject to the same 60-second mesh-TX spacing. The firmware refuses to move a clock backwards, so a repeater running ahead of this server will reject the push.",
          )}
        </p>
        <MeshCoreReceiveOnlyNote receiveOnly={receiveOnly} />
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void syncNow()}
            disabled={!canSync || syncing || receiveOnly}
            title={
              receiveOnly
                ? t(
                    'meshcore.receive_only.control_tooltip',
                    'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.',
                  )
                : undefined
            }
          >
            {syncing
              ? t('meshcore.time_sync_config.syncing', 'Syncing…')
              : t('meshcore.time_sync_config.sync_button', 'Sync Clock')}
          </button>
        </div>
        {syncMsg && (
          <div
            className="meshcore-empty-state"
            style={{
              marginTop: '0.5rem',
              color: syncMsg.kind === 'ok' ? 'var(--color-success)' : 'var(--color-error)',
            }}
            role={syncMsg.kind === 'ok' ? 'status' : 'alert'}
          >
            {syncMsg.text}
          </div>
        )}
      </div>

      {error && (
        <div className="meshcore-empty-state" style={{ marginTop: '0.5rem', color: 'var(--color-error)' }} role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div className="meshcore-empty-state" style={{ marginTop: '0.5rem', color: 'var(--color-success)' }} role="status">
          {t('meshcore.time_sync_config.saved', 'Saved.')}
        </div>
      )}
    </div>
  );
};
