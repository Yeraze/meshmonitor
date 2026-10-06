/**
 * Per-node neighbours-retrieval config panel for the MeshCore per-node detail
 * view (issue #4618).
 *
 * A sibling of `MeshCoreNodeTelemetryConfig`: mounts in the DM/contact detail
 * pane of `MeshCoreDirectMessagesView` for a peer with a real 64-hex pubkey,
 * reads/writes `(enabled, intervalMinutes)` for the (sourceId, publicKey) pair
 * from `/api/sources/:id/meshcore/nodes/:publicKey/neighbours-config`, and
 * offers a manual "Poll Now" that runs the paged `/neighbours/fetch` job
 * (#5413: the whole table, one page a minute, with progress and Cancel). The
 * scheduler reads one page, strongest first, and fills
 * the node's neighbour table into Node Details on the chosen cadence. Gated by
 * `configuration:write` for edits, `nodes:read` for the manual poll.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { MeshCoreReceiveOnlyNote } from './MeshCoreReceiveOnlyNote';
import { MeshCoreNeighboursFetchProgress } from './MeshCoreNeighboursFetchProgress';
import { createNeighboursFetchActions } from './hooks/meshcoreNeighboursFetchApi';
import { useMeshCoreNeighboursFetch } from './hooks/useMeshCoreNeighboursFetch';
import { NumberInput } from '../common/NumberInput';

interface MeshCoreNodeNeighboursConfigProps {
  /** Frontend basename (e.g. '' or '/meshmonitor'). */
  baseUrl: string;
  /** Owning source id (UUID). */
  sourceId: string;
  /** 64-char hex pubkey of the remote MeshCore node. */
  publicKey: string;
  /** True when this MeshCore source is in strict receive-only mode (#4547). */
  receiveOnly?: boolean;
}

interface NeighboursConfigState {
  enabled: boolean;
  intervalMinutes: number;
  lastRequestAt: number | null;
}

const DEFAULT_CFG: NeighboursConfigState = {
  enabled: false,
  intervalMinutes: 60,
  lastRequestAt: null,
};

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 24 * 60;

