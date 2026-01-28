import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../contexts/SettingsContext';
import { DEFAULT_TAPBACK_EMOJIS, type TapbackEmoji } from './EmojiPickerModal/EmojiPickerModal';
import { useToast } from './ToastContainer';
import { logger } from '../utils/logger';
import { isEmoji } from '../utils/text';

/**
 * TapbackEmojiSettings - Settings component for managing tapback emoji reactions
 */
const TapbackEmojiSettings: React.FC = () => {
  const { t } = useTranslation();
  const { tapbackEmojis, setTapbackEmojis } = useSettings();
  const { showToast } = useToast();

  const [newEmoji, setNewEmoji] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleAddEmoji = async () => {
    const trimmedEmoji = newEmoji.trim();
    const trimmedTitle = newTitle.trim() || trimmedEmoji;

    if (!trimmedEmoji) {
      showToast(t('settings.tapback_emoji_required', 'Please enter an emoji'), 'error');
      return;
    }

    // Validate that the input is actually an emoji (not regular text)
    if (!isEmoji(trimmedEmoji)) {
      showToast(t('settings.tapback_invalid_emoji', 'Please enter a valid emoji, not text'), 'error');
      return;
    }

    // Check if emoji already exists
    if (tapbackEmojis.some(e => e.emoji === trimmedEmoji)) {
      showToast(t('settings.tapback_emoji_exists', 'This emoji is already in the list'), 'error');
      return;
    }

    setIsSaving(true);
    try {
      const newEmojiEntry: TapbackEmoji = {
        emoji: trimmedEmoji,
        title: trimmedTitle
      };

      await setTapbackEmojis([...tapbackEmojis, newEmojiEntry]);
      setNewEmoji('');
      setNewTitle('');
      showToast(t('settings.tapback_emoji_added', 'Emoji added'), 'success');
    } catch (error) {
      logger.error('Failed to add emoji:', error);
      showToast(t('settings.tapback_save_failed', 'Failed to save emoji'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveEmoji = async (emojiToRemove: string) => {
    if (tapbackEmojis.length <= 1) {
      showToast(t('settings.tapback_min_emojis', 'You must have at least one emoji'), 'error');
      return;
    }

    setIsSaving(true);
    try {
      const filtered = tapbackEmojis.filter(e => e.emoji !== emojiToRemove);
      await setTapbackEmojis(filtered);
      showToast(t('settings.tapback_emoji_removed', 'Emoji removed'), 'success');
    } catch (error) {
      logger.error('Failed to remove emoji:', error);
      showToast(t('settings.tapback_save_failed', 'Failed to save changes'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetToDefaults = async () => {
    const confirmed = window.confirm(
      t('settings.tapback_confirm_reset', 'Reset tapback emojis to defaults? This will replace all your custom emojis.')
    );

    if (!confirmed) return;

    setIsSaving(true);
    try {
      await setTapbackEmojis([...DEFAULT_TAPBACK_EMOJIS]);
      showToast(t('settings.tapback_reset_success', 'Emojis reset to defaults'), 'success');
    } catch (error) {
      logger.error('Failed to reset emojis:', error);
      showToast(t('settings.tapback_save_failed', 'Failed to reset emojis'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSaving) {
      handleAddEmoji();
    }
  };

  return (
    <div className="settings-section" id="settings-tapback-emojis">
      <h3>{t('settings.tapback_emojis', 'Tapback Emojis')}</h3>
      <p className="setting-description">
        {t('settings.tapback_emojis_description', 'Customize the emoji reactions available when responding to messages. These settings apply to all users.')}
      </p>

      {/* Current emoji grid */}
      <div className="tapback-emoji-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(48px, 1fr))',
        gap: '8px',
        marginBottom: '16px',
        padding: '12px',
        backgroundColor: 'var(--surface0)',
        borderRadius: '8px',
        maxHeight: '200px',
        overflowY: 'auto'
      }}>
        {tapbackEmojis.map(({ emoji, title }) => (
          <div
            key={emoji}
            title={title}
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.5rem',
              padding: '8px',
              backgroundColor: 'var(--surface1)',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'background-color 0.2s'
            }}
            className="tapback-emoji-item"
          >
            {emoji}
            <button
              onClick={() => handleRemoveEmoji(emoji)}
              disabled={isSaving}
              title={t('settings.tapback_remove_emoji', 'Remove emoji')}
              style={{
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                width: '18px',
                height: '18px',
                padding: 0,
                border: 'none',
                borderRadius: '50%',
                backgroundColor: 'var(--red)',
                color: 'var(--base)',
                fontSize: '12px',
                lineHeight: '18px',
                cursor: 'pointer',
                opacity: 0,
                transition: 'opacity 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              className="tapback-emoji-remove"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Add emoji form */}
      <div style={{
        display: 'flex',
        gap: '8px',
        marginBottom: '16px',
        flexWrap: 'wrap'
      }}>
        <input
          type="text"
          value={newEmoji}
          onChange={(e) => setNewEmoji(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={t('settings.tapback_emoji_placeholder', 'Emoji')}
          disabled={isSaving}
          style={{
            width: '80px',
            padding: '8px 12px',
            fontSize: '1.2rem',
            textAlign: 'center',
            borderRadius: '6px',
            border: '1px solid var(--surface2)',
            backgroundColor: 'var(--surface0)',
            color: 'var(--text)'
          }}
        />
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={t('settings.tapback_title_placeholder', 'Title (optional)')}
          disabled={isSaving}
          style={{
            flex: 1,
            minWidth: '150px',
            padding: '8px 12px',
            borderRadius: '6px',
            border: '1px solid var(--surface2)',
            backgroundColor: 'var(--surface0)',
            color: 'var(--text)'
          }}
        />
        <button
          onClick={handleAddEmoji}
          disabled={isSaving || !newEmoji.trim()}
          className="btn btn-primary"
          style={{
            padding: '8px 16px',
            borderRadius: '6px'
          }}
        >
          {t('settings.tapback_add_emoji', 'Add')}
        </button>
      </div>

      {/* Reset button */}
      <button
        onClick={handleResetToDefaults}
        disabled={isSaving}
        className="btn btn-secondary"
        style={{
          padding: '8px 16px',
          borderRadius: '6px'
        }}
      >
        {t('settings.tapback_reset_defaults', 'Reset to Defaults')}
      </button>

      {/* CSS for hover effects */}
      <style>{`
        .tapback-emoji-item:hover {
          background-color: var(--surface2) !important;
        }
        .tapback-emoji-item:hover .tapback-emoji-remove {
          opacity: 1 !important;
        }
        .tapback-emoji-remove:hover {
          background-color: var(--maroon) !important;
        }
      `}</style>
    </div>
  );
};

export default TapbackEmojiSettings;
