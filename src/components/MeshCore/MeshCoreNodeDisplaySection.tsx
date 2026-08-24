import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useNodeDisplaySettings, nodeDisplaySettingsQueryKey } from '../../hooks/useNodeDisplaySettings';
import { writeNodeDisplayLocal } from '../../utils/nodeDisplayStorage';
import {
  NODE_DISPLAY_RANGES,
  MAX_INFRA_NODE_AGE_HOURS_RANGE,
  type NodeDisplaySettingKey,
} from '../../constants/nodeDisplayDefaults';

interface MeshCoreNodeDisplaySectionProps {
  /** App base URL (appBasename), as every other MeshCore section takes it. */
  baseUrl: string;
  /** Source UUID — scopes GET/POST to /api/settings?sourceId=<id>. */
  sourceId: string;
}

/**
 * The four Node Display keys that have a MeshCore consumer (#4412 Phase 4
 * spec §2 D3). The other six (localStatsIntervalMinutes,
 * nodeHopsCalculation, hideIncompleteNodes, nodeDimmingEnabled,
 * nodeDimmingStartHours, nodeDimmingMinOpacity) have only Meshtastic-view
 * consumers and are deliberately omitted here.
 *
 * `satisfies` binds this list to the epic's key union, so deleting a key
 * from nodeDisplayDefaults.ts breaks the build here instead of drifting
 * silently.
 */
const MESHCORE_NODE_DISPLAY_KEYS = [
  'maxNodeAgeHours',
  'inactiveNodeThresholdHours',
  'inactiveNodeCheckIntervalMinutes',
  'inactiveNodeCooldownHours',
] as const satisfies readonly NodeDisplaySettingKey[];

/**
 * #4899: the Infrastructure age cutoff is a standalone per-source setting (NOT
 * one of the frozen ten Node Display keys), so it rides alongside the four
 * MeshCore keys in the draft and save body rather than in
 * `MESHCORE_NODE_DISPLAY_KEYS`.
 */
type MeshCoreNodeDisplayDraft =
  Record<typeof MESHCORE_NODE_DISPLAY_KEYS[number], number>
  & { maxInfraNodeAgeHours: number };

type MeshCoreNodeDisplayDraftKey = keyof MeshCoreNodeDisplayDraft;

/**
 * MeshCore Node Display settings section (#4412 Phase 4 WP2).
 *
 * Persists through the SAME per-source `/api/settings?sourceId=` endpoints
 * Phases 1-3 built for the Meshtastic `SettingsTab` — there is no
 * MeshCore-specific route for this data because these are not
 * MeshCore-specific settings; they are four of the ten rows in the shared
 * `settings` table. See PER_SOURCE_NODE_DISPLAY_PHASE4_SPEC.md D1.
 *
 * Reads through `useNodeDisplaySettings(sourceId)` so this section, the
 * Nodes list and the map all share one TanStack cache entry and can never
 * disagree.
 */
