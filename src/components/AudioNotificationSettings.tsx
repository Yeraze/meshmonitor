/**
 * Master audio toggle plus the per-channel sound picker (P11 S9).
 * Shared by the Meshtastic Settings tab and the MeshCore settings view.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import ChannelSoundPicker from './ChannelSoundPicker';

interface AudioNotificationSettingsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** MeshCore device type (1 Companion, 2 Repeater); decides if the DM row shows. */
  meshcoreDeviceType?: number | null;
}

const AudioNotificationSettings: React.FC<AudioNotificationSettingsProps> = ({
  enabled,
  onEnabledChange,
  meshcoreDeviceType,
}) => {
  const { t } = useTranslation();
  return (
    <>
      <div className="setting-item">
        <label>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            {t('settings.enable_audio_notifications')}
          </span>
          <span className="setting-description">{t('settings.enable_audio_notifications_description')}</span>
        </label>
      </div>
      {enabled && (
        <div className="setting-item">
          <label>
            {t('settings.channel_sounds_label', 'Per-channel notification sound')}
            <span className="setting-description">
              {t('settings.channel_sounds_description', 'Choose which sound plays for new messages on each channel, or silence a channel. Preview each sound before selecting.')}
            </span>
          </label>
          <ChannelSoundPicker meshcoreDeviceType={meshcoreDeviceType} />
        </div>
      )}
    </>
  );
};

export default AudioNotificationSettings;
