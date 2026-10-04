/**
 * Shared "{{ }} substitutions" reference drawer (#3653).
 *
 * Lists every interpolation token usable in action text fields (message body,
 * notify title/body): `{{ trigger.* }}` per trigger type, `{{ var.* }}`, `{{ NOW }}`.
 * Used by both the builder (next to the message fields) and the Test panel.
 */
import { UiIcon } from '../icons';
import { HOP_COUNT_EMOJIS, HOP_EMOJI_MAX, MQTT_SOURCE_EMOJI } from '../../utils/hopEmoji';
import { REPLY_CONTEXT_TAPBACK, REPLY_CONTEXT_REPLY } from '../../utils/replyContext';
import { NODE_TOKENS, SUBJECT_NODE_TRIGGER_TYPES } from './substitutionNodeTokens';

// #5534: tokens shared by trigger.nodeUpdated / trigger.nodeDiscovered.
// Packet tokens are empty whenever the event had no single originating packet.
const NODE_EVENT_PACKET_ID_TOKEN: [string, string] = [
  'packetId',
  'Meshtastic only: id of the received packet that caused the event, unsigned 32-bit. Empty for MeshCore and when no packet caused it (device sync, manual edits)',
];
// #5595: MeshCore has no node number, so {{ node.* }} is empty for it; these
// trigger.* tokens carry the contact's facts instead. Empty on Meshtastic.
const NODE_EVENT_MESHCORE_TOKENS: Array<[string, string]> = [
  ['publicKey', 'Public key (MeshCore; empty for Meshtastic)'],
  ['name', 'Display name (MeshCore; use node.longName on Meshtastic). MeshCore has no short name — there is no shortName token, and node.shortName is empty'],
  ['roleName', 'MeshCore only: Companion, Repeater, Room Server or Sensor; empty when the type is unknown. On Meshtastic use node.roleName'],
  ['hops', 'MeshCore only: relays the advert that caused the event passed through (0 = heard direct). Empty when no advert caused it (path updates, discovery sweeps, contact re-reads). On Meshtastic use node.hopsAway'],
  ['routeHops', 'MeshCore only: hops on the stored route this source would send on. Not the same as hops — it can differ from the path the advert took. Empty when no route is stored (sends flood)'],
  ['lastHeard', 'MeshCore only: when this source last heard the node (epoch ms, same as Node silent). On Meshtastic use node.lastHeard'],
];
const NODE_EVENT_PACKET_HASH_TOKEN: [string, string] = [
  'packetHash',
  'MeshCore only: hash of the advert that caused the event, 16 uppercase hex chars — matches map.meshcore.com.hr/#/packets/<hash>. Empty for Meshtastic, and for MeshCore changes not caused by an advert (path updates, discovery sweeps)',
];

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
    // #4340: these are protocol/content emoji (the actual glyphs sent over the mesh),
    // not UI iconography — UiIcon does not apply. See CLAUDE.md "App-owned interface icons".
    ['hopEmoji', `Hop count as an emoji — ${HOP_COUNT_EMOJIS[0]} direct, ${HOP_COUNT_EMOJIS[1]}–${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]} (${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]} = 7 or more); ${MQTT_SOURCE_EMOJI} when the message came in through an MQTT source, whatever its hop count; blank when the hop count is unknown`],
    ['viaMqttSource', `true if the message came in through an MQTT source (bridge or broker) rather than over RF — the ${MQTT_SOURCE_EMOJI} case above`],
    ['snr', 'Receive SNR — RF-received messages only'], ['rssi', 'Receive RSSI dBm — RF only'],
    ['isBroadcast', 'true if broadcast (alias of isChannel)'],
    ['wantAck', 'Sender requested an ack'], ['replyId', 'Replied-to packet id'],
    ['emoji', 'Tapback/reaction emoji flag'], ['viaMqtt', 'true if it arrived via MQTT'],
    ['replyContext', `"${REPLY_CONTEXT_TAPBACK}"/"${REPLY_CONTEXT_REPLY}"/"" — Meshtastic only; a short marker for a tapback/reply so it doesn't read as a standalone message once relayed to a protocol with no thread concept`],
    ['zeroHop', '1 when the message arrived over RF with 0 hops; 0 when relayed or received via MQTT'],
    ['decryptedBy', 'Channel/key that decrypted it'], ['protocol', 'meshtastic or meshcore'],
    ['protocolShort', 'Short protocol code: MT (Meshtastic) or MC (MeshCore)'],
    ['scopeName', 'Region/scope name (MeshCore)'],
    ['packetHash', 'MeshCore only: packet hash, 16 uppercase hex chars — matches map.meshcore.com.hr/#/packets/<hash>. Best-effort for DMs; empty when the raw frame could not be matched (room posts, messages synced after a reconnect)'],
    ['scopeCode', 'Region/scope code — 0 = unscoped (MeshCore)'], ['scoped', 'true if sent with a region (MeshCore)'],
  ],
  'trigger.telemetry': [['nodeNum', 'Node number'], ['telemetryType', 'Metric name'], ['value', 'Reading value'], ['unit', 'Unit']],
  'trigger.nodeUpdated': [
    ['nodeNum', 'Node number (Meshtastic)'], ['changed', 'Changed field names (list). MeshCore: name, latitude, longitude, advType, outPath, pathLen'],
    ...NODE_EVENT_MESHCORE_TOKENS,
    NODE_EVENT_PACKET_ID_TOKEN, NODE_EVENT_PACKET_HASH_TOKEN,
  ],
  'trigger.nodeDiscovered': [
    ['nodeNum', 'Node number (Meshtastic)'], ['changed', 'Changed field names (list; empty on discovery)'],
    ...NODE_EVENT_MESHCORE_TOKENS,
    NODE_EVENT_PACKET_ID_TOKEN, NODE_EVENT_PACKET_HASH_TOKEN,
  ],
  'trigger.system': [['event', 'System event'], ['nodeNum', 'Node number (if any)'], ['reason', 'Detail / reason'], ['latestVersion', 'Latest version (upgrade-available)'], ['currentVersion', 'Current version (upgrade-available)']],
  'trigger.geofence': [['event', 'enter / exit / dwell'], ['nodeNum', 'Node number'], ['latitude', 'Node latitude'], ['longitude', 'Node longitude'], ['distanceKm', 'Distance from the region centre (km)']],
  'trigger.becameMobile': [['nodeNum', 'Node number'], ['previousMobile', 'Previous mobile flag (0)'], ['mobile', 'New mobile flag (1)'], ['latitude', 'Node latitude'], ['longitude', 'Node longitude']],
  'trigger.leftHome': [['nodeNum', 'Node number'], ['latitude', 'Node latitude'], ['longitude', 'Node longitude'], ['homeLat', 'Home latitude'], ['homeLon', 'Home longitude'], ['distanceMeters', 'Distance from home (m)'], ['thresholdMeters', 'Configured threshold (m)']],
  'trigger.meshBeacon': [['nodeNum', 'Node number'], ['message', 'Beacon text'], ['offerChannelName', 'Offered channel name'], ['offerRegion', 'Offered region code'], ['offerPreset', 'Offered modem preset'], ['hasOffer', 'true if the beacon advertises a network']],
  'trigger.nodeStale': [['nodeNum', 'Node number (Meshtastic)'], ['publicKey', 'Public key (MeshCore)'], ['ageMinutes', 'Minutes since last heard'], ['staleAfterMinutes', 'Configured silence threshold (min)'], ['lastHeard', 'Last-heard time (epoch ms)']],
  'trigger.nodeOnline': [['nodeNum', 'Node number (Meshtastic)'], ['publicKey', 'Public key (MeshCore)'], ['offlineDurationMinutes', 'Minutes the node was offline'], ['staleAfterMinutes', 'Configured silence threshold (min)']],
  'trigger.nodeRebooted': [['nodeNum', 'Node number'], ['previousUptimeSeconds', 'Uptime before the reset (s)'], ['uptimeSeconds', 'Uptime after the reset (s)']],
  'trigger.nodePowerChanged': [['nodeNum', 'Node number'], ['direction', 'lost (now on battery) / restored (now powered)'], ['powered', 'true if now on external/USB power'], ['previousPowered', 'true if previously on external/USB power'], ['batteryLevel', 'Battery level (%, >100 = powered)']],
  'trigger.batteryTrend': [['nodeNum', 'Node number'], ['dropPercent', 'Observed drop over the window (percentage points)'], ['windowHours', 'Lookback window (hours)'], ['minDropPercent', 'Configured drop threshold (points)'], ['startLevel', 'Battery level at the window start (%)'], ['latestLevel', 'Latest battery level (%)']],
  'trigger.becameLikelyAircraft': [['nodeNum', 'Node number'], ['altitude', 'Altitude (m MSL)'], ['heightAboveGround', 'Height above ground (m, AGL basis only)'], ['groundElevation', 'Ground elevation (m)'], ['basis', 'agl / msl'], ['thresholdM', 'Threshold crossed (m)'], ['previousLikelyAircraft', 'Previous likely-aircraft flag (false / null)'], ['latitude', 'Node latitude'], ['longitude', 'Node longitude']],
  'trigger.schedule': [],
};

