import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';
import { useToast } from '../ToastContainer';

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
  const connected = status?.connected ?? false;
  const isCompanion = status?.deviceType === DEVICE_TYPE_COMPANION;
  // Which discovery (if any) is currently running, so we can disable both
  // buttons and label the active one "Discovering…".
  const [discovering, setDiscovering] = useState<'nearby' | 'repeaters' | 'sensors' | null>(null);
  // "Be discoverable" toggle — whether we answer inbound discovery requests.
  const [discoverable, setDiscoverableState] = useState(false);
  const { getDiscoverable, setDiscoverable, getDefaultScope, setDefaultScope, discoverRegions } = actions;

  // Default region/scope (#3667). `defaultScope` is the persisted value;
  // `scopeInput` is the editable field (so we can show a dirty state).
  const [defaultScope, setDefaultScopeState] = useState('');
  const [scopeInput, setScopeInput] = useState('');
  const [savingScope, setSavingScope] = useState(false);
  // Region discovery (#3667 phase 3) — names served by nearby repeaters.
  const [discoveredRegions, setDiscoveredRegions] = useState<string[] | null>(null);
  const [discoveringRegions, setDiscoveringRegions] = useState(false);

  useEffect(() => {
    if (connected && isCompanion) {
      void getDiscoverable().then(setDiscoverableState);
      void getDefaultScope().then((s) => { setDefaultScopeState(s); setScopeInput(s); });
    }
  }, [connected, isCompanion, getDiscoverable, getDefaultScope]);

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
                'Queries known repeaters for the regions they serve. Run "Discover Repeaters" (above) first for the fullest list.')}
            </p>
            {discoveredRegions && discoveredRegions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.5rem' }}>
                {discoveredRegions.map((region) => (
                  <button
                    key={region}
                    type="button"
                    onClick={() => setScopeInput(region)}
                    title={t('meshcore.scope.use_region', 'Use "{{region}}" as the default scope', { region })}
                    style={{
                      padding: '0.2rem 0.6rem',
                      borderRadius: 999,
                      border: '1px solid var(--ctp-blue)',
                      background: scopeInput.trim().replace(/^#/, '') === region ? 'var(--ctp-blue)' : 'transparent',
                    }}
                  >
                    {region}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

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
    </div>
  );
};
