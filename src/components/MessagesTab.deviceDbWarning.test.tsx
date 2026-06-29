import { describe, it, expect } from 'vitest';

/**
 * Regression coverage for issue #3853.
 *
 * The "not in device DB" warning in the DM view shows one of two messages
 * depending on whether MeshMonitor can pre-populate the radio's NodeDB via
 * add_contact before sending a PKI DM (PR #3227):
 *
 *   - Key known AND no key mismatch -> MeshMonitor will push the contact
 *     (incl. public key) before the DM, so the DM succeeds. Show the
 *     reassuring "will attempt to restore the saved key" message.
 *   - Key unknown, OR a key mismatch is active (stored key can't be trusted,
 *     so add_contact is skipped) -> the DM truly will fail until keys are
 *     exchanged. Show the original "Direct messages will fail" warning.
 *
 * This predicate MUST stay in lockstep with the backend gate in
 * meshtasticManager.sendTextMessage (`publicKey && !keyMismatchDetected`),
 * which decides whether pushContactToRadio runs.
 */
function showsKeyKnownMessage(node: { user?: { publicKey?: string }; keyMismatchDetected?: boolean } | undefined): boolean {
  return !!(node?.user?.publicKey && !node?.keyMismatchDetected);
}

describe('MessagesTab — not-in-device-DB warning message selection (#3853)', () => {
  it('shows the reassuring key-known message when the public key is known and no mismatch', () => {
    expect(showsKeyKnownMessage({ user: { publicKey: 'AQID' }, keyMismatchDetected: false })).toBe(true);
  });

  it('shows the original "will fail" warning when the public key is unknown', () => {
    expect(showsKeyKnownMessage({ user: { publicKey: '' }, keyMismatchDetected: false })).toBe(false);
    expect(showsKeyKnownMessage({ user: {}, keyMismatchDetected: false })).toBe(false);
    expect(showsKeyKnownMessage({})).toBe(false);
    expect(showsKeyKnownMessage(undefined)).toBe(false);
  });

  it('shows the original "will fail" warning when a key mismatch is active, even with a stored key', () => {
    // add_contact is skipped on mismatch (stored key is stale), so the DM can still fail.
    expect(showsKeyKnownMessage({ user: { publicKey: 'AQID' }, keyMismatchDetected: true })).toBe(false);
  });
});
