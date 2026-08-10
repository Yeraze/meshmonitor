import React, { useCallback, useRef, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { useSaveBar } from '../../hooks/useSaveBar';
// Shared with the server so the client's save gate can't drift from what the
// backend accepts (#4632).
import { isValidMeshtasticKey } from '../../utils/meshtasticKeyFormat';

/**
 * Validates if a string is valid base64 format
 * Returns true for empty strings (optional keys)
 */
const isValidBase64 = (str: string): boolean => {
  if (!str || !str.trim()) return true; // Empty is valid (optional)
  const trimmed = str.trim();
  // Check for valid base64 characters and proper padding
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(trimmed)) return false;
  // Check length is multiple of 4 (valid base64)
  if (trimmed.length % 4 !== 0) return false;
  // Try to decode to verify
  try {
    atob(trimmed);
    return true;
  } catch {
    return false;
  }
};

interface SecurityConfigSectionProps {
  // Keys (read-only display)
  publicKey: string;
  privateKey: string;
  // Setting a new private key is local-node only (#4632). When this setter is
  // absent the key stays copy-only, exactly as it was before.
  setPrivateKey?: (value: string) => void;
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
  setPrivateKey,
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

  // Private-key editing (#4632). Off until the user opts in; the input is
  // cleared for paste rather than pre-filled with the existing secret.
  const [isEditingPrivateKey, setIsEditingPrivateKey] = useState(false);
  const canSetPrivateKey = typeof setPrivateKey === 'function';

  // Track initial values for change detection. This snapshot is taken once at
  // mount and is only correct because the whole Configuration tab is gated
  // behind `isLoading` (ConfigurationTab.tsx) — it renders this section only
  // AFTER getSecurityKeys() has resolved, so `privateKey` is already the loaded
  // value here, not the empty initial state. If that gate is ever removed this
  // baseline would capture '' and the loaded key would read as a change.
  const initialValuesRef = useRef({
    adminKeys: [...adminKeys],
    isManaged,
    serialEnabled,
    debugLogApiEnabled,
    adminChannelEnabled,
    privateKey
  });

  // A private key counts as changed only once it is non-empty AND differs from
  // the loaded one — an empty box (edit opened, nothing pasted) is not a change
  // to save, and must never be sent as a key.
  const trimmedPrivateKey = privateKey.trim();
  const privateKeyChanged =
    trimmedPrivateKey.length > 0 && trimmedPrivateKey !== initialValuesRef.current.privateKey.trim();
  const privateKeyValid = !privateKeyChanged || isValidMeshtasticKey(trimmedPrivateKey);

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    // Check if adminKeys array has changed
    const adminKeysChanged = adminKeys.length !== initial.adminKeys.length ||
      adminKeys.some((key, i) => key !== initial.adminKeys[i]);

