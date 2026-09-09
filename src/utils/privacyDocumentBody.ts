/**
 * Rendering helper for operator-hosted privacy documents (#5156).
 *
 * The page renders the stored document title as its `<h1>`. An operator's
 * Markdown very often opens with that same title as its own `# Heading` —
 * whether they uploaded an exported policy, pasted one, or wrote it by hand —
 * which renders the title twice.
 *
 * This drops that leading heading at RENDER time rather than rewriting what
 * the operator saved. Editing their stored document would be the more
 * surprising fix: what they typed is what stays in the database, and only the
 * presentation de-duplicates.
 *
 * Only a leading H1 that actually duplicates the title is removed. A document
 * whose first heading says something different keeps it — that is real content,
 * not a repeat.
 */

/** Normalize for comparison: trim, collapse whitespace, case-insensitive. */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Remove a leading `# Heading` from `content` when it duplicates `title`.
 *
 * @returns the content to render. Unchanged when there is no leading H1, or
 *   when that H1 says something other than the title.
 */
export function stripDuplicateHeading(content: string, title: string): string {
  const match = /^\s*#\s+(.+?)\s*(?:\n|$)/.exec(content);
  if (!match) return content;
  if (normalize(match[1]) !== normalize(title)) return content;
  return content.slice(match[0].length).replace(/^\n+/, '');
}
