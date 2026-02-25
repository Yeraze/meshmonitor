import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';
import { useToast } from './ToastContainer';
import { ROLE_NAMES, DeviceRole } from '../constants';

interface AutoFavoriteSectionProps {
  baseUrl: string;
}

interface AutoFavoriteStatus {
  localNodeRole: number | null;
  firmwareVersion: string | null;
  supportsFavorites: boolean;
  autoFavoriteNodes: Array<{
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    role: number | null;
    hopsAway: number | null;
    lastHeard: number | null;
  }>;
}

const ELIGIBLE_LOCAL_ROLES: Set<number> = new Set([DeviceRole.ROUTER, DeviceRole.ROUTER_LATE, DeviceRole.CLIENT_BASE]);

const AutoFavoriteSection: React.FC<AutoFavoriteSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(false);
  const [localStaleHours, setLocalStaleHours] = useState(72);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [initialSettings, setInitialSettings] = useState<{ enabled: boolean; staleHours: number } | null>(null);
  const [status, setStatus] = useState<AutoFavoriteStatus | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [settingsRes, statusRes] = await Promise.all([
        csrfFetch(`${baseUrl}/api/settings`),
        csrfFetch(`${baseUrl}/api/auto-favorite/status`),
      ]);
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        const enabled = settings.autoFavoriteEnabled === 'true';
        const staleHours = parseInt(settings.autoFavoriteStaleHours || '72');
        setLocalEnabled(enabled);
        setLocalStaleHours(staleHours);
        setInitialSettings({ enabled, staleHours });
      }
      if (statusRes.ok) {
        setStatus(await statusRes.json());
      }
    } catch (error) {
      console.error('Failed to fetch auto-favorite data:', error);
    }
  }, [baseUrl, csrfFetch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!initialSettings) return;
    setHasChanges(
      localEnabled !== initialSettings.enabled ||
      localStaleHours !== initialSettings.staleHours
    );
  }, [localEnabled, localStaleHours, initialSettings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoFavoriteEnabled: localEnabled ? 'true' : 'false',
          autoFavoriteStaleHours: String(localStaleHours),
        }),
      });
      if (response.ok) {
        setInitialSettings({ enabled: localEnabled, staleHours: localStaleHours });
        setHasChanges(false);
        showToast(t('automation.auto_favorite.saved', 'Auto Favorite settings saved'), 'success');
        fetchData();
      } else {
        showToast(t('automation.auto_favorite.save_error', 'Failed to save settings'), 'error');
      }
    } catch (error) {
      showToast(t('automation.auto_favorite.save_error', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [baseUrl, csrfFetch, localEnabled, localStaleHours, showToast, t, fetchData]);

  const resetChanges = useCallback(() => {
    if (initialSettings) {
      setLocalEnabled(initialSettings.enabled);
      setLocalStaleHours(initialSettings.staleHours);
    }
  }, [initialSettings]);

  useSaveBar({
    id: 'auto-favorite',
    sectionName: t('automation.auto_favorite.title', 'Auto Favorite'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  const roleValid = status?.localNodeRole != null && ELIGIBLE_LOCAL_ROLES.has(status.localNodeRole);
  const firmwareValid = status?.supportsFavorites ?? false;

  const getTargetDescription = () => {
    if (!status?.localNodeRole) return '';
    if (status.localNodeRole === DeviceRole.CLIENT_BASE) {
      return t('automation.auto_favorite.target_all', 'all 0-hop nodes');
    }
    return t('automation.auto_favorite.target_routers', '0-hop Router, Router Late, and Client Base nodes');
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
          {t('automation.auto_favorite.title', 'Auto Favorite')}
          <a
            href="https://meshtastic.org/blog/zero-cost-hops-favorite-routers/"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title={t('automation.auto_favorite.read_more', 'Read more')}
          >
            ?
          </a>
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.auto_favorite.description',
            'Automatically favorite eligible nodes for zero-cost hop routing.')}{' '}
          <a
            href="https://meshtastic.org/blog/zero-cost-hops-favorite-routers/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#89b4fa' }}
          >
            {t('automation.auto_favorite.read_more', 'Read more')}
          </a>
        </p>

        {/* Status/Warning Banners */}
        {status && (
          <>
            {!firmwareValid && (
              <div style={{
                marginLeft: '1.75rem',
                marginBottom: '1rem',
                padding: '0.75rem 1rem',
                background: 'var(--ctp-surface0)',
                border: '1px solid var(--ctp-yellow)',
                borderLeft: '4px solid var(--ctp-yellow)',
                borderRadius: '6px',
                color: 'var(--ctp-yellow)',
                fontSize: '13px',
                lineHeight: '1.5',
              }}>
                {t('automation.auto_favorite.firmware_warning',
                  'Firmware {{version}} does not support favorites (requires >= 2.7.0)',
                  { version: status.firmwareVersion || 'unknown' })}
              </div>
            )}
            {firmwareValid && !roleValid && (
              <div style={{
                marginLeft: '1.75rem',
                marginBottom: '1rem',
                padding: '0.75rem 1rem',
                background: 'var(--ctp-surface0)',
                border: '1px solid var(--ctp-yellow)',
                borderLeft: '4px solid var(--ctp-yellow)',
                borderRadius: '6px',
                color: 'var(--ctp-yellow)',
                fontSize: '13px',
                lineHeight: '1.5',
              }}>
                {t('automation.auto_favorite.role_warning',
                  'Your node role is "{{role}}" — Auto Favorite requires Router, Router Late, or Client Base.',
                  { role: ROLE_NAMES[status.localNodeRole ?? 0] || 'Unknown' })}
              </div>
            )}
            {firmwareValid && roleValid && (
              <div style={{
                marginLeft: '1.75rem',
                marginBottom: '1rem',
                padding: '0.75rem 1rem',
                background: 'var(--ctp-surface0)',
                border: '1px solid var(--ctp-green)',
                borderLeft: '4px solid var(--ctp-green)',
                borderRadius: '6px',
                color: 'var(--ctp-green)',
                fontSize: '13px',
                lineHeight: '1.5',
              }}>
                {t('automation.auto_favorite.valid_config',
                  'Valid configuration: {{role}} on firmware {{version}}. Will auto-favorite: {{targets}}.',
                  {
                    role: ROLE_NAMES[status.localNodeRole!] || 'Unknown',
                    version: status.firmwareVersion || 'unknown',
                    targets: getTargetDescription(),
                  })}
              </div>
            )}
          </>
        )}

        {/* Staleness Threshold */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoFavoriteStaleHours">
            {t('automation.auto_favorite.stale_hours_label', 'Staleness threshold (hours)')}
            <span className="setting-description">
              {t('automation.auto_favorite.stale_hours_hint',
                'Nodes not heard from within this period are automatically unfavorited.')}
            </span>
          </label>
          <input
            id="autoFavoriteStaleHours"
            type="number"
            min={1}
            max={720}
            value={localStaleHours}
            onChange={(e) => setLocalStaleHours(parseInt(e.target.value) || 72)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        {/* Auto-Favorited Nodes List */}
        {status && status.autoFavoriteNodes.length > 0 && (
          <div style={{ marginTop: '2rem', marginLeft: '1.75rem' }}>
            <h3 style={{ marginBottom: '0.75rem' }}>
              {t('automation.auto_favorite.managed_nodes', 'Auto-Favorited Nodes')}
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
                      {t('common.node', 'Node')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('common.role', 'Role')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('common.hops', 'Hops')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {status.autoFavoriteNodes.map((node) => (
                    <tr key={node.nodeNum} style={{ borderBottom: '1px solid var(--ctp-surface1)' }}>
                      <td style={{ padding: '0.5rem' }}>{node.longName || node.shortName || node.nodeId}</td>
                      <td style={{ padding: '0.5rem', textAlign: 'center' }}>{ROLE_NAMES[node.role ?? 0] || 'Unknown'}</td>
                      <td style={{ padding: '0.5rem', textAlign: 'center' }}>{node.hopsAway ?? '?'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {status && status.autoFavoriteNodes.length === 0 && (
          <p style={{ marginTop: '1rem', marginLeft: '1.75rem', color: 'var(--ctp-subtext0)', fontSize: '13px' }}>
            {t('automation.auto_favorite.no_nodes', 'No nodes auto-favorited yet.')}
          </p>
        )}
      </div>
    </>
  );
};

export default AutoFavoriteSection;
