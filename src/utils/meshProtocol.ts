/**
 * Mesh protocol of a source, for DISPLAY only (#5744).
 *
 * One place decides which protocol a message belongs to and which theme token
 * paints it, so the Unified Messages card border and the per-source channel
 * and DM stripes cannot drift apart.
 *
 * This is deliberately separate from `sourceTypeProtocol()` in
 * `nodeTypeCategory.ts`: that one folds Reticulum into Meshtastic and feeds
 * node categorization. Never gate a device, TX or permission path on the
 * result of anything in this file.
 */

export type MeshProtocol = 'meshtastic' | 'meshcore' | 'reticulum';

export const MESH_PROTOCOLS: MeshProtocol[] = ['meshtastic', 'meshcore', 'reticulum'];

/**
 * Classify a source `type` string into the protocol its messages travel on.
 *
 * - `meshcore`, `meshcore_mqtt` → MeshCore
 * - `reticulum` → Reticulum
 * - everything else → Meshtastic. That covers `meshtastic_tcp`, the MQTT
 *   sources (`mqtt_broker`, `mqtt_bridge` carry Meshtastic packets), and a
 *   missing type (`null` in the legacy single-source view).
 */
export function sourceTypeMeshProtocol(type: string | undefined | null): MeshProtocol {
  if (type === 'meshcore' || type === 'meshcore_mqtt') return 'meshcore';
  if (type === 'reticulum') return 'reticulum';
  return 'meshtastic';
}

/**
 * Theme role token for each protocol. Meshtastic and MeshCore match the node
 * popup's protocol badge (`.node-popup-protocol-badge.protocol-*`).
 *
 * `src/components/messages/ProtocolStripe.module.css` holds the same mapping
 * for the stylesheet side; `meshProtocol.test.ts` fails if the two differ.
 */
export const MESH_PROTOCOL_COLOR_VAR: Record<MeshProtocol, string> = {
  meshtastic: 'var(--color-success)',
  meshcore: 'var(--color-caution)',
  reticulum: 'var(--color-accent)',
};

/** CSS colour value (a `var(--color-*)` reference) for a protocol. */
export function meshProtocolColorVar(protocol: MeshProtocol): string {
  return MESH_PROTOCOL_COLOR_VAR[protocol];
}

/** Display name of each protocol. Brand names, so they are not translated. */
export const MESH_PROTOCOL_LABEL: Record<MeshProtocol, string> = {
  meshtastic: 'Meshtastic',
  meshcore: 'MeshCore',
  reticulum: 'Reticulum',
};
