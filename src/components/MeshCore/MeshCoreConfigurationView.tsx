import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus, MeshCoreActions, TelemetryMode } from './hooks/useMeshCore';
import { RADIO_PRESETS, findPresetId } from './radioPresets';
import { useAuth } from '../../contexts/AuthContext';
import { MeshCoreChannelsConfigSection } from './MeshCoreChannelsConfigSection';
import { MeshCoreLocalConsole } from './MeshCoreLocalConsole';
import { CollapsibleSection } from './CollapsibleSection';

const TELEMETRY_MODE_OPTIONS: TelemetryMode[] = ['always', 'device', 'never'];
// MeshCore device types: COMPANION=1, REPEATER=2, ROOM_SERVER=3.
const COMPANION_ONLY_DEVICES = new Set([2, 3]);

interface MeshCoreConfigurationViewProps {
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  /** Frontend basename (typically `''` or `'/meshmonitor'`). Optional so legacy
   *  single-source callers that don't manage channels still compile. */
  baseUrl?: string;
  /** Source UUID — required for the channels sub-section's API calls. */
  sourceId?: string;
}

export const MeshCoreConfigurationView: React.FC<MeshCoreConfigurationViewProps> = ({
  status,
  actions,
  baseUrl,
  sourceId,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canWriteConfig = hasPermission('configuration', 'write');
  const connected = status?.connected ?? false;
  const local = status?.localNode;

  const [name, setName] = useState(local?.name || '');
  const [freq, setFreq] = useState<number>(local?.radioFreq ?? 869.525);
  const [bw, setBw] = useState<number>(local?.radioBw ?? 250);
  const [sf, setSf] = useState<number>(local?.radioSf ?? 11);
  const [cr, setCr] = useState<number>(local?.radioCr ?? 5);
  const [lat, setLat] = useState<number>(local?.latitude ?? 0);
  const [lon, setLon] = useState<number>(local?.longitude ?? 0);
  const [advLoc, setAdvLoc] = useState<boolean>(local?.advLocPolicy === 1);
  const [telBase, setTelBase] = useState<TelemetryMode>(local?.telemetryModeBase ?? 'always');
  const [telLoc, setTelLoc] = useState<TelemetryMode>(local?.telemetryModeLoc ?? 'always');
  const [telEnv, setTelEnv] = useState<TelemetryMode>(local?.telemetryModeEnv ?? 'always');

  const presetId = useMemo(() => findPresetId(freq, bw, sf, cr), [freq, bw, sf, cr]);

  const handlePresetChange = (id: string) => {
    if (id === 'custom') return;
    const preset = RADIO_PRESETS.find(p => p.id === id);
    if (!preset) return;
    setFreq(preset.freq);
    setBw(preset.bw);
    setSf(preset.sf);
    setCr(preset.cr);
  };

  const [txPower, setTxPower] = useState<number>(local?.txPower ?? 0);
  const maxTxPower = local?.maxTxPower ?? 22;

  const [savingName, setSavingName] = useState(false);
  const [savingRadio, setSavingRadio] = useState(false);
  const [savingTxPower, setSavingTxPower] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [savingAdvLoc, setSavingAdvLoc] = useState(false);
  const [savingTelemetry, setSavingTelemetry] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [radioSaved, setRadioSaved] = useState(false);
  const [txPowerSaved, setTxPowerSaved] = useState(false);
  const [locationSaved, setLocationSaved] = useState(false);
  const [telemetrySaved, setTelemetrySaved] = useState(false);

  useEffect(() => {
    if (local?.name) setName(local.name);
  }, [local?.name]);

  useEffect(() => {
    if (typeof local?.txPower === 'number') setTxPower(local.txPower);
  }, [local?.txPower]);

  useEffect(() => {
    if (!local) return;
    if (typeof local.radioFreq === 'number') setFreq(local.radioFreq);
    if (typeof local.radioBw === 'number') setBw(local.radioBw);
    if (typeof local.radioSf === 'number') setSf(local.radioSf);
    if (typeof local.radioCr === 'number') setCr(local.radioCr);
  }, [local?.radioFreq, local?.radioBw, local?.radioSf, local?.radioCr]);

  useEffect(() => {
    if (!local) return;
    if (typeof local.latitude === 'number') setLat(local.latitude);
    if (typeof local.longitude === 'number') setLon(local.longitude);
    if (typeof local.advLocPolicy === 'number') setAdvLoc(local.advLocPolicy === 1);
  }, [local?.latitude, local?.longitude, local?.advLocPolicy]);

  useEffect(() => {
    if (!local) return;
    if (local.telemetryModeBase) setTelBase(local.telemetryModeBase);
    if (local.telemetryModeLoc) setTelLoc(local.telemetryModeLoc);
    if (local.telemetryModeEnv) setTelEnv(local.telemetryModeEnv);
  }, [local?.telemetryModeBase, local?.telemetryModeLoc, local?.telemetryModeEnv]);

  const handleSaveName = async () => {
    if (!name.trim()) return;
    setSavingName(true);
    setNameSaved(false);
    const ok = await actions.setDeviceName(name.trim());
    setSavingName(false);
    if (ok) {
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2500);
    }
  };

  const handleSaveRadio = async () => {
    setSavingRadio(true);
    setRadioSaved(false);
    const ok = await actions.setRadioParams({ freq, bw, sf, cr });
    setSavingRadio(false);
    if (ok) {
      setRadioSaved(true);
      setTimeout(() => setRadioSaved(false), 2500);
    }
  };

  const handleSaveTxPower = async () => {
    setSavingTxPower(true);
    setTxPowerSaved(false);
    const ok = await actions.setTxPower(txPower);
    setSavingTxPower(false);
    if (ok) {
      setTxPowerSaved(true);
      setTimeout(() => setTxPowerSaved(false), 2500);
    }
  };

  const handleSaveLocation = async () => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    setSavingLocation(true);
    setLocationSaved(false);
    const ok = await actions.setCoords(lat, lon);
    setSavingLocation(false);
    if (ok) {
      setLocationSaved(true);
      setTimeout(() => setLocationSaved(false), 2500);
    }
  };

  const handleToggleAdvLoc = async (checked: boolean) => {
    setSavingAdvLoc(true);
    const prev = advLoc;
    setAdvLoc(checked);
    const ok = await actions.setAdvertLocPolicy(checked ? 1 : 0);
    setSavingAdvLoc(false);
    if (!ok) {
      setAdvLoc(prev);
    }
  };

  const advType = local?.advType;
  const isCompanionOnly = typeof advType === 'number' && COMPANION_ONLY_DEVICES.has(advType);
  const telemetryDisabled = !connected || isCompanionOnly || !canWriteConfig;

  const handleSaveTelemetry = async () => {
    setSavingTelemetry(true);
    setTelemetrySaved(false);
    const results = await Promise.all([
      actions.setTelemetryModeBase(telBase),
      actions.setTelemetryModeLoc(telLoc),
      actions.setTelemetryModeEnv(telEnv),
    ]);
    setSavingTelemetry(false);
    if (results.every(Boolean)) {
      setTelemetrySaved(true);
      setTimeout(() => setTelemetrySaved(false), 2500);
    }
  };

  return (
    <div className="meshcore-form-view">
      <h2 style={{ color: 'var(--ctp-text)', marginBottom: '1rem' }}>
        {t('meshcore.nav.configuration', 'Configuration')}
      </h2>

      {!connected && (
        <div className="meshcore-empty-state" style={{ marginBottom: '1rem' }}>
          {t('meshcore.config.not_connected', 'Connect to a device to change its configuration.')}
        </div>
      )}

      {!canWriteConfig && (
        <div
          className="meshcore-empty-state"
          style={{ marginBottom: '1rem', color: 'var(--ctp-yellow)' }}
          role="status"
        >
          {t(
            'meshcore.config.permission_denied',
            "You don't have permission to change configuration for this source.",
          )}
        </div>
      )}

      <CollapsibleSection title={t('meshcore.config.device_name', 'Device name')} className="form-section">
        <p className="hint">
          {t('meshcore.config.device_name_hint', 'Friendly name advertised to other nodes (max 32 chars).')}
        </p>
        <label htmlFor="mc-cfg-name">{t('meshcore.config.name_label', 'Name')}</label>
        <input
          id="mc-cfg-name"
          type="text"
          value={name}
          maxLength={32}
          onChange={e => setName(e.target.value)}
          disabled={!connected || savingName}
        />
        <div>
          <button
            onClick={() => void handleSaveName()}
            disabled={!connected || savingName || !name.trim() || !canWriteConfig}
          >
            {savingName
              ? t('meshcore.config.saving', 'Saving…')
              : t('meshcore.config.save_name', 'Save name')}
          </button>
          {nameSaved && (
            <span style={{ marginLeft: '0.75rem', color: 'var(--ctp-green)' }}>
              ✓ {t('meshcore.config.saved', 'Saved')}
            </span>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title={t('meshcore.config.location', 'Location')} className="form-section">
        <p className="hint">
          {t('meshcore.config.location_hint',
            'GPS coordinates reported by the device. Latitude (-90 to 90), Longitude (-180 to 180).')}
        </p>
        <div className="form-row">
          <div>
            <label htmlFor="mc-cfg-lat">{t('meshcore.config.latitude', 'Latitude')}</label>
            <input
              id="mc-cfg-lat"
              type="number"
              step="0.000001"
              min={-90}
              max={90}
              value={lat}
              onChange={e => setLat(parseFloat(e.target.value))}
              disabled={!connected || savingLocation}
            />
          </div>
          <div>
            <label htmlFor="mc-cfg-lon">{t('meshcore.config.longitude', 'Longitude')}</label>
            <input
              id="mc-cfg-lon"
              type="number"
              step="0.000001"
              min={-180}
              max={180}
              value={lon}
              onChange={e => setLon(parseFloat(e.target.value))}
              disabled={!connected || savingLocation}
            />
          </div>
        </div>
        <div>
          <button
            onClick={() => void handleSaveLocation()}
            disabled={
              !connected || savingLocation || !Number.isFinite(lat) || !Number.isFinite(lon) || !canWriteConfig
            }
          >
            {savingLocation
              ? t('meshcore.config.saving', 'Saving…')
              : t('meshcore.config.save_location', 'Save location')}
          </button>
          {locationSaved && (
            <span style={{ marginLeft: '0.75rem', color: 'var(--ctp-green)' }}>
              ✓ {t('meshcore.config.saved', 'Saved')}
            </span>
          )}
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={advLoc}
              onChange={e => void handleToggleAdvLoc(e.target.checked)}
              disabled={!connected || savingAdvLoc || !canWriteConfig}
            />
            {t('meshcore.config.advert_loc_policy', 'Include location in adverts')}
          </label>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title={t('meshcore.config.radio_params', 'Radio parameters')} className="form-section">
        <p className="hint">
          {t('meshcore.config.radio_hint',
            'Frequency (137–1020 MHz), Bandwidth (kHz), Spreading Factor (5–12), Coding Rate (5–8 → 4/5 – 4/8).')}
        </p>
        <div>
          <label htmlFor="mc-cfg-preset">{t('meshcore.config.preset', 'Preset')}</label>
          <select
            id="mc-cfg-preset"
            value={presetId}
            onChange={e => handlePresetChange(e.target.value)}
            disabled={!connected || savingRadio}
          >
            <option value="custom">{t('meshcore.config.preset.custom', 'Custom')}</option>
            {RADIO_PRESETS.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <div>
            <label>{t('meshcore.config.frequency', 'Frequency (MHz)')}</label>
            <input
              type="number"
              step="0.001"
              min={137}
              max={1020}
              value={freq}
              onChange={e => setFreq(parseFloat(e.target.value))}
              disabled={!connected || savingRadio}
            />
          </div>
          <div>
            <label>{t('meshcore.config.bandwidth', 'Bandwidth (kHz)')}</label>
            <select
              value={bw}
              onChange={e => setBw(parseFloat(e.target.value))}
              disabled={!connected || savingRadio}
            >
              {[7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500].map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label>{t('meshcore.config.sf', 'Spreading Factor')}</label>
            <select
              value={sf}
              onChange={e => setSf(parseInt(e.target.value, 10))}
              disabled={!connected || savingRadio}
            >
              {[5, 6, 7, 8, 9, 10, 11, 12].map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label>{t('meshcore.config.cr', 'Coding Rate')}</label>
            <select
              value={cr}
              onChange={e => setCr(parseInt(e.target.value, 10))}
              disabled={!connected || savingRadio}
            >
              <option value={5}>4/5</option>
              <option value={6}>4/6</option>
              <option value={7}>4/7</option>
              <option value={8}>4/8</option>
            </select>
          </div>
        </div>
        <div>
          <button
            onClick={() => void handleSaveRadio()}
            disabled={!connected || savingRadio || !canWriteConfig}
          >
            {savingRadio
              ? t('meshcore.config.saving', 'Saving…')
              : t('meshcore.config.save_radio', 'Save radio settings')}
          </button>
          {radioSaved && (
            <span style={{ marginLeft: '0.75rem', color: 'var(--ctp-green)' }}>
              ✓ {t('meshcore.config.saved', 'Saved')}
            </span>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title={t('meshcore.config.tx_power', 'TX Power')} className="form-section">
        <p className="hint">
          {t('meshcore.config.tx_power_hint',
            `Transmit power in dBm (1–${maxTxPower}). This controls the LoRa chip output only; boards with an external PA may amplify further.`)}
        </p>
        <div className="form-row" style={{ alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="mc-cfg-txpower">{t('meshcore.config.tx_power_label', 'Power (dBm)')}</label>
            <input
              id="mc-cfg-txpower"
              type="range"
              min={1}
              max={maxTxPower}
              step={1}
              value={txPower}
              onChange={e => setTxPower(parseInt(e.target.value, 10))}
              disabled={!connected || savingTxPower || !canWriteConfig}
            />
          </div>
          <div style={{ minWidth: '4rem', textAlign: 'center', fontWeight: 600, fontSize: '1.1rem' }}>
            {txPower} dBm
          </div>
        </div>
        <div>
          <button
            onClick={() => void handleSaveTxPower()}
            disabled={!connected || savingTxPower || !canWriteConfig || txPower < 1 || txPower > maxTxPower}
          >
            {savingTxPower
              ? t('meshcore.config.saving', 'Saving…')
              : t('meshcore.config.save_tx_power', 'Save TX power')}
          </button>
          {txPowerSaved && (
            <span style={{ marginLeft: '0.75rem', color: 'var(--ctp-green)' }}>
              ✓ {t('meshcore.config.saved', 'Saved')}
            </span>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title={t('meshcore.config.telemetry', 'Telemetry')} className="form-section">
        <p className="hint">
          {t('meshcore.config.telemetry_hint',
            'Control what telemetry this node shares. Always = broadcast on advert; Device only = only respond to direct requests from your contacts; Never = disable.')}
        </p>
        {connected && isCompanionOnly && (
          <p className="hint" style={{ color: 'var(--ctp-yellow)' }}>
            {t('meshcore.config.telemetry_companion_only',
              'Telemetry mode is only configurable on companion devices.')}
          </p>
        )}
        <div className="form-row">
          <div>
            <label htmlFor="mc-cfg-tel-base">
              {t('meshcore.config.telemetry_base', 'Basic telemetry')}
            </label>
            <select
              id="mc-cfg-tel-base"
              value={telBase}
              onChange={e => setTelBase(e.target.value as TelemetryMode)}
              disabled={telemetryDisabled || savingTelemetry}
            >
              {TELEMETRY_MODE_OPTIONS.map(mode => (
                <option key={mode} value={mode}>
                  {t(`meshcore.config.telemetry_mode.${mode}`,
                    mode === 'always' ? 'Always' : mode === 'device' ? 'Device only' : 'Never')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mc-cfg-tel-loc">
              {t('meshcore.config.telemetry_loc', 'Location telemetry')}
            </label>
            <select
              id="mc-cfg-tel-loc"
              value={telLoc}
              onChange={e => setTelLoc(e.target.value as TelemetryMode)}
              disabled={telemetryDisabled || savingTelemetry}
            >
              {TELEMETRY_MODE_OPTIONS.map(mode => (
                <option key={mode} value={mode}>
                  {t(`meshcore.config.telemetry_mode.${mode}`,
                    mode === 'always' ? 'Always' : mode === 'device' ? 'Device only' : 'Never')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mc-cfg-tel-env">
              {t('meshcore.config.telemetry_env', 'Environment telemetry')}
            </label>
            <select
              id="mc-cfg-tel-env"
              value={telEnv}
              onChange={e => setTelEnv(e.target.value as TelemetryMode)}
              disabled={telemetryDisabled || savingTelemetry}
            >
              {TELEMETRY_MODE_OPTIONS.map(mode => (
                <option key={mode} value={mode}>
                  {t(`meshcore.config.telemetry_mode.${mode}`,
                    mode === 'always' ? 'Always' : mode === 'device' ? 'Device only' : 'Never')}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <button
            onClick={() => void handleSaveTelemetry()}
            disabled={telemetryDisabled || savingTelemetry}
          >
            {savingTelemetry
              ? t('meshcore.config.saving', 'Saving…')
              : t('meshcore.config.save_telemetry', 'Save telemetry settings')}
          </button>
          {telemetrySaved && (
            <span style={{ marginLeft: '0.75rem', color: 'var(--ctp-green)' }}>
              ✓ {t('meshcore.config.saved', 'Saved')}
            </span>
          )}
        </div>
      </CollapsibleSection>

      {/* Channels — Companion-only and only when the per-source addressing
          props are available (sourceId/baseUrl come from the MeshCorePage). */}
      {baseUrl !== undefined && sourceId && !COMPANION_ONLY_DEVICES.has(local?.advType ?? 1) && (
        <MeshCoreChannelsConfigSection
          baseUrl={baseUrl}
          sourceId={sourceId}
          canWrite={connected && canWriteConfig}
        />
      )}

      {/* Local CLI console — gated on configuration:write (matches the
          form fields above) and per-source via the route. Available for
          all firmware types; the catalog adapts. */}
      {sourceId && canWriteConfig && (
        <MeshCoreLocalConsole
          sourceId={sourceId}
          deviceName={local?.name}
          deviceType={local?.advType}
          connected={connected}
          actions={{ sendLocalCliCommand: actions.sendLocalCliCommand }}
        />
      )}

      {/* Device Management — danger zone operations. Companion only. */}
      {connected && canWriteConfig && !COMPANION_ONLY_DEVICES.has(local?.advType ?? 1) && (
        <MeshCoreDeviceManagement actions={actions} deviceName={local?.name} />
      )}
    </div>
  );
};

/**
 * Danger-zone device management: reboot + key backup/restore.
 * Extracted as a sub-component to keep ConfigurationView manageable.
 */
const MeshCoreDeviceManagement: React.FC<{
  actions: MeshCoreActions;
  deviceName?: string;
}> = ({ actions, deviceName }) => {
  const { t } = useTranslation();
  const [rebooting, setRebooting] = useState(false);
  const [exportingKey, setExportingKey] = useState(false);
  const [exportedKey, setExportedKey] = useState<string | null>(null);
  const [importKeyOpen, setImportKeyOpen] = useState(false);
  const [importKeyDraft, setImportKeyDraft] = useState('');
  const [importingKey, setImportingKey] = useState(false);
  const [importKeyError, setImportKeyError] = useState<string | null>(null);

  const handleReboot = async () => {
    const msg = t(
      'meshcore.config.reboot_confirm',
      `Reboot ${deviceName ?? 'the device'}? It will disconnect and restart.`,
    );
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setRebooting(true);
    try {
      await actions.rebootDevice({ confirm: true });
    } finally {
      setRebooting(false);
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

  const handleImportKey = async () => {
    if (importingKey) return;
    const hex = importKeyDraft.trim();
    if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
      setImportKeyError(t('meshcore.config.import_key_invalid', 'Key must be a 128-character hex string.'));
      return;
    }
    const msg = t(
      'meshcore.config.import_key_confirm',
      'Import this private key? This REPLACES the device identity. All contacts will need to re-discover this node.',
    );
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setImportingKey(true);
    setImportKeyError(null);
    try {
      const ok = await actions.importPrivateKey(hex, { confirm: true });
      if (ok) {
        setImportKeyOpen(false);
        setImportKeyDraft('');
      } else {
        setImportKeyError(t('meshcore.config.import_key_failed', 'Import failed.'));
      }
    } finally {
      setImportingKey(false);
    }
  };

  return (
    <div className="meshcore-config-section" style={{ borderTop: '2px solid var(--ctp-red, #f38ba8)', marginTop: '1.5rem', paddingTop: '1rem' }}>
      <h3 style={{ color: 'var(--ctp-red, #f38ba8)' }}>
        {t('meshcore.config.device_management', 'Device Management')}
      </h3>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleReboot}
          disabled={rebooting}
          style={{ color: 'var(--ctp-red)' }}
        >
          {rebooting
            ? t('meshcore.config.rebooting', 'Rebooting…')
            : t('meshcore.config.reboot_button', 'Reboot Device')}
        </button>

        <button
          type="button"
          className="btn-secondary"
          onClick={handleExportKey}
          disabled={exportingKey}
        >
          {exportingKey
            ? t('meshcore.config.exporting_key', 'Exporting…')
            : t('meshcore.config.export_key_button', 'Backup Private Key')}
        </button>

        <button
          type="button"
          className="btn-secondary"
          onClick={() => { setImportKeyDraft(''); setImportKeyError(null); setImportKeyOpen(true); }}
          style={{ color: 'var(--ctp-red)' }}
        >
          {t('meshcore.config.import_key_button', 'Restore Private Key')}
        </button>
      </div>

      {exportedKey && (
        <div style={{
          background: 'var(--ctp-surface0, #313244)',
          padding: '0.75rem',
          borderRadius: '6px',
          marginBottom: '1rem',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: '0.85em',
          wordBreak: 'break-all',
        }}>
          <div style={{ marginBottom: '0.5rem', color: 'var(--ctp-yellow, #f9e2af)' }}>
            {t('meshcore.config.export_key_warning', 'Store this key securely. Anyone with it can impersonate this device.')}
          </div>
          <div>{exportedKey}</div>
          <button
            type="button"
            className="btn-secondary"
            style={{ marginTop: '0.5rem', fontSize: '0.85em' }}
            onClick={handleCopyKey}
          >
            {t('meshcore.config.copy_key', 'Copy to clipboard')}
          </button>
        </div>
      )}

      {importKeyOpen && (
        <div style={{
          background: 'var(--ctp-surface0, #313244)',
          padding: '0.75rem',
          borderRadius: '6px',
          marginBottom: '1rem',
        }}>
          <div style={{ marginBottom: '0.5rem', color: 'var(--ctp-red, #f38ba8)' }}>
            {t('meshcore.config.import_key_warning', 'This replaces the device identity. All contacts will need to re-discover this node.')}
          </div>
          <input
            type="text"
            value={importKeyDraft}
            onChange={(e) => setImportKeyDraft(e.target.value)}
            disabled={importingKey}
            placeholder="128-character hex private key"
            style={{
              width: '100%',
              padding: '0.5rem',
              fontFamily: 'var(--font-mono, monospace)',
              boxSizing: 'border-box',
              marginBottom: '0.5rem',
            }}
          />
          {importKeyError && (
            <div style={{ color: 'var(--ctp-red)', marginBottom: '0.5rem' }} role="alert">{importKeyError}</div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn-secondary" onClick={() => setImportKeyOpen(false)} disabled={importingKey}>
              {t('meshcore.config.cancel', 'Cancel')}
            </button>
            <button type="button" className="btn-primary" onClick={handleImportKey} disabled={importingKey || importKeyDraft.trim().length === 0}
              style={{ color: 'var(--ctp-red)' }}>
              {importingKey
                ? t('meshcore.config.importing_key', 'Importing…')
                : t('meshcore.config.import_key_confirm_button', 'Import Key')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
