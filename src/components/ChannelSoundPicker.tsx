/**
 * Per-channel notification sound picker.
 *
 * Renders one row per channel with a dropdown to choose which bundled sound
 * plays when a new message arrives on that channel (including a "Silent"
 * option), plus a preview button that plays the currently-selected sound.
 *
 * Selections persist to localStorage via the notificationSounds helpers — the
 * same client-local persistence the master audio toggle already uses — so this
 * component is fully self-contained and needs no new props threaded through the
 * Settings tab. It fetches the channel list for the active source itself,
 * mirroring how NotificationsTab loads channels.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../services/api';
import { logger } from '../utils/logger';
import { Channel } from '../types/device';
import { useSource } from '../contexts/SourceContext';
import {
  NOTIFICATION_SOUNDS,
  DEFAULT_SOUND_ID,
  SILENT_SOUND_ID,
  getChannelSoundId,
  setChannelSoundId,
  playSound,
} from '../utils/notificationSounds';

const STANDARD_SOUNDS = NOTIFICATION_SOUNDS.filter(s => s.category === 'standard');
const FUN_SOUNDS = NOTIFICATION_SOUNDS.filter(s => s.category === 'fun');

const ChannelSoundPicker: React.FC = () => {
  const { t } = useTranslation();
  const { sourceId: currentSourceId } = useSource();

  const [channels, setChannels] = useState<Channel[]>([]);
  // Map of channelId -> selected sound id. Seeded from localStorage once the
  // channels load so re-renders don't repeatedly hit storage.
  const [selections, setSelections] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = currentSourceId ? `?sourceId=${encodeURIComponent(currentSourceId)}` : '';
        const response = await api.get<Channel[]>(`/api/channels${qs}`);
        const list = Array.isArray(response) ? response : [];
        if (cancelled) return;
        setChannels(list);
        const seeded: Record<number, string> = {};
        for (const ch of list) {
          seeded[ch.id] = getChannelSoundId(ch.id);
        }
        setSelections(seeded);
      } catch (error) {
        logger.error('Failed to load channels for sound picker:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSourceId]);

  const handleChange = (channelId: number, soundId: string) => {
    setChannelSoundId(channelId, soundId);
    setSelections(prev => ({ ...prev, [channelId]: soundId }));
  };

  const handlePreview = (soundId: string) => {
    playSound(soundId);
  };

  if (channels.length === 0) {
    return (
      <p className="setting-description" style={{ marginTop: '0.5rem' }}>
        {t('settings.channel_sounds_no_channels', 'No channels available yet.')}
      </p>
    );
  }

  return (
    <div className="channel-sound-picker" style={{ marginTop: '0.5rem' }}>
      {channels.map(channel => {
        const value = selections[channel.id] ?? DEFAULT_SOUND_ID;
        const selectId = `channel-sound-${channel.id}`;
        return (
          <div
            key={channel.id}
            className="setting-item"
            style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}
          >
            <label htmlFor={selectId} style={{ minWidth: '120px', margin: 0 }}>
              {channel.displayName || channel.name || t('notifications.channel_number', { id: channel.id })}
            </label>
            <select
              id={selectId}
              className="setting-input"
              style={{ flex: '1 1 180px', minWidth: '160px' }}
              value={value}
              onChange={e => handleChange(channel.id, e.target.value)}
            >
              <option value={SILENT_SOUND_ID}>🔕 {t('settings.channel_sound_silent', 'Silent')}</option>
              <optgroup label={t('settings.channel_sound_group_standard', 'Standard')}>
                {STANDARD_SOUNDS.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.emoji} {s.label}
                    {s.id === DEFAULT_SOUND_ID ? ` (${t('common.default', 'Default')})` : ''}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('settings.channel_sound_group_fun', 'Fun')}>
                {FUN_SOUNDS.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.emoji} {s.label}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => handlePreview(value)}
              disabled={value === SILENT_SOUND_ID}
              aria-label={t('settings.channel_sound_preview', 'Preview sound')}
              title={t('settings.channel_sound_preview', 'Preview sound')}
              style={{ padding: '0.35rem 0.75rem' }}
            >
              ▶ {t('settings.channel_sound_preview', 'Preview')}
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default ChannelSoundPicker;
