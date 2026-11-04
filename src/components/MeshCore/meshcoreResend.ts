/**
 * When the MeshCore message stream offers "Resend" on one of our channel
 * messages (#5512). Mirrors the server's checks in
 * MeshCoreManager.resendChannelMessage, which stays the authority: the UI only
 * hides the button when the server would refuse anyway.
 */
import type { MeshCoreMessage } from './hooks/useMeshCore';
import { requiredRepeaterHeard, type RepeaterContactLike } from '../../utils/meshcoreHeardBy';

/**
 * Optional per-source Required Repeater gate (#6178). When
 * `requiredRepeaterPublicKey` is set, a message counts as "heard" only once that
 * one repeater is heard relaying it; otherwise the default "heard by any
 * repeater" rule applies. `repeaters` is the source's known relay contacts.
 */
export interface ResendAvailabilityOpts {
  requiredRepeaterPublicKey?: string | null;
  repeaters?: ReadonlyArray<RepeaterContactLike>;
}

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
  if (m.reactionEmoji) return false;
  if (!selfPublicKey || m.fromPublicKey !== selfPublicKey) return false;
  if (!m.toPublicKey || !m.toPublicKey.startsWith('channel-')) return false;
  return typeof m.senderTimestamp === 'number';
}

export function resendAvailability(
  m: MeshCoreMessage,
  selfPublicKey: string | undefined,
  now: number,
  opts?: ResendAvailabilityOpts,
): ResendAvailability {
  if (!isOwnChannelSend(m, selfPublicKey)) return { kind: 'never' };
  // #6178: with a Required Repeater set, the send stops being resendable only
  // once THAT repeater is heard relaying it (conservative unique-prefix match);
  // otherwise the default "heard by any repeater" rule applies, byte-for-byte.
  const required = opts?.requiredRepeaterPublicKey;
  if (required) {
    if (requiredRepeaterHeard(m.heardBy, required, opts?.repeaters ?? [])) return { kind: 'never' };
  } else if (m.heardBy && m.heardBy.length > 0) {
    return { kind: 'never' };
  }
  if ((m.resendCount ?? 0) >= RESEND_MAX) return { kind: 'never' };
  if (now - m.timestamp > RESEND_MAX_AGE_MS) return { kind: 'never' };
  if (m.autoRetryPending) return { kind: 'wait' };
  const last = Math.max(m.timestamp, m.lastResendAt ?? 0);
  if (now - last < RESEND_COOLDOWN_MS) return { kind: 'wait' };
  return { kind: 'ready' };
}
