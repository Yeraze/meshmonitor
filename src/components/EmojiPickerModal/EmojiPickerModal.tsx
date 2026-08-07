import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshMessage } from '../../types/message';
import './EmojiPickerModal.css';
import { UiIcon } from '../icons';
import { HOP_COUNT_EMOJIS, HOP_EMOJI_MAX, MQTT_SOURCE_EMOJI } from '../../utils/hopEmoji';

/**
 * Tapback emoji type
 */
export interface TapbackEmoji {
  emoji: string;
  title: string;
}

/**
 * Default tapback emoji options - compatible with Meshtastic OLED displays
 */
export const DEFAULT_TAPBACK_EMOJIS: TapbackEmoji[] = [
  // Common reactions (compatible with Meshtastic OLED displays)
  { emoji: '👍', title: 'Thumbs up' },
  { emoji: '👎', title: 'Thumbs down' },
  { emoji: '❤️', title: 'Heart' },
  { emoji: '😂', title: 'Laugh' },
  { emoji: '😢', title: 'Cry' },
  { emoji: '😮', title: 'Wow' },
  { emoji: '😡', title: 'Angry' },
  { emoji: '🎉', title: 'Celebrate' },
  // Questions and alerts
  { emoji: '❓', title: 'Question' },
  { emoji: '❗', title: 'Exclamation' },
  { emoji: '‼️', title: 'Double exclamation' },
  // Hop count emojis (for ping/test responses) — glyphs come from the single
  // shared table so they can never drift from Auto-Acknowledge / automations.
  ...HOP_COUNT_EMOJIS.map((emoji, hops) => ({
    emoji,
    title: hops === 0 ? 'Direct (0 hops)' : hops === HOP_EMOJI_MAX ? '7+ hops' : `${hops} hop${hops === 1 ? '' : 's'}`,
  })),
  // #4594: the transport counterpart to the hop keycaps — appended here rather
  // than added to HOP_COUNT_EMOJIS, which is indexed BY hop count above.
  { emoji: MQTT_SOURCE_EMOJI, title: 'Received via MQTT' },
  // Fun emojis (OLED compatible)
  { emoji: '💩', title: 'Poop' },
  { emoji: '👋', title: 'Wave' },
  { emoji: '🤠', title: 'Cowboy' },
  { emoji: '🐭', title: 'Mouse' },
  { emoji: '😈', title: 'Devil' },
  // Weather (OLED compatible)
  { emoji: '☀️', title: 'Sunny' },
  { emoji: '☔', title: 'Rain' },
  { emoji: '☁️', title: 'Cloudy' },
  { emoji: '🌫️', title: 'Foggy' },
  // Additional useful reactions
  { emoji: '✅', title: 'Check' },
  { emoji: '❌', title: 'X' },
  { emoji: '🔥', title: 'Fire' },
  { emoji: '💯', title: '100' },
];

interface EmojiPickerModalProps {
  message: MeshMessage | null;
  onSelectEmoji: (emoji: string, message: MeshMessage) => void;
  onClose: () => void;
  customEmojis?: TapbackEmoji[];
}

export const EmojiPickerModal: React.FC<EmojiPickerModalProps> = ({
  message,
  onSelectEmoji,
  onClose,
  customEmojis,
}) => {
  const { t } = useTranslation();
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customEmoji, setCustomEmoji] = useState('');
  const customInputRef = useRef<HTMLInputElement>(null);

  // Focus input when custom input is shown
  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus();
    }
  }, [showCustomInput]);

  if (!message) return null;

  // Use custom emojis if provided, otherwise use defaults
  const emojis = customEmojis && customEmojis.length > 0 ? customEmojis : DEFAULT_TAPBACK_EMOJIS;

  const handleCustomSubmit = () => {
    const trimmed = customEmoji.trim();
    if (trimmed) {
      onSelectEmoji(trimmed, message);
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCustomSubmit();
    } else if (e.key === 'Escape') {
      setShowCustomInput(false);
      setCustomEmoji('');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="emoji-picker-modal" onClick={e => e.stopPropagation()}>
        <div className="emoji-picker-header">
          <h3>{t('emoji_picker.title', 'React with an emoji')}</h3>
          <button className="emoji-picker-close" onClick={onClose} title={t('common.close', 'Close')}>
            ×
          </button>
        </div>
        <div className="emoji-picker-grid">
          {emojis.map(({ emoji, title }) => (
            <button
              key={emoji}
              className="emoji-picker-item"
              onClick={() => {
                onSelectEmoji(emoji, message);
                onClose();
              }}
              title={title}
            >
              {emoji}
            </button>
          ))}
          {/* Custom emoji button */}
          <button
            className="emoji-picker-item emoji-picker-custom-btn"
            onClick={() => setShowCustomInput(!showCustomInput)}
            title={t('emoji_picker.custom', 'Custom emoji')}
          >
            <UiIcon name="edit" size={16} />
          </button>
        </div>
        {/* Custom emoji input section */}
        {showCustomInput && (
          <div className="emoji-picker-custom-input">
            <input
              ref={customInputRef}
              type="text"
              value={customEmoji}
              onChange={e => setCustomEmoji(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('emoji_picker.custom_placeholder', 'Type or paste emoji...')}
              maxLength={10}
            />
            <button
              onClick={handleCustomSubmit}
              disabled={!customEmoji.trim()}
              title={t('emoji_picker.send_custom', 'Send')}
            >
              {t('common.send', 'Send')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
