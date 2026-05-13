import React, { useEffect, useState } from 'react';
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

  const [connectionType, setConnectionType] = useState<'serial' | 'tcp'>('serial');
  const [serialPort, setSerialPort] = useState('COM3');
  const [tcpHost, setTcpHost] = useState('');
  const [tcpPort, setTcpPort] = useState('4403');
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);

  useEffect(() => {
    if (defaultsLoaded || connected) return;
    const env = status?.envConfig;
    if (env) {
      if (env.connectionType === 'serial' || env.connectionType === 'tcp') {
        setConnectionType(env.connectionType);
      }
      if (env.serialPort) setSerialPort(env.serialPort);
      if (env.tcpHost) setTcpHost(env.tcpHost);
      if (env.tcpPort) setTcpPort(String(env.tcpPort));
      setDefaultsLoaded(true);
    }
  }, [status?.envConfig, defaultsLoaded, connected]);

  const handleConnect = async () => {
    await actions.connect({
      connectionType,
      serialPort: connectionType === 'serial' ? serialPort : undefined,
      tcpHost: connectionType === 'tcp' ? tcpHost : undefined,
      tcpPort: connectionType === 'tcp' ? parseInt(tcpPort, 10) : undefined,
    });
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
            <div className="form-row">
              <div>
                <label>{t('meshcore.connection_type', 'Connection type')}</label>
                <select
                  value={connectionType}
                  onChange={e => setConnectionType(e.target.value as 'serial' | 'tcp')}
                  disabled={loading}
                >
                  <option value="serial">{t('meshcore.serial_port', 'Serial')}</option>
                  <option value="tcp">{t('meshcore.tcp_ip', 'TCP/IP')}</option>
                </select>
              </div>
            </div>
            {connectionType === 'serial' ? (
              <div className="form-row">
                <div>
                  <label>{t('meshcore.serial_port', 'Serial port')}</label>
                  <input
                    type="text"
                    value={serialPort}
                    onChange={e => setSerialPort(e.target.value)}
                    placeholder="COM3 or /dev/ttyACM0"
                    disabled={loading}
                  />
                </div>
              </div>
            ) : (
              <div className="form-row">
                <div>
                  <label>{t('meshcore.host', 'Host')}</label>
                  <input
                    type="text"
                    value={tcpHost}
                    onChange={e => setTcpHost(e.target.value)}
                    placeholder="192.168.1.100"
                    disabled={loading}
                  />
                </div>
                <div>
                  <label>{t('meshcore.port', 'Port')}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={tcpPort}
                    onChange={e => setTcpPort(e.target.value)}
                    placeholder="4403"
                    disabled={loading}
                  />
                </div>
              </div>
            )}
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
