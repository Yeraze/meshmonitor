/**
 * When the MeshCore message stream offers "Resend" on one of our channel
 * messages — and, since #6194, our direct messages too. Mirrors the server's
 * checks in MeshCoreManager.resendChannelMessage, which stays the authority: the
 * UI only hides the button when the server would refuse anyway.
 */
import type { MeshCoreMessage } from './hooks/useMeshCore';
import { getMeshCoreDirectSendState } from '../../utils/deliveryDiagnostics/status';
import {
  requiredRepeatersHeard,
  type RepeaterContactLike,
  type RequiredRepeaterMode,
} from '../../utils/meshcoreHeardBy';

/**
 * Optional per-source Required Repeaters gate (#6178 → #6193). When
 * `requiredRepeaterKeys` is non-empty, a message counts as "heard" (so the
 * resend button goes away) only once the gate is satisfied: in `'any'` mode as
 * soon as one listed repeater is heard, in `'all'` mode once every listed one
 * is. With an empty list the default "heard by any repeater" rule applies.
 * `repeaters` is the source's known relay contacts.
 */
export interface ResendAvailabilityOpts {
  requiredRepeaterKeys?: string[];
  requiredRepeaterMode?: RequiredRepeaterMode;
  repeaters?: ReadonlyArray<RepeaterContactLike>;
}

/** Max user resends per message. Matches MeshCoreManager.RESEND_MAX. */
export const RESEND_MAX = 3;
/** Wait after the send and after each resend. Matches RESEND_COOLDOWN_MS. */
export const RESEND_COOLDOWN_MS = 30_000;
/** Oldest message we offer to resend. Matches RESEND_MAX_AGE_MS. */
export const RESEND_MAX_AGE_MS = 60 * 60 * 1000;

export type ResendAvailability =
  /** Never resendable (received, heard, delivered, capped, too old, no timestamp). */
  | { kind: 'never' }
  /** Resendable later: auto-retry pending or cooldown running. */
  | { kind: 'wait' }
  /** Resendable now. */
  | { kind: 'ready' };

/**
 * Our own send that carries a stored wire timestamp and is resendable in kind:
 * a channel send (#5512) or a direct message (#6194). Room posts and reactions
 * are never resendable. Returns the kind, or null when not ours/not resendable.
 */
function ownResendableKind(
  m: MeshCoreMessage,
  selfPublicKey: string | undefined,
): 'channel' | 'dm' | null {
  if (m.reactionEmoji) return null;
  if (!selfPublicKey || m.fromPublicKey !== selfPublicKey) return null;
  if (typeof m.senderTimestamp !== 'number') return null;
  if (!m.toPublicKey) return null;
  if (m.toPublicKey.startsWith('channel-')) return 'channel';
  // A DM to a real recipient; a room post is excluded (#6194).
  if (m.messageType === 'room_post') return null;
  return 'dm';
}

export function resendAvailability(
  m: MeshCoreMessage,
  selfPublicKey: string | undefined,
  now: number,
  opts?: ResendAvailabilityOpts,
): ResendAvailability {
  const sendKind = ownResendableKind(m, selfPublicKey);
  if (!sendKind) return { kind: 'never' };
  // #6194: a DM the recipient's radio acknowledged (ACK / SendConfirmed) is
  // delivered — never offer resend, regardless of the heard-by gate. Channel
  // sends have no ack, so this only suppresses DMs.
  if (sendKind === 'dm') {
    const direct = getMeshCoreDirectSendState(m, selfPublicKey);
    if (direct?.state === 'delivered') return { kind: 'never' };
  }
  // #6178 → #6193: with a Required Repeaters list set, the send stops being
  // resendable only once the ANY/ALL gate is satisfied (conservative
  // unique-prefix match per key); an empty list keeps the default "heard by any
  // repeater" rule, byte-for-byte.
  if (
    requiredRepeatersHeard(
      m.heardBy,
      opts?.requiredRepeaterKeys ?? [],
      opts?.requiredRepeaterMode ?? 'any',
      opts?.repeaters ?? [],
    )
  ) {
    return { kind: 'never' };
  }
  if ((m.resendCount ?? 0) >= RESEND_MAX) return { kind: 'never' };
  if (now - m.timestamp > RESEND_MAX_AGE_MS) return { kind: 'never' };
  if (m.autoRetryPending) return { kind: 'wait' };
  const last = Math.max(m.timestamp, m.lastResendAt ?? 0);
  if (now - last < RESEND_COOLDOWN_MS) return { kind: 'wait' };
  return { kind: 'ready' };
}
