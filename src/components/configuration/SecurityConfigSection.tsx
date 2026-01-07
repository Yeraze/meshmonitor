import React from 'react';
import { useTranslation } from 'react-i18next';

interface SecurityConfigSectionProps {
  // Keys (read-only display)
  publicKey: string;
  privateKey: string;
  // Admin keys (editable array)
  adminKeys: string[];
  // Settings
  isManaged: boolean;
  serialEnabled: boolean;
  debugLogApiEnabled: boolean;
  adminChannelEnabled: boolean;
  // Setters
  setAdminKeys: (keys: string[]) => void;
  setIsManaged: (value: boolean) => void;
  setSerialEnabled: (value: boolean) => void;
  setDebugLogApiEnabled: (value: boolean) => void;
  setAdminChannelEnabled: (value: boolean) => void;
  // Common
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const SecurityConfigSection: React.FC<SecurityConfigSectionProps> = ({
  publicKey,
  privateKey,
  adminKeys,
  isManaged,
  serialEnabled,
  debugLogApiEnabled,
  adminChannelEnabled,
  setAdminKeys,
  setIsManaged,
  setSerialEnabled,
  setDebugLogApiEnabled,
  setAdminChannelEnabled,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  const handleAdminKeyChange = (index: number, value: string) => {
    const newKeys = [...adminKeys];
    newKeys[index] = value;
    setAdminKeys(newKeys);
  };

  const handleAddAdminKey = () => {
    if (adminKeys.length < 3) {
      setAdminKeys([...adminKeys, '']);
    }
  };

  const handleRemoveAdminKey = (index: number) => {
    if (adminKeys.length > 1) {
      const newKeys = adminKeys.filter((_, i) => i !== index);
      setAdminKeys(newKeys);
    }
  };

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('security_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/radio/security/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('security_config.view_docs')}
        >
          ❓
        </a>
      </h3>

      {/* Public Key (Read-only) */}
      <div className="setting-item">
        <label htmlFor="publicKey">
          {t('security_config.public_key')}
          <span className="setting-description">{t('security_config.public_key_description')}</span>
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            id="publicKey"
            type="text"
            value={publicKey || t('common.na')}
            readOnly
            className="setting-input"
            style={{
              flex: 1,
              backgroundColor: 'var(--ctp-surface0)',
              color: 'var(--ctp-subtext0)',
              fontFamily: 'monospace',
              fontSize: '0.85rem'
            }}
          />
          {publicKey && (
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(publicKey)}
              style={{
                padding: '0.5rem',
                backgroundColor: 'var(--ctp-surface1)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                color: 'var(--ctp-text)'
              }}
              title={t('common.copy_to_clipboard')}
            >
              📋
            </button>
          )}
        </div>
      </div>

      {/* Private Key (Read-only, masked by default) */}
      <div className="setting-item">
        <label htmlFor="privateKey">
          {t('security_config.private_key')}
          <span className="setting-description">{t('security_config.private_key_description')}</span>
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            id="privateKey"
            type="password"
            value={privateKey || t('common.na')}
            readOnly
            className="setting-input"
            style={{
              flex: 1,
              backgroundColor: 'var(--ctp-surface0)',
              color: 'var(--ctp-subtext0)',
              fontFamily: 'monospace',
              fontSize: '0.85rem'
            }}
          />
          {privateKey && (
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(privateKey)}
              style={{
                padding: '0.5rem',
                backgroundColor: 'var(--ctp-surface1)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                color: 'var(--ctp-text)'
              }}
              title={t('common.copy_to_clipboard')}
            >
              📋
            </button>
          )}
        </div>
        <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem', color: 'var(--ctp-yellow)' }}>
          ⚠️ {t('security_config.private_key_warning')}
        </span>
      </div>

      {/* Separator */}
      <hr style={{ border: 'none', borderTop: '1px solid var(--ctp-surface2)', margin: '1.5rem 0' }} />

      {/* Admin Keys */}
      <div className="setting-item">
        <label>
          {t('security_config.admin_keys')}
          <span className="setting-description">{t('security_config.admin_keys_description')}</span>
        </label>
        {adminKeys.map((key, index) => (
          <div key={index} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
            <input
              type="text"
              value={key}
              onChange={(e) => handleAdminKeyChange(index, e.target.value)}
              className="setting-input"
              style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.85rem' }}
              placeholder={t('security_config.admin_key_placeholder')}
            />
            {adminKeys.length > 1 && (
              <button
                type="button"
                onClick={() => handleRemoveAdminKey(index)}
                style={{
                  padding: '0.5rem 0.75rem',
                  backgroundColor: 'var(--ctp-red)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: '#fff'
                }}
              >
                {t('common.remove')}
              </button>
            )}
          </div>
        ))}
        {adminKeys.length < 3 && (
          <button
            type="button"
            onClick={handleAddAdminKey}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: 'var(--ctp-green)',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              color: '#fff',
              marginTop: '0.5rem'
            }}
          >
            + {t('security_config.add_admin_key')}
          </button>
        )}
        <span className="setting-description" style={{ display: 'block', marginTop: '0.5rem' }}>
          {t('security_config.admin_keys_note', { count: adminKeys.length, max: 3 })}
        </span>
      </div>

      {/* Is Managed */}
      <div className="setting-item">
        <label htmlFor="isManaged" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="isManaged"
            type="checkbox"
            checked={isManaged}
            onChange={(e) => setIsManaged(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('security_config.is_managed')}</div>
            <span className="setting-description">{t('security_config.is_managed_description')}</span>
          </div>
        </label>
      </div>

      {/* Serial Enabled */}
      <div className="setting-item">
        <label htmlFor="serialEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="serialEnabled"
            type="checkbox"
            checked={serialEnabled}
            onChange={(e) => setSerialEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('security_config.serial_enabled')}</div>
            <span className="setting-description">{t('security_config.serial_enabled_description')}</span>
          </div>
        </label>
      </div>

      {/* Debug Log API Enabled */}
      <div className="setting-item">
        <label htmlFor="debugLogApiEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="debugLogApiEnabled"
            type="checkbox"
            checked={debugLogApiEnabled}
            onChange={(e) => setDebugLogApiEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('security_config.debug_log_api_enabled')}</div>
            <span className="setting-description">{t('security_config.debug_log_api_enabled_description')}</span>
          </div>
        </label>
      </div>

      {/* Admin Channel Enabled */}
      <div className="setting-item">
        <label htmlFor="adminChannelEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="adminChannelEnabled"
            type="checkbox"
            checked={adminChannelEnabled}
            onChange={(e) => setAdminChannelEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('security_config.admin_channel_enabled')}</div>
            <span className="setting-description">{t('security_config.admin_channel_enabled_description')}</span>
          </div>
        </label>
      </div>

      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('security_config.save_button')}
      </button>
    </div>
  );
};

export default SecurityConfigSection;
