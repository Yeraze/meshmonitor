import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionStatus, MeshCoreActions, RepeaterSettingsSnapshot, TelemetryMode } from './hooks/useMeshCore';
import { RADIO_PRESETS, findPresetId } from './radioPresets';
import { useAuth } from '../../contexts/AuthContext';
import { MeshCoreChannelsConfigSection } from './MeshCoreChannelsConfigSection';
import { MeshCoreLocalConsole } from './MeshCoreLocalConsole';
import { MeshCoreObserverSection } from './MeshCoreObserverSection';
import { MeshCoreContactSyncSection } from './MeshCoreContactSyncSection';
import { MeshCoreDeviceActionsSection } from './MeshCoreDeviceActionsSection';
import { MeshCoreNodePurgeSection } from './MeshCoreNodePurgeSection';
import { MeshCorePathHashSection } from './MeshCorePathHashSection';
import { MeshCoreDefaultScopeSection } from './MeshCoreDefaultScopeSection';
import { MeshCoreBlePinSection } from './MeshCoreBlePinSection';
import { MeshCoreDeviceManagement } from './MeshCoreDeviceManagement';
import { companionCapabilities, type DeviceManagementCapabilities } from './deviceManagementCapabilities';
import { RepeaterSettingsForm } from './RepeaterSettingsForm';
import { MeshCoreMultiAcksSection } from './MeshCoreMultiAcksSection';
import { ConfigSection } from '../shared/config/ConfigSection';
import { MESHCORE_DOCS } from './meshcoreDocs';
import { UiIcon } from '../icons';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import SectionNav from '../SectionNav';
import { meshcoreConfigurationNavItems } from '../search/configSections';
import navStyles from './MeshCoreSectionNav.module.css';
import sectionNavLayout from '../SectionNav.module.css';
import { LocationPinPicker } from '../map/LocationPinPicker';

const TELEMETRY_MODE_OPTIONS: TelemetryMode[] = ['always', 'device', 'never'];
// MeshCore device types: COMPANION=1, REPEATER=2, ROOM_SERVER=3.
const COMPANION_ONLY_DEVICES = new Set([2, 3]);
// MeshCoreDeviceType.COMPANION, as the connection status reports it. The
// sections that came from the Settings tab (#5683 follow-up) keep the
// companion test they had there.
const DEVICE_TYPE_COMPANION = 1;
const DEVICE_TYPE_REPEATER = 2;

interface MeshCoreConfigurationViewProps {
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  /** Frontend basename (typically `''` or `'/meshmonitor'`). Optional so legacy
   *  single-source callers that don't manage channels still compile. */
  baseUrl?: string;
  /** Source UUID — required for the channels sub-section's API calls. */
  sourceId?: string;
  /** True when this MeshCore source is in strict receive-only mode (#4547
   *  Phase 2). Threaded to MeshCoreLocalConsole; the rest of this view
   *  (name/location/radio params/TX power/telemetry modes/channel CRUD) is
   *  serial/DB-only and deliberately not gated (§3.7 of the Phase 2 spec). */
  receiveOnly?: boolean;
  /** A connect / disconnect is in flight: holds the device actions. */
  loading?: boolean;
}

/**
 * Device Configuration for a MeshCore source: what is written to, or done on,
 * the radio.
 *
 * Top to bottom: the saved device settings (name, location, radio, TX power,
 * telemetry, default path hash size, default region / scope, channels), the
 * radio contact list, the **Device actions** group (things done on the radio
 * now, nothing saved), the device console, the Analyzer Observer and the
 * danger zone.
 *
 * Every section saves through its own button; there is no page-wide save.
 * Each control is gated on the grant its own route checks, which is not
 * always `configuration`: the device actions need `nodes:write` or
 * `connection:write`.
 */
