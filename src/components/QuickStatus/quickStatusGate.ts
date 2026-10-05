/**
 * Who sees the header quick-status pill (#5616).
 *
 * Meshtastic DEVICE sources only. MQTT broker/bridge, MeshCore and Reticulum
 * sources have no local Meshtastic node, so there is no Status Message module
 * to write. An allowlist, not a denylist: a source type added later stays
 * hidden until someone decides it has the module.
 *
 * The firmware check (2.7.20+) is not here: the pill reads it from the node's
 * config and hides itself.
 */
export interface QuickStatusGateInput {
  authenticated: boolean;
  /** `SourceContext.sourceType`; null on the legacy single-source view. */
  sourceType: string | null;
  connectionStatus: string;
  /** `configuration:write` on this source. */
  canWriteConfiguration: boolean;
}

export function shouldShowQuickStatus({
  authenticated,
  sourceType,
  connectionStatus,
  canWriteConfiguration,
}: QuickStatusGateInput): boolean {
  if (!authenticated || !canWriteConfiguration) return false;
  // The legacy single-source view has no source type and is always a
  // Meshtastic device.
  if (sourceType !== null && sourceType !== 'meshtastic_tcp') return false;
  // A save needs a live link to the node.
  return connectionStatus === 'connected';
}
