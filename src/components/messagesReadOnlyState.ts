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
 *
 * `is_unmessagable` is only a NodeInfo *self-report*, not an enforced protocol
 * restriction, so it can be stale or simply wrong. `overrideUnmessageable`
 * (#4153) lets the user say "message anyway" and bypass the DM gate for that
 * node. It must NEVER bypass the MQTT case — MQTT is a hard transport
 * limitation (no send capability at all), not a self-report, so overriding it
 * wouldn't work and isn't offered in the UI.
 */
export interface MessagesReadOnlyState {
  /** Hide the DM message log and the compose field. */
  dmReadOnly: boolean;
  /**
   * WHY the DM log/composer is hidden, so the UI can explain itself instead
   * of just disappearing (#4139). `null` when `dmReadOnly` is false. When
   * both conditions hold, `'unmessageable'` wins — it's the more specific,
   * more actionable explanation for the user.
   */
  dmReadOnlyReason: 'mqtt' | 'unmessageable' | null;
  /** Hide the mesh-transmit action buttons (traceroute/telemetry/nodeinfo/…). */
  actionsReadOnly: boolean;
}

export function computeMessagesReadOnlyState(opts: {
  mqttReadOnly: boolean;
  isUnmessagable: boolean | undefined;
  /**
   * User opted to "message anyway" for the currently-selected node (#4153).
   * Only ever suppresses the `isUnmessagable` gate — MQTT's `mqttReadOnly`
   * always forces `dmReadOnly` regardless of this flag. Defaults to `false`.
   */
  overrideUnmessageable?: boolean;
}): MessagesReadOnlyState {
  const { mqttReadOnly, isUnmessagable, overrideUnmessageable = false } = opts;
  const unmessageableGate = isUnmessagable === true && !overrideUnmessageable;
  const dmReadOnly = mqttReadOnly || unmessageableGate;
  return {
    // DMs are suppressed by either condition.
    dmReadOnly,
    // Unmessageable is the more specific/actionable reason, so it wins when
    // both apply.
    dmReadOnlyReason: !dmReadOnly ? null : unmessageableGate ? 'unmessageable' : 'mqtt',
    // Action buttons are suppressed ONLY by the MQTT-bridge mirror — an
    // unmessageable node still responds to these channel-routed requests.
    actionsReadOnly: mqttReadOnly,
  };
}
