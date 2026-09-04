import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MODEM_PRESET_OPTIONS, REGION_OPTIONS } from './constants';
import styles from './BroadcastTargetsEditor.module.css';
import { MESH_BEACON_MAX_TARGETS, type BroadcastTarget } from '../admin-commands/useAdminCommandsState';
import type { Channel } from '../../types/device';

/**
 * Editor for the MeshBeacon repeated `broadcast_targets` list. Since firmware
 * consolidated the single `broadcast_on_*` destination onto this list
 * (protobufs #1048 / firmware #11646, issue #5062) it is the *only* way to name
 * a beacon transmit destination. Purely presentational — the parent owns the
 * array and passes value + onChange, so both the local config and remote-admin
 * surfaces reuse the same widget instead of duplicating this table twice.
 *
 * Field semantics (all "fall back to the running config" when left at the
 * neutral choice): preset null = running config preset; region 0/UNSET =
 * running config region; channelIndex null = the preset's default channel.
 *
 * Two firmware limits are enforced here because both fail *silently*: nanopb
 * caps the list at `max_count:4`, and a `channel_index` the node has no channel
 * for cannot be encrypted. Exceeding the count drops the whole ModuleConfig on
 * the device with no error and no log line, so the channel field is a slot
 * picker over the node's own channels rather than a free number.
 */
interface BroadcastTargetsEditorProps {
  targets: BroadcastTarget[];
  onChange: (targets: BroadcastTarget[]) => void;
  disabled: boolean;
  /**
   * The node's channel table. Only slots the node actually has are offered —
   * the firmware needs a channel's key to encrypt a beacon copy, so an index it
   * does not hold silently transmits nothing.
   */
  channels?: Channel[];
}

/** A channel slot is usable as a target only when the node has it configured. */
function isConfiguredChannel(channel: Channel): boolean {
  // role 0 = DISABLED. Slot 0 is PRIMARY and effectively always present.
  return channel.role !== undefined && channel.role !== 0;
}

const BroadcastTargetsEditor: React.FC<BroadcastTargetsEditorProps> = ({
  targets,
  onChange,
  disabled,
  channels = [],
}) => {
  const { t } = useTranslation();

  const channelOptions = useMemo(
    () =>
      channels
        .filter(isConfiguredChannel)
        .map((channel) => ({
          index: channel.id,
          // `displayName` carries the server's preset-derived label for an
          // unnamed slot 0; fall back for the remote-admin list, which builds
          // its rows straight from get-channel responses.
          label: channel.displayName || channel.name || (channel.id === 0 ? 'Primary' : `Channel ${channel.id}`),
        }))
        .sort((a, b) => a.index - b.index),
    [channels]
  );

  const hasChannels = channelOptions.length > 0;
  const atMaxTargets = targets.length >= MESH_BEACON_MAX_TARGETS;

  const updateTarget = (index: number, patch: Partial<BroadcastTarget>) => {
    onChange(targets.map((target, i) => (i === index ? { ...target, ...patch } : target)));
  };

  const addTarget = () => {
    if (atMaxTargets) return;
    onChange([...targets, { preset: null, region: 0, channelIndex: null }]);
  };

  const removeTarget = (index: number) => {
    onChange(targets.filter((_, i) => i !== index));
  };

  return (
    <div className="setting-item">
      <label>{t('meshbeacon_config.targets', 'Broadcast Targets')}</label>
      <span className="setting-description">
        {t('meshbeacon_config.targets_desc', 'Send one beacon copy per target, each on its own preset, region, and channel. Leave the list empty to send a single beacon on this node\'s running preset and region over the primary channel. Each extra target is one more transmission per broadcast cycle.')}
      </span>

      {targets.map((target, index) => {
        // A target loaded from the device can point at a slot this node no
        // longer has. Surface it as its own option instead of silently
        // rewriting the user's stored value to "default".
        const isUnknownChannel =
          target.channelIndex !== null && !channelOptions.some((option) => option.index === target.channelIndex);

        return (
          <div key={index} className={styles.row}>
            <div className={styles.field}>
              <label htmlFor={`beaconTargetPreset-${index}`} className={styles.fieldLabel}>
                {t('meshbeacon_config.target_preset', 'Preset')}
              </label>
              <select
                id={`beaconTargetPreset-${index}`}
                value={target.preset === null ? '' : target.preset}
                onChange={(e) =>
                  updateTarget(index, {
                    preset: e.target.value === '' ? null : parseInt(e.target.value),
                  })
                }
                disabled={disabled}
                className="setting-input"
              >
                <option value="">{t('meshbeacon_config.target_use_running', 'Running config')}</option>
                {MODEM_PRESET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.name}</option>
                ))}
              </select>
            </div>

            <div className={styles.fieldWide}>
              <label htmlFor={`beaconTargetRegion-${index}`} className={styles.fieldLabel}>
                {t('meshbeacon_config.target_region', 'Region')}
              </label>
              <select
                id={`beaconTargetRegion-${index}`}
                value={target.region}
                onChange={(e) => updateTarget(index, { region: parseInt(e.target.value) || 0 })}
                disabled={disabled}
                className="setting-input"
              >
                {REGION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className={styles.fieldWide}>
              <label htmlFor={`beaconTargetChannel-${index}`} className={styles.fieldLabel}>
                {t('meshbeacon_config.target_channel', 'Channel')}
              </label>
              <select
                id={`beaconTargetChannel-${index}`}
                value={target.channelIndex === null ? '' : target.channelIndex}
                onChange={(e) =>
                  updateTarget(index, {
                    channelIndex: e.target.value === '' ? null : parseInt(e.target.value),
                  })
                }
                disabled={disabled || !hasChannels}
                className="setting-input"
              >
                <option value="">{t('meshbeacon_config.target_channel_default', 'Default for preset')}</option>
                {channelOptions.map((option) => (
                  <option key={option.index} value={option.index}>
                    {option.index} — {option.label}
                  </option>
                ))}
                {isUnknownChannel && (
                  <option value={target.channelIndex as number}>
                    {t('meshbeacon_config.target_channel_missing', '{{index}} — not configured on this node', {
                      index: target.channelIndex,
                    })}
                  </option>
                )}
              </select>
            </div>

            <button
              type="button"
              onClick={() => removeTarget(index)}
              disabled={disabled}
              className="btn btn-secondary"
              aria-label={t('meshbeacon_config.target_remove', 'Remove target')}
            >
              {t('meshbeacon_config.target_remove', 'Remove target')}
            </button>
          </div>
        );
      })}

      {!hasChannels && (
        <span className={styles.notice}>
          {t('meshbeacon_config.targets_no_channels', 'No channels are available for this node yet, so a target can only use the default channel for its preset. A beacon can only be sent on a channel the node already has — the firmware needs that channel\'s key to encrypt it.')}
        </span>
      )}

      <button
        type="button"
        onClick={addTarget}
        disabled={disabled || atMaxTargets}
        className={`btn btn-secondary ${styles.addButton}`}
      >
        {t('meshbeacon_config.target_add', 'Add target')}
      </button>

      {atMaxTargets && (
        <span className={styles.warning}>
          {t('meshbeacon_config.targets_max_reached', 'Firmware accepts at most {{max}} targets. A longer list is rejected by the device without an error, and the whole MeshBeacon config is dropped with it.', {
            max: MESH_BEACON_MAX_TARGETS,
          })}
        </span>
      )}
    </div>
  );
};

export default BroadcastTargetsEditor;
