/**
 * The settings key a Meshtastic source persists its local node number under
 * (#5377). Mirrors `MeshtasticManager.localNodeSettingKey('localNodeNum')`:
 * the legacy `default` source keeps the bare key, every other source is
 * suffixed. This is NOT the `source:{id}:` namespace that getSettingForSource
 * reads, so read it through getLocalNodeNumForSource, never
 * getSettingForSource(id, 'localNodeNum').
 *
 * Lives in its own file so `BaseRepository` can use it without importing the
 * settings repository, which extends it.
 */
export function localNodeNumSettingKey(sourceId: string): string {
  return sourceId && sourceId !== 'default' ? `localNodeNum_${sourceId}` : 'localNodeNum';
}

/**
 * The one-time snapshot migration 050 promoted from the pre-4.x global key.
 * Read only as a fallback, for a source that has not reconnected since.
 */
export function legacyLocalNodeNumSettingKey(sourceId: string): string {
  return `source:${sourceId}:localNodeNum`;
}
