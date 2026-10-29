import React, { ReactNode, RefObject, useMemo } from 'react';
import { useComposeDraft } from '../contexts/composeDraftStore';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useMentionAutocomplete } from '../hooks/useMentionAutocomplete';
import MentionAutocomplete from './mentions/MentionAutocomplete';
import { MessageEmojiButton } from './MessageEmojiButton';
import { UiIcon } from './icons';
import { getUtf8ByteLength, formatByteCount } from '../utils/text';
import { applyHomoglyphOptimization } from '../utils/homoglyph';
import type { MentionCandidate } from '../utils/mentions';

interface MessageComposeInputProps {
  /** id for the mention suggestion list (unique per composer). */
  listId: string;
  /** The textarea element, for auto-resize, mentions and the emoji picker. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Ref to attach to the textarea; defaults to `textareaRef`. */
  inputRef?: React.Ref<HTMLTextAreaElement>;
  mentionCandidates: readonly MentionCandidate[];
  homoglyphEnabled: boolean;
  placeholder: string;
  disabled: boolean;
  /** Title for the textarea and send button while disabled. */
  disabledTitle?: string;
  onFocus?: React.FocusEventHandler<HTMLTextAreaElement>;
  onSend: () => void;
  /** Buttons rendered between the emoji button and the send button. */
  actions?: ReactNode;
  sendAriaLabel?: string;
}

/**
 * The text box, byte counter, emoji button and send button of a message
 * composer. It is the only component that subscribes to the compose draft,
 * so a keystroke re-renders this and nothing else — not the conversation,
 * not the node list, not App (see composeDraftStore).
 */
const MessageComposeInput: React.FC<MessageComposeInputProps> = ({
  listId,
  textareaRef,
  inputRef,
  mentionCandidates,
  homoglyphEnabled,
  placeholder,
  disabled,
  disabledTitle,
  onFocus,
  onSend,
  actions,
  sendAriaLabel,
}) => {
  const [draft, setDraft] = useComposeDraft();

  useAutoResizeTextarea(textareaRef, draft);

  // #5276: `@` mention autocomplete over the nodes this source knows.
  const mentions = useMentionAutocomplete({
    value: draft,
    onChange: setDraft,
    textareaRef,
    candidates: mentionCandidates,
  });

  // Memoize byte count to avoid redundant homoglyph optimization on each render
  const byteCountDisplay = useMemo(() => {
    const message = homoglyphEnabled ? applyHomoglyphOptimization(draft) : draft;
    return formatByteCount(getUtf8ByteLength(message));
  }, [draft, homoglyphEnabled]);

  const title = disabled ? disabledTitle : undefined;

  return (
    <>
      <div className="input-with-counter" style={{ position: 'relative' }}>
        <MentionAutocomplete
          id={listId}
          candidates={mentions.suggestions}
          activeIndex={mentions.activeIndex}
          onHover={mentions.setActiveIndex}
          onSelect={mentions.select}
        />
        <textarea
          ref={inputRef ?? textareaRef}
          value={draft}
          onChange={e => {
            setDraft(e.target.value);
            mentions.handleChange(e.target.value, e.target.selectionStart);
          }}
          onSelect={e => mentions.syncFromCaret(
            e.currentTarget.value,
            e.currentTarget.selectionStart
          )}
          onBlur={mentions.close}
          role="combobox"
          aria-expanded={mentions.isOpen}
          aria-controls={mentions.isOpen ? listId : undefined}
          aria-activedescendant={mentions.activeDescendantId(listId)}
          aria-autocomplete="list"
          onFocus={onFocus}
          placeholder={placeholder}
          className="message-input"
          rows={1}
          disabled={disabled}
          title={title}
          onKeyDown={e => {
            // An open suggestion list claims Enter/Tab/arrows first, or
            // picking a node would send instead.
            if (mentions.handleKeyDown(e)) return;
            if (
              disabled ||
              !(
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey &&
                !e.nativeEvent.isComposing
              )
            ) {
              return;
            }
            e.preventDefault();
            onSend();
          }}
        />
        <div className={byteCountDisplay.className}>
          {byteCountDisplay.text}
        </div>
      </div>
      <MessageEmojiButton
        textareaRef={textareaRef}
        value={draft}
        onChange={setDraft}
      />
      {actions}
      <button
        onClick={onSend}
        disabled={!draft.trim() || disabled}
        className="send-btn"
        title={title}
        aria-label={sendAriaLabel}
      >
        <UiIcon name="send" size={16} />
      </button>
    </>
  );
};

export default MessageComposeInput;
