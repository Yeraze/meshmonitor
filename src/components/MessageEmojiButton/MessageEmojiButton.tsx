import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsDesktop } from '../../hooks/useIsDesktop';
import './MessageEmojiButton.css';
import { UiIcon } from '../icons';
import { insertIntoTextarea } from '../../utils/insertAtCaret';

const EmojiPicker = React.lazy(() => import('emoji-picker-react'));

const LIGHT_THEMES = new Set([
  'latte',
  'solarized-light',
  'gruvbox-light',
  'high-contrast-light',
]);

function detectPickerTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr && LIGHT_THEMES.has(attr)) return 'light';
  return 'dark';
}

export interface MessageEmojiButtonProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}

export const MessageEmojiButton: React.FC<MessageEmojiButtonProps> = ({
  textareaRef,
  value,
  onChange,
}) => {
  const { t } = useTranslation();
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  const handleSelect = useCallback(
    (emoji: string) => {
      insertIntoTextarea(textareaRef.current, () => value, onChange, emoji);
      setOpen(false);
    },
    [textareaRef, value, onChange]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        buttonRef.current?.focus();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open, close]);

  if (!isDesktop) return null;

  return (
    <div className="emoji-insert-wrapper" ref={wrapperRef}>
      <button
        ref={buttonRef}
        type="button"
        className="emoji-insert-button"
        title={t('messages.insert_emoji_button_title', 'Insert emoji')}
        aria-label={t('messages.insert_emoji_button_title', 'Insert emoji')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <UiIcon name="reaction" size={17} />
      </button>
      {open && (
        <div className="emoji-insert-popover" role="dialog" aria-label={t('messages.insert_emoji_button_title', 'Insert emoji')}>
          <Suspense fallback={null}>
            <EmojiPicker
              onEmojiClick={(e: { emoji: string }) => handleSelect(e.emoji)}
              theme={detectPickerTheme() as never}
              // v5 defaults to native glyphs; keep v4's Apple images (#5887).
              emojiStyle="apple"
            />
          </Suspense>
        </div>
      )}
    </div>
  );
};
