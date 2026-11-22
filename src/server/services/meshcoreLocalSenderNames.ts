/**
 * Local MeshCore sender names (#5551, #6282): which channel-message sender
 * names are ours. Leaf module so the device and MQTT store paths share it.
 */

/**
 * Sender names MeshMonitor recently sent under as an override (#6282), shared
 * by every source in the process. A sibling source (a second companion or a
 * logging repeater on the same channel) hears our raw send as a message from
 * "Name", and only this registry tells it the name is ours. Erring towards
 * "ours" is the safe direction (same rule as #5551): it only stops automations
 * from replying. Entries expire after {@link SENDER_NAME_OVERRIDE_TTL_MS}.
 */
export const SENDER_NAME_OVERRIDE_TTL_MS = 30 * 60 * 1000;
const recentSenderNameOverrides = new Map<string, number>();

export function noteSenderNameOverride(name: string, now: number = Date.now()): void {
  recentSenderNameOverrides.set(name.trim().toLowerCase(), now + SENDER_NAME_OVERRIDE_TTL_MS);
}

export function isRecentSenderNameOverride(name: string | null | undefined, now: number = Date.now()): boolean {
  if (!name) return false;
  const key = name.trim().toLowerCase();
  const until = recentSenderNameOverrides.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    recentSenderNameOverrides.delete(key);
    return false;
  }
  return true;
}

/** Test seam: forget every recorded override name. */
export function __resetSenderNameOverridesForTests(): void {
  recentSenderNameOverrides.clear();
}

/**
 * True when `name` is the advertised name of a local node on ANY connected
 * MeshCore source (#5551). A channel message carries only the sender's name,
 * so this is how a repeater recognises our own companion's sends. A stranger
 * using the same name is also matched; that only stops automations reacting
 * to them, which is the safe direction. Imported lazily: the registry imports
 * this module.
 */
export async function isLocalMeshCoreSenderName(name: string | null | undefined): Promise<boolean> {
  if (!name) return false;
  if (isRecentSenderNameOverride(name)) return true;
  try {
    const [{ sourceManagerRegistry }, { isMeshCoreManager }] = await Promise.all([
      import('../sourceManagerRegistry.js'),
      import('../sourceManagerTypes.js'),
    ]);
    const want = name.trim().toLowerCase();
    for (const m of sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager)) {
      const local = m.getLocalNode();
      if (local?.name && local.name.trim().toLowerCase() === want) return true;
    }
  } catch {
    // Registry unavailable (tests, shutdown): treat as not ours.
  }
  return false;
}