    return (
      adminKeysChanged ||
      isManaged !== initial.isManaged ||
      serialEnabled !== initial.serialEnabled ||
      debugLogApiEnabled !== initial.debugLogApiEnabled ||
      adminChannelEnabled !== initial.adminChannelEnabled ||
      privateKeyChanged
    );
  }, [adminKeys, isManaged, serialEnabled, debugLogApiEnabled, adminChannelEnabled, privateKeyChanged]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setAdminKeys([...initial.adminKeys]);
    setIsManaged(initial.isManaged);
    setSerialEnabled(initial.serialEnabled);
    setDebugLogApiEnabled(initial.debugLogApiEnabled);
    setAdminChannelEnabled(initial.adminChannelEnabled);
    setPrivateKey?.(initial.privateKey);
    setIsEditingPrivateKey(false);
  }, [setAdminKeys, setIsManaged, setSerialEnabled, setDebugLogApiEnabled, setAdminChannelEnabled, setPrivateKey]);

  // Check if any admin keys have invalid format
  const hasInvalidKeys = adminKeys.some(key => key.trim() && !isValidBase64(key));

  // Update initial values after successful save
  const handleSaveInternal = useCallback(async () => {
    // Validate before saving
    if (hasInvalidKeys) {
      alert(t('security_config.fix_invalid_keys'));
      return;
    }
    // A private-key change rewrites the node's mesh identity — validate it and
    // make the user confirm the consequences before it goes out (#4632).
    if (privateKeyChanged) {
      if (!privateKeyValid) {
        alert(t('security_config.private_key_invalid'));
        return;
      }
      if (!window.confirm(t('security_config.set_private_key_confirm'))) {
        return;
      }
    }
    await onSave();
    initialValuesRef.current = {
      adminKeys: [...adminKeys],
      isManaged,
      serialEnabled,
      debugLogApiEnabled,
      adminChannelEnabled,
      privateKey
    };
    setIsEditingPrivateKey(false);
  }, [onSave, adminKeys, isManaged, serialEnabled, debugLogApiEnabled, adminChannelEnabled, privateKey, privateKeyChanged, privateKeyValid, hasInvalidKeys, t]);

  // Register with SaveBar
  useSaveBar({
    id: 'security-config',
    sectionName: t('security_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSaveInternal,
    onDismiss: resetChanges
  });

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

  const handleCopyPrivateKey = useCallback(() => {
    if (!privateKey) return;
    const confirmed = window.confirm(t('security_config.copy_private_key_confirm'));
    if (confirmed) {
      void navigator.clipboard.writeText(privateKey);
    }
  }, [privateKey, t]);

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
          <UiIcon name="help" />
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
              backgroundColor: 'var(--color-surface)',
              color: 'var(--color-text-subtle)',
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
                backgroundColor: 'var(--color-surface-hover)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                color: 'var(--color-text)'
              }}
              title={t('common.copy_to_clipboard')}
            >
              <UiIcon name="copy" />
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
            type={isEditingPrivateKey ? 'text' : 'password'}
            value={isEditingPrivateKey ? privateKey : (privateKey ? privateKey : t('common.na'))}
            readOnly={!isEditingPrivateKey}
            onChange={isEditingPrivateKey ? (e) => setPrivateKey?.(e.target.value) : undefined}
            placeholder={isEditingPrivateKey ? t('security_config.private_key_paste_placeholder') : undefined}
            spellCheck={false}
            autoComplete="off"
            className="setting-input"
            style={{
              flex: 1,
              backgroundColor: 'var(--color-surface)',
              color: isEditingPrivateKey ? 'var(--color-text)' : 'var(--color-text-subtle)',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              borderColor: privateKeyChanged && !privateKeyValid ? 'var(--color-error)' : undefined
            }}
          />
          {!isEditingPrivateKey && privateKey && (
            <button
              type="button"
              onClick={handleCopyPrivateKey}
              style={{
                padding: '0.5rem',
                backgroundColor: 'var(--color-surface-hover)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                color: 'var(--color-text)'
              }}
              title={t('common.copy_to_clipboard')}
            >
              <UiIcon name="copy" />
            </button>
          )}
          {canSetPrivateKey && !isEditingPrivateKey && (
            <button
              type="button"
              onClick={() => { setPrivateKey?.(''); setIsEditingPrivateKey(true); }}
              style={{
                padding: '0.5rem 0.75rem',
                backgroundColor: 'var(--color-surface-hover)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                color: 'var(--color-text)',
                whiteSpace: 'nowrap'
              }}
              title={t('security_config.set_private_key')}
            >
              <UiIcon name="edit" /> {t('security_config.set_private_key')}
            </button>
          )}
          {isEditingPrivateKey && (
            <button
              type="button"
              onClick={() => { setPrivateKey?.(initialValuesRef.current.privateKey); setIsEditingPrivateKey(false); }}
              style={{
                padding: '0.5rem 0.75rem',
                backgroundColor: 'var(--color-surface-hover)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                color: 'var(--color-text)',
                whiteSpace: 'nowrap'
              }}
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
        {isEditingPrivateKey && privateKeyChanged && !privateKeyValid && (
          <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem', color: 'var(--color-error)' }}>
            <UiIcon name="alert" /> {t('security_config.private_key_invalid')}
          </span>
        )}
        <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem', color: 'var(--color-warning)' }}>
          <UiIcon name="alert" /> {isEditingPrivateKey ? t('security_config.set_private_key_warning') : t('security_config.private_key_warning')}
        </span>
      </div>

      {/* Separator */}
      <hr style={{ border: 'none', borderTop: '1px solid var(--color-surface-active)', margin: '1.5rem 0' }} />

      {/* Admin Keys */}
      <div className="setting-item">
        <label>
          {t('security_config.admin_keys')}
          <span className="setting-description">{t('security_config.admin_keys_description')}</span>
        </label>
        {adminKeys.map((key, index) => {
          const isInvalid = key.trim() && !isValidBase64(key);
          return (
            <div key={index} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'flex-start', flexDirection: 'column' }}>
              <div style={{ display: 'flex', gap: '0.5rem', width: '100%', alignItems: 'center' }}>
                <input
                  type="text"
                  value={key}
                  onChange={(e) => handleAdminKeyChange(index, e.target.value)}
                  className="setting-input"
                  style={{
                    flex: 1,
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    borderColor: isInvalid ? 'var(--color-error)' : undefined,
                    boxShadow: isInvalid ? '0 0 0 1px var(--color-error)' : undefined
                  }}
                  placeholder={t('security_config.admin_key_placeholder')}
                />
                {adminKeys.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveAdminKey(index)}
                    style={{
                      padding: '0.5rem 0.75rem',
                      backgroundColor: 'var(--color-error)',
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
              {isInvalid && (
                <span style={{ color: 'var(--color-error)', fontSize: '0.85rem' }}>
                  {t('security_config.invalid_base64')}
                </span>
              )}
            </div>
          );
        })}
        {adminKeys.length < 3 && (
          <button
            type="button"
            onClick={handleAddAdminKey}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: 'var(--color-success)',
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
    </div>
  );
};

export default SecurityConfigSection;
