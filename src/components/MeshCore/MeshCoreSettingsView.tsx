import React, { useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ConnectionStatus, DiscoveredNode, MeshCoreActions, SavedRegion } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { UiIcon } from '../icons';
import { MeshCoreNodeDisplaySection } from './MeshCoreNodeDisplaySection';
import { MeshCoreReceiveOnlyNote } from './MeshCoreReceiveOnlyNote';

// MeshCoreDeviceType.COMPANION — active discovery is companion-only.
const DEVICE_TYPE_COMPANION = 1;

interface MeshCoreSettingsViewProps {
  status: ConnectionStatus | null;
  loading: boolean;
  actions: MeshCoreActions;
  /** App base URL (appBasename) — passed through to MeshCoreNodeDisplaySection (#4412 Phase 4 WP2). */
  baseUrl: string;
  /** Source UUID — passed through to MeshCoreNodeDisplaySection (#4412 Phase 4 WP2). */
  sourceId: string;
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2). Plumbed here in WP1; WP2 wires the toggle itself plus the
   *  gating of Send advert / Discover ×3 / Discover regions. */
  receiveOnly?: boolean;
}

export const MeshCoreSettingsView: React.FC<MeshCoreSettingsViewProps> = ({
  status,
  loading,
  actions,
  baseUrl,
  sourceId,
  receiveOnly = false,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const csrfFetch = useCsrfFetch();
  const queryClient = useQueryClient();
  const [savingReceiveOnly, setSavingReceiveOnly] = useState(false);
  const canPurgeMessages = hasPermission('messages', 'write');
  const [purgingMessages, setPurgingMessages] = useState(false);
  const connected = status?.connected ?? false;
  const isCompanion = status?.deviceType === DEVICE_TYPE_COMPANION;
  // Which discovery (if any) is currently running, so we can disable both
  // buttons and label the active one "Discovering…".
  const [discovering, setDiscovering] = useState<'nearby' | 'repeaters' | 'sensors' | null>(null);
  /**
   * Who answered the last sweep (#4516). Previously the run reported only
   * "N returned (M new)", which told a user nothing about *which* nodes are in
   * range. Reset at the start of every run, so the list always describes the
   * most recent sweep rather than accumulating across them.
   */
  const [discoveredNodes, setDiscoveredNodes] = useState<DiscoveredNode[] | null>(null);
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
    setDiscoveredNodes(null);
    try {
      const result = await actions.discoverNodes(mode);
      if (result) {
        setDiscoveredNodes(result.nodes);
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

  // Receive-only toggle (#4547 Phase 2 WP2). Enabling is the safe direction —
  // no confirm. Disabling resumes RF transmission, so that direction is
  // gated behind window.confirm (interview decision — see spec §3.2).
  const handleToggleReceiveOnly = useCallback(async (next: boolean) => {
    if (!next && !window.confirm(t(
      'meshcore.receive_only.disable_confirm',
      'Allow this MeshCore node to transmit again?\n\nMessages, adverts, path discovery, remote administration and every enabled automation will resume sending over the radio. Continue?',
    ))) {
      return;
    }
    setSavingReceiveOnly(true);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meshcoreReceiveOnly: next }),
        },
      );
      if (!res.ok) {
        showToast(t('meshcore.receive_only.save_failed', 'Failed to change receive-only mode'), 'error');
        return;
      }
      // Prefix match — hits this source's txStatus entry (and every other
      // source's, harmlessly) so every consumer of useTxStatus re-reads
      // within one tick. Same idiom as ConfigurationTab.tsx after a TX
      // config change.
      await queryClient.invalidateQueries({ queryKey: ['txStatus'] });
      showToast(
        t(
          next ? 'meshcore.receive_only.saved_on' : 'meshcore.receive_only.saved_off',
          next
            ? 'Receive-only mode enabled — this node will not transmit'
            : 'Receive-only mode disabled — this node can transmit again',
        ),
        'success',
      );
    } finally {
      setSavingReceiveOnly(false);
    }
  }, [baseUrl, sourceId, csrfFetch, queryClient, showToast, t]);

  const receiveOnlyTooltip = receiveOnly
    ? t('meshcore.receive_only.control_tooltip', 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.')
    : undefined;

  return (
    <div className="meshcore-form-view">
      <h2 style={{ color: 'var(--color-text)', marginBottom: '1rem' }}>
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
        <h3>{t('meshcore.receive_only.title', 'Receive-only mode')}</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={receiveOnly}
            disabled={savingReceiveOnly}
            onChange={(e) => void handleToggleReceiveOnly(e.target.checked)}
          />
          <span>{t('meshcore.receive_only.toggle_label', 'Strict receive-only (never transmit)')}</span>
        </label>
        <p className="hint">
          {t(
            'meshcore.receive_only.description',
            'Block every transmission from this MeshCore node. Messages, adverts, path discovery, remote CLI, logins, telemetry requests and all automations are held. Receiving, the packet log, the Analyzer Observer, contact and telemetry updates, and local serial configuration keep working.',
          )}
        </p>
        <p className="hint">
          {t(
            'meshcore.receive_only.firmware_caveat',
            'MeshCore firmware has no radio-level transmit switch, so MeshMonitor enforces this in software. Transmissions the node makes on its own — link-layer acknowledgements, and any advert schedule configured outside MeshMonitor — are not affected.',
          )}
        </p>
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
          <button
            onClick={() => void actions.sendAdvert()}
            disabled={!connected || loading || receiveOnly}
            title={receiveOnlyTooltip}
          >
            {t('meshcore.send_advert', 'Send advert')}
          </button>
        </div>
      </div>

      <MeshCoreNodeDisplaySection baseUrl={baseUrl} sourceId={sourceId} />

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
              disabled={!connected || loading || discovering !== null || discoveringRegions || receiveOnly}
              title={receiveOnlyTooltip}
            >
              {discovering === 'nearby'
                ? t('meshcore.discover.running', 'Discovering…')
                : t('meshcore.discover.nearby', 'Discover Nearby Nodes')}
            </button>
            <button
              onClick={() => void handleDiscover('repeaters')}
              disabled={!connected || loading || discovering !== null || discoveringRegions || receiveOnly}
              title={receiveOnlyTooltip}
            >
              {discovering === 'repeaters'
                ? t('meshcore.discover.running', 'Discovering…')
                : t('meshcore.discover.repeaters', 'Discover Repeaters')}
            </button>
            <button
              onClick={() => void handleDiscover('sensors')}
              disabled={!connected || loading || discovering !== null || discoveringRegions || receiveOnly}
              title={receiveOnlyTooltip}
            >
              {discovering === 'sensors'
                ? t('meshcore.discover.running', 'Discovering…')
                : t('meshcore.discover.sensors', 'Discover Sensors')}
            </button>
          </div>

          {/* Who answered the last sweep (#4516). A discovery response carries
              only key + type + signal, so a name is present only for a node
              that has advertised or answered the ANON_REQ OWNER pass. */}
          {discoveredNodes && discoveredNodes.length > 0 && (
            <div style={{ marginTop: '0.75rem', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-surface-hover)', textAlign: 'left' }}>
                    <th style={{ padding: '0.25rem 0.5rem' }}>
                      {t('meshcore.discover.col_node', 'Node')}
                    </th>
                    <th style={{ padding: '0.25rem 0.5rem', fontFamily: 'var(--font-mono, monospace)' }}>
                      {t('meshcore.discover.col_key', 'Key')}
                    </th>
                    <th style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
                      {t('meshcore.contact_details.ping_zero_hop_snr_in', 'SNR here')}
                    </th>
                    <th style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
                      {t('meshcore.contact_details.ping_zero_hop_snr_out', 'SNR at node')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {discoveredNodes.map((node) => (
                    <tr key={node.publicKey} style={{ borderBottom: '1px solid var(--color-surface)' }}>
                      <td style={{ padding: '0.25rem 0.5rem' }}>
                        {node.name || (
                          <span style={{ opacity: 0.6 }}>
                            {t('meshcore.discover.unnamed', 'Unknown')}
                          </span>
                        )}
                        {node.isNew && (
                          <span
                            style={{
                              marginLeft: '0.4rem', padding: '0 0.3rem', borderRadius: 4,
                              fontSize: '0.75em', fontWeight: 600,
                              color: 'var(--color-bg)', background: 'var(--color-success)',
                            }}
                          >
                            {t('meshcore.discover.new_badge', 'NEW')}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '0.25rem 0.5rem', fontFamily: 'var(--font-mono, monospace)' }}>
                        {node.publicKey.substring(0, 12)}…
                      </td>
                      <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
                        {node.snr !== null ? `${node.snr.toFixed(2)} dB` : '—'}
                      </td>
                      <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
                        {node.snrToNode !== null ? `${node.snrToNode.toFixed(2)} dB` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

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
          <MeshCoreReceiveOnlyNote receiveOnly={receiveOnly} />
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
              disabled={!connected || loading || discoveringRegions || discovering !== null || receiveOnly}
              title={receiveOnlyTooltip}
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
                        padding: '0.1rem 0.3rem', borderRadius: 999, border: '1px solid var(--color-accent)',
                        background: scopeInput.trim().replace(/^#/, '') === region ? 'var(--color-accent)' : 'transparent',
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
                  border: '1px solid var(--color-surface-active)', background: 'var(--color-surface)',
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
          <div style={{ color: 'var(--color-text-subtle)', fontSize: '0.85rem', lineHeight: 1.7 }}>
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
          <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.85rem', lineHeight: 1.6 }}>
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