export const MeshCoreConfigurationView: React.FC<MeshCoreConfigurationViewProps> = ({
  status,
  actions,
  baseUrl,
  sourceId,
  receiveOnly = false,
  loading = false,
}) => {
  const { t } = useTranslation();
  const { hasPermission, authStatus } = useAuth();
  const isAdmin = authStatus?.user?.isAdmin === true;
  const canWriteConfig = hasPermission('configuration', 'write');
  const canWriteNodes = hasPermission('nodes', 'write');
  const canWriteConnection = hasPermission('connection', 'write');
  const connected = status?.connected ?? false;
  const isCompanion = status?.deviceType === DEVICE_TYPE_COMPANION;
  // One radio sweep at a time: node discovery and region discovery each hold
  // the other's button while they run, as they did on the Settings tab.
  const [nodeSweepRunning, setNodeSweepRunning] = useState(false);
  const [regionSweepRunning, setRegionSweepRunning] = useState(false);
  const local = status?.localNode;

  const [name, setName] = useState(local?.name || '');
  const [freq, setFreq] = useState<number>(local?.radioFreq ?? 869.525);
  const [bw, setBw] = useState<number>(local?.radioBw ?? 250);
  const [sf, setSf] = useState<number>(local?.radioSf ?? 11);
  const [cr, setCr] = useState<number>(local?.radioCr ?? 5);
  const [lat, setLat] = useState<number>(local?.latitude ?? 0);
  const [lon, setLon] = useState<number>(local?.longitude ?? 0);
  // #5649: one scope per Save button, so a blank frequency does not block the
  // location Save and the reverse.
  const locationNumbers = useNumberInputScope();
  const radioNumbers = useNumberInputScope();
  const [advLoc, setAdvLoc] = useState<boolean>(local?.advLocPolicy === 1);
  const [telBase, setTelBase] = useState<TelemetryMode>(local?.telemetryModeBase ?? 'always');
  const [telLoc, setTelLoc] = useState<TelemetryMode>(local?.telemetryModeLoc ?? 'always');
  const [telEnv, setTelEnv] = useState<TelemetryMode>(local?.telemetryModeEnv ?? 'always');

  // Repeater (#6255 P9): its settings live on the device, read over the serial CLI.
  const isRepeater = status?.deviceType === DEVICE_TYPE_REPEATER || local?.advType === DEVICE_TYPE_REPEATER;
  const canReadConfig = hasPermission('configuration', 'read', { sourceId });
  const [repeaterSnapshot, setRepeaterSnapshot] = useState<RepeaterSettingsSnapshot | null>(null);
  const [repeaterLoading, setRepeaterLoading] = useState(false);
  const [adminPasswordChanged, setAdminPasswordChanged] = useState(false);
  const [clockSyncing, setClockSyncing] = useState(false);
  const [clockResult, setClockResult] = useState<'ok' | 'failed' | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const repeaterActive = connected && isRepeater && canReadConfig;

  const loadRepeaterSettings = useCallback(async () => {
    setRepeaterLoading(true);
    try {
      // Optional call + catch: the effect fires with `void`, so a rejection
      // here would surface as an unhandled promise rejection.
      setRepeaterSnapshot((await actionsRef.current.getRepeaterSettings?.()) ?? null);
    } catch {
      setRepeaterSnapshot(null);
    } finally {
      setRepeaterLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!repeaterActive) {
      setRepeaterSnapshot(null);
      return;
    }
    void loadRepeaterSettings();
  }, [repeaterActive, sourceId, loadRepeaterSettings]);

  const handleSyncClock = async () => {
    setClockSyncing(true);
    setClockResult(null);
    const ok = await actions.syncDeviceTime();
    setClockSyncing(false);
    setClockResult(ok ? 'ok' : 'failed');
  };

  const presetId = useMemo(() => findPresetId(freq, bw, sf, cr), [freq, bw, sf, cr]);

  // Keyed off the RESOLVED preset, not the last one clicked, so the note is
  // also there for a node that already arrived on these parameters (#5137).
  const presetNote = useMemo(
    () => RADIO_PRESETS.find(p => p.id === presetId)?.note,
    [presetId],
  );

  const handlePresetChange = (id: string) => {
    if (id === 'custom') return;
    const preset = RADIO_PRESETS.find(p => p.id === id);
    if (!preset) return;
    setFreq(preset.freq);
    // The preset may equal the saved frequency, which the field cannot see as a change.
    radioNumbers.reset();
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
    // #5649: a blank or out-of-range frequency must never reach the radio.
    if (radioNumbers.invalid) return;
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
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || locationNumbers.invalid) return;
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

  // Mount conditions for the optional sections. The nav reads the same flags,
  // so it never offers a chip for a section that is not on the page. (The
  // mounts repeat the sourceId/baseUrl checks only to narrow their types.)
  const notCompanionOnlyDevice = !COMPANION_ONLY_DEVICES.has(local?.advType ?? 1);
  const hasSourceAddressing = baseUrl !== undefined && !!sourceId;
  const showChannels = hasSourceAddressing && notCompanionOnlyDevice;
  const showContactSync = isCompanion && hasSourceAddressing;
  const showConsole = !!sourceId && canWriteConfig;
  const showObserver = !!sourceId && notCompanionOnlyDevice;
  const showDangerZone = connected && canWriteConfig && (notCompanionOnlyDevice || isRepeater);
  const showRepeaterClock = repeaterActive;
  // Its chips need a section to jump to, so they wait for the read.
  const showRepeaterSettings = repeaterActive && repeaterSnapshot !== null;
  // MeshCoreObserverSection renders nothing without this grant (its own gate).
  const canReadObserver = hasPermission('configuration', 'read', { sourceId });
  const navItems = meshcoreConfigurationNavItems(t, {
    isCompanion,
    showChannels,
    showContactSync,
    showConsole,
    showObserver: showObserver && canReadObserver,
    showDangerZone,
    showRepeaterSettings,
    showRepeaterClock,
  });

  const deviceCapabilities: DeviceManagementCapabilities = isRepeater
    ? {
        reboot: repeaterSnapshot?.capabilities.reboot ?? true,
        powerOff: repeaterSnapshot?.capabilities.powerOff ?? false,
        keyExport: repeaterSnapshot?.capabilities.keyExport ?? false,
        keyImport: repeaterSnapshot?.capabilities.keyImport ?? false,
        factoryReset: false,
        reasons: repeaterSnapshot?.capabilities.reasons,
      }
    : companionCapabilities(local?.firmwareVer);

  const handleSaveTelemetry = async () => {
    setSavingTelemetry(true);
    setTelemetrySaved(false);
    // One after the other, never together (#5773). Each write rewrites all
    // three modes on the device from a fresh read, so parallel writes undo
    // each other and only the last one sticks.
    const okBase = await actions.setTelemetryModeBase(telBase);
    const okLoc = await actions.setTelemetryModeLoc(telLoc);
    const okEnv = await actions.setTelemetryModeEnv(telEnv);
    setSavingTelemetry(false);
    if (okBase && okLoc && okEnv) {
      setTelemetrySaved(true);
      setTimeout(() => setTelemetrySaved(false), 2500);
    }
  };

  return (
    <div className="meshcore-form-view">
      <h2 style={{ color: 'var(--color-text)', marginBottom: '1rem' }}>
        {t('nav.device_configuration', 'Device Configuration')}
      </h2>

      {/* Picker + form share one flex row on a landscape phone (#6211): the
          picker becomes a left rail so the form keeps the full usable height. */}
      <div className={sectionNavLayout.shell}>
      {/* No sections, no nav: a chip must always have a section to jump to. */}
      {navItems.length > 0 && (
        <SectionNav
          className={navStyles.nav}
          searchable
          searchPlaceholder={t('config_search.filter_configuration', 'Search configuration...')}
          searchLabel={t('config_search.filter_configuration', 'Search configuration...')}
          noMatchesLabel={t('config_search.no_sections', 'No matching sections')}
          items={navItems}
        />
      )}
      <div className={sectionNavLayout.body}>

      {!connected && (
        <div className="meshcore-empty-state" style={{ marginBottom: '1rem' }}>
          {t('meshcore.config.not_connected', 'Connect to a device to change its configuration.')}
        </div>
      )}

      {!canWriteConfig && (
        <div
          className="meshcore-empty-state"
          style={{ marginBottom: '1rem', color: 'var(--color-warning)' }}
          role="status"
        >
          {t(
            'meshcore.config.permission_denied',
            "You don't have permission to change configuration for this source.",
          )}
        </div>
      )}

      <div id="meshcore-config-name">
        <ConfigSection
          title={t('meshcore.config.device_name', 'Device name')}
          docsUrl={`${MESHCORE_DOCS}#configuration`}
          description={t('meshcore.config.device_name_hint', 'Friendly name advertised to other nodes (max 32 chars).')}
          canWrite={canWriteConfig}
          collapsible
        >
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
              <span style={{ marginLeft: '0.75rem', color: 'var(--color-success)' }}>
                <UiIcon name="check" size={14} /> {t('meshcore.config.saved', 'Saved')}
              </span>
            )}
          </div>
        </ConfigSection>
      </div>

      <div id="meshcore-config-location">
        <ConfigSection
          title={t('meshcore.config.location', 'Location')}
          docsUrl={`${MESHCORE_DOCS}#configuration`}
          description={t('meshcore.config.location_hint',
            'GPS coordinates reported by the device. Latitude (-90 to 90), Longitude (-180 to 180).')}
          canWrite={canWriteConfig}
          collapsible
        >
          <div className="form-row">
            <div>
              <label htmlFor="mc-cfg-lat">{t('meshcore.config.latitude', 'Latitude')}</label>
              <NumberInputScope scope={locationNumbers}>
                <NumberInput
                  id="mc-cfg-lat"
                  step={0.000001}
                  min={-90}
                  max={90}
                  value={lat}
                  onChange={setLat}
                  disabled={!connected || savingLocation}
                />
              </NumberInputScope>
            </div>
            <div>
              <label htmlFor="mc-cfg-lon">{t('meshcore.config.longitude', 'Longitude')}</label>
              <NumberInputScope scope={locationNumbers}>
                <NumberInput
                  id="mc-cfg-lon"
                  step={0.000001}
                  min={-180}
                  max={180}
                  value={lon}
                  onChange={setLon}
                  disabled={!connected || savingLocation}
                />
              </NumberInputScope>
            </div>
          </div>
          <LocationPinPicker
            lat={lat}
            lon={lon}
            onChange={(la, lo) => { setLat(la); setLon(lo); }}
            disabled={!connected || savingLocation || !canWriteConfig}
            decimals={6}
            testId="meshcore-location-map"
          />
          <div style={{ marginTop: '0.5rem' }}>
            <button
              onClick={() => void handleSaveLocation()}
              disabled={
                !connected || savingLocation || !Number.isFinite(lat) || !Number.isFinite(lon) || !canWriteConfig
                || locationNumbers.invalid
              }
            >
              {savingLocation
                ? t('meshcore.config.saving', 'Saving…')
                : t('meshcore.config.save_location', 'Save location')}
            </button>
            {locationSaved && (
              <span style={{ marginLeft: '0.75rem', color: 'var(--color-success)' }}>
                <UiIcon name="check" size={14} /> {t('meshcore.config.saved', 'Saved')}
              </span>
            )}
          </div>
          {!isRepeater && (
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
          )}
        </ConfigSection>
      </div>

      {showRepeaterClock && (
        <>
          {repeaterSnapshot ? (
            <RepeaterSettingsForm
              values={repeaterSnapshot.values}
              guestPasswordSet={repeaterSnapshot.guestPasswordSet}
              firmwareVersion={repeaterSnapshot.firmware?.version ?? local?.ver}
              radio={{ sf: local?.radioSf, bw: local?.radioBw, cr: local?.radioCr }}
              canWrite={canWriteConfig}
              onSave={actions.saveRepeaterSettings}
              onSaved={(patch, response) => {
                if (patch.adminPassword !== undefined && response.results.adminPassword?.ok) {
                  setAdminPasswordChanged(true);
                }
                void loadRepeaterSettings();
              }}
            />
          ) : (
            <div className="meshcore-empty-state" style={{ marginBottom: '1rem' }} role="status">
              {repeaterLoading
                ? t('meshcore.repeater.loading', 'Reading repeater settings…')
                : t('meshcore.repeater.load_failed', 'Could not read the repeater settings.')}{' '}
              {!repeaterLoading && (
                <button type="button" className="btn-secondary" onClick={() => void loadRepeaterSettings()}>
                  {t('meshcore.repeater.retry', 'Retry')}
                </button>
              )}
            </div>
          )}
          {adminPasswordChanged && (
            <p role="status" data-testid="repeater-stale-credentials" style={{ color: 'var(--color-warning)' }}>
              {t('meshcore.repeater.stale_credentials', 'The admin password changed. Saved remote-admin credentials for this repeater are now stale: update them in the remote admin login.')}
            </p>
          )}
          <div id="meshcore-config-repeater-clock">
            <ConfigSection
              title={t('meshcore.repeater.clock_title', 'Clock')}
              docsUrl={`${MESHCORE_DOCS}#configuration`}
              description={t('meshcore.repeater.clock_hint', 'Sets the repeater clock to this server\'s time. A repeater clock only moves forward, so a clock that runs ahead cannot be set back.')}
              canWrite={canWriteConfig}
              collapsible
            >
              <button
                type="button"
                onClick={() => void handleSyncClock()}
                disabled={!connected || clockSyncing || !canWriteConfig}
                data-testid="repeater-sync-clock"
              >
                {clockSyncing
                  ? t('meshcore.repeater.clock_syncing', 'Syncing…')
                  : t('meshcore.repeater.sync_clock', 'Sync clock')}
              </button>
              {clockResult === 'ok' && (
                <span style={{ marginLeft: '0.75rem', color: 'var(--color-success)' }}>
                  <UiIcon name="check" size={14} /> {t('meshcore.repeater.clock_synced', 'Clock synced')}
                </span>
              )}
              {clockResult === 'failed' && (
                <span style={{ marginLeft: '0.75rem', color: 'var(--color-error)' }} role="alert">
                  {t('meshcore.repeater.clock_failed', 'Clock not synced')}
                </span>
              )}
            </ConfigSection>
          </div>
        </>
      )}

      <div id="meshcore-config-radio">
        <ConfigSection
          title={t('meshcore.config.radio_params', 'Radio parameters')}
          docsUrl={`${MESHCORE_DOCS}#radio-configuration`}
          description={t('meshcore.config.radio_hint',
            'Frequency (137–1020 MHz), Bandwidth (kHz), Spreading Factor (5–12), Coding Rate (5–8 → 4/5 – 4/8).')}
          canWrite={canWriteConfig}
          collapsible
        >
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
            {presetNote && (
              <p className="hint" data-testid="mc-cfg-preset-note">
                <UiIcon name="info" size={14} /> {presetNote}
              </p>
            )}
          </div>
          <div className="form-row">
            <div>
              <label htmlFor="mc-cfg-freq">{t('meshcore.config.frequency', 'Frequency (MHz)')}</label>
              <NumberInputScope scope={radioNumbers}>
                <NumberInput
                  id="mc-cfg-freq"
                  step={0.001}
                  min={137}
                  max={1020}
                  value={freq}
                  onChange={setFreq}
                  disabled={!connected || savingRadio}
                />
              </NumberInputScope>
            </div>
            <div>
              <label htmlFor="mc-cfg-bw">{t('meshcore.config.bandwidth', 'Bandwidth (kHz)')}</label>
              <select
                id="mc-cfg-bw"
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
              <label htmlFor="mc-cfg-sf">{t('meshcore.config.sf', 'Spreading Factor')}</label>
              <select
                id="mc-cfg-sf"
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
              <label htmlFor="mc-cfg-cr">{t('meshcore.config.cr', 'Coding Rate')}</label>
              <select
                id="mc-cfg-cr"
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
              disabled={!connected || savingRadio || !canWriteConfig || radioNumbers.invalid}
            >
              {savingRadio
                ? t('meshcore.config.saving', 'Saving…')
                : t('meshcore.config.save_radio', 'Save radio settings')}
            </button>
            {radioSaved && (
              <span style={{ marginLeft: '0.75rem', color: 'var(--color-success)' }}>
                <UiIcon name="check" size={14} /> {t('meshcore.config.saved', 'Saved')}
              </span>
            )}
          </div>
        </ConfigSection>
      </div>

      <div id="meshcore-config-tx-power">
        <ConfigSection
          title={t('meshcore.config.tx_power', 'TX Power')}
          docsUrl={`${MESHCORE_DOCS}#radio-configuration`}
          description={t('meshcore.config.tx_power_hint',
            `Transmit power in dBm (1–${maxTxPower}). This controls the LoRa chip output only; boards with an external PA may amplify further.`)}
          canWrite={canWriteConfig}
          collapsible
        >
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
              <span style={{ marginLeft: '0.75rem', color: 'var(--color-success)' }}>
                <UiIcon name="check" size={14} /> {t('meshcore.config.saved', 'Saved')}
              </span>
            )}
          </div>
        </ConfigSection>
      </div>

      <div id="meshcore-config-telemetry">
        <ConfigSection
          title={t('meshcore.config.telemetry', 'Telemetry')}
          docsUrl={`${MESHCORE_DOCS}#telemetry-modes`}
          description={t('meshcore.config.telemetry_hint',
            'Control what telemetry this node shares. Always = broadcast on advert; Device only = only respond to direct requests from your contacts; Never = disable.')}
          canWrite={canWriteConfig}
          collapsible
        >
          {connected && isCompanionOnly && (
            <p className="hint" style={{ color: 'var(--color-warning)' }}>
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
              <span style={{ marginLeft: '0.75rem', color: 'var(--color-success)' }}>
                <UiIcon name="check" size={14} /> {t('meshcore.config.saved', 'Saved')}
              </span>
            )}
          </div>
        </ConfigSection>
      </div>

      {/* Written to the device, so they sit with the other saved device
          settings (#5683 follow-up; both came from the Settings tab). */}
      {isCompanion && (
        <MeshCorePathHashSection
          connected={connected}
          loading={loading}
          actions={actions}
          canWriteConfig={canWriteConfig}
        />
      )}
      {isCompanion && (
        <MeshCoreBlePinSection
          connected={connected}
          loading={loading}
          actions={actions}
          canWriteConfig={canWriteConfig}
        />
      )}
      {isCompanion && (
        <MeshCoreMultiAcksSection
          connected={connected}
          loading={loading}
          actions={actions}
          canWriteConfig={canWriteConfig}
          multiAcks={local?.multiAcks}
          firmwareVer={local?.firmwareVer}
        />
      )}
      {isCompanion && (
        <MeshCoreDefaultScopeSection
          connected={connected}
          loading={loading}
          actions={actions}
          receiveOnly={receiveOnly}
          canWriteConfig={canWriteConfig}
          canWriteNodes={canWriteNodes}
          otherSweepRunning={nodeSweepRunning}
          onSweepRunningChange={setRegionSweepRunning}
        />
      )}

      {/* Channels — Companion-only and only when the per-source addressing
          props are available (sourceId/baseUrl come from the MeshCorePage). */}
      {showChannels && baseUrl !== undefined && sourceId && (
        <MeshCoreChannelsConfigSection
          baseUrl={baseUrl}
          sourceId={sourceId}
          canWrite={connected && canWriteConfig}
        />
      )}

      {/* Radio contact list vs MeshMonitor (#5502). Gates itself: the auto-add
          switch on configuration:write, the push on nodes:write. */}
      {showContactSync && baseUrl !== undefined && sourceId && (
        <MeshCoreContactSyncSection
          baseUrl={baseUrl}
          sourceId={sourceId}
          connected={connected}
          canEditConfig={canWriteConfig}
          canEditNodes={canWriteNodes}
        />
      )}

      {/* Device actions: done on the radio when pressed, never saved. Kept
          apart from the saved settings above. */}
      <MeshCoreDeviceActionsSection
        connected={connected}
        loading={loading}
        isCompanion={isCompanion}
        actions={actions}
        receiveOnly={receiveOnly}
        canWriteNodes={canWriteNodes}
        canWriteConnection={canWriteConnection}
        otherSweepRunning={regionSweepRunning}
        onSweepRunningChange={setNodeSweepRunning}
      />

      {/* Local CLI console — gated on configuration:write (matches the
          form fields above) and per-source via the route. Available for
          all firmware types; the catalog adapts. */}
      {showConsole && sourceId && (
        <MeshCoreLocalConsole
          sourceId={sourceId}
          deviceName={local?.name}
          deviceType={local?.advType}
          firmwareVer={local?.firmwareVer}
          connected={connected}
          actions={{ sendLocalCliCommand: actions.sendLocalCliCommand }}
          receiveOnly={receiveOnly}
        />
      )}

      {/* Analyzer Observer (#4457) — signing key + live publish status. Rendered
          while DISCONNECTED too: three of the four key routes work without a
          manager. Companion-only, matching the server's OBSERVER_REQUIRES_COMPANION.
          Deliberately NOT gated on connected or canWriteConfig (unlike the
          Device Management mount below): read-only users get the status
          display, and disconnected sources still need key management. The
          component does its own configuration:read / configuration:write gating. */}
      {showObserver && sourceId && (
        <MeshCoreObserverSection sourceId={sourceId} connected={connected} deviceType={local?.advType} />
      )}

      {/* Purge non-favourite nodes from MeshMonitor's DB (#6041). A DB-only
          action, so it is shown for every device type and whether connected or
          not; it gates itself on nodes:write. The radio is never touched. */}
      {sourceId && (
        <MeshCoreNodePurgeSection
          sourceId={sourceId}
          canWriteNodes={canWriteNodes}
        />
      )}

      {/* Device Management — danger zone operations (Companion and Repeater). */}
      {showDangerZone && (
        <MeshCoreDeviceManagement
          actions={actions}
          deviceName={local?.name}
          publicKey={local?.publicKey}
          capabilities={deviceCapabilities}
          isAdmin={isAdmin}
          isCompanion={isCompanion}
          firmwareVer={local?.firmwareVer}
          overNetwork={status?.config?.connectionType === 'tcp' || !!status?.config?.tcpHost}
        />
      )}
      </div>
      </div>
    </div>
  );
};
