import React, { useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ConnectionStatus, MeshCoreActions, SavedRegion } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { UiIcon } from '../icons';
import { MeshCoreNodeDisplaySection } from './MeshCoreNodeDisplaySection';
import { MeshCoreReceiveOnlyNote } from './MeshCoreReceiveOnlyNote';
import { MeshCoreDeviceActionsSection } from './MeshCoreDeviceActionsSection';
import { MovedSettingNote } from '../common/MovedSettingNote';
import { GlobalSettingsLink } from '../nav/GlobalSettingsLink';
import { MeshCoreIgnoredNodesSection } from './MeshCoreIgnoredNodesSection';
import { MeshCoreMessageFiltersSection } from './MeshCoreMessageFiltersSection';
import { MeshCoreContactSyncSection } from './MeshCoreContactSyncSection';

/**
 * MeshCoreSettingsView — what MeshMonitor stores and does for this MeshCore
 * source: connect / disconnect, software receive-only, whether MeshMonitor
 * answers discovery requests, node display, ignore and filter lists, the
 * saved-regions catalogue, and purging stored messages.
 *
 * What is written to or done on the radio lives on Device Configuration
 * (#5683 follow-up): default path hash size, default region / scope, radio
 * contact list sync, and the device actions (Refresh contacts, Send advert,
 * Discover nodes). A short pointer stays where each used to be.
 *
 * A viewer who cannot open Device Configuration (no `configuration:read`)
 * keeps the contact sync and the device actions here: their routes check
 * `nodes:write` / `connection:write`, not `configuration`, so moving them
 * must not take them out of that viewer's reach.
 */

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
  /** The viewer may open the Device Configuration tab (`configuration:read`).
   *  Default true; MeshCorePage passes the nav's own answer. */
  canOpenDeviceConfiguration?: boolean;
  /** Switches to the Device Configuration tab: the link in each pointer. */
  onOpenDeviceConfiguration?: () => void;
}

