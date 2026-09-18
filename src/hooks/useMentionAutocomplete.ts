import { useCallback, useMemo, useRef, useState } from 'react';
import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
  type MentionCandidate,
  type MentionQuery,
} from '../utils/mentions';

/** Either composer element shape: Meshtastic uses a textarea, MeshCore an input. */
export type MentionInputElement = HTMLTextAreaElement | HTMLInputElement;

interface UseMentionAutocompleteOptions<T extends MentionCandidate> {
  /** Current draft text. */
  value: string;
  /** Called with the new draft when a mention is inserted. */
  onChange: (next: string) => void;
  /** The composer's input, so the caret can be read and restored. */
  textareaRef: React.RefObject<MentionInputElement | null>;
  /** Everything mentionable, most likely first — a bare `@` shows the head of this list. */
  candidates: readonly T[];
  /**
   * Builds the text to insert. Defaults to the Meshtastic `@!<id> ` token;
   * MeshCore passes its own `@[Name] ` form.
   */
  buildInsertion?: (candidate: T) => string;
}

/**
 * Drives an `@` mention popup for one composer (#5276).
 *
 * The hook owns which query is open and which row is highlighted; the caller
 * owns the textarea. Callers must pass `onKeyDown` through *before* their own
 * Enter-to-send handler, because an open list has to claim Enter, Tab, the
 * arrows and Escape first — otherwise picking a suggestion would send the
 * message instead.
 */
export function useMentionAutocomplete<T extends MentionCandidate>({
  value,
  onChange,
  textareaRef,
  candidates,
  buildInsertion,
}: UseMentionAutocompleteOptions<T>) {
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Remembers where to put the caret after React re-renders with the new text.
  const pendingCaret = useRef<number | null>(null);

  const suggestions = useMemo(
    () => (query ? filterMentionCandidates(candidates, query.query) : []),
    [candidates, query]
  );

  const close = useCallback(() => {
    setQuery(null);
    setActiveIndex(0);
  }, []);

  /** Re-read the caret and reopen, close, or keep the list in step. */
  const syncFromCaret = useCallback((text: string, caret: number | null | undefined) => {
    if (caret === null || caret === undefined) {
      close();
      return;
    }
    const next = findMentionQuery(text, caret);
    setQuery(next);
    setActiveIndex(0);
  }, [close]);

  const handleChange = useCallback((text: string, caret: number | null | undefined) => {
    syncFromCaret(text, caret);
  }, [syncFromCaret]);

  const select = useCallback((candidate: T) => {
    if (!query) return;
    const insertion = buildInsertion ? buildInsertion(candidate) : undefined;
    const result = insertion === undefined
      ? applyMention(value, query, candidate.id)
      : {
          text: value.slice(0, query.start) + insertion + value.slice(query.end),
          caret: query.start + insertion.length,
        };

    onChange(result.text);
    pendingCaret.current = result.caret;
    close();

    // The textarea still holds the old value this tick; move the caret once
    // React has written the new one.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      const caret = pendingCaret.current;
      pendingCaret.current = null;
      if (!el || caret === null) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }, [buildInsertion, close, onChange, query, textareaRef, value]);

  /**
   * Returns true when the key was consumed, so the caller can skip its own
   * handling (most importantly Enter, which would otherwise send).
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<MentionInputElement>): boolean => {
    if (!query || suggestions.length === 0) return false;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex(i => (i + 1) % suggestions.length);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex(i => (i - 1 + suggestions.length) % suggestions.length);
        return true;
      case 'Enter':
      case 'Tab':
        if (e.nativeEvent.isComposing) return false;
        e.preventDefault();
        select(suggestions[activeIndex]);
        return true;
      case 'Escape':
        e.preventDefault();
        close();
        return true;
      default:
        return false;
    }
  }, [activeIndex, close, query, select, suggestions]);

  return {
    /** Rows to render; empty means the popup is closed. */
    suggestions,
    activeIndex,
    setActiveIndex,
    isOpen: query !== null && suggestions.length > 0,
    handleChange,
    handleKeyDown,
    select,
    close,
    /** Re-check after a click or arrow move that only changed the caret. */
    syncFromCaret,
  };
}
