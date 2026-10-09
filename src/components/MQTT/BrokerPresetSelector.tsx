/**
 * The broker preset chooser that sits above the broker address in the three
 * Meshtastic MQTT forms (#5689). Presets live in `./brokerPresets`; each form
 * passes the preset its stored values already match and an `onApplyPreset`
 * that maps the chosen preset onto its own fields.
 *
 * Choosing an entry only edits the form: nothing is saved or sent from here.
 * "Custom…" changes no field; it is shown whenever the fields match no preset.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import {
  BROKER_DISCOVERY_LINKS,
  BROKER_PRESETS,
  CUSTOM_PRESET_ID,
  findBrokerPreset,
  type BrokerPreset,
  type KeptCredentials,
} from './brokerPresets';
import styles from './BrokerPresetSelector.module.css';

interface BrokerPresetSelectorProps {
  /** id of the <select>, for its label. */
  id: string;
  /** The preset the form's current values describe, or null for none. */
  matchedPresetId: string | null;
  /** Fill the form from `preset`; return which credentials were left alone. */
  onApplyPreset: (preset: BrokerPreset) => KeptCredentials;
  disabled?: boolean;
  /** `settings`: the device config pages. `dashboard`: the bridge source form. */
  layout: 'settings' | 'dashboard';
}

export const BrokerPresetSelector: React.FC<BrokerPresetSelectorProps> = ({
  id,
  matchedPresetId,
  onApplyPreset,
  disabled = false,
  layout,
}) => {
  const { t } = useTranslation();
  // "Custom…" picked while the fields still match a preset: keep showing it
  // until the user picks a preset again.
  const [forceCustom, setForceCustom] = useState(false);
  const [lastApplied, setLastApplied] = useState<{ presetId: string; kept: KeptCredentials } | null>(null);

  const value = forceCustom ? CUSTOM_PRESET_ID : matchedPresetId ?? CUSTOM_PRESET_ID;

  const handleChange = (next: string) => {
    if (next === CUSTOM_PRESET_ID) {
      setForceCustom(true);
      setLastApplied(null);
      return;
    }
    const preset = findBrokerPreset(next);
    if (!preset) return;
    setForceCustom(false);
    setLastApplied({ presetId: preset.id, kept: onApplyPreset(preset) });
  };

  // Name kept credentials only while the form still shows that preset.
  const keptPreset =
    lastApplied && !forceCustom && lastApplied.presetId === matchedPresetId
      ? findBrokerPreset(lastApplied.presetId)
      : undefined;
  const kept = keptPreset && lastApplied ? lastApplied.kept : null;
  let keptKey: string | null = null;
  if (kept?.storedPassword) keptKey = 'mqtt_presets.kept_stored_password';
  else if (kept?.username && kept.password) keptKey = 'mqtt_presets.kept_both';
  else if (kept?.username) keptKey = 'mqtt_presets.kept_username';
  else if (kept?.password) keptKey = 'mqtt_presets.kept_password';
  const keptFallbacks: Record<string, string> = {
    'mqtt_presets.kept_stored_password':
      'A password is saved for this bridge, so the preset left the password field blank. This broker’s login is {{username}} / {{password}}; type the password in to use it.',
    'mqtt_presets.kept_both':
      'Your username and password were left as they were. This broker’s login is {{username}} / {{password}}; type it in to use it.',
    'mqtt_presets.kept_username':
      'Your username was left as it was. This broker’s username is {{username}}; type it in to use it.',
    'mqtt_presets.kept_password':
      'Your password was left as it was. This broker’s password is {{password}}; type it in to use it.',
  };

  const select = (
    <select
      id={id}
      data-testid="broker-preset-select"
      className={`${layout === 'settings' ? `setting-input ${styles.selectSettings}` : 'dashboard-form-input'} ${styles.select}`}
      value={value}
      disabled={disabled}
      onChange={(e) => handleChange(e.target.value)}
    >
      {BROKER_PRESETS.map((p) => (
        <option key={p.id} value={p.id}>
          {t(p.labelKey, p.labelFallback)}
        </option>
      ))}
      <option value={CUSTOM_PRESET_ID}>{t('mqtt_presets.custom', 'Custom…')}</option>
    </select>
  );

  const notes = (
    <>
      {keptKey && keptPreset && (
        <p className={styles.kept} role="status" data-testid="broker-preset-kept">
          {t(keptKey, keptFallbacks[keptKey], {
            username: keptPreset.username,
            password: keptPreset.password,
          })}
        </p>
      )}
      <p className={styles.note} data-testid="broker-preset-discovery">
        {t('mqtt_presets.discovery', 'Want a regional broker? Local groups publish their own. Find yours:')}{' '}
        <a href={BROKER_DISCOVERY_LINKS.localGroups} target="_blank" rel="noopener noreferrer">
          {t('mqtt_presets.discovery_local_groups', 'Meshtastic Local Groups')}
        </a>
        {' · '}
        <a href={BROKER_DISCOVERY_LINKS.siteGallery} target="_blank" rel="noopener noreferrer">
          {t('mqtt_presets.discovery_site_gallery', 'MeshMonitor Site Gallery')}
        </a>
      </p>
      <p className={`${styles.note} ${styles.privacy}`} data-testid="broker-preset-privacy">
        <UiIcon name="info" />
        <span>
          {t(
            'mqtt_presets.privacy',
            'Channels with uplink on publish their traffic to this broker. On a public broker, anyone on the internet can read it.',
          )}
        </span>
      </p>
    </>
  );

  if (layout === 'dashboard') {
    return (
      <div className="dashboard-form-field" data-testid="broker-preset-selector">
        <label className="dashboard-form-label" htmlFor={id}>
          {t('mqtt_presets.label', 'Broker preset')}
        </label>
        {select}
        {notes}
      </div>
    );
  }

  return (
    <div className="setting-item" data-testid="broker-preset-selector">
      <label htmlFor={id}>
        {t('mqtt_presets.label', 'Broker preset')}
        <span className="setting-description">
          {t(
            'mqtt_presets.description',
            'Fills in the broker address, TLS and login. Nothing is sent until you save.',
          )}
        </span>
      </label>
      {select}
      {notes}
    </div>
  );
};

export default BrokerPresetSelector;
