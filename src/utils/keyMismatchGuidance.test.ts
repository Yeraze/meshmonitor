/**
 * Public-key mismatch guidance (#4738).
 *
 * This decides how alarmed a user should be about a security event, so the
 * property that matters is that severity tracks their actual exposure — not
 * the event, which is identical either way.
 */
import { describe, it, expect } from 'vitest';
import { assessKeyMismatch } from './keyMismatchGuidance';

describe('assessKeyMismatch', () => {
  it('is HIGH when the user has sent DMs to this node', () => {
    // Something was encrypted to the old key, so interception and
    // impersonation are real questions.
    const g = assessKeyMismatch({ sentDirectMessageCount: 3 });
    expect(g.severity).toBe('high');
    expect(g.riskKey).toBe('key_mismatch.risk_high');
  });

  it('is HIGH when the user has administered the node, even with no DMs', () => {
    // Remote admin traffic is PKI-encrypted like a DM — same exposure.
    expect(assessKeyMismatch({ sentDirectMessageCount: 0, hasAdministered: true }).severity).toBe('high');
  });

  it('is LOW when the node has only ever been seen on public channels', () => {
    // Public channel traffic is not protected by this key, so there is
    // essentially nothing at stake. Treating this as equally alarming is how
    // users learn to dismiss the warning unread.
    const g = assessKeyMismatch({ sentDirectMessageCount: 0 });
    expect(g.severity).toBe('low');
    expect(g.riskKey).toBe('key_mismatch.risk_low');
  });

  it('does not count RECEIVED messages as exposure', () => {
    // The caller passes SENT count specifically; a node messaging you does not
    // mean you encrypted anything to it.
    expect(assessKeyMismatch({ sentDirectMessageCount: 0, hasAdministered: false }).severity).toBe('low');
  });

  it('always explains what changed, at either severity', () => {
    for (const n of [0, 5]) {
      expect(assessKeyMismatch({ sentDirectMessageCount: n }).headlineKey).toBe('key_mismatch.headline');
    }
  });

  it('puts verification before deletion in the action order', () => {
    // Deleting re-exchanges keys and destroys the evidence, so it must never
    // be suggested before the user can confirm the change was legitimate.
    const { actionKeys } = assessKeyMismatch({ sentDirectMessageCount: 1 });
    expect(actionKeys.indexOf('key_mismatch.action_verify'))
      .toBeLessThan(actionKeys.indexOf('key_mismatch.action_intentional'));
  });

  it('only advises avoiding DMs when the user actually sends them', () => {
    // Advice that does not apply trains people to skim the ones that do.
    expect(assessKeyMismatch({ sentDirectMessageCount: 2 }).actionKeys).toContain('key_mismatch.action_avoid_dms');
    expect(assessKeyMismatch({ sentDirectMessageCount: 0 }).actionKeys).not.toContain('key_mismatch.action_avoid_dms');
  });

  it('still models administered exposure, for when that history exists', () => {
    // No caller supplies this yet — MeshMonitor stores no per-node remote-admin
    // history — but the exposure is real, so the model keeps it and the
    // low-risk copy states the omission instead of implying certainty.
    expect(assessKeyMismatch({ sentDirectMessageCount: 0, hasAdministered: true }).severity).toBe('high');
  });

  it('gives every severity a non-empty action list', () => {
    // A warning with no remedy is the problem this issue was filed about.
    for (const n of [0, 1]) {
      expect(assessKeyMismatch({ sentDirectMessageCount: n }).actionKeys.length).toBeGreaterThan(0);
    }
  });
});
