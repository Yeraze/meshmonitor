/**
 * Copy text with the secure-context Clipboard API, else a hidden-textarea
 * execCommand('copy') fallback (plain-HTTP LAN installs have no navigator.clipboard).
 * Resolves false on failure; never throws.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand path
  }
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    try {
      textArea.select();
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(textArea);
    }
  } catch {
    return false;
  }
}
