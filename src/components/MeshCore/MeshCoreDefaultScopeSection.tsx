/**
 * MeshCoreDefaultScopeSection — default region / scope (#3667), on Device
 * Configuration.
 *
 * The scope is the flood scope MeshMonitor sets on the device for outgoing
 * traffic that has no channel scope, so it is device configuration. It sat on
 * the Settings tab until the #5683 follow-up. Reads and writes are the ones it
 * always used:
 *
 *   GET / POST …/meshcore/config/default-scope {scope}   `configuration`
 *   POST …/meshcore/regions/discover                     `nodes:write`, TX
 *   GET / POST …/meshcore/saved-regions                  (the saved catalogue)
 *
 * "Discover regions from repeaters" TRANSMITS. It runs only when its button is
 * pressed, is held in receive-only mode, and is gated on its own grant
 * (`nodes:write`), not on the grant that opened the page.
 *
 * The saved-regions catalogue itself is a list MeshMonitor keeps, so it stays
 * on the Settings tab. This section only reads it, to mark a discovered region
 * that is already saved and to offer saving one that is not.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreActions, SavedRegion } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { UiIcon } from '../icons';
import { CollapsibleSection } from './CollapsibleSection';
import styles from './MeshCoreDeviceSettingSections.module.css';

export interface MeshCoreDefaultScopeSectionProps {
  connected: boolean;
  loading?: boolean;
  actions: Pick<
    MeshCoreActions,
    'getDefaultScope' | 'setDefaultScope' | 'discoverRegions' | 'fetchSavedRegions' | 'addSavedRegion'
  >;
  /** Strict receive-only mode: region discovery is held. */
  receiveOnly?: boolean;
  /** `configuration:write` on this source: saving the scope. */
  canWriteConfig: boolean;
  /** `nodes:write` on this source: the region sweep. */
  canWriteNodes: boolean;
  /** Another radio sweep (node discovery) is running: hold region discovery. */
  otherSweepRunning?: boolean;
  /** Told when a region sweep starts and ends, so the other sweep can hold too. */
  onSweepRunningChange?: (running: boolean) => void;
}

