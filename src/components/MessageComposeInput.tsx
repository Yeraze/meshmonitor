import React, { ReactNode, RefObject, useCallback, useId, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useComposeDraftStore, type ComposeDraftStore } from '../contexts/composeDraftStore';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useMentionAutocomplete } from '../hooks/useMentionAutocomplete';
import MentionAutocomplete from './mentions/MentionAutocomplete';
import { MessageEmojiButton } from './MessageEmojiButton';
import ComposeInsertMenu from './ComposeInsertMenu';
import type { ComposeInsertMenuItem } from './composeInsertMenuTypes';
import { insertIntoTextarea } from '../utils/insertAtCaret';
import { UiIcon } from './icons';
import { getUtf8ByteLength, formatByteCount } from '../utils/text';
import { applyHomoglyphOptimization } from '../utils/homoglyph';
import type { MentionCandidate } from '../utils/mentions';
import styles from './MessageComposeInput.module.css';

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
  /** Draft store to bind to. Default: the compose-draft context store. */
  draftStore?: ComposeDraftStore;
  /** Byte budget shown by the counter. Default 200 (one Meshtastic packet). */
  maxBytes?: number;
  /** Block sending (button and Enter) while the draft is over `maxBytes`. */
  blockSendOverLimit?: boolean;
  /** Text a picked mention inserts. Default: the hook's `@!id` token. */
  buildMentionInsertion?: (candidate: MentionCandidate) => string;
  /** A send is in flight: disables the textarea and send, sets aria-busy. */
  sending?: boolean;
  /** Default true. False: Shift+Enter adds no newline; pasted newlines become spaces. */
  allowNewlines?: boolean;
  /**
   * Entries for a + menu between the compose box and Send (#6370). Unset or
   * empty: no + button. Inserted text counts toward `maxBytes` like typing.
   */
  insertMenuItems?: readonly ComposeInsertMenuItem[];
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
  draftStore,
  maxBytes,
  blockSendOverLimit = false,
  buildMentionInsertion,
  sending = false,
  allowNewlines = true,
  insertMenuItems,
}) => {
  const { t } = useTranslation();
  const overLimitHintId = useId();
  const contextStore = useComposeDraftStore();
  const store = draftStore ?? contextStore;
  const draft = useSyncExternalStore(store.subscribe, store.get, store.get);
  const setDraft = store.set;
  // Reads the store at call time: a + menu entry may hold this across a
  // picker dialog while the user keeps typing.
  const insertText = useCallback(
    (text: string) => insertIntoTextarea(textareaRef.current, store.get, store.set, text, { pad: true }),
    [textareaRef, store],
  );

  useAutoResizeTextarea(textareaRef, draft);

  // #5276: `@` mention autocomplete over the nodes this source knows.
  const mentions = useMentionAutocomplete({
    value: draft,
    onChange: setDraft,
    textareaRef,
    candidates: mentionCandidates,
    buildInsertion: buildMentionInsertion,
  });

  // Memoize byte count to avoid redundant homoglyph optimization on each render
  const byteLen = useMemo(() => {
    const message = homoglyphEnabled ? applyHomoglyphOptimization(draft) : draft;
    return getUtf8ByteLength(message);
  }, [draft, homoglyphEnabled]);
  const byteCountDisplay = useMemo(
    () => (maxBytes === undefined ? formatByteCount(byteLen) : formatByteCount(byteLen, maxBytes)),
    [byteLen, maxBytes]
  );
  const overLimit = blockSendOverLimit && maxBytes !== undefined && byteLen > maxBytes;
  const inputDisabled = disabled || sending;

  // Say why Send is off while the draft is over the limit, not just a red
  // counter (#4173 review L24).
  const overLimitHint = overLimit
    ? t('messages.over_limit_hint', 'Too long to send: remove {{count}} bytes', { count: byteLen - (maxBytes ?? 0) })
    : undefined;
  const title = disabled ? disabledTitle : overLimitHint;

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
            const value = allowNewlines ? e.target.value : e.target.value.replace(/\r?\n/g, ' ');
            setDraft(value);
            mentions.handleChange(value, e.target.selectionStart);
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
          autoCapitalize="sentences"
          disabled={inputDisabled}
          aria-busy={sending || undefined}
          title={title}
          onKeyDown={e => {
            // An open suggestion list claims Enter/Tab/arrows first, or
            // picking a node would send instead.
            if (mentions.handleKeyDown(e)) return;
            if (!allowNewlines && e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              return;
            }
            if (
              inputDisabled ||
              overLimit ||
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
        {overLimitHint && (
          <div id={overLimitHintId} className={styles.overLimitHint} role="status">
            {overLimitHint}
          </div>
        )}
        <div className={byteCountDisplay.className}>
          {byteCountDisplay.text}
        </div>
      </div>
      {insertMenuItems && insertMenuItems.length > 0 && (
        <ComposeInsertMenu
          items={insertMenuItems}
          insert={insertText}
          disabled={inputDisabled}
          disabledTitle={disabledTitle}
        />
      )}
      <MessageEmojiButton
        textareaRef={textareaRef}
        value={draft}
        onChange={setDraft}
      />
      {actions}
      <button
        onClick={onSend}
        disabled={!draft.trim() || inputDisabled || overLimit}
        aria-busy={sending || undefined}
        className="send-btn"
        title={title}
        aria-label={sendAriaLabel}
        aria-describedby={overLimitHint ? overLimitHintId : undefined}
      >
        <UiIcon name="send" size={16} />
      </button>
    </>
  );
};

export default MessageComposeInput;
