/**
 * Insert text into a compose box at the caret (replacing any selection).
 * Shared by the emoji picker and the composer's + menu (#6370).
 */

export interface InsertAtCaretResult {
  next: string;
  /** Caret position just after the inserted text. */
  caret: number;
}

/**
 * Pure string half. With `pad`, a space is added before the text when it would
 * touch a non-space character on the left, and after it when it would touch
 * one on the right, so an inserted token stays a separate word.
 */
export function insertAtCaret(
  value: string,
  text: string,
  start: number,
  end: number,
  opts: { pad?: boolean } = {},
): InsertAtCaretResult {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  const before = value.slice(0, s);
  const after = value.slice(e);
  let insert = text;
  if (opts.pad) {
    if (before.length > 0 && !/\s$/.test(before)) insert = ' ' + insert;
    if (after.length > 0 && !/^\s/.test(after)) insert = insert + ' ';
  }
  return { next: before + insert + after, caret: s + insert.length };
}

/**
 * DOM half: read the caret from the textarea (end of text when there is
 * none), write the new value, then put focus and the caret back after the
 * inserted text. `getValue` is read at call time, so a caller holding this
 * across a picker dialog never writes over newer typing.
 */
export function insertIntoTextarea(
  textarea: HTMLTextAreaElement | null,
  getValue: () => string,
  setValue: (next: string) => void,
  text: string,
  opts: { pad?: boolean } = {},
): void {
  const value = getValue();
  const start = textarea?.selectionStart ?? value.length;
  const end = textarea?.selectionEnd ?? value.length;
  const { next, caret } = insertAtCaret(value, text, start, end, opts);
  setValue(next);
  if (!textarea) return;
  requestAnimationFrame(() => {
    textarea.focus();
    try {
      textarea.setSelectionRange(caret, caret);
    } catch {
      /* setSelectionRange can throw on disabled inputs; ignore */
    }
  });
}
