/**
 * Companion contact-table failures (#5349).
 *
 * MeshCore companion firmware resolves the target of CMD_SEND_LOGIN,
 * CMD_SEND_STATUS_REQ and CMD_SEND_TXT_MSG against its OWN saved contact table
 * (examples/companion_radio/MyMesh.cpp `lookupContactByPubKey`). A target
 * that is not in that table fails at once with ERR_CODE_NOT_FOUND — nothing
 * is transmitted. MeshMonitor can show such contacts (heard via a 0x8A
 * NewAdvert the firmware chose not to store, evicted by the firmware, or
 * known only from the DB), so these errors let callers say so plainly
 * instead of a generic "login failed".
 */

/** Error message: the target is not in the companion's contact table. */
export const MESHCORE_CONTACT_NOT_ON_DEVICE = 'MESHCORE_CONTACT_NOT_ON_DEVICE';

/** Error message: the companion's contact table is full (ERR_CODE_TABLE_FULL). */
export const MESHCORE_DEVICE_TABLE_FULL = 'MESHCORE_DEVICE_TABLE_FULL';

/** Firmware error codes (MyMesh.cpp ERR_CODE_*). */
export const MESHCORE_ERR_CODE_NOT_FOUND = 2;
export const MESHCORE_ERR_CODE_TABLE_FULL = 3;

/** Human-readable explanation shared by the API and logs. */
export const CONTACT_NOT_ON_DEVICE_MESSAGE =
  "This node is not in the radio's contact list, so the radio cannot address it. " +
  'Add it to the radio first (the list may be full, or the radio is set to add contacts manually).';

/** Thrown by manager operations whose target is not on the companion. */
export class MeshCoreContactNotOnDeviceError extends Error {
  constructor(public readonly publicKey: string) {
    super(CONTACT_NOT_ON_DEVICE_MESSAGE);
    this.name = 'MeshCoreContactNotOnDeviceError';
  }
}

/**
 * Map a firmware Err frame code to one of the error messages above, or null
 * when the code is not a contact-table failure.
 */
export function contactTableErrorForCode(code: number | null | undefined): string | null {
  if (code === MESHCORE_ERR_CODE_NOT_FOUND) return MESHCORE_CONTACT_NOT_ON_DEVICE;
  if (code === MESHCORE_ERR_CODE_TABLE_FULL) return MESHCORE_DEVICE_TABLE_FULL;
  return null;
}
