import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreActions } from './hooks/useMeshCore';
import { COMPANION_CMD_FIRMWARE_MIN } from './MeshCoreMultiAcksSection';
import { FactoryResetWipeList } from '../shared/config/FactoryResetWipeList';
import { DangerZone, DangerZoneActions, DangerZoneButton } from '../shared/config/DangerZone';
import { ConfirmDialog } from '../shared/automation/ConfirmDialog';
import { TypedConfirmDialog } from '../common/TypedConfirmDialog';
import styles from './MeshCoreDeviceManagement.module.css';
import type { DeviceManagementCapabilities } from './deviceManagementCapabilities';

interface Props {
  actions: Pick<
    MeshCoreActions,
    'rebootDevice' | 'exportPrivateKey' | 'importPrivateKey' | 'factoryReset'
  > & Partial<Pick<MeshCoreActions, 'powerOffDevice'>>;
  deviceName?: string;
  publicKey?: string;
  capabilities: DeviceManagementCapabilities;
  /** Admin only: the server enforces `requireAdmin` on factory reset, power-off and key restore. */
  isAdmin: boolean;
  isCompanion: boolean;
  firmwareVer?: number;
  /** The source reaches the device over TCP / WiFi. */
  overNetwork: boolean;
  /** Fired after a successful restore, power-off or reboot, so the parent can refresh. */
  onDeviceChanged?: () => void;
}

/**
 * Danger-zone device management: reboot, power off, key backup / restore and
 * (Companion) factory reset. Shared by the Companion and the Repeater: the
 * parent passes the capabilities its device offers.
 *
 * Every destructive action confirms in an in-app dialog (#5830). Power-off,
 * key restore and factory reset need the device name typed. The hook sends
 * `confirm: true` for the server's DANGER_CONFIRM_REQUIRED check, so these
 * dialogs are the only guard.
 */
