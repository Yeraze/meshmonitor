import React from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';

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
  const connected = status?.connected ?? false;

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
