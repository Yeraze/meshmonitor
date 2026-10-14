/**
 * Remembers the channel last picked on the Unified Messages page (#5792), per
 * browser. Kept apart from the page so it can be unit-tested without rendering.
 */
import { ALL_CHANNELS_PARAM } from '../utils/unifiedChannelFilter';

/** localStorage key for the last channel chosen on Unified Messages. */
export const UNIFIED_CHANNEL_STORAGE_KEY = 'unifiedMessagesChannel';

/** Read the remembered channel. Storage errors read as nothing stored. */
export function readStoredUnifiedChannel(): string | null {
  try {
    return localStorage.getItem(UNIFIED_CHANNEL_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Persist the chosen channel. Storage errors are ignored (private mode, quota). */
export function writeStoredUnifiedChannel(channel: string): void {
  try {
    localStorage.setItem(UNIFIED_CHANNEL_STORAGE_KEY, channel);
  } catch {
    // The selection still applies for this page view.
  }
}

/**
 * Pick the channel to show when the page opens: the remembered one if it is
 * "All Channels" or still in the list, otherwise the built-in default
 * (Primary / LongFast, else the first channel). Returns '' for an empty list.
 */
export function resolveInitialUnifiedChannel(
  channelNames: string[],
  stored: string | null,
): string {
  if (channelNames.length === 0) return '';
  if (stored && (stored === ALL_CHANNELS_PARAM || channelNames.includes(stored))) return stored;
  const preferred = channelNames.find((name) => /^(primary|longfast)$/i.test(name));
  return preferred ?? channelNames[0];
}
