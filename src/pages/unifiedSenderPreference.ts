/**
 * Remembers which node sends for each channel on the Unified Messages page
 * (#3045 P2), per browser. Only a manual pick is stored. Kept apart from the
 * composer so it can be unit-tested without rendering.
 */
import type { SenderRef } from './unifiedSendRequest';

/** localStorage key: a JSON map of channel name -> source id. */
export const UNIFIED_SENDER_STORAGE_KEY = 'unifiedMessagesSender';

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(UNIFIED_SENDER_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Read the remembered source id for a channel. Storage errors read as null. */
export function readStoredUnifiedSender(channelName: string): string | null {
  return readMap()[channelName] || null;
}

/** Persist a manual pick for a channel. Storage errors are ignored. */
export function writeStoredUnifiedSender(channelName: string, sourceId: string): void {
  try {
    const next = { ...readMap(), [channelName]: sourceId };
    localStorage.setItem(UNIFIED_SENDER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The pick still applies for this page view.
  }
}

/**
 * Choose the sending node: the remembered one if it is still in the eligible
 * list, otherwise the first eligible one, otherwise null.
 */
export function resolveUnifiedSender(
  eligible: SenderRef[],
  storedSourceId: string | null,
): SenderRef | null {
  const usable = eligible.filter((r) => r.canSend);
  if (usable.length === 0) return null;
  if (storedSourceId) {
    const stored = usable.find((r) => r.sourceId === storedSourceId);
    if (stored) return stored;
  }
  return usable[0];
}
