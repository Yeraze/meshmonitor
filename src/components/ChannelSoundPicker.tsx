/**
 * Per-channel notification sound picker.
 *
 * Renders one row per channel with a dropdown to choose which bundled sound
 * plays when a new message arrives on that channel (including a "Silent"
 * option), plus a preview button that plays the currently-selected sound. A
 * row for the direct-message pseudo-channel (id -1) is shown first for
 * Meshtastic sources — MeshCore message events don't reach the notification
 * path, so it is hidden there, mirroring NotificationsTab's DM toggle.
 *
 * Selections persist to localStorage via the notificationSounds helpers — the
 * same client-local persistence the master audio toggle already uses — and are
 * scoped to the active source so the same channel number on two sources keeps
 * independent sounds. The component fetches the channel list for the active
 * source itself, mirroring how NotificationsTab loads channels.
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

/** DM pseudo-channel id, matching the app's convention (see App.tsx). */
const DM_CHANNEL_ID = -1;

/** A single row in the picker: a channel id and the label to show for it. */
interface PickerRow {
  id: number;
  label: string;
}

const ChannelSoundPicker: React.FC = () => {
  const { t } = useTranslation();
  const { sourceId: currentSourceId, sourceType } = useSource();
  const isMeshCore = sourceType === 'meshcore';

  const [channels, setChannels] = useState<Channel[]>([]);
  // Map of channelId -> selected sound id. Seeded from localStorage once the
  // channels load so re-renders don't repeatedly hit storage.
  const [selections, setSelections] = useState<Record<number, string>>({});

  // The DM pseudo-channel comes first (Meshtastic only), then the real channels.
  const rows: PickerRow[] = [
    ...(isMeshCore
      ? []
      : [{ id: DM_CHANNEL_ID, label: t('settings.channel_sound_dm', 'Direct Messages') }]),
    ...channels.map(ch => ({
      id: ch.id,
      label: ch.displayName || ch.name || t('notifications.channel_number', { id: ch.id }),
    })),
  ];

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
        if (!isMeshCore) {
          seeded[DM_CHANNEL_ID] = getChannelSoundId(DM_CHANNEL_ID, currentSourceId);
        }
        for (const ch of list) {
          seeded[ch.id] = getChannelSoundId(ch.id, currentSourceId);
        }
        setSelections(seeded);
      } catch (error) {
        logger.error('Failed to load channels for sound picker:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSourceId, isMeshCore]);

  const handleChange = (channelId: number, soundId: string) => {
    setChannelSoundId(channelId, soundId, currentSourceId);
    setSelections(prev => ({ ...prev, [channelId]: soundId }));
  };

  const handlePreview = (soundId: string) => {
    playSound(soundId);
  };

  if (rows.length === 0) {
    return (
      <p className="setting-description" style={{ marginTop: '0.5rem' }}>
        {t('settings.channel_sounds_no_channels', 'No channels available yet.')}
      </p>
    );
  }

  return (
    <div className="channel-sound-picker" style={{ marginTop: '0.5rem' }}>
      {rows.map(row => {
        const value = selections[row.id] ?? DEFAULT_SOUND_ID;
        const selectId = `channel-sound-${row.id}`;
        return (
          <div
            key={row.id}
            className="setting-item"
            style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}
          >
            <label htmlFor={selectId} style={{ minWidth: '120px', margin: 0 }}>
              {row.label}
            </label>
            <select
              id={selectId}
              className="setting-input"
              style={{ flex: '1 1 180px', minWidth: '160px' }}
              value={value}
              onChange={e => handleChange(row.id, e.target.value)}
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
              aria-label={`${t('settings.channel_sound_preview', 'Preview sound')}: ${row.label}`}
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
