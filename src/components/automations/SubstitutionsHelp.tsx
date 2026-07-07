/**
 * Shared "{{ }} substitutions" reference drawer (#3653).
 *
 * Lists every interpolation token usable in action text fields (message body,
 * notify title/body): `{{ trigger.* }}` per trigger type, `{{ var.* }}`, `{{ NOW }}`.
 * Used by both the builder (next to the message fields) and the Test panel.
 */

// All `{{ trigger.* }}` tokens, by trigger type. `sourceId`/`timestamp` are added to every group.
export const TRIGGER_TOKENS: Record<string, Array<[string, string]>> = {
  'trigger.message': [
    ['text', 'Message body'],
    // ── Universal sender/channel tokens (work the same on Meshtastic & MeshCore) ──
    ['senderLabel', 'Best label for the sender (name → channel name → id) — the "just works" token for addressing a reply on either protocol'],
    ['fromName', 'Sender display name — Meshtastic node long/short name (falls back to the id); MeshCore parsed sender name'],
    ['channelName', 'Channel name (both protocols); empty on a DM'],
    ['isDM', 'true if a direct message'], ['isChannel', 'true if a channel/broadcast message'],
    // ── Raw identity (protocol-specific) ──
    ['from', 'Raw sender identity: Meshtastic node number; MeshCore sender pubkey, or a synthetic "channel-<idx>" key for channel messages (not an identity — use senderLabel/fromName)'],
    ['fromId', 'Raw sender id: Meshtastic !hex; MeshCore pubkey / channel-<idx> (same caveat as from)'],
    ['to', 'Recipient node number'], ['toId', 'Recipient node id'], ['channel', 'Channel index'],
    ['portnum', 'Port number'], ['packetId', 'Packet id (used as tapback replyId) — Meshtastic only; unset for MeshCore, where replyToTrigger instead auto-prepends the @[senderLabel] mention'],
    ['hops', 'Hop count (hopStart − hopLimit)'], ['hopStart', 'Hop start'], ['hopLimit', 'Hop limit'],
    ['snr', 'Receive SNR — RF-received messages only'], ['rssi', 'Receive RSSI dBm — RF only'],
    ['isBroadcast', 'true if broadcast (alias of isChannel)'],
    ['wantAck', 'Sender requested an ack'], ['replyId', 'Replied-to packet id'],
    ['emoji', 'Tapback/reaction emoji flag'], ['viaMqtt', 'true if it arrived via MQTT'],
    ['decryptedBy', 'Channel/key that decrypted it'], ['protocol', 'meshtastic or meshcore'],
    ['scopeName', 'Region/scope name (MeshCore)'],
    ['scopeCode', 'Region/scope code — 0 = unscoped (MeshCore)'], ['scoped', 'true if sent with a region (MeshCore)'],
  ],
  'trigger.telemetry': [['nodeNum', 'Node number'], ['telemetryType', 'Metric name'], ['value', 'Reading value'], ['unit', 'Unit']],
  'trigger.nodeUpdated': [['nodeNum', 'Node number'], ['changed', 'Changed field names (list)']],
  'trigger.nodeDiscovered': [['nodeNum', 'Node number'], ['changed', 'Changed field names (list)']],
  'trigger.system': [['event', 'System event'], ['nodeNum', 'Node number (if any)'], ['reason', 'Detail / reason'], ['latestVersion', 'Latest version (upgrade-available)'], ['currentVersion', 'Current version (upgrade-available)']],
  'trigger.geofence': [['event', 'enter / exit / dwell'], ['nodeNum', 'Node number'], ['latitude', 'Node latitude'], ['longitude', 'Node longitude'], ['distanceKm', 'Distance from the region centre (km)']],
  'trigger.schedule': [],
};
export const UNIVERSAL_TOKENS: Array<[string, string]> = [['sourceId', 'The source the event came from'], ['timestamp', 'Event time (rendered as a local date/time)']];
const TRIGGER_LABEL: Record<string, string> = {
  'trigger.message': 'Message', 'trigger.telemetry': 'Telemetry', 'trigger.nodeUpdated': 'Node updated',
  'trigger.nodeDiscovered': 'Node discovered', 'trigger.system': 'System event', 'trigger.geofence': 'Geofence', 'trigger.schedule': 'Schedule',
};

/** Drawer listing every available substitution token (current trigger first). */
export default function SubstitutionsHelpDrawer({ triggerType, variables, onClose }: {
  triggerType: string; variables: Array<{ name: string }>; onClose: () => void;
}) {
  const order = [triggerType, ...Object.keys(TRIGGER_TOKENS).filter((t) => t !== triggerType)];
  // Docked, non-modal slide-in panel (no backdrop / click-away) so it stays open
  // beside the builder while you keep editing the page.
  return (
    <aside className="ae-drawer" role="complementary" aria-label="Substitutions reference">
      <button className="ae-btn ae-btn--ghost ae-drawer-close" onClick={onClose}>✕</button>
      <h2>Substitutions</h2>
      <p className="ae-muted">Insert these <code>{'{{ … }}'}</code> tokens in any text field (message, notify title/body). An unknown or empty value renders blank.</p>

      <h3>Variables &amp; misc</h3>
      <dl>
        <dt>{'{{ var.NAME }}'}</dt><dd>Any user variable{variables.length ? `: ${variables.map((v) => v.name).join(', ')}` : ' (none defined yet)'}.</dd>
        <dt>{'{{ var.NAME.a.b }}'}</dt><dd>Index into a <strong>json</strong> variable (e.g. a “Run a script” result) — dotted path into the stored object/array. A whole object renders as JSON.</dd>
        <dt>{'{{ NOW }}'}</dt><dd>Current time (rendered as a local date/time).</dd>
      </dl>

      {order.filter((t) => TRIGGER_TOKENS[t]).map((t) => (
        <div key={t}>
          <h3>{TRIGGER_LABEL[t] ?? t}{t === triggerType ? ' — current trigger' : ''}</h3>
          <dl>
            {[...TRIGGER_TOKENS[t], ...UNIVERSAL_TOKENS].flatMap(([k, d]) => [
              <dt key={`${k}-t`}>{`{{ trigger.${k} }}`}</dt>,
              <dd key={`${k}-d`}>{d}</dd>,
            ])}
          </dl>
        </div>
      ))}
    </aside>
  );
}