export const MeshCoreSettingsView: React.FC<MeshCoreSettingsViewProps> = ({
  status,
  loading,
  actions,
  baseUrl,
  sourceId,
  receiveOnly = false,
  canOpenDeviceConfiguration = true,
  onOpenDeviceConfiguration,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const csrfFetch = useCsrfFetch();
  const queryClient = useQueryClient();
  const [savingReceiveOnly, setSavingReceiveOnly] = useState(false);
  const canPurgeMessages = hasPermission('messages', 'write');
  // "Respond to discovery" is saved through POST …/config/discoverable, which
  // checks `configuration:write`, not the `settings` grant that opens this tab.
  const canWriteConfig = hasPermission('configuration', 'write');
  const [purgingMessages, setPurgingMessages] = useState(false);
  const connected = status?.connected ?? false;
  const isCompanion = status?.deviceType === DEVICE_TYPE_COMPANION;
  // "Be discoverable" toggle — whether we answer inbound discovery requests.
  const [discoverable, setDiscoverableState] = useState(false);
  const {
    getDiscoverable, setDiscoverable,
    fetchSavedRegions, addSavedRegion, deleteSavedRegion,
  } = actions;

  // Saved-regions catalog (#3770) — a user-maintained list of region names.
  const [savedRegions, setSavedRegions] = useState<SavedRegion[]>([]);
  const [newRegionInput, setNewRegionInput] = useState('');
  const [savingRegion, setSavingRegion] = useState(false);

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
    }
  }, [connected, isCompanion, getDiscoverable]);

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

  const handleToggleDiscoverable = async () => {
    const next = !discoverable;
    setDiscoverableState(next); // optimistic
    const ok = await setDiscoverable(next);
    if (!ok) {
      setDiscoverableState(!next); // revert on failure
      showToast(t('meshcore.discover.toggle_failed', 'Failed to update setting'), 'error');
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

  const openDeviceConfiguration = canOpenDeviceConfiguration ? onOpenDeviceConfiguration : undefined;
  const deviceConfigurationLink = t('moved.open_device_configuration', 'Open Device Configuration');
  const needsConfigRead = t(
    'moved.meshcore_needs_configuration_read',
    'That page needs the Device Configuration read permission on this source.',
  );

  return (
    <div className="meshcore-form-view">
      <h2 style={{ color: 'var(--color-text)', marginBottom: '1rem' }}>
        {t('nav.settings', 'Settings')}
      </h2>
      <GlobalSettingsLink variant="inline" />

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
        <p className="hint" data-testid="receive-only-why-here">
          {t(
            'meshcore.receive_only.why_here',
            'That makes this a MeshMonitor setting, so it is on Settings and not on Device Configuration.',
          )}
        </p>
      </div>

      {/* Radio contact list sync and the device actions live on Device
          Configuration (#5683 follow-up). A viewer who cannot open that page
          keeps them here: see the module comment. */}
      {canOpenDeviceConfiguration ? (
        <MovedSettingNote
          testId="meshcore-actions-moved"
          text={t(
            'moved.meshcore_actions',
            'Radio contact list sync, Refresh contacts, Send advert and Discover nodes moved to Device Configuration.',
          )}
          linkLabel={deviceConfigurationLink}
          onOpen={openDeviceConfiguration}
        />
      ) : (
        <>
          {isCompanion && (
            <MeshCoreContactSyncSection
              baseUrl={baseUrl}
              sourceId={sourceId}
              connected={connected}
              canEditConfig={canWriteConfig}
              canEditNodes={hasPermission('nodes', 'write')}
            />
          )}
          <MeshCoreDeviceActionsSection
            connected={connected}
            loading={loading}
            isCompanion={isCompanion}
            actions={actions}
            receiveOnly={receiveOnly}
            canWriteNodes={hasPermission('nodes', 'write')}
            canWriteConnection={hasPermission('connection', 'write')}
          />
        </>
      )}

      <MeshCoreNodeDisplaySection baseUrl={baseUrl} sourceId={sourceId} />

      {/* Ignore / Block (#5408) */}
      <MeshCoreIgnoredNodesSection sourceId={sourceId} />
      <MeshCoreMessageFiltersSection sourceId={sourceId} />

      {isCompanion && (
        <div className="form-section">
          <h3>{t('meshcore.discover.responder_title', 'Answer discovery requests')}</h3>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            title={!canWriteConfig
              ? t('meshcore.discover.respond_needs_config_write', 'Changing this needs the Device Configuration write permission on this source.')
              : undefined}
          >
            <input
              type="checkbox"
              checked={discoverable}
              disabled={!canWriteConfig || !connected || loading}
              onChange={() => void handleToggleDiscoverable()}
            />
            <span>{t('meshcore.discover.respond_label', 'Respond to discovery requests (let other nodes discover this one)')}</span>
          </label>
          <p className="hint">
            {t('meshcore.discover.respond_hint',
              'MeshCore companion firmware does not answer discovery on its own, so other nodes can only ' +
              'find this one when this is enabled. Replies are zero-hop (direct range) and rate-limited.')}
          </p>
          {!canWriteConfig && (
            <p className="hint" role="status">
              {t('meshcore.discover.respond_needs_config_write', 'Changing this needs the Device Configuration write permission on this source.')}
            </p>
          )}
          <MeshCoreReceiveOnlyNote receiveOnly={receiveOnly} />
        </div>
      )}

      {isCompanion && (
        <MovedSettingNote
          testId="meshcore-device-settings-moved"
          text={canOpenDeviceConfiguration
            ? t(
              'moved.meshcore_device_settings',
              'Default path hash size and default region / scope are written to the device, so they moved to Device Configuration.',
            )
            : `${t(
              'moved.meshcore_device_settings',
              'Default path hash size and default region / scope are written to the device, so they moved to Device Configuration.',
            )} ${needsConfigRead}`}
          linkLabel={deviceConfigurationLink}
          onOpen={openDeviceConfiguration}
        />
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
