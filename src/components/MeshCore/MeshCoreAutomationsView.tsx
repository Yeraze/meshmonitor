import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useAuth } from '../../contexts/AuthContext';
import { MeshCoreAutoAckSection } from './MeshCoreAutoAckSection';
import { MeshCoreAutoAnnounceSection } from './MeshCoreAutoAnnounceSection';
import { MeshCoreAutoResponderSection } from './MeshCoreAutoResponderSection';
import { MeshCoreTimerTriggersSection } from './MeshCoreTimerTriggersSection';
import { MeshCorePathfindingFilterSection } from './MeshCorePathfindingFilterSection';
import { AutomationTokenReference } from '../AutomationTokenReference';
import { buildMeshCoreTokenGroups } from './meshcoreAutomationTokens';
import { UiIcon } from '../icons';

interface MeshCoreAutomationsViewProps {
  baseUrl: string;
  sourceId: string;
}

interface PathfindingSettings {
  enabled: boolean;
  pathDiscoveryEnabled: boolean;
  neighborsEnabled: boolean;
  intervalMinutes: number;
  repeatHours: number;
  schedulerRunning: boolean;
  lastRunAt: number | null;
}

const DEFAULTS: PathfindingSettings = {
  enabled: false,
  pathDiscoveryEnabled: true,
  neighborsEnabled: true,
  intervalMinutes: 5,
  repeatHours: 24,
  schedulerRunning: false,
  lastRunAt: null,
};

