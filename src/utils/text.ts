/**
 * Calculate the UTF-8 byte length of a string
 * This properly handles multi-byte characters including emoji
 *
 * @param text - The text to measure
 * @returns The byte length when encoded as UTF-8
 */
export function getUtf8ByteLength(text: string): number {
  // Use TextEncoder for accurate UTF-8 byte counting
  // This properly handles all multi-byte characters including emoji
  const encoder = new TextEncoder();
  return encoder.encode(text).length;
}

/**
 * Format byte count display with appropriate styling based on limit
 *
 * @param byteCount - Current byte count
 * @param maxBytes - Maximum allowed bytes
 * @returns Object containing display text and style class
 */
export function formatByteCount(byteCount: number, maxBytes: number = 200): { text: string; className: string } {
  const percentage = (byteCount / maxBytes) * 100;

  let className = 'byte-counter';
  if (percentage >= 100) {
    className += ' byte-counter-over';
  } else if (percentage >= 90) {
    className += ' byte-counter-warning';
  }

  return {
    text: `${byteCount}/${maxBytes}`,
    className
  };
}

/**
 * Check if a string consists primarily of emoji characters
 * Used for styling sender dots that use emoji as shortnames
 *
 * @param content - The text to check
 * @returns True if the content is primarily emoji (1-2 emoji characters)
 */
export function isEmoji(content: string): boolean {
  if (!content) return false;
  // Match emoji characters - allow any length to support skin tone modifiers and ZWJ sequences
  return /^\p{Emoji}+$/u.test(content);
}