export const MeshCoreDeviceManagement: React.FC<Props> = ({
  actions,
  deviceName,
  publicKey,
  capabilities,
  isAdmin,
  isCompanion,
  firmwareVer,
  overNetwork,
  onDeviceChanged,
}) => {
  const { t } = useTranslation();
  const [rebooting, setRebooting] = useState(false);
  const [rebootConfirmOpen, setRebootConfirmOpen] = useState(false);
  const [exportingKey, setExportingKey] = useState(false);
  const [exportedKey, setExportedKey] = useState<string | null>(null);
  const [importKeyOpen, setImportKeyOpen] = useState(false);
  const [importKeyDraft, setImportKeyDraft] = useState('');
  const [importingKey, setImportingKey] = useState(false);
  const [importKeyError, setImportKeyError] = useState<string | null>(null);
  // The validated key waiting on the typed-name dialog.
  const [pendingImportKey, setPendingImportKey] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [powerOffOpen, setPowerOffOpen] = useState(false);
  const [poweringOff, setPoweringOff] = useState(false);

  // Companion firmware before v7 has no factory-reset command.
  const firmwareTooOld = typeof firmwareVer === 'number' && firmwareVer < COMPANION_CMD_FIRMWARE_MIN;
  const resetBlockedReason = !isCompanion
    ? t('meshcore.factory_reset.blocked_not_companion', 'Factory reset works on a Companion only.')
    : firmwareTooOld
      ? t('meshcore.factory_reset.blocked_firmware', 'Needs Companion firmware version {{min}} or later.', { min: COMPANION_CMD_FIRMWARE_MIN })
      : undefined;
  // The typed word: the device name, or a public-key prefix when it has none.
  const typedWord = (deviceName ?? '').trim() || (publicKey ?? '').slice(0, 8);
  const shownName = deviceName || typedWord;

  const handleFactoryReset = async () => {
    setResetting(true);
    try {
      await actions.factoryReset({ confirm: true });
    } finally {
      setResetting(false);
      setResetOpen(false);
    }
  };

  const handleReboot = async () => {
    setRebootConfirmOpen(false);
    setRebooting(true);
    try {
      const ok = await actions.rebootDevice({ confirm: true });
      if (ok) onDeviceChanged?.();
    } finally {
      setRebooting(false);
    }
  };

  const handlePowerOff = async () => {
    if (!actions.powerOffDevice) return;
    setPoweringOff(true);
    try {
      const ok = await actions.powerOffDevice({ confirm: true });
      if (ok) onDeviceChanged?.();
    } finally {
      setPoweringOff(false);
      setPowerOffOpen(false);
    }
  };

  const handleExportKey = async () => {
    setExportingKey(true);
    setExportedKey(null);
    try {
      const hex = await actions.exportPrivateKey();
      if (hex) {
        setExportedKey(hex);
      }
    } finally {
      setExportingKey(false);
    }
  };

  const handleCopyKey = async () => {
    if (!exportedKey) return;
    try {
      await navigator.clipboard.writeText(exportedKey);
    } catch {
      window.prompt('Copy this private key:', exportedKey);
    }
  };

  /** Validates the draft, then asks for the typed name. Sends nothing. */
  const requestImportKey = () => {
    if (importingKey) return;
    const hex = importKeyDraft.trim();
    if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
      setImportKeyError(t('meshcore.config.import_key_invalid', 'Key must be a 128-character hex string.'));
      return;
    }
    setImportKeyError(null);
    setPendingImportKey(hex);
  };

  const handleImportKey = async () => {
    const hex = pendingImportKey;
    if (!hex || importingKey) return;
    setImportingKey(true);
    setImportKeyError(null);
    try {
      const ok = await actions.importPrivateKey(hex, { confirm: true });
      if (ok) {
        setImportKeyOpen(false);
        setImportKeyDraft('');
        onDeviceChanged?.();
      } else {
        setImportKeyError(t('meshcore.config.import_key_failed', 'Import failed.'));
      }
    } finally {
      setImportingKey(false);
      setPendingImportKey(null);
    }
  };

  const showPowerOff = capabilities.powerOff && isAdmin && !!actions.powerOffDevice;
  const showImport = capabilities.keyImport && isAdmin;

  return (
    // The id wraps the whole zone so the section filter hides all of it.
    <div id="meshcore-device-management">
      <DangerZone>
        <DangerZoneActions>
          {capabilities.reboot && (
            <DangerZoneButton
              onClick={() => setRebootConfirmOpen(true)}
              disabled={rebooting}
              title={capabilities.reasons?.reboot}
              data-testid="meshcore-reboot-button"
            >
              {rebooting
                ? t('meshcore.config.rebooting', 'Rebooting…')
                : t('meshcore.config.reboot_button', 'Reboot Device')}
            </DangerZoneButton>
          )}

          {showPowerOff && (
            <DangerZoneButton
              onClick={() => setPowerOffOpen(true)}
              disabled={poweringOff || typedWord === ''}
              title={capabilities.reasons?.powerOff}
              data-testid="meshcore-power-off-button"
            >
              {t('device_actions.shutdown.button', 'Shut down')}
            </DangerZoneButton>
          )}

          {capabilities.keyExport && (
            <DangerZoneButton
              variant="plain"
              onClick={handleExportKey}
              disabled={exportingKey}
              title={capabilities.reasons?.keyExport}
            >
              {exportingKey
                ? t('meshcore.config.exporting_key', 'Exporting…')
                : t('meshcore.config.export_key_button', 'Backup Private Key')}
            </DangerZoneButton>
          )}

          {showImport && (
            <DangerZoneButton
              onClick={() => { setImportKeyDraft(''); setImportKeyError(null); setImportKeyOpen(true); }}
              title={capabilities.reasons?.keyImport}
              data-testid="meshcore-import-key-button"
            >
              {t('meshcore.config.import_key_button', 'Restore Private Key')}
            </DangerZoneButton>
          )}

          {capabilities.factoryReset && isAdmin && (
            <DangerZoneButton
              onClick={() => setResetOpen(true)}
              disabled={resetting || resetBlockedReason !== undefined || typedWord === ''}
              title={resetBlockedReason}
              data-testid="meshcore-factory-reset-button"
            >
              {t('meshcore.factory_reset.button', 'Factory Reset')}
            </DangerZoneButton>
          )}
        </DangerZoneActions>

        {exportedKey && (
          <div className={styles.panel}>
            <div className={styles.warn}>
              {t('meshcore.config.export_key_warning', 'Store this key securely. Anyone with it can impersonate this device.')}
            </div>
            <div className={styles.mono}>{exportedKey}</div>
            <button
              type="button"
              className={`btn-secondary ${styles.smallBtn}`}
              onClick={handleCopyKey}
            >
              {t('meshcore.config.copy_key', 'Copy to clipboard')}
            </button>
          </div>
        )}

        {importKeyOpen && (
          <div className={styles.panel}>
            <div className={styles.error}>
              {t('meshcore.config.import_key_warning', 'This replaces the device identity. All contacts will need to re-discover this node.')}
            </div>
            <input
              type="text"
              value={importKeyDraft}
              onChange={(e) => setImportKeyDraft(e.target.value)}
              disabled={importingKey}
              placeholder="128-character hex private key"
              aria-label={t('meshcore.config.import_key_input', 'Private key (hex)')}
              className={styles.keyInput}
            />
            {importKeyError && (
              <div className={styles.errorGap} role="alert">{importKeyError}</div>
            )}
            <div className={styles.row}>
              <button type="button" className="btn-secondary" onClick={() => setImportKeyOpen(false)} disabled={importingKey}>
                {t('meshcore.config.cancel', 'Cancel')}
              </button>
              <button type="button" className={`btn-primary ${styles.errorText}`} onClick={requestImportKey} disabled={importingKey || importKeyDraft.trim().length === 0}>
                {importingKey
                  ? t('meshcore.config.importing_key', 'Importing…')
                  : t('meshcore.config.import_key_confirm_button', 'Import Key')}
              </button>
            </div>
          </div>
        )}

        {rebootConfirmOpen && (
          <ConfirmDialog
            title={t('meshcore.config.reboot_dialog_title', 'Reboot the device?')}
            message={t('meshcore.config.reboot_dialog_message', {
              name: deviceName ?? t('meshcore.config.this_device', 'this device'),
              defaultValue: '{{name}} disconnects and restarts.',
            })}
            confirmLabel={t('meshcore.config.reboot_button', 'Reboot Device')}
            cancelLabel={t('common.cancel', 'Cancel')}
            onConfirm={() => { void handleReboot(); }}
            onCancel={() => setRebootConfirmOpen(false)}
          />
        )}

        <TypedConfirmDialog
          isOpen={powerOffOpen}
          title={t('meshcore.config.power_off_dialog_title', 'Power off {{name}}?', { name: shownName })}
          confirmWord={typedWord}
          confirmLabel={t('device_actions.shutdown.confirm_label', 'Shut down')}
          danger
          busy={poweringOff}
          onConfirm={() => { void handlePowerOff(); }}
          onCancel={() => setPowerOffOpen(false)}
        >
          <p>
            {t('meshcore.config.power_off_dialog_body', {
              name: shownName,
              defaultValue: '{{name}} powers off and leaves the mesh. It stays off until someone power-cycles it.',
            })}
          </p>
        </TypedConfirmDialog>

        <TypedConfirmDialog
          isOpen={resetOpen}
          title={t('meshcore.factory_reset.dialog_title', 'Factory reset this device?')}
          confirmWord={typedWord}
          confirmLabel={t('meshcore.factory_reset.confirm_label', 'Factory Reset')}
          danger
          busy={resetting}
          onConfirm={() => { void handleFactoryReset(); }}
          onCancel={() => setResetOpen(false)}
        >
          <p>
            {t('meshcore.factory_reset.dialog_body', {
              name: shownName,
              defaultValue: '{{name}} erases its own storage and restarts. This cannot be undone.',
            })}
          </p>
          <FactoryResetWipeList items={['settings', 'channels', 'contacts', 'network', 'identity']} />
          <p>{t('meshcore.factory_reset.identity_note', 'The device gets a new public key, so other nodes no longer know it by its old one.')}</p>
          {overNetwork && (
            <p className={styles.warnText}>
              {t('meshcore.factory_reset.network_warning', 'This source reaches the device over TCP or WiFi. You may lose network access, because the WiFi credentials are wiped. You then set the device up again over USB or Bluetooth.')}
            </p>
          )}
          <p>
            {t('meshcore.factory_reset.backup_first', 'Back up first:')}{' '}
            <button
              type="button"
              className="btn-link"
              onClick={() => { setResetOpen(false); void handleExportKey(); }}
              data-testid="meshcore-factory-reset-backup"
            >
              {t('meshcore.config.export_key_button', 'Backup Private Key')}
            </button>
          </p>
        </TypedConfirmDialog>

        <TypedConfirmDialog
          isOpen={pendingImportKey !== null}
          title={t('meshcore.config.import_key_dialog_title', 'Replace the device identity?')}
          confirmWord={typedWord}
          confirmLabel={t('meshcore.config.import_key_confirm_button', 'Import Key')}
          danger
          busy={importingKey}
          onConfirm={() => { void handleImportKey(); }}
          onCancel={() => setPendingImportKey(null)}
        >
          <p>
            {t(
              'meshcore.config.import_key_dialog_body',
              'This REPLACES the device identity with the imported private key. Every contact will need to re-discover this node. It cannot be undone without the old key.',
            )}
          </p>
          {!isCompanion && (
            <p>
              {t(
                'meshcore.config.import_key_repeater_note',
                'The repeater reboots to apply the key. Saved remote-admin credentials for the old key stop working.',
              )}
            </p>
          )}
          <p>
            {t('meshcore.config.import_key_type_name', {
              name: shownName,
              defaultValue: 'Type the device name to confirm.',
            })}
          </p>
        </TypedConfirmDialog>
      </DangerZone>
    </div>
  );
};
