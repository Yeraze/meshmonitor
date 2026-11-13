/**
 * Insert a message token (e.g. `{VERSION}`) into a template string.
 *
 * Shared by the auto-announce / auto-welcome editors. With a selection, the
 * token replaces it (or lands at the caret when start === end); with no
 * selection (textarea not mounted) it is appended. `caret` is where the
 * cursor belongs afterwards: just past the inserted token.
 */
export function insertTokenAtSelection(
  text: string,
  token: string,
  selection: { start: number; end: number } | null,
): { text: string; caret: number } {
  if (!selection) {
    const appended = text + token;
    return { text: appended, caret: appended.length };
  }
  const { start, end } = selection;
  return {
    text: text.substring(0, start) + token + text.substring(end),
    caret: start + token.length,
  };
}
