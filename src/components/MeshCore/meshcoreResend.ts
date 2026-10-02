/**
 * When the MeshCore message stream offers "Resend" on one of our channel
 * messages (#5512). Mirrors the server's checks in
 * MeshCoreManager.resendChannelMessage, which stays the authority: the UI only
 * hides the button when the server would refuse anyway.
 */
import type { MeshCoreMessage } from './hooks/useMeshCore';

/** Max user resends per message. Matches MeshCoreManager.RESEND_MAX. */
export const RESEND_MAX = 3;
/** Wait after the send and after each resend. Matches RESEND_COOLDOWN_MS. */
export const RESEND_COOLDOWN_MS = 30_000;
/** Oldest message we offer to resend. Matches RESEND_MAX_AGE_MS. */
export const RESEND_MAX_AGE_MS = 60 * 60 * 1000;

export type ResendAvailability =
  /** Never resendable (received, DM, heard, capped, too old, no stored timestamp). */
  | { kind: 'never' }
  /** Resendable later: auto-retry pending or cooldown running. */
  | { kind: 'wait' }
  /** Resendable now. */
  | { kind: 'ready' };

/** Our own channel send that carries a stored wire timestamp. */
function isOwnChannelSend(m: MeshCoreMessage, selfPublicKey: string | undefined): boolean {
  if (!selfPublicKey || m.fromPublicKey !== selfPublicKey) return false;
  if (!m.toPublicKey || !m.toPublicKey.startsWith('channel-')) return false;
  return typeof m.senderTimestamp === 'number';
}

export function resendAvailability(
  m: MeshCoreMessage,
  selfPublicKey: string | undefined,
  now: number,
): ResendAvailability {
  if (!isOwnChannelSend(m, selfPublicKey)) return { kind: 'never' };
  if (m.heardBy && m.heardBy.length > 0) return { kind: 'never' };
  if ((m.resendCount ?? 0) >= RESEND_MAX) return { kind: 'never' };
  if (now - m.timestamp > RESEND_MAX_AGE_MS) return { kind: 'never' };
  if (m.autoRetryPending) return { kind: 'wait' };
  const last = Math.max(m.timestamp, m.lastResendAt ?? 0);
  if (now - last < RESEND_COOLDOWN_MS) return { kind: 'wait' };
  return { kind: 'ready' };
}
