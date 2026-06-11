import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { ROLE_NAMES, DeviceRole } from '../../constants/index';

/**
 * Automated Remote Favorites Management (issue #2608).
 *
 * Per-target config UI shown on the Remote Admin tab. Lets the operator have
 * MeshMonitor keep the favorites list up to date on a remote infrastructure
 * node — discovering its neighbors from NeighborInfo and/or passing traceroutes
 * and blindly pushing set-favorite admin commands over LoRa.
 */

interface AutoFavoriteConfig {
  configured: boolean;
  enabled: boolean;
  useNeighborInfo: boolean;
  useTraceroutes: boolean;
  intervalHours: number;
  maxNewPerCycle: number;
  maxRefavoritePerCycle: number;
  eligibleRoles: number[];
  lastRunAt: number | null;
  lastNeighborRequestAt: number | null;
  assignments: Array<{
    favoriteNodeNum: number;
    discoverySource: string | null;
    firstAssignedAt: number;
    lastAssignedAt: number;
  }>;
}

interface AutoFavoriteManagementSectionProps {
  selectedNodeNum: number | null;
  sourceId: string | null;
  nodes: any[];
}

// Roles that make sense to favorite for zero-hop routing.
const SELECTABLE_ROLES = [
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_LATE,
  DeviceRole.CLIENT_BASE,
  DeviceRole.REPEATER,
  DeviceRole.ROUTER_CLIENT,
];