const normalize = (value: string) => value.trim().replace(/^#/, '');

export const MeshCoreDefaultScopeSection: React.FC<MeshCoreDefaultScopeSectionProps> = ({
  connected,
  loading = false,
  actions,
  receiveOnly = false,
  canWriteConfig,
  canWriteNodes,
  otherSweepRunning = false,
  onSweepRunningChange,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { getDefaultScope, setDefaultScope, discoverRegions, fetchSavedRegions, addSavedRegion } = actions;

  // `defaultScope` is the persisted value; `scopeInput` is the editable field
  // (so the Save button can show a dirty state).
  const [defaultScope, setDefaultScopeState] = useState('');
  const [scopeInput, setScopeInput] = useState('');
  const [savingScope, setSavingScope] = useState(false);
  // Region discovery (#3667 phase 3): names served by nearby repeaters.
  const [discoveredRegions, setDiscoveredRegions] = useState<string[] | null>(null);
  const [discoveringRegions, setDiscoveringRegions] = useState(false);
  // Saved-regions catalogue (#3770), read to mark what is already saved.
  const [savedRegions, setSavedRegions] = useState<SavedRegion[]>([]);
  const [savingRegion, setSavingRegion] = useState(false);

  const savedRegionNames = useMemo(
    () => new Set(savedRegions.map((r) => r.name.toLowerCase())),
    [savedRegions],
  );

  const refreshSavedRegions = useCallback(async () => {
    const rows = await fetchSavedRegions();
    if (rows) setSavedRegions(rows);
  }, [fetchSavedRegions]);

  useEffect(() => {
    if (!connected) return;
    void getDefaultScope().then((s) => { setDefaultScopeState(s); setScopeInput(s); });
  }, [connected, getDefaultScope]);

  useEffect(() => {
    void refreshSavedRegions();
  }, [refreshSavedRegions]);

  const handleSaveScope = async () => {
    setSavingScope(true);
    try {
      const result = await setDefaultScope(scopeInput);
      if (result === null) {
        showToast(t('meshcore.scope.save_failed', 'Failed to save default scope'), 'error');
        return;
      }
      setDefaultScopeState(result);
      setScopeInput(result);
      setDiscoveredRegions(null); // collapse the suggestion chips once applied
      showToast(t('meshcore.scope.saved', 'Default scope saved'), 'success');
    } finally {
      setSavingScope(false);
    }
  };

  const handleDiscoverRegions = async () => {
    setDiscoveringRegions(true);
    onSweepRunningChange?.(true);
    try {
      const result = await discoverRegions();
      if (!result) {
        showToast(t('meshcore.scope.discover_failed', 'Failed to discover regions'), 'error');
        return;
      }
      setDiscoveredRegions(result.regions);
      if (result.noZeroHopRepeaters) {
        showToast(
          t('meshcore.scope.discover_no_repeaters', 'No nearby (0-hop) repeaters found. Move closer to a repeater and try again.'),
          'info',
        );
      } else if (result.regions.length === 0) {
        showToast(
          t('meshcore.scope.discover_none', 'Nearby repeaters reported no regions.'),
          'info',
        );
      }
    } finally {
      setDiscoveringRegions(false);
      onSweepRunningChange?.(false);
    }
  };

  const handleSaveRegion = async (name: string) => {
    const trimmed = normalize(name);
    if (!trimmed) return;
    setSavingRegion(true);
    try {
      const saved = await addSavedRegion(trimmed);
      if (!saved) {
        showToast(t('meshcore.regions.save_failed', 'Failed to save region'), 'error');
        return;
      }
      await refreshSavedRegions();
      showToast(t('meshcore.regions.saved', 'Region "{{name}}" saved', { name: saved.name }), 'success');
    } finally {
      setSavingRegion(false);
    }
  };

  const receiveOnlyTooltip = receiveOnly
    ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.')
    : undefined;
  const needsNodesWrite = t(
    'meshcore.device_actions.needs_nodes_write',
    'This needs the Nodes write permission on this source.',
  );
  const scopeDisabled = !canWriteConfig || !connected || loading || savingScope;

  return (
    <CollapsibleSection title={t('meshcore.scope.title', 'Default region / scope')} className="form-section">
      <div id="meshcore-default-scope">
        <p className="hint">
          {t('meshcore.scope.hint',
            'Region applied to all outgoing flood traffic (direct messages, adverts, requests) that has no channel-specific scope. ' +
            'Use a large region that includes you and the contacts you message — both your messages and the returning ACKs are scoped to it. ' +
            'Leave blank to send unscoped (legacy). Letters, digits and hyphens only.')}
        </p>
        <div className={styles.row}>
          <input
            type="text"
            className={styles.grow}
            value={scopeInput}
            onChange={(e) => setScopeInput(e.target.value)}
            placeholder={t('meshcore.scope.placeholder', 'e.g. muenchen — blank for unscoped')}
            aria-label={t('meshcore.scope.title', 'Default region / scope')}
            disabled={scopeDisabled}
            maxLength={63}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => void handleSaveScope()}
            disabled={scopeDisabled || normalize(scopeInput) === defaultScope}
            aria-label={t('meshcore.scope.save', 'Save default scope')}
          >
            {savingScope ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>

        <div className={styles.block}>
          <button
            type="button"
            onClick={() => void handleDiscoverRegions()}
            disabled={!canWriteNodes || !connected || loading || discoveringRegions || otherSweepRunning || receiveOnly}
            title={!canWriteNodes ? needsNodesWrite : receiveOnlyTooltip}
          >
            {discoveringRegions
              ? t('meshcore.scope.discovering', 'Discovering regions…')
              : t('meshcore.scope.discover', 'Discover regions from repeaters')}
          </button>
          <p className={`hint ${styles.smallHint}`}>
            {t('meshcore.scope.discover_hint',
              'Sweeps for nearby (0-hop / direct-range) repeaters and asks each one which regions it serves.')}
          </p>
          {discoveredRegions && discoveredRegions.length > 0 && (
            <div className={styles.chips}>
              {discoveredRegions.map((region) => {
                const isSaved = savedRegionNames.has(region.toLowerCase());
                const selected = normalize(scopeInput) === region;
                return (
                  <span key={region} className={`${styles.chip} ${selected ? styles.chipSelected : ''}`.trim()}>
                    <button
                      type="button"
                      className={styles.chipButton}
                      onClick={() => setScopeInput(region)}
                      title={t('meshcore.scope.use_region', 'Use "{{region}}" as the default scope', { region })}
                    >
                      {region}
                    </button>
                    <button
                      type="button"
                      className={styles.chipSave}
                      disabled={isSaved || savingRegion}
                      onClick={() => void handleSaveRegion(region)}
                      title={isSaved
                        ? t('meshcore.regions.already_saved', 'Already in saved regions')
                        : t('meshcore.regions.save_this', 'Save "{{region}}" to your regions list', { region })}
                    >
                      <UiIcon name={isSaved ? 'check' : 'plus'} size={14} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
};

export default MeshCoreDefaultScopeSection;