export const MeshCoreAutomationsView: React.FC<MeshCoreAutomationsViewProps> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [settings, setSettings] = useState<PathfindingSettings>(DEFAULTS);
  const [initial, setInitial] = useState<PathfindingSettings>(DEFAULTS);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/automation/pathfinding`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          const s: PathfindingSettings = {
            enabled: json.data.enabled ?? false,
            pathDiscoveryEnabled: json.data.pathDiscoveryEnabled ?? true,
            neighborsEnabled: json.data.neighborsEnabled ?? true,
            intervalMinutes: json.data.intervalMinutes ?? 5,
            repeatHours: json.data.repeatHours ?? 24,
            schedulerRunning: json.data.schedulerRunning ?? false,
            lastRunAt: json.data.lastRunAt ?? null,
          };
          setSettings(s);
          setInitial(s);
          setLoaded(true);
        }
      }
    } catch {
      // ignore fetch errors on load
    }
  }, [baseUrl, sourceId, csrfFetch]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (!loaded) return;
    const changed =
      settings.enabled !== initial.enabled ||
      settings.pathDiscoveryEnabled !== initial.pathDiscoveryEnabled ||
      settings.neighborsEnabled !== initial.neighborsEnabled ||
      settings.intervalMinutes !== initial.intervalMinutes ||
      settings.repeatHours !== initial.repeatHours;
    setHasChanges(changed);
  }, [settings, initial, loaded]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/automation/pathfinding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: settings.enabled,
          pathDiscoveryEnabled: settings.pathDiscoveryEnabled,
          neighborsEnabled: settings.neighborsEnabled,
          intervalMinutes: settings.intervalMinutes,
          repeatHours: settings.repeatHours,
        }),
      });
      if (!res.ok) {
        if (res.status === 403) return;
        throw new Error(`Server returned ${res.status}`);
      }
      const json = await res.json();
      const updated = {
        ...settings,
        schedulerRunning: json.data?.schedulerRunning ?? settings.schedulerRunning,
        lastRunAt: json.data?.lastRunAt ?? settings.lastRunAt,
      };
      setSettings(updated);
      setInitial(updated);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to save auto-pathfinding settings:', error);
    } finally {
      setIsSaving(false);
    }
  }, [settings, baseUrl, sourceId, csrfFetch]);

  const handleDismiss = useCallback(() => {
    setSettings(initial);
    setHasChanges(false);
  }, [initial]);

  useSaveBar({
    id: 'meshcore-auto-pathfinding',
    sectionName: t('meshcore.automation.pathfinding.title', 'Auto-Pathfinding'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = <K extends keyof PathfindingSettings>(key: K, value: PathfindingSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="meshcore-automations-view" style={{ padding: '1rem', overflowY: 'auto', height: '100%', minHeight: 0 }}>
      <h1 style={{ marginBottom: '1.5rem' }}>
        {t('meshcore.automation.title', 'Automations')}
      </h1>

      {/* Single source-of-truth token reference for the whole page. */}
      <AutomationTokenReference
        title={t('meshcore.automation.tokens.title', 'Available message tokens')}
        intro={t(
          'meshcore.automation.tokens.intro',
          'These placeholders are substituted in the message templates below. Reply tokens only expand when responding to a received message.',
        )}
        groups={buildMeshCoreTokenGroups({
          replyTitle: t('meshcore.automation.tokens.reply_title', 'When replying (Auto-Acknowledge, Auto-Responder)'),
          replyNote: t('meshcore.automation.tokens.reply_note', 'Resolved from the message that triggered the reply.'),
          globalTitle: t('meshcore.automation.tokens.global_title', 'Available everywhere'),
          globalNote: t('meshcore.automation.tokens.global_note', 'Also work in Auto-Announce and Timer Triggers.'),
        })}
        footer={
          <>
            <UiIcon name="sparkles" size={15} /> {t('meshcore.automation.tokens.engine_tip', 'Want maximum flexibility? Try the')}{' '}
            <Link to="/automations" style={{ color: 'var(--ctp-mauve)', fontWeight: 'bold' }}>
              {t('automation.engine_link', 'Automation Engine')}
            </Link>{' '}
            {t('meshcore.automation.tokens.engine_tip2', '— build global “when this happens, do that” workflows across every source.')}
          </>
        }
      />

      {/* Auto-Pathfinding Section */}
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px',
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => update('enabled', e.target.checked)}
            disabled={!canWrite}
            style={{ width: 'auto', margin: 0, cursor: canWrite ? 'pointer' : 'default' }}
          />
          {t('meshcore.automation.pathfinding.title', 'Auto-Pathfinding')}
        </h2>
        {settings.schedulerRunning && (
          <span style={{
            marginLeft: 'auto',
            fontSize: '0.8rem',
            padding: '0.25rem 0.5rem',
            borderRadius: '4px',
            background: 'var(--ctp-green)',
            color: 'var(--ctp-base)',
          }}>
            {t('meshcore.automation.running', 'Running')}
          </span>
        )}
      </div>

      <div className="settings-section" style={{
        opacity: settings.enabled ? 1 : 0.5,
        transition: 'opacity 0.2s',
        pointerEvents: settings.enabled ? 'auto' : 'none',
      }}>
        <p style={{ marginBottom: '1.5rem', color: 'var(--ctp-subtext0)', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('meshcore.automation.pathfinding.description',
            'Automatically discover paths and collect neighbor information from your MeshCore contacts on a recurring schedule.')}
        </p>

        {/* Path Discovery for Companions */}
        <div style={{
          padding: '1rem 1.25rem',
          marginBottom: '1rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-surface1)',
          borderRadius: '8px',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: canWrite ? 'pointer' : 'default' }}>
            <input
              type="checkbox"
              checked={settings.pathDiscoveryEnabled}
              onChange={(e) => update('pathDiscoveryEnabled', e.target.checked)}
              disabled={!canWrite}
              style={{ width: 'auto', margin: 0 }}
            />
            <div>
              <strong>{t('meshcore.automation.pathfinding.path_discovery', 'Path Discovery for Companions')}</strong>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.pathfinding.path_discovery_desc',
                  'Sends a path discovery request to each Companion contact. The device learns the forwarding route via its normal path return mechanism.')}
              </p>
            </div>
          </label>
        </div>

        {/* Neighbors for Repeaters */}
        <div style={{
          padding: '1rem 1.25rem',
          marginBottom: '1.5rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-surface1)',
          borderRadius: '8px',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: canWrite ? 'pointer' : 'default' }}>
            <input
              type="checkbox"
              checked={settings.neighborsEnabled}
              onChange={(e) => update('neighborsEnabled', e.target.checked)}
              disabled={!canWrite}
              style={{ width: 'auto', margin: 0 }}
            />
            <div>
              <strong>{t('meshcore.automation.pathfinding.neighbors', 'Neighbors for Repeaters')}</strong>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.pathfinding.neighbors_desc',
                  'Queries the neighbor list from each Repeater contact. Returns nearby nodes with signal quality information.')}
              </p>
            </div>
          </label>
        </div>

        {/* Interval between commands */}
        <div className="setting-item" style={{ marginBottom: '1rem' }}>
          <label htmlFor="pathfindingInterval">
            {t('meshcore.automation.pathfinding.interval', 'Time between commands (minutes)')}
            <span className="setting-description" style={{ display: 'block', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
              {t('meshcore.automation.pathfinding.interval_desc',
                'Delay between each individual path discovery or neighbor request to avoid flooding the mesh.')}
            </span>
          </label>
          <input
            id="pathfindingInterval"
            type="number"
            min={3}
            max={60}
            value={settings.intervalMinutes}
            onChange={(e) => update('intervalMinutes', Math.max(3, parseInt(e.target.value) || 3))}
            disabled={!canWrite}
            className="setting-input"
            style={{ width: '100px', marginTop: '0.5rem' }}
          />
        </div>

        {/* Repeat interval */}
        <div className="setting-item" style={{ marginBottom: '1rem' }}>
          <label htmlFor="pathfindingRepeat">
            {t('meshcore.automation.pathfinding.repeat', 'Repeat every (hours)')}
            <span className="setting-description" style={{ display: 'block', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
              {t('meshcore.automation.pathfinding.repeat_desc',
                'How often the full cycle runs. All eligible contacts are processed in each cycle.')}
            </span>
          </label>
          <input
            id="pathfindingRepeat"
            type="number"
            min={1}
            max={168}
            value={settings.repeatHours}
            onChange={(e) => update('repeatHours', Math.max(1, parseInt(e.target.value) || 1))}
            disabled={!canWrite}
            className="setting-input"
            style={{ width: '100px', marginTop: '0.5rem' }}
          />
        </div>

        {/* Last run info */}
        {settings.lastRunAt ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)', marginTop: '1rem' }}>
            {t('meshcore.automation.pathfinding.last_run', 'Last run')}: {new Date(settings.lastRunAt).toLocaleString()}
          </p>
        ) : null}

        {/* Target Filter (#4024) */}
        <MeshCorePathfindingFilterSection baseUrl={baseUrl} sourceId={sourceId} canWrite={canWrite} />
      </div>

      {/* Auto-Acknowledge Section */}
      <MeshCoreAutoAckSection baseUrl={baseUrl} sourceId={sourceId} />

      {/* Auto-Announce Section */}
      <MeshCoreAutoAnnounceSection baseUrl={baseUrl} sourceId={sourceId} />

      {/* Auto-Responder Section */}
      <MeshCoreAutoResponderSection baseUrl={baseUrl} sourceId={sourceId} />

      {/* Timer Triggers Section */}
      <MeshCoreTimerTriggersSection baseUrl={baseUrl} sourceId={sourceId} />
    </div>
  );
};
