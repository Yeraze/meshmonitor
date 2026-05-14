import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus, MeshCoreActions, TelemetryMode } from './hooks/useMeshCore';
import { RADIO_PRESETS, findPresetId } from './radioPresets';
import { useAuth } from '../../contexts/AuthContext';

const TELEMETRY_MODE_OPTIONS: TelemetryMode[] = ['always', 'device', 'never'];
// MeshCore device types: COMPANION=1, REPEATER=2, ROOM_SERVER=3.
const COMPANION_ONLY_DEVICES = new Set([2, 3]);

interface MeshCoreConfigurationViewProps {
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
}

export const MeshCoreConfigurationView: React.FC<MeshCoreConfigurationViewProps> = ({
  status,
  actions,
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

  const [savingName, setSavingName] = useState(false);
  const [savingRadio, setSavingRadio] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [savingAdvLoc, setSavingAdvLoc] = useState(false);
  const [savingTelemetry, setSavingTelemetry] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [radioSaved, setRadioSaved] = useState(false);
  const [locationSaved, setLocationSaved] = useState(false);
  const [telemetrySaved, setTelemetrySaved] = useState(false);

  useEffect(() => {
    if (local?.name) setName(local.name);
  }, [local?.name]);

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

      <div className="form-section">
        <h3>{t('meshcore.config.device_name', 'Device name')}</h3>
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
      </div>

      <div className="form-section">
        <h3>{t('meshcore.config.location', 'Location')}</h3>
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
      </div>

      <div className="form-section">
        <h3>{t('meshcore.config.radio_params', 'Radio parameters')}</h3>
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
      </div>

      <div className="form-section">
        <h3>{t('meshcore.config.telemetry', 'Telemetry')}</h3>
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
      </div>
    </div>
  );
};
