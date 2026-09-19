import databaseService from '../../services/database.js';

/**
 * The settings key a Meshtastic source persists its local node number under.
 * Mirrors `MeshtasticManager.localNodeSettingKey('localNodeNum')`: the legacy
 * `default` source keeps the bare key, every other source is suffixed.
 */
export function localNodeNumSettingKey(sourceId: string): string {
  return sourceId && sourceId !== 'default' ? `localNodeNum_${sourceId}` : 'localNodeNum';
}

/**
 * Each source's local node number, read from what its manager persisted on
 * connect, so it works for a source that is currently disconnected. Sources
 * with no local node (MQTT, MeshCore, a TCP source that never connected) are
 * left out of the result.
 */
export async function resolveLocalNodeNums(sourceIds: string[]): Promise<Map<string, number>> {
  // A Map, not an object: source ids come from the request query string.
  const out = new Map<string, number>();
  await Promise.all(
    sourceIds.map(async (sourceId) => {
      const raw = await databaseService.settings.getSetting(localNodeNumSettingKey(sourceId));
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) out.set(sourceId, n);
    }),
  );
  return out;
}
