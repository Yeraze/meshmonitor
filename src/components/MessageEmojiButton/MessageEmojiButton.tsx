import React from 'react';
import { useTranslation } from 'react-i18next';
import { useIsDesktop } from '../../hooks/useIsDesktop';
import './MessageEmojiButton.css';

export interface MessageEmojiButtonProps {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (next: string) => void;
}

export const MessageEmojiButton: React.FC<MessageEmojiButtonProps> = () => {
  const { t } = useTranslation();
  const isDesktop = useIsDesktop();
  if (!isDesktop) return null;
  return (
    <div className="emoji-insert-wrapper">
      <button
        type="button"
        className="emoji-insert-button"
        title={t('messages.insert_emoji_button_title', 'Insert emoji')}
        aria-label={t('messages.insert_emoji_button_title', 'Insert emoji')}
      >
        😀
      </button>
    </div>
  );
};
