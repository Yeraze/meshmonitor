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
    <div className="settings-section">
      <h3>{t('automation.auto_favorite.title', 'Auto Favorite')}</h3>

      <p className="settings-description">
        {t('automation.auto_favorite.description',
          'Automatically favorite eligible nodes for zero-cost hop routing.')}{' '}
        <a
          href="https://meshtastic.org/blog/zero-cost-hops-favorite-routers/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('automation.auto_favorite.read_more', 'Read more')}
        </a>
      </p>

      {/* Status/Warning Banners */}
      {status && (
        <>
          {!firmwareValid && (
            <div className="alert alert-warning">
              {t('automation.auto_favorite.firmware_warning',
                'Firmware {{version}} does not support favorites (requires >= 2.7.0)',
                { version: status.firmwareVersion || 'unknown' })}
            </div>
          )}
          {firmwareValid && !roleValid && (
            <div className="alert alert-warning">
              {t('automation.auto_favorite.role_warning',
                'Your node role is "{{role}}" — Auto Favorite requires Router, Router Late, or Client Base.',
                { role: ROLE_NAMES[status.localNodeRole ?? 0] || 'Unknown' })}
            </div>
          )}
          {firmwareValid && roleValid && (
            <div className="alert alert-success">
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

      {/* Enable Checkbox */}
      <div className="settings-row">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
          />
          {t('automation.auto_favorite.enable', 'Enable Auto Favorite')}
        </label>
      </div>

      {/* Staleness Threshold */}
      {localEnabled && (
        <div className="settings-row">
          <label>
            {t('automation.auto_favorite.stale_hours_label', 'Staleness threshold (hours)')}
            <input
              type="number"
              min={1}
              max={720}
              value={localStaleHours}
              onChange={(e) => setLocalStaleHours(parseInt(e.target.value) || 72)}
              style={{ width: '80px', marginLeft: '8px' }}
            />
          </label>
          <p className="settings-hint">
            {t('automation.auto_favorite.stale_hours_hint',
              'Nodes not heard from within this period are automatically unfavorited.')}
          </p>
        </div>
      )}

      {/* Auto-Favorited Nodes List */}
      {localEnabled && status && status.autoFavoriteNodes.length > 0 && (
        <div className="settings-row">
          <h4>{t('automation.auto_favorite.managed_nodes', 'Auto-Favorited Nodes')}</h4>
          <table className="simple-table">
            <thead>
              <tr>
                <th>{t('common.node', 'Node')}</th>
                <th>{t('common.role', 'Role')}</th>
                <th>{t('common.hops', 'Hops')}</th>
              </tr>
            </thead>
            <tbody>
              {status.autoFavoriteNodes.map((node) => (
                <tr key={node.nodeNum}>
                  <td>{node.longName || node.shortName || node.nodeId}</td>
                  <td>{ROLE_NAMES[node.role ?? 0] || 'Unknown'}</td>
                  <td>{node.hopsAway ?? '?'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {localEnabled && status && status.autoFavoriteNodes.length === 0 && (
        <p className="settings-hint">
          {t('automation.auto_favorite.no_nodes', 'No nodes auto-favorited yet.')}
        </p>
      )}
    </div>
  );
};

export default AutoFavoriteSection;