export const MeshCoreNodeDisplaySection: React.FC<MeshCoreNodeDisplaySectionProps> = ({
  baseUrl,
  sourceId,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = hasPermission('settings', 'write', { sourceId });

  const settings = useNodeDisplaySettings(sourceId);

  const buildDraft = useCallback((): MeshCoreNodeDisplayDraft => ({
    maxNodeAgeHours: settings.maxNodeAgeHours,
    maxInfraNodeAgeHours: settings.maxInfraNodeAgeHours,
    inactiveNodeThresholdHours: settings.inactiveNodeThresholdHours,
    inactiveNodeCheckIntervalMinutes: settings.inactiveNodeCheckIntervalMinutes,
    inactiveNodeCooldownHours: settings.inactiveNodeCooldownHours,
  }), [
    settings.maxNodeAgeHours,
    settings.maxInfraNodeAgeHours,
    settings.inactiveNodeThresholdHours,
    settings.inactiveNodeCheckIntervalMinutes,
    settings.inactiveNodeCooldownHours,
  ]);

  const [draft, setDraft] = useState<MeshCoreNodeDisplayDraft>(buildDraft);
  const [initial, setInitial] = useState<MeshCoreNodeDisplayDraft>(buildDraft);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Re-seed once the query resolves (the hook returns hardcoded defaults
  // until then) — same re-seed discipline as SettingsTab's buildBaseline.
  useEffect(() => {
    const next = buildDraft();
    setDraft(next);
    setInitial(next);
  }, [buildDraft]);

  useEffect(() => {
    setHasChanges(
      MESHCORE_NODE_DISPLAY_KEYS.some((k) => draft[k] !== initial[k])
      || draft.maxInfraNodeAgeHours !== initial.maxInfraNodeAgeHours,
    );
  }, [draft, initial]);

  const update = (key: MeshCoreNodeDisplayDraftKey, value: number) => {
    // Clearing a number input yields `parseInt(...) === NaN` — fall back to
    // the current draft value rather than letting NaN reach state, where it
    // would render as the literal string "NaN" and serialize the same way
    // in the save POST body (#4433 review).
    setDraft((prev) => ({ ...prev, [key]: Number.isNaN(value) ? prev[key] : value }));
  };

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...Object.fromEntries(MESHCORE_NODE_DISPLAY_KEYS.map((k) => [k, String(draft[k])])),
          // #4899: standalone key, POSTed alongside the four frozen ones.
          maxInfraNodeAgeHours: String(draft.maxInfraNodeAgeHours),
        }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('settings.node_display.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${res.status}`);
      }
      for (const k of MESHCORE_NODE_DISPLAY_KEYS) {
        writeNodeDisplayLocal(sourceId, k, String(draft[k]));
      }
      // Mandatory: without this the Nodes list and map keep filtering on the
      // stale cutoff until the next full page reload (#4412 Phase 4 spec R3).
      await queryClient.invalidateQueries({ queryKey: nodeDisplaySettingsQueryKey(sourceId) });
      setInitial(draft);
      setHasChanges(false);
      showToast(t('settings.node_display.settings_saved', 'Settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore Node Display settings:', err);
      showToast(t('settings.node_display.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [draft, baseUrl, sourceId, csrfFetch, queryClient, showToast, t]);

  const handleDismiss = useCallback(() => {
    setDraft(initial);
    setHasChanges(false);
  }, [initial]);

  useSaveBar({
    id: 'meshcore-node-display',
    sectionName: t('settings.node_display', 'Node Display'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const maxNodeAgeRange = NODE_DISPLAY_RANGES.maxNodeAgeHours!;
  const infraAgeRange = MAX_INFRA_NODE_AGE_HOURS_RANGE;
  const thresholdRange = NODE_DISPLAY_RANGES.inactiveNodeThresholdHours!;
  const checkIntervalRange = NODE_DISPLAY_RANGES.inactiveNodeCheckIntervalMinutes!;
  const cooldownRange = NODE_DISPLAY_RANGES.inactiveNodeCooldownHours!;

  return (
    <div className="form-section">
      <h3>{t('settings.node_display', 'Node Display')}</h3>

      <div className="setting-item">
        <label htmlFor="maxNodeAge">
          {t('settings.max_node_age_label', 'Maximum Age of Active Nodes (hours)')}
          <span className="setting-description">
            {t(
              'meshcore.settings.node_display.max_age_description',
              'Nodes not heard within this window are hidden from the Nodes list and the map. Favorites and your own node are always shown. This does not change which nodes Auto-Pathfinding targets — see Automations → Target Filter.',
            )}
          </span>
        </label>
        <input
          id="maxNodeAge"
          type="number"
          min={maxNodeAgeRange.min}
          max={maxNodeAgeRange.max}
          value={draft.maxNodeAgeHours}
          onChange={(e) => update('maxNodeAgeHours', parseInt(e.target.value, 10))}
          disabled={!canWrite}
          className="setting-input"
        />
      </div>

      <div className="setting-item">
        <label htmlFor="maxInfraNodeAge">
          {t('meshcore.settings.node_display.max_infra_age_label', 'Maximum Age of Infrastructure Nodes (hours)')}
          <span className="setting-description">
            {t(
              'meshcore.settings.node_display.max_infra_age_description',
              'A separate age window for Repeaters and Room Servers, which advertise infrequently (often days apart) and never send direct messages. Set higher than the companion window above so fixed infrastructure does not vanish from the Nodes list and map between adverts. Use 0 to never hide them.',
            )}
          </span>
        </label>
        <input
          id="maxInfraNodeAge"
          type="number"
          min={infraAgeRange.min}
          max={infraAgeRange.max}
          value={draft.maxInfraNodeAgeHours}
          onChange={(e) => update('maxInfraNodeAgeHours', parseInt(e.target.value, 10))}
          disabled={!canWrite}
          className="setting-input"
        />
      </div>

      <div className="setting-item">
        <label htmlFor="inactiveNodeThresholdHours">
          {t('settings.inactive_node_threshold_label', "Inactive Node Notification Threshold (hours)")}
          <span className="setting-description">
            {t(
              'settings.inactive_node_threshold_description',
              "Nodes that haven't been heard from for this many hours will trigger inactive node notifications (if enabled in Notifications tab)",
            )}
          </span>
        </label>
        <input
          id="inactiveNodeThresholdHours"
          type="number"
          min={thresholdRange.min}
          max={thresholdRange.max}
          value={draft.inactiveNodeThresholdHours}
          onChange={(e) => update('inactiveNodeThresholdHours', parseInt(e.target.value, 10))}
          disabled={!canWrite}
          className="setting-input"
        />
      </div>

      <div className="setting-item">
        <label htmlFor="inactiveNodeCheckIntervalMinutes">
          {t('settings.inactive_node_check_interval_label', 'Inactive Node Check Interval (minutes)')}
          <span className="setting-description">
            {t(
              'settings.inactive_node_check_interval_description',
              'How often to check for inactive nodes (1-1440 minutes, default: 60)',
            )}
          </span>
        </label>
        <input
          id="inactiveNodeCheckIntervalMinutes"
          type="number"
          min={checkIntervalRange.min}
          max={checkIntervalRange.max}
          value={draft.inactiveNodeCheckIntervalMinutes}
          onChange={(e) => update('inactiveNodeCheckIntervalMinutes', parseInt(e.target.value, 10))}
          disabled={!canWrite}
          className="setting-input"
        />
      </div>

      <div className="setting-item">
        <label htmlFor="inactiveNodeCooldownHours">
          {t('settings.inactive_node_cooldown_label', 'Inactive Node Notification Cooldown (hours)')}
          <span className="setting-description">
            {t(
              'settings.inactive_node_cooldown_description',
              'Minimum time between notifications for the same node (prevents spam, default: 24 hours)',
            )}
          </span>
        </label>
        <input
          id="inactiveNodeCooldownHours"
          type="number"
          min={cooldownRange.min}
          max={cooldownRange.max}
          value={draft.inactiveNodeCooldownHours}
          onChange={(e) => update('inactiveNodeCooldownHours', parseInt(e.target.value, 10))}
          disabled={!canWrite}
          className="setting-input"
        />
      </div>
    </div>
  );
};

export default MeshCoreNodeDisplaySection;
