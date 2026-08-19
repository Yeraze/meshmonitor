import React from 'react';
import { useTranslation } from 'react-i18next';
import { MODEM_PRESET_OPTIONS, REGION_OPTIONS } from './constants';
import type { BroadcastTarget } from '../admin-commands/useAdminCommandsState';

/**
 * Editor for the MeshBeacon repeated `broadcast_targets` list (issue #4802,
 * module_config.proto:929). Each target sends one beacon copy on its own
 * preset/region/channel. Purely presentational — the parent owns the array and
 * passes value + onChange, so both the local config and remote-admin surfaces
 * reuse the same widget instead of duplicating this table twice.
 *
 * Field semantics (all "fall back to the running config" when left at the
 * neutral choice): preset null = running config preset; region 0/UNSET = running
 * config region; channelIndex null = the preset's default channel.
 */
interface BroadcastTargetsEditorProps {
  targets: BroadcastTarget[];
  onChange: (targets: BroadcastTarget[]) => void;
  disabled: boolean;
  /** Highest valid channel-table index (MAX_NUM_CHANNELS-1). */
  maxChannelIndex?: number;
}

const DEFAULT_MAX_CHANNEL_INDEX = 7;

const BroadcastTargetsEditor: React.FC<BroadcastTargetsEditorProps> = ({
  targets,
  onChange,
  disabled,
  maxChannelIndex = DEFAULT_MAX_CHANNEL_INDEX,
}) => {
  const { t } = useTranslation();

  const updateTarget = (index: number, patch: Partial<BroadcastTarget>) => {
    onChange(targets.map((target, i) => (i === index ? { ...target, ...patch } : target)));
  };

  const addTarget = () => {
    onChange([...targets, { preset: null, region: 0, channelIndex: null }]);
  };

  const removeTarget = (index: number) => {
    onChange(targets.filter((_, i) => i !== index));
  };

  return (
    <div className="setting-item">
      <label>{t('meshbeacon_config.targets', 'Broadcast Targets')}</label>
      <span className="setting-description">
        {t('meshbeacon_config.targets_desc', 'Send one beacon copy per target, each on its own preset, region, and channel. Leave the list empty to use the single transmit settings above. Each extra target is one more transmission per broadcast cycle.')}
      </span>

      {targets.map((target, index) => (
        <div
          key={index}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'flex-end',
            marginTop: '0.5rem',
            padding: '0.5rem',
            border: '1px solid var(--color-surface-hover)',
            borderRadius: '0.375rem',
          }}
        >
          <div style={{ flex: '1 1 8rem' }}>
            <label htmlFor={`beaconTargetPreset-${index}`} style={{ fontSize: '0.8rem' }}>
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

          <div style={{ flex: '1 1 10rem' }}>
            <label htmlFor={`beaconTargetRegion-${index}`} style={{ fontSize: '0.8rem' }}>
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

          <div style={{ flex: '0 1 7rem' }}>
            <label htmlFor={`beaconTargetChannel-${index}`} style={{ fontSize: '0.8rem' }}>
              {t('meshbeacon_config.target_channel_index', 'Channel #')}
            </label>
            <input
              id={`beaconTargetChannel-${index}`}
              type="number"
              min="0"
              max={maxChannelIndex}
              value={target.channelIndex === null ? '' : target.channelIndex}
              onChange={(e) =>
                updateTarget(index, {
                  channelIndex: e.target.value === '' ? null : parseInt(e.target.value),
                })
              }
              disabled={disabled}
              className="setting-input"
              placeholder={t('meshbeacon_config.target_channel_default', 'default')}
            />
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
      ))}

      <button
        type="button"
        onClick={addTarget}
        disabled={disabled}
        className="btn btn-secondary"
        style={{ marginTop: '0.5rem' }}
      >
        {t('meshbeacon_config.target_add', 'Add target')}
      </button>
    </div>
  );
};

export default BroadcastTargetsEditor;
