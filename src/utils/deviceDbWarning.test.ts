import { describe, it, expect } from 'vitest';
import { isDeviceDbWarningMitigatable } from './deviceDbWarning';

/**
 * Regression coverage for issue #3853.
 *
 * The "not in device DB" warning in the DM view shows one of two messages
 * (and box colors) depending on whether MeshMonitor can pre-populate the
 * radio's NodeDB via add_contact before sending a PKI DM (PR #3227):
 *
 *   - Key known AND no key mismatch -> mitigatable: MeshMonitor will push the
 *     contact (incl. public key) before the DM, so the DM succeeds.
 *   - Key unknown, OR a key mismatch is active (stored key can't be trusted,
 *     so add_contact is skipped) -> the DM truly will fail.
 *
 * Imports the production predicate directly so the test can't drift from the
 * component. It MUST stay in lockstep with the backend gate in
 * meshtasticManager.sendTextMessage (`publicKey && !keyMismatchDetected`).
 */
describe('isDeviceDbWarningMitigatable (#3853)', () => {
  it('is mitigatable when the public key is known and no mismatch is active', () => {
    expect(isDeviceDbWarningMitigatable({ user: { id: '!1', publicKey: 'AQID' }, keyMismatchDetected: false })).toBe(true);
  });

  it('is not mitigatable when the public key is unknown', () => {
    expect(isDeviceDbWarningMitigatable({ user: { id: '!1', publicKey: '' }, keyMismatchDetected: false })).toBe(false);
    expect(isDeviceDbWarningMitigatable({ user: { id: '!1' }, keyMismatchDetected: false })).toBe(false);
    expect(isDeviceDbWarningMitigatable({})).toBe(false);
    expect(isDeviceDbWarningMitigatable(null)).toBe(false);
    expect(isDeviceDbWarningMitigatable(undefined)).toBe(false);
  });

  it('is not mitigatable when a key mismatch is active, even with a stored key', () => {
    // add_contact is skipped on mismatch (stored key is stale), so the DM can still fail.
    expect(isDeviceDbWarningMitigatable({ user: { id: '!1', publicKey: 'AQID' }, keyMismatchDetected: true })).toBe(false);
  });
});
