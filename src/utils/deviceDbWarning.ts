import type { DeviceInfo } from '../types/device';

/**
 * Decides whether the DM-view "not in device DB" warning is *mitigatable*
 * (issue #3853).
 *
 * Since PR #3227, MeshMonitor pre-populates the radio's NodeDB via add_contact
 * immediately before sending a PKI DM, so the DM succeeds even when the node was
 * evicted from the radio's NodeDB — as long as the public key is known and there
 * is no active key mismatch. In that case the warning is mitigatable: show a
 * softer, reassuring message. When the key is unknown, or a key mismatch is
 * active (the stored key can't be trusted, so add_contact is skipped), the DM
 * truly will fail and the stronger warning applies.
 *
 * This predicate MUST stay in lockstep with the backend gate in
 * meshtasticManager.sendTextMessage (`publicKey && !keyMismatchDetected`), which
 * decides whether pushContactToRadio runs.
 */
export function isDeviceDbWarningMitigatable(
  node: Pick<DeviceInfo, 'user' | 'keyMismatchDetected'> | null | undefined,
): boolean {
  return !!(node?.user?.publicKey && !node?.keyMismatchDetected);
}
