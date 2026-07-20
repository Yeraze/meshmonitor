import React, { useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus, MeshCoreActions, SavedRegion } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { UiIcon } from '../icons';

// MeshCoreDeviceType.COMPANION — active discovery is companion-only.
const DEVICE_TYPE_COMPANION = 1;

interface MeshCoreSettingsViewProps {
  status: ConnectionStatus | null;
  loading: boolean;
  actions: MeshCoreActions;
}

export const MeshCoreSettingsView: React.FC<MeshCoreSettingsViewProps> = ({
  status,
  loading,
  actions,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canPurgeMessages = hasPermission('messages', 'write');
  const [purgingMessages, setPurgingMessages] = useState(false);
  const connected = status?.connected ?? false;
  const isCompanion = status?.deviceType === DEVICE_TYPE_COMPANION;
  // Which discovery (if any) is currently running, so we can disable both
  // buttons and label the active one "Discovering…".
  const [discovering, setDiscovering] = useState<'nearby' | 'repeaters' | 'sensors' | null>(null);
  // "Be discoverable" toggle — whether we answer inbound discovery requests.
  const [discoverable, setDiscoverableState] = useState(false);
  const {
    getDiscoverable, setDiscoverable, getDefaultScope, setDefaultScope, discoverRegions,
    fetchSavedRegions, addSavedRegion, deleteSavedRegion,
  } = actions;

  // Default region/scope (#3667). `defaultScope` is the persisted value;
  // `scopeInput` is the editable field (so we can show a dirty state).
  const [defaultScope, setDefaultScopeState] = useState('');
  const [scopeInput, setScopeInput] = useState('');
  const [savingScope, setSavingScope] = useState(false);
  // Region discovery (#3667 phase 3) — names served by nearby repeaters.
  const [discoveredRegions, setDiscoveredRegions] = useState<string[] | null>(null);
  const [discoveringRegions, setDiscoveringRegions] = useState(false);
  // Saved-regions catalog (#3770) — a user-maintained list of region names.
  const [savedRegions, setSavedRegions] = useState<SavedRegion[]>([]);
  const [newRegionInput, setNewRegionInput] = useState('');
  const [savingRegion, setSavingRegion] = useState(false);

  // Set of saved region names (lowercased) so discovered chips can show a
  // "saved" affordance / disable re-saving.
  const savedRegionNames = React.useMemo(
    () => new Set(savedRegions.map((r) => r.name.toLowerCase())),
    [savedRegions],
  );

  const refreshSavedRegions = useCallback(async () => {
    const rows = await fetchSavedRegions();
    if (rows) setSavedRegions(rows);
  }, [fetchSavedRegions]);

  // Purge every MeshCore message (channel + DM) for this source (#3981).
  // Destructive and irreversible — double-confirm and surface the result.
  const handlePurgeAllMessages = useCallback(async () => {
    if (!window.confirm(t(
      'meshcore.settings.confirm_purge_all_messages',
      'Delete ALL MeshCore messages (every channel and DM) for this source? This cannot be undone.',
    ))) return;
    setPurgingMessages(true);
    try {
      const ok = await actions.purgeAllMessages();
      showToast(
        ok
          ? t('meshcore.settings.purge_all_messages_done', 'All MeshCore messages purged')
          : t('meshcore.settings.purge_all_messages_failed', 'Failed to purge messages'),
        ok ? 'success' : 'error',
      );
    } finally {
      setPurgingMessages(false);
    }
  }, [actions, showToast, t]);

  useEffect(() => {
    if (connected && isCompanion) {
      void getDiscoverable().then(setDiscoverableState);
      void getDefaultScope().then((s) => { setDefaultScopeState(s); setScopeInput(s); });
    }
  }, [connected, isCompanion, getDiscoverable, getDefaultScope]);

  // Load the saved-regions catalog (global; not gated on connection).
  useEffect(() => {
    void refreshSavedRegions();
  }, [refreshSavedRegions]);

  const handleSaveRegion = async (name: string) => {
    const trimmed = name.trim().replace(/^#/, '');
    if (!trimmed) return;
    setSavingRegion(true);
    try {
      const saved = await addSavedRegion(trimmed);
      if (!saved) {
        showToast(t('meshcore.regions.save_failed', 'Failed to save region'), 'error');
        return;
      }
      await refreshSavedRegions();
      setNewRegionInput('');
      showToast(t('meshcore.regions.saved', 'Region "{{name}}" saved', { name: saved.name }), 'success');
    } finally {
      setSavingRegion(false);
    }
  };

  const handleDeleteRegion = async (region: SavedRegion) => {
    const ok = await deleteSavedRegion(region.id);
    if (!ok) {
      showToast(t('meshcore.regions.delete_failed', 'Failed to delete region'), 'error');
      return;
    }
    await refreshSavedRegions();
  };

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
    }
  };

  const handleToggleDiscoverable = async () => {
    const next = !discoverable;
    setDiscoverableState(next); // optimistic
    const ok = await setDiscoverable(next);
    if (!ok) {
      setDiscoverableState(!next); // revert on failure
      showToast(t('meshcore.discover.toggle_failed', 'Failed to update setting'), 'error');
    }
  };

  const handleDiscover = async (mode: 'nearby' | 'repeaters' | 'sensors') => {
    setDiscovering(mode);
    try {
      const result = await actions.discoverNodes(mode);
      if (result) {
        showToast(
          t('meshcore.discover.result', '{{returned}} contacts returned ({{new}} new)', {
            returned: result.returned,
            new: result.newCount,
          }),
          'success',
        );
      } else {
        showToast(t('meshcore.discover.failed', 'Discovery failed'), 'error');
      }
    } finally {
      setDiscovering(null);
    }
  };

  const handleConnect = async () => {
    // Connection params live in the saved source.config — the hook posts to
    // /api/sources/:id/connect with no body.
    await actions.connect();
  };

  return (
    <div className="meshcore-form-view">
      <h2 style={{ color: 'var(--ctp-text)', marginBottom: '1rem' }}>
        {t('meshcore.nav.settings', 'Settings')}
      </h2>

      <div className="form-section">
        <h3>{t('meshcore.connection', 'Connection')}</h3>
        {connected ? (
          <>
            <p className="hint">
              {t('meshcore.settings.currently_connected',
                'Currently connected. Disconnect first to change connection settings.')}
            </p>
            <div>
              <button className="disconnect" onClick={() => void actions.disconnect()} disabled={loading}>
                {t('meshcore.disconnect', 'Disconnect')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              {t('meshcore.settings.persource_hint',
                'Connection parameters are managed in the source configuration.')}
            </p>
            <div>
              <button onClick={() => void handleConnect()} disabled={loading}>
                {loading
                  ? t('meshcore.connecting', 'Connecting…')
                  : t('meshcore.connect', 'Connect')}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="form-section">
        <h3>{t('meshcore.settings.actions', 'Device actions')}</h3>
        <p className="hint">
          {t('meshcore.settings.actions_hint',
            'Refresh the contact list from the device or broadcast a fresh advert.')}
        </p>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => void actions.refreshContacts()} disabled={!connected || loading}>
            {t('meshcore.refresh', 'Refresh contacts')}
          </button>
          <button onClick={() => void actions.sendAdvert()} disabled={!connected || loading}>
            {t('meshcore.send_advert', 'Send advert')}
          </button>
        </div>
      </div>

      {isCompanion && (
        <div className="form-section">
          <h3>{t('meshcore.discover.title', 'Discover nodes')}</h3>
          <p className="hint">
            {t('meshcore.discover.hint',
              'Ask nodes in direct radio range to announce themselves. Responders are added as contacts. ' +
              'Multi-hop nodes will not appear — discovery is zero-hop.')}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => void handleDiscover('nearby')}
              disabled={!connected || loading || discovering !== null || discoveringRegions}
            >
              {discovering === 'nearby'
                ? t('meshcore.discover.running', 'Discovering…')
                : t('meshcore.discover.nearby', 'Discover Nearby Nodes')}
            </button>
            <button
              onClick={() => void handleDiscover('repeaters')}
              disabled={!connected || loading || discovering !== null || discoveringRegions}
            >
              {discovering === 'repeaters'
                ? t('meshcore.discover.running', 'Discovering…')
                : t('meshcore.discover.repeaters', 'Discover Repeaters')}
            </button>
            <button
              onClick={() => void handleDiscover('sensors')}
              disabled={!connected || loading || discovering !== null || discoveringRegions}
            >
              {discovering === 'sensors'
                ? t('meshcore.discover.running', 'Discovering…')
                : t('meshcore.discover.sensors', 'Discover Sensors')}
            </button>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem' }}>
            <input
              type="checkbox"
              checked={discoverable}
              disabled={!connected || loading}
              onChange={() => void handleToggleDiscoverable()}
            />
            <span>{t('meshcore.discover.respond_label', 'Respond to discovery requests (let other nodes discover this one)')}</span>
          </label>
          <p className="hint">
            {t('meshcore.discover.respond_hint',
              'MeshCore companion firmware does not answer discovery on its own, so other nodes can only ' +
              'find this one when this is enabled. Replies are zero-hop (direct range) and rate-limited.')}
          </p>
        </div>
      )}

      {isCompanion && (
        <div className="form-section">
          <h3>{t('meshcore.scope.title', 'Default region / scope')}</h3>
          <p className="hint">
            {t('meshcore.scope.hint',
              'Region applied to all outgoing flood traffic (direct messages, adverts, requests) that has no channel-specific scope. ' +
              'Use a large region that includes you and the contacts you message — both your messages and the returning ACKs are scoped to it. ' +
              'Leave blank to send unscoped (legacy). Letters, digits and hyphens only.')}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="text"
              value={scopeInput}
              onChange={(e) => setScopeInput(e.target.value)}
              placeholder={t('meshcore.scope.placeholder', 'e.g. muenchen — blank for unscoped')}
              disabled={!connected || loading || savingScope}
              maxLength={63}
              spellCheck={false}
              autoComplete="off"
              style={{ flex: 1 }}
            />
            <button
              onClick={() => void handleSaveScope()}
              disabled={!connected || loading || savingScope || scopeInput.trim().replace(/^#/, '') === defaultScope}
            >
              {savingScope ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <button
              onClick={() => void handleDiscoverRegions()}
              disabled={!connected || loading || discoveringRegions || discovering !== null}
            >
              {discoveringRegions
                ? t('meshcore.scope.discovering', 'Discovering regions…')
                : t('meshcore.scope.discover', 'Discover regions from repeaters')}
            </button>
            <p className="hint" style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
              {t('meshcore.scope.discover_hint',
                'Sweeps for nearby (0-hop / direct-range) repeaters and asks each one which regions it serves.')}
            </p>
            {discoveredRegions && discoveredRegions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.5rem' }}>
                {discoveredRegions.map((region) => {
                  const isSaved = savedRegionNames.has(region.toLowerCase());
                  return (
                    <span
                      key={region}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                        padding: '0.1rem 0.3rem', borderRadius: 999, border: '1px solid var(--ctp-blue)',
                        background: scopeInput.trim().replace(/^#/, '') === region ? 'var(--ctp-blue)' : 'transparent',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setScopeInput(region)}
                        title={t('meshcore.scope.use_region', 'Use "{{region}}" as the default scope', { region })}
                        style={{ padding: '0.1rem 0.3rem', border: 'none', background: 'transparent', cursor: 'pointer' }}
                      >
                        {region}
                      </button>
                      <button
                        type="button"
                        disabled={isSaved || savingRegion}
                        onClick={() => void handleSaveRegion(region)}
                        title={isSaved
                          ? t('meshcore.regions.already_saved', 'Already in saved regions')
                          : t('meshcore.regions.save_this', 'Save "{{region}}" to your regions list', { region })}
                        style={{
                          padding: '0.05rem 0.35rem', border: 'none', background: 'transparent',
                          cursor: isSaved ? 'default' : 'pointer', opacity: isSaved ? 0.5 : 1,
                        }}
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
      )}

      <div className="form-section">
        <h3>{t('meshcore.regions.title', 'Saved regions')}</h3>
        <p className="hint">
          {t('meshcore.regions.hint',
            'A list of region/scope names you maintain. Save regions reported by repeaters or add your own, ' +
            'then pick them when setting a channel scope or overriding the scope for a single message. ' +
            'Letters, digits and hyphens only.')}
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
          <input
            type="text"
            value={newRegionInput}
            onChange={(e) => setNewRegionInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveRegion(newRegionInput); }}
            placeholder={t('meshcore.regions.add_placeholder', 'e.g. muenchen')}
            disabled={savingRegion}
            maxLength={63}
            spellCheck={false}
            autoComplete="off"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => void handleSaveRegion(newRegionInput)}
            disabled={savingRegion || !newRegionInput.trim()}
          >
            {savingRegion ? t('common.saving', 'Saving…') : t('meshcore.regions.add', 'Add')}
          </button>
        </div>
        {savedRegions.length === 0 ? (
          <p className="hint" style={{ fontSize: '0.8rem' }}>
            {t('meshcore.regions.empty', 'No saved regions yet.')}
          </p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {savedRegions.map((region) => (
              <span
                key={region.id}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                  padding: '0.2rem 0.5rem', borderRadius: 999,
                  border: '1px solid var(--ctp-surface2)', background: 'var(--ctp-surface0)',
                }}
              >
                <span>{region.name}</span>
                <button
                  type="button"
                  onClick={() => void handleDeleteRegion(region)}
                  title={t('meshcore.regions.delete', 'Delete "{{name}}"', { name: region.name })}
                  aria-label={t('meshcore.regions.delete', 'Delete "{{name}}"', { name: region.name })}
                  style={{ padding: '0 0.2rem', border: 'none', background: 'transparent', cursor: 'pointer' }}
                >
                  <UiIcon name="close" size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {status?.localNode && (
        <div className="form-section">
          <h3>{t('meshcore.settings.local_node', 'Local node')}</h3>
          <div style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', lineHeight: 1.7 }}>
            <div>{t('meshcore.settings.name', 'Name')}: {status.localNode.name || '—'}</div>
            <div>{t('meshcore.settings.type', 'Type')}: {status.deviceTypeName}</div>
            <div>
              {t('meshcore.public_key', 'Public key')}:{' '}
              <span style={{ fontFamily: 'monospace' }}>
                {status.localNode.publicKey ?? '—'}
              </span>
            </div>
            {typeof status.localNode.radioFreq === 'number' && (
              <div>
                {t('meshcore.radio', 'Radio')}: {status.localNode.radioFreq} MHz,
                BW{status.localNode.radioBw}, SF{status.localNode.radioSf}, CR{status.localNode.radioCr}
              </div>
            )}
          </div>
        </div>
      )}

      {canPurgeMessages && (
        <div className="form-section">
          <h3>{t('meshcore.settings.message_data', 'Message data')}</h3>
          <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', lineHeight: 1.6 }}>
            {t(
              'meshcore.settings.purge_all_messages_desc',
              'Permanently delete every stored MeshCore message (all channels and direct messages) for this source.',
            )}
          </p>
          <button
            type="button"
            className="meshcore-purge-all-btn"
            onClick={() => void handlePurgeAllMessages()}
            disabled={purgingMessages}
          >
            <UiIcon name="delete" size={15} /> {purgingMessages
              ? t('meshcore.settings.purging', 'Purging…')
              : t('meshcore.settings.purge_all_messages', 'Purge all messages')}
          </button>
        </div>
      )}
    </div>
  );
};
