import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';

interface AutoPingSectionProps {
  baseUrl: string;
}

interface AutoPingSettings {
  autoPingEnabled: boolean;
  autoPingIntervalSeconds: number;
  autoPingMaxPings: number;
  autoPingTimeoutSeconds: number;
}

interface PingResult {
  pingNum: number;
  status: 'ack' | 'nak' | 'timeout';
  durationMs?: number;
  sentAt: number;
}

interface AutoPingSessionInfo {
  requestedBy: number;
  requestedByName: string;
  totalPings: number;
  completedPings: number;
  successfulPings: number;
  failedPings: number;
  startTime: number;
  results: PingResult[];
}

const AutoPingSection: React.FC<AutoPingSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(false);
  const [localInterval, setLocalInterval] = useState(30);
  const [localMaxPings, setLocalMaxPings] = useState(20);
  const [localTimeout, setLocalTimeout] = useState(60);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sessions, setSessions] = useState<AutoPingSessionInfo[]>([]);
  const [initialSettings, setInitialSettings] = useState<AutoPingSettings | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch current settings and sessions
  const fetchData = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/auto-ping`);
      if (response.ok) {
        const data = await response.json();
        const s = data.settings as AutoPingSettings;
        if (!initialSettings) {
          setLocalEnabled(s.autoPingEnabled);
          setLocalInterval(s.autoPingIntervalSeconds);
          setLocalMaxPings(s.autoPingMaxPings);
          setLocalTimeout(s.autoPingTimeoutSeconds);
          setInitialSettings(s);
        }
        setSessions(data.sessions || []);
      }
    } catch (error) {
      console.error('Failed to fetch auto-ping settings:', error);
    }
  }, [baseUrl, csrfFetch, initialSettings]);

  useEffect(() => {
    fetchData();
  }, [baseUrl, csrfFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for active sessions
  useEffect(() => {
    if (sessions.length > 0) {
      if (!pollRef.current) {
        pollRef.current = setInterval(fetchData, 5000);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [sessions.length, fetchData]);

  // Check if any settings have changed
  useEffect(() => {
    if (!initialSettings) return;
    const changed =
      localEnabled !== initialSettings.autoPingEnabled ||
      localInterval !== initialSettings.autoPingIntervalSeconds ||
      localMaxPings !== initialSettings.autoPingMaxPings ||
      localTimeout !== initialSettings.autoPingTimeoutSeconds;
    setHasChanges(changed);
  }, [localEnabled, localInterval, localMaxPings, localTimeout, initialSettings]);

  const resetChanges = useCallback(() => {
    if (initialSettings) {
      setLocalEnabled(initialSettings.autoPingEnabled);
      setLocalInterval(initialSettings.autoPingIntervalSeconds);
      setLocalMaxPings(initialSettings.autoPingMaxPings);
      setLocalTimeout(initialSettings.autoPingTimeoutSeconds);
    }
  }, [initialSettings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/auto-ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoPingEnabled: String(localEnabled),
          autoPingIntervalSeconds: String(localInterval),
          autoPingMaxPings: String(localMaxPings),
          autoPingTimeoutSeconds: String(localTimeout),
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      setInitialSettings({
        autoPingEnabled: localEnabled,
        autoPingIntervalSeconds: localInterval,
        autoPingMaxPings: localMaxPings,
        autoPingTimeoutSeconds: localTimeout,
      });
      setHasChanges(false);
      showToast(t('automation.auto_ping.settings_saved', 'Auto-ping settings saved'), 'success');
    } catch (error) {
      console.error('Failed to save auto-ping settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localEnabled, localInterval, localMaxPings, localTimeout, baseUrl, csrfFetch, showToast, t]);

  useSaveBar({
    id: 'auto-ping',
    sectionName: t('automation.auto_ping.title', 'Auto Ping'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  const handleStopSession = async (nodeNum: number) => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/auto-ping/stop/${nodeNum}`, {
        method: 'POST',
      });
      if (response.ok) {
        showToast(t('automation.auto_ping.session_stopped', 'Ping session stopped'), 'success');
        fetchData();
      }
    } catch (error) {
      console.error('Failed to stop ping session:', error);
      showToast(t('automation.auto_ping.stop_failed', 'Failed to stop ping session'), 'error');
    }
  };

  const formatElapsed = (startTime: number) => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  };

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          {t('automation.auto_ping.title', 'Auto Ping')}
          <a
            href="https://meshmonitor.org/features/automation#auto-ping"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title={t('automation.view_docs')}
          >
            ?
          </a>
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.auto_ping.description', 'When enabled, mesh users can send a DM with "ping N" to start N automated pings back to them, or "ping stop" to cancel an active session.')}
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoPingInterval">
            {t('automation.auto_ping.interval', 'Ping Interval (seconds)')}
            <span className="setting-description">
              {t('automation.auto_ping.interval_description', 'Time between each ping in a session')}
            </span>
          </label>
          <input
            id="autoPingInterval"
            type="number"
            min="10"
            max="300"
            value={localInterval}
            onChange={(e) => setLocalInterval(parseInt(e.target.value) || 30)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoPingMaxPings">
            {t('automation.auto_ping.max_pings', 'Max Pings Per Session')}
            <span className="setting-description">
              {t('automation.auto_ping.max_pings_description', 'Maximum number of pings a user can request in a single session')}
            </span>
          </label>
          <input
            id="autoPingMaxPings"
            type="number"
            min="1"
            max="100"
            value={localMaxPings}
            onChange={(e) => setLocalMaxPings(parseInt(e.target.value) || 20)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoPingTimeout">
            {t('automation.auto_ping.timeout', 'Ping Timeout (seconds)')}
            <span className="setting-description">
              {t('automation.auto_ping.timeout_description', 'How long to wait for a response before marking a ping as timed out')}
            </span>
          </label>
          <input
            id="autoPingTimeout"
            type="number"
            min="10"
            max="300"
            value={localTimeout}
            onChange={(e) => setLocalTimeout(parseInt(e.target.value) || 60)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        {/* DM Command Help */}
        <div style={{
          marginTop: '2rem',
          marginLeft: '1.75rem',
          padding: '1rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-surface2)',
          borderRadius: '6px',
        }}>
          <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--ctp-text)' }}>
            {t('automation.auto_ping.dm_commands', 'DM Commands')}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)', lineHeight: '1.8' }}>
            <code style={{ background: 'var(--ctp-surface1)', padding: '0.2rem 0.4rem', borderRadius: '3px' }}>ping 5</code>
            {' '}{t('automation.auto_ping.dm_start_help', '- Start 5 pings at the configured interval')}
            <br />
            <code style={{ background: 'var(--ctp-surface1)', padding: '0.2rem 0.4rem', borderRadius: '3px' }}>ping stop</code>
            {' '}{t('automation.auto_ping.dm_stop_help', '- Cancel an active ping session')}
          </div>
        </div>

        {/* Active Sessions */}
        {sessions.length > 0 && (
          <div style={{ marginTop: '2rem', marginLeft: '1.75rem' }}>
            <h3 style={{ marginBottom: '0.75rem' }}>
              {t('automation.auto_ping.active_sessions', 'Active Sessions')}
            </h3>
            <div style={{
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '6px',
              overflow: 'hidden',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--ctp-surface0)' }}>
                    <th style={{ padding: '0.5rem', textAlign: 'left', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('automation.auto_ping.requested_by', 'Requested By')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('automation.auto_ping.progress', 'Progress')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('automation.auto_ping.successful', 'Successful')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('automation.auto_ping.failed', 'Failed')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('automation.auto_ping.elapsed', 'Elapsed')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('common.actions', 'Actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(session => (
                    <tr key={session.requestedBy} style={{ borderBottom: '1px solid var(--ctp-surface1)' }}>
                      <td style={{ padding: '0.5rem' }}>{session.requestedByName}</td>
                      <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                        {session.completedPings}/{session.totalPings}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center', color: 'var(--ctp-green)' }}>
                        {session.successfulPings}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center', color: 'var(--ctp-red)' }}>
                        {session.failedPings}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                        {formatElapsed(session.startTime)}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                        <button
                          onClick={() => handleStopSession(session.requestedBy)}
                          className="btn-secondary"
                          style={{ padding: '0.2rem 0.5rem', fontSize: '11px' }}
                        >
                          {t('common.stop', 'Stop')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default AutoPingSection;