const AutoFavoriteManagementSection: React.FC<AutoFavoriteManagementSectionProps> = ({ selectedNodeNum, sourceId, nodes }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [config, setConfig] = useState<AutoFavoriteConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const nodeNameByNum = useMemo(() => {
    const map = new Map<number, string>();
    for (const n of nodes) {
      if (typeof n.nodeNum === 'number') map.set(n.nodeNum, n.longName || n.shortName || `!${n.nodeNum.toString(16).padStart(8, '0')}`);
    }
    return map;
  }, [nodes]);

  const nodeLabel = useCallback((nodeNum: number) => {
    return nodeNameByNum.get(nodeNum) || `!${nodeNum.toString(16).padStart(8, '0')}`;
  }, [nodeNameByNum]);

  const loadConfig = useCallback(async () => {
    if (selectedNodeNum === null || !sourceId) {
      setConfig(null);
      return;
    }
    setIsLoading(true);
    try {
      const data = await apiService.get<AutoFavoriteConfig>(
        `/api/admin/auto-favorite-targets/${selectedNodeNum}?sourceId=${encodeURIComponent(sourceId)}`
      );
      setConfig(data);
    } catch (error: any) {
      showToast(error?.message || t('auto_favorite.load_failed', 'Failed to load auto-favorite config'), 'error');
      setConfig(null);
    } finally {
      setIsLoading(false);
    }
  }, [selectedNodeNum, sourceId, showToast, t]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const update = useCallback((patch: Partial<AutoFavoriteConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const toggleRole = useCallback((role: number) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const has = prev.eligibleRoles.includes(role);
      const eligibleRoles = has ? prev.eligibleRoles.filter((r) => r !== role) : [...prev.eligibleRoles, role];
      return { ...prev, eligibleRoles };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (selectedNodeNum === null || !sourceId || !config) return;
    setIsSaving(true);
    try {
      await apiService.put(`/api/admin/auto-favorite-targets/${selectedNodeNum}`, {
        sourceId,
        enabled: config.enabled,
        useNeighborInfo: config.useNeighborInfo,
        useTraceroutes: config.useTraceroutes,
        intervalHours: config.intervalHours,
        maxNewPerCycle: config.maxNewPerCycle,
        maxRefavoritePerCycle: config.maxRefavoritePerCycle,
        eligibleRoles: config.eligibleRoles,
      });
      showToast(t('auto_favorite.saved', 'Auto-favorite settings saved'), 'success');
      await loadConfig();
    } catch (error: any) {
      showToast(error?.message || t('auto_favorite.save_failed', 'Failed to save auto-favorite settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [selectedNodeNum, sourceId, config, showToast, t, loadConfig]);

  const handleRunNow = useCallback(async () => {
    if (selectedNodeNum === null || !sourceId) return;
    if (!confirm(t('auto_favorite.run_now_confirm', 'Run one discovery + favorite cycle now? This sends several packets over the mesh.'))) {
      return;
    }
    setIsRunning(true);
    try {
      const result = await apiService.post<{ ran: boolean; reason?: string; discoveredNeighbors: number; newlyFavorited: number[]; reFavorited: number[] }>(
        `/api/admin/auto-favorite-targets/${selectedNodeNum}/run`,
        { sourceId }
      );
      if (!result.ran) {
        showToast(t('auto_favorite.run_skipped', 'Cycle skipped: {{reason}}', { reason: result.reason || 'unknown' }), 'error');
      } else {
        showToast(
          t('auto_favorite.run_done', 'Cycle complete: {{new}} new, {{re}} re-favorited ({{found}} neighbors found)', {
            new: result.newlyFavorited.length,
            re: result.reFavorited.length,
            found: result.discoveredNeighbors,
          }),
          'success'
        );
      }
      await loadConfig();
    } catch (error: any) {
      showToast(error?.message || t('auto_favorite.run_failed', 'Failed to run auto-favorite cycle'), 'error');
    } finally {
      setIsRunning(false);
    }
  }, [selectedNodeNum, sourceId, showToast, t, loadConfig]);

  const formatTime = (ts: number | null) => {
    if (!ts) return t('auto_favorite.never', 'Never');
    return new Date(ts).toLocaleString();
  };

  const checkboxRow = (label: string, description: string, checked: boolean, onChange: (v: boolean) => void) => (
    <div className="setting-item">
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ marginTop: '0.25rem' }}
        />
        <span>
          {label}
          <span className="setting-description">{description}</span>
        </span>
      </label>
    </div>
  );

  const numberRow = (label: string, description: string, value: number, min: number, onChange: (v: number) => void) => (
    <div className="setting-item">
      <label>
        {label}
        <span className="setting-description">{description}</span>
      </label>
      <input
        type="number"
        className="setting-input"
        min={min}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          onChange(Number.isFinite(n) ? Math.max(min, n) : min);
        }}
        style={{ maxWidth: '160px' }}
      />
    </div>
  );

  return (
    <div id="admin-auto-favorites" className="settings-section">
      <h3>⭐ {t('auto_favorite.title', 'Automatic Favorites Management')}</h3>

      <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '0.75rem' }}>
        {t('auto_favorite.description',
          'Automatically keep the favorites list up to date on this remote node. MeshMonitor discovers the node’s neighbors (from NeighborInfo broadcasts and/or traceroutes that pass through it) and sends set-favorite commands via Remote Admin, preserving zero-hop routing as your mesh changes.')}
      </p>

      <div style={{
        border: '1px solid var(--ctp-surface2)',
        background: 'var(--ctp-mantle)',
        borderRadius: '8px',
        padding: '0.75rem 1rem',
        marginBottom: '1.25rem',
        color: 'var(--ctp-subtext1)',
        fontSize: '0.9rem',
        lineHeight: 1.5,
      }}>
        <strong>⚠️ {t('auto_favorite.caveats_title', 'Before you enable this')}</strong>
        <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
          <li>
            {t('auto_favorite.caveat_no_ack',
              'There is no confirmation that a favorite was actually set — favorite commands are sent blindly over LoRa with no acknowledgement. The "re-favorite per cycle" option re-sends previously assigned favorites to re-assert them in case the original command was dropped by the mesh.')}
          </li>
          <li>
            {t('auto_favorite.caveat_heavy',
              'This is a heavy operation. Each favorite requires multiple packets per transaction (including a session-passkey handshake), so use it sparingly — keep the per-cycle limits low and the interval long.')}
          </li>
        </ul>
      </div>

      {selectedNodeNum === null || !sourceId ? (
        <p style={{ color: 'var(--ctp-subtext0)' }}>
          {t('auto_favorite.select_target', 'Select a target node above to configure automatic favorites management.')}
        </p>
      ) : isLoading || !config ? (
        <p style={{ color: 'var(--ctp-subtext0)' }}>{t('auto_favorite.loading', 'Loading…')}</p>
      ) : (
        <>
          {checkboxRow(
            t('auto_favorite.enabled', 'Enable automatic favorites management'),
            t('auto_favorite.enabled_desc', 'Run discovery + favorite cycles for this target on the schedule below.'),
            config.enabled,
            (v) => update({ enabled: v })
          )}

          <h4 style={{ marginTop: '1.25rem', marginBottom: '0.5rem', color: 'var(--ctp-text)' }}>
            {t('auto_favorite.discovery_modes', 'Discovery modes')}
          </h4>
          {checkboxRow(
            t('auto_favorite.use_neighborinfo', 'Use NeighborInfo'),
            t('auto_favorite.use_neighborinfo_desc', 'Periodically request NeighborInfo from the target and favorite newly discovered neighbors. The target must have the NeighborInfo module enabled.'),
            config.useNeighborInfo,
            (v) => update({ useNeighborInfo: v })
          )}
          {checkboxRow(
            t('auto_favorite.use_traceroutes', 'Use Traceroutes'),
            t('auto_favorite.use_traceroutes_desc', 'Identify the target’s neighbors from any traceroutes that pass through it, and favorite them.'),
            config.useTraceroutes,
            (v) => update({ useTraceroutes: v })
          )}

          <h4 style={{ marginTop: '1.25rem', marginBottom: '0.5rem', color: 'var(--ctp-text)' }}>
            {t('auto_favorite.timing_limits', 'Timing & limits')}
          </h4>
          {numberRow(
            t('auto_favorite.interval_hours', 'Cycle interval (hours)'),
            t('auto_favorite.interval_hours_desc', 'How often to request neighbor info and run a favorite cycle. Default 24 hours.'),
            config.intervalHours, 1,
            (v) => update({ intervalHours: v })
          )}
          {numberRow(
            t('auto_favorite.max_new', 'Maximum new neighbors per cycle'),
            t('auto_favorite.max_new_desc', 'Cap on how many newly discovered neighbors are favorited each cycle. Default 1.'),
            config.maxNewPerCycle, 0,
            (v) => update({ maxNewPerCycle: v })
          )}
          {numberRow(
            t('auto_favorite.max_refavorite', 'Maximum re-favorite per cycle'),
            t('auto_favorite.max_refavorite_desc', 'Re-send this many previously assigned favorites each cycle to re-assert assignments that may have been dropped. Default 1.'),
            config.maxRefavoritePerCycle, 0,
            (v) => update({ maxRefavoritePerCycle: v })
          )}

          <h4 style={{ marginTop: '1.25rem', marginBottom: '0.5rem', color: 'var(--ctp-text)' }}>
            {t('auto_favorite.eligible_roles', 'Eligible neighbor roles')}
          </h4>
          <p className="setting-description" style={{ marginTop: 0 }}>
            {t('auto_favorite.eligible_roles_desc', 'Only neighbors with one of these roles will be favorited.')}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.5rem' }}>
            {SELECTABLE_ROLES.map((role) => (
              <label key={role} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={config.eligibleRoles.includes(role)}
                  onChange={() => toggleRole(role)}
                />
                <span>{ROLE_NAMES[role] || `Role ${role}`}</span>
              </label>
            ))}
          </div>

          <h4 style={{ marginTop: '1.25rem', marginBottom: '0.5rem', color: 'var(--ctp-text)' }}>
            {t('auto_favorite.status', 'Status')}
          </h4>
          <div className="setting-description" style={{ marginBottom: '0.75rem' }}>
            <div>{t('auto_favorite.last_run', 'Last cycle')}: {formatTime(config.lastRunAt)}</div>
            <div>{t('auto_favorite.last_neighbor_request', 'Last NeighborInfo request')}: {formatTime(config.lastNeighborRequestAt)}</div>
            <div>{t('auto_favorite.managed_count', 'Favorites managed on this target')}: {config.assignments.length}</div>
          </div>
          {config.assignments.length > 0 && (
            <div style={{
              maxHeight: '180px',
              overflowY: 'auto',
              border: '1px solid var(--ctp-surface1)',
              borderRadius: '6px',
              marginBottom: '1rem',
            }}>
              {config.assignments.map((a) => (
                <div key={a.favoriteNodeNum} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '0.4rem 0.75rem',
                  borderBottom: '1px solid var(--ctp-surface0)',
                  fontSize: '0.85rem',
                }}>
                  <span>{nodeLabel(a.favoriteNodeNum)}</span>
                  <span style={{ color: 'var(--ctp-subtext0)' }}>
                    {t('auto_favorite.last_sent', 'last sent')}: {formatTime(a.lastAssignedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={isSaving}
              style={{ opacity: isSaving ? 0.6 : 1 }}
            >
              {isSaving ? t('auto_favorite.saving', 'Saving…') : t('auto_favorite.save', 'Save Settings')}
            </button>
            <button
              className="btn"
              onClick={handleRunNow}
              disabled={isRunning}
              style={{ opacity: isRunning ? 0.6 : 1 }}
              title={t('auto_favorite.run_now_title', 'Run one cycle immediately (sends packets over the mesh)')}
            >
              {isRunning ? t('auto_favorite.running', 'Running…') : `▶️ ${t('auto_favorite.run_now', 'Run Cycle Now')}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default AutoFavoriteManagementSection;
