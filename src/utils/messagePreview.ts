/** One-line preview of a message body for a conversation list row. */
export function formatMessagePreview(text: string | null | undefined, max = 50): string {
  const s = text || '';
  return s.substring(0, max) + (s.length > max ? '...' : '');
}
