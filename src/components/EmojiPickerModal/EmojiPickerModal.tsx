import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshMessage } from '../../types/message';
import './EmojiPickerModal.css';

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
  // Hop count emojis (for ping/test responses)
  { emoji: '*️⃣', title: 'Direct (0 hops)' },
  { emoji: '1️⃣', title: '1 hop' },
  { emoji: '2️⃣', title: '2 hops' },
  { emoji: '3️⃣', title: '3 hops' },
  { emoji: '4️⃣', title: '4 hops' },
  { emoji: '5️⃣', title: '5 hops' },
  { emoji: '6️⃣', title: '6 hops' },
  { emoji: '7️⃣', title: '7+ hops' },
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

  if (!message) return null;

  // Use custom emojis if provided, otherwise use defaults
  const emojis = customEmojis && customEmojis.length > 0 ? customEmojis : DEFAULT_TAPBACK_EMOJIS;

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
        </div>
      </div>
    </div>
  );
};
