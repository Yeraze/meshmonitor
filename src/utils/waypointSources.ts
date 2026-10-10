/**
 * Which sources can send a waypoint (#5685).
 *
 * The waypoint routes (`src/server/routes/waypoints.ts`) store a row for any
 * source but broadcast only when the source's manager has `broadcastWaypoint`.
 * Only `MeshtasticManager` does, and its `sourceType` is `meshtastic_tcp`
 * (`isMeshtasticManager` in `src/server/sourceManagerTypes.ts`). An MQTT
 * broker or bridge, a MeshCore source and a Reticulum source have no such
 * method, so a waypoint saved there would never go on air. A disabled source
 * has no manager at all.
 */
export const WAYPOINT_SENDER_SOURCE_TYPE = 'meshtastic_tcp';

export function canSourceSendWaypoints(source: { type?: string | null; enabled?: boolean | null }): boolean {
  return source.type === WAYPOINT_SENDER_SOURCE_TYPE && source.enabled !== false;
}