export const UNIVERSAL_TOKENS: Array<[string, string]> = [['sourceId', 'The source the event came from'], ['timestamp', 'Event time (rendered as a local date/time)']];
const TRIGGER_LABEL: Record<string, string> = {
  'trigger.message': 'Message', 'trigger.telemetry': 'Telemetry', 'trigger.nodeUpdated': 'Node updated',
  'trigger.nodeDiscovered': 'Node discovered', 'trigger.system': 'System event', 'trigger.geofence': 'Geofence',
  'trigger.becameMobile': 'Became mobile', 'trigger.leftHome': 'Left home', 'trigger.schedule': 'Schedule',
  'trigger.meshBeacon': 'MeshBeacon',
  'trigger.nodeStale': 'Node silent', 'trigger.nodeOnline': 'Node recovered',
  'trigger.nodeRebooted': 'Node rebooted',
  'trigger.nodePowerChanged': 'Node power changed',
  'trigger.batteryTrend': 'Battery draining',
  'trigger.becameLikelyAircraft': 'Became likely aircraft',
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
      <button className="ae-btn ae-btn--ghost ae-drawer-close" onClick={onClose} aria-label="Close substitutions reference"><UiIcon name="close" size={16} /></button>
      <h2>Substitutions</h2>
      <p className="ae-muted">Insert these <code>{'{{ … }}'}</code> tokens in any text field (message, notify title/body). An unknown or empty value renders blank.</p>

      <h3>Variables &amp; misc</h3>
      <dl>
        <dt>{'{{ var.NAME }}'}</dt><dd>Any user variable{variables.length ? `: ${variables.map((v) => v.name).join(', ')}` : ' (none defined yet)'}.</dd>
        <dt>{'{{ var.NAME.a.b }}'}</dt><dd>Index into a <strong>json</strong> variable (e.g. a “Run a script” result) — dotted path into the stored object/array. A whole object renders as JSON.</dd>
        <dt>{'{{ NOW }}'}</dt><dd>Current time (rendered as a local date/time).</dd>
      </dl>

      {(SUBJECT_NODE_TRIGGER_TYPES as readonly string[]).includes(triggerType) && (
        <div>
          <h3>Subject node — current trigger</h3>
          <p className="ae-muted">Hydrated from the node DB row at fire time. Use these for names on Became mobile / Left home / Node updated / …</p>
          <dl>
            {NODE_TOKENS.flatMap(([k, d]) => [
              <dt key={`${k}-t`}>{`{{ node.${k} }}`}</dt>,
              <dd key={`${k}-d`}>{d}</dd>,
            ])}
          </dl>
        </div>
      )}

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
