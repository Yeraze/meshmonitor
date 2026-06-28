/**
 * Read-only gating for the Messages DM view.
 *
 * MeshMonitor distinguishes two *different* reasons a DM conversation can be
 * "read-only", and they gate different parts of the UI:
 *
 *  - **MQTT-bridge mirror** (`mqttReadOnly`): the selected source is a passive
 *    MQTT mirror, so we cannot transmit ANY packet to the mesh. Both the DM
 *    composer AND every mesh-action button (traceroute, telemetry, NodeInfo /
 *    position exchange, neighbor-info, admin scan) must be hidden.
 *
 *  - **Unmessageable node** (Meshtastic NodeInfo `is_unmessagable`, e.g. sensors
 *    and repeaters): the node can't receive text DMs, so the DM message log and
 *    compose field are hidden (#3755). But it STILL answers channel-routed
 *    requests — traceroute, telemetry, NodeInfo/position exchange, etc. are sent
 *    to their own PortNums on the node's channel, not as text DMs — so those
 *    action buttons must remain available (#3831).
 *
 * Conflating the two (the pre-#3831 `effectiveReadOnly` flag) wrongly hid the
 * action buttons for unmessageable nodes. Keep them separate.
 */
export interface MessagesReadOnlyState {
  /** Hide the DM message log and the compose field. */
  dmReadOnly: boolean;
  /** Hide the mesh-transmit action buttons (traceroute/telemetry/nodeinfo/…). */
  actionsReadOnly: boolean;
}

export function computeMessagesReadOnlyState(opts: {
  mqttReadOnly: boolean;
  isUnmessagable: boolean | undefined;
}): MessagesReadOnlyState {
  const { mqttReadOnly, isUnmessagable } = opts;
  return {
    // DMs are suppressed by either condition.
    dmReadOnly: mqttReadOnly || isUnmessagable === true,
    // Action buttons are suppressed ONLY by the MQTT-bridge mirror — an
    // unmessageable node still responds to these channel-routed requests.
    actionsReadOnly: mqttReadOnly,
  };
}