export const MeshCoreNodeNeighboursConfig: React.FC<MeshCoreNodeNeighboursConfigProps> = ({
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
  // A manual poll is a user-initiated read that happens to transmit, gated on
  // nodes:read to match the backend route.
  const canPoll = hasPermission('nodes', 'read');

  const [cfg, setCfg] = useState<NeighboursConfigState>(DEFAULT_CFG);
  const [intervalDraft, setIntervalDraft] = useState<string>('60');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/nodes/${encodeURIComponent(publicKey)}/neighbours-config`;
  const mcPrefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore`;
  const fetchActions = useMemo(() => createNeighboursFetchActions(csrfFetch, mcPrefix), [csrfFetch, mcPrefix]);
  const neighboursFetch = useMeshCoreNeighboursFetch(fetchActions);
  const { reset: resetNeighboursFetch, startError: pollStartError } = neighboursFetch;
  const pollFetch = neighboursFetch.fetch;
  const polling = neighboursFetch.running;

  // Stop watching a poll when the node or source changes.
  useEffect(() => {
    resetNeighboursFetch();
  }, [endpoint, resetNeighboursFetch]);

  // Receive-only refusals surface as a toast, like every other RF button.
  useEffect(() => {
    if (pollStartError?.txDisabled) {
      showToast(t('meshcore.receive_only.blocked_toast', 'Receive-only mode is on for this MeshCore source — nothing was sent.'), 'warning');
    }
  }, [pollStartError, showToast, t]);

  // Refetch whenever the selected node or source changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);
    void (async () => {
      try {
        const response = await csrfFetch(endpoint);
        const data = await response.json();
        if (cancelled) return;
        if (data.success && data.data) {
          const next: NeighboursConfigState = {
            enabled: Boolean(data.data.enabled),
            intervalMinutes: typeof data.data.intervalMinutes === 'number' ? data.data.intervalMinutes : 60,
            lastRequestAt: data.data.lastRequestAt ?? null,
          };
          setCfg(next);
          setIntervalDraft(String(next.intervalMinutes));
        } else {
          setError(data.error || t('meshcore.neighbours_config.load_error', 'Failed to load config'));
        }
      } catch (_err) {
        if (!cancelled) {
          setError(t('meshcore.neighbours_config.load_error', 'Failed to load config'));
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
        setError(data.error || t('meshcore.neighbours_config.save_error', 'Failed to save'));
      }
    } catch (_err) {
      setError(t('meshcore.neighbours_config.save_error', 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = (next: boolean) => {
    setCfg((prev) => ({ ...prev, enabled: next }));
    void save({ enabled: next });
  };

  const showIntervalRangeError = () => {
    setError(t('meshcore.neighbours_config.interval_range', `Interval must be between ${MIN_INTERVAL} and ${MAX_INTERVAL} minutes`));
  };

  const handleIntervalCommit = () => {
    const n = parseInt(intervalDraft, 10);
    if (!Number.isFinite(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) {
      showIntervalRangeError();
      return;
    }
    if (n === cfg.intervalMinutes) return;
    void save({ intervalMinutes: n });
  };

  const poll = () => {
    void neighboursFetch.start(publicKey);
  };

  let pollMsg: { kind: 'ok' | 'err'; text: string } | null = null;
  if (pollStartError && !pollStartError.txDisabled) {
    pollMsg = { kind: 'err', text: pollStartError.message || t('meshcore.neighbours_config.poll_error', 'Poll failed') };
  } else if (pollFetch?.phase === 'done' && pollFetch.outcome === 'complete') {
    const written = pollFetch.written ?? 0;
    pollMsg = {
      kind: 'ok',
      text: written > 0
        ? t('meshcore.neighbours_config.poll_wrote', 'Stored {{count}} neighbour(s).', { count: written })
        : t('meshcore.neighbours_config.poll_empty', 'Request sent — no neighbours returned.'),
    };
  }

  return (
    <div className="node-details-block">
      <div className="node-details-header">
        <h3 className="node-details-title">
          {t('meshcore.neighbours_config.title', 'Neighbours Retrieval')}
        </h3>
      </div>

      <p className="hint" style={{ marginBottom: '0.75rem' }}>
        {t(
          'meshcore.neighbours_config.hint',
          "Periodically request this node's neighbour table over RF and fill it into Node Details. A 60-second minimum spacing is enforced across all scheduled mesh ops on this source, tracked separately from Telemetry Retrieval.",
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

      {loading ? (
        <div className="meshcore-empty-state">{t('meshcore.neighbours_config.loading', 'Loading…')}</div>
      ) : (
        <div className="node-details-grid">
          <div className="node-detail-card">
            <div className="node-detail-label">
              {t('meshcore.neighbours_config.enabled_label', 'Retrieval')}
            </div>
            <div className="node-detail-value">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={(e) => handleToggle(e.target.checked)}
                  disabled={!canWriteConfig || saving}
                  aria-label={t('meshcore.neighbours_config.enabled_label', 'Retrieval')}
                />
                <span>
                  {cfg.enabled
                    ? t('meshcore.neighbours_config.on', 'On')
                    : t('meshcore.neighbours_config.off', 'Off')}
                </span>
              </label>
            </div>
          </div>

          <div className="node-detail-card">
            <div className="node-detail-label">
              {t('meshcore.neighbours_config.interval_label', 'Interval (minutes)')}
            </div>
            <div className="node-detail-value">
              <NumberInput
                min={MIN_INTERVAL}
                max={MAX_INTERVAL}
                integer
                value={intervalDraft === '' ? null : Number(intervalDraft)}
                onChange={(v) => setIntervalDraft(String(v))}
                // Commits on blur. Blank or out-of-range text stays in the field,
                // outlined, with the range shown, and is not sent (#5649).
                onBlur={(e) => {
                  if (e.currentTarget.dataset.numberInvalid === 'true') {
                    showIntervalRangeError();
                    return;
                  }
                  handleIntervalCommit();
                }}
                disabled={!canWriteConfig || saving}
                aria-label={t('meshcore.neighbours_config.interval_label', 'Interval (minutes)')}
                style={{ width: '6rem' }}
              />
            </div>
          </div>

          {cfg.lastRequestAt && (
            <div className="node-detail-card node-detail-card-2col">
              <div className="node-detail-label">
                {t('meshcore.neighbours_config.last_request', 'Last request')}
              </div>
              <div className="node-detail-value">
                {new Date(cfg.lastRequestAt).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: '1rem', borderTop: '1px solid var(--color-surface)', paddingTop: '0.75rem' }}>
        <div className="node-details-header">
          <h4 className="node-details-title" style={{ fontSize: '0.95rem' }}>
            {t('meshcore.neighbours_config.poll_title', 'Poll Now')}
          </h4>
        </div>
        <p className="hint" style={{ marginBottom: '0.5rem' }}>
          {t(
            'meshcore.neighbours_config.poll_hint',
            'Read the whole neighbour table now, outside the scheduled interval. A repeater sends at most 10 neighbours per reply, so this takes up to 5 pages, each waiting the 60-second mesh-TX spacing (about 5 minutes for a full table). The scheduled poll reads one page, strongest first.',
          )}
        </p>
        <MeshCoreReceiveOnlyNote receiveOnly={receiveOnly} />
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={poll}
            disabled={!canPoll || polling || receiveOnly}
            title={receiveOnly ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.') : undefined}
          >
            {polling
              ? t('meshcore.neighbours_config.polling', 'Polling…')
              : t('meshcore.neighbours_config.poll_button', 'Poll Neighbours')}
          </button>
        </div>
        {pollFetch && (
          <MeshCoreNeighboursFetchProgress fetch={pollFetch} onCancel={() => void neighboursFetch.cancel()} />
        )}
        {pollMsg && (
          <div
            className="meshcore-empty-state"
            style={{ marginTop: '0.5rem', color: pollMsg.kind === 'ok' ? 'var(--color-success)' : 'var(--color-error)' }}
            role={pollMsg.kind === 'ok' ? 'status' : 'alert'}
          >
            {pollMsg.text}
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
          {t('meshcore.neighbours_config.saved', 'Saved.')}
        </div>
      )}
    </div>
  );
};
