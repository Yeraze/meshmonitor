/**
 * Public-key mismatch guidance (#4738).
 *
 * MeshMonitor showed a bare "This node is a security risk" with no explanation
 * of what changed, what it means, or what to do. That is the worst shape a
 * security warning can take: alarming enough to worry about, too vague to act
 * on, and identical whether the user has anything actually at stake.
 *
 * **Severity is about the user's exposure, not the event.** A key change is the
 * same event either way; what differs is whether the user has ever encrypted
 * anything to the old key. Someone who has only ever seen this node on public
 * channels has essentially nothing at risk — public channel traffic is not
 * protected by that key in the first place — while someone who has sent DMs
 * has a real interception and impersonation question. Treating both as equally
 * alarming is how users learn to dismiss the warning without reading it.
 *
 * Kept free of React and i18n: it returns translation KEYS, so the copy stays
 * translatable and this stays unit-testable.
 */

export type KeyMismatchSeverity = 'high' | 'low';

export interface KeyMismatchContext {
  /**
   * DMs the user has SENT to this node. The tractable proxy for "has anything
   * been encrypted to the old key" — a received DM does not imply the user
   * encrypted anything to them.
   */
  sentDirectMessageCount: number;
  /**
   * Whether the user has administered this node remotely. Admin traffic is
   * PKI-encrypted like a DM, so it carries the same exposure.
   */
  hasAdministered?: boolean;
}

export interface KeyMismatchGuidance {
  severity: KeyMismatchSeverity;
  /** Translation key for the one-line "what changed". */
  headlineKey: string;
  /** Translation key for the severity-specific "why it matters". */
  riskKey: string;
  /** Translation keys for the ordered "what to do" steps. */
  actionKeys: string[];
}

/**
 * Steps shared by both severities, in the order a user should try them.
 *
 * Verification comes first deliberately: deleting the node re-exchanges keys
 * and makes the evidence disappear, so it must not be suggested before the
 * user has had a chance to confirm the change was legitimate.
 */
const COMMON_ACTIONS = [
  'key_mismatch.action_verify',
  'key_mismatch.action_intentional',
];

export function assessKeyMismatch(ctx: KeyMismatchContext): KeyMismatchGuidance {
  const exposed = ctx.sentDirectMessageCount > 0 || ctx.hasAdministered === true;

  return {
    severity: exposed ? 'high' : 'low',
    headlineKey: 'key_mismatch.headline',
    riskKey: exposed ? 'key_mismatch.risk_high' : 'key_mismatch.risk_low',
    actionKeys: exposed
      // Only tell someone to stop sending sensitive DMs if they actually send
      // DMs here. Advice that does not apply trains people to skim.
      ? [...COMMON_ACTIONS, 'key_mismatch.action_avoid_dms']
      : COMMON_ACTIONS,
  };
}
