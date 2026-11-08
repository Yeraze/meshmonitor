/**
 * Hand-off for "open this MeshCore contact" from outside the MeshCore page
 * (Mesh Issues links, #6263). The sender writes the lowercased public key to
 * sessionStorage and passes it as router state `focusMeshcoreContact`;
 * `MeshCorePage` takes whichever it finds, clears the storage key and selects
 * the contact through its existing Show-on-Map hand-off.
 */

/** sessionStorage key holding the pending contact public key. */
export const PENDING_SELECTED_MESHCORE_CONTACT_STORAGE_KEY = 'meshmonitor.pendingSelectedMeshcoreContact';

const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Read and clear a pending contact. Router state (`history.state.usr`, where
 * react-router keeps `navigate(..., { state })`) wins over sessionStorage.
 * Returns a lowercased 64-hex key or null.
 */
export function takePendingMeshCoreContact(): string | null {
  let fromStorage: string | null = null;
  try {
    fromStorage = sessionStorage.getItem(PENDING_SELECTED_MESHCORE_CONTACT_STORAGE_KEY);
    if (fromStorage !== null) sessionStorage.removeItem(PENDING_SELECTED_MESHCORE_CONTACT_STORAGE_KEY);
  } catch {
    // Storage blocked: router state may still carry the key.
  }
  let fromState: unknown = null;
  try {
    fromState = (window.history.state as { usr?: { focusMeshcoreContact?: unknown } } | null)?.usr
      ?.focusMeshcoreContact;
  } catch {
    // no history state
  }
  for (const candidate of [fromState, fromStorage]) {
    if (typeof candidate !== 'string') continue;
    const key = candidate.toLowerCase();
    if (PUBLIC_KEY_RE.test(key)) return key;
  }
  return null;
}
