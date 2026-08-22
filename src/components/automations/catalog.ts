/**
 * Builder catalog (#3653) — metadata driving the IFTTT/Maintainerr-style form.
 *
 * Each block type declares the param fields the builder renders. This is UI
 * metadata only; the engine validates the resulting graph server-side. Field
 * `kind` maps to an input renderer in AutomationBuilder.
 */
import { HOP_COUNT_EMOJIS, HOP_EMOJI_MAX, MQTT_SOURCE_EMOJI } from '../../utils/hopEmoji';

export type FieldKind = 'text' | 'number' | 'nodeNum' | 'textarea' | 'select' | 'checkbox' | 'variable' | 'emoji' | 'fieldselect' | 'sourceMulti' | 'sendSourceMulti' | 'channelMulti' | 'geofence' | 'scriptselect' | 'regionSelect' | 'nodeMulti';

export interface FieldOpt { value: string; label: string; }
export interface FieldGroup { label: string; options: FieldOpt[]; }

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  options?: FieldOpt[];
  /** Grouped options for `fieldselect` (event / node / telemetry). Computed at render time. */
  groups?: FieldGroup[];
  placeholder?: string;
  /**
   * Optional per-trigger placeholders for tokenised message fields. When the
   * current WHEN trigger matches a key, that string wins over `placeholder`.
   */
  placeholderByTrigger?: Record<string, string>;
  help?: string;
  advanced?: boolean;
  /** This `text`/`textarea` field accepts `{{ }}` tokens → highlight + typo-check. */
  tokens?: boolean;
  /**
   * Restrict a source/channel picker (`sourceMulti` / `sendSourceMulti` /
   * `channelMulti`) to one protocol's options. `'meshcore'` shows only MeshCore
   * sources/channels; `'meshtastic'` shows everything that is NOT MeshCore
   * (native Meshtastic + MQTT bridge/broker, which are Meshtastic-protocol).
   * Omitted = show all. Used by the MT↔MC Bridge template so the "Meshtastic"
   * pickers don't list MeshCore options and vice-versa.
   */
  protocolFilter?: 'meshtastic' | 'meshcore';
  /**
   * Render this field only when a sibling param matches. Omitted = always shown.
   * Declarative (not a predicate function) so the catalog stays serialisable data.
   */
  showIf?: {
    field: string;
    equals?: unknown;
    notEquals?: unknown;
    /** Visible only when the sibling param is truthy (`true`) / falsy (`false`).
     *  Covers "a number field that is unset, blank, or 0" in one operator (#4340 Phase 2). */
    truthy?: boolean;
  };
}

/** Resolve the placeholder shown for a field under the current WHEN trigger. */
export function fieldPlaceholder(field: FieldDef, triggerType: string): string | undefined {
  return field.placeholderByTrigger?.[triggerType] ?? field.placeholder;
}

/** Should this field render, given the block's current params? Pure — unit-tested without React. */
export function fieldVisible(field: FieldDef, params: Record<string, unknown>): boolean {
  const c = field.showIf;
  if (!c) return true;
  const v = params[c.field];
  if ('equals' in c && v !== c.equals) return false;
  if ('notEquals' in c && v === c.notEquals) return false;
  // Boolean(v) covers undefined / '' / 0 / false uniformly. Known, harmless
  // wart: the string '0' is truthy — it only shows an extra select.
  if (c.truthy !== undefined && Boolean(v) !== c.truthy) return false;
  return true;
}

export interface BlockDef {
  type: string;
  label: string;
  description: string;
  fields: FieldDef[];
}

const COOLDOWN: FieldDef = {
  name: 'cooldownSeconds', label: 'Cooldown (seconds)', kind: 'number', advanced: true,
  placeholder: '0', help: 'Minimum seconds between firings — an anti-spam throttle. 0 = no limit.',
};

const COOLDOWN_SCOPE: FieldDef = {
  name: 'cooldownScope', label: 'Cooldown applies to', kind: 'select', advanced: true,
  // Values mirror CooldownScope in src/types/automation.ts. Kept as literals so
  // this frontend catalog keeps its zero dependency on the server-side types
  // module (the same call Phase 1 made for action.tapback's emojiMode).
  // 'automation' MUST be first: defaultParams() seeds a select's first option,
  // so a newly added trigger block gets the pre-4.14 behaviour.
  options: [
    { value: 'automation', label: 'The whole automation (one shared timer)' },
    { value: 'node', label: 'Each node separately' },
    { value: 'sourceNode', label: 'Each node, per source' },
  ],
  // Only meaningful once a cooldown is actually set.
  showIf: { field: 'cooldownSeconds', truthy: true },
  help: 'The whole automation: one timer for the rule — on a busy channel, answering one node suppresses the answer to the next. Each node separately: every sending/subject node gets its own timer, which is what you want for a range-test responder. Each node, per source: the same node heard via two sources cools down independently. Triggers with no subject node (Schedule, System, MeshCore channel messages) fall back to one shared timer.',
};

// ─── Triggers (WHEN) ─────────────────────────────────────────────────────────

export const TRIGGERS: BlockDef[] = [
  {
    type: 'trigger.message',
    label: 'A message is received',
    description: 'Fires when a text message arrives.',
    fields: [
      { name: 'textContains', label: 'Text contains', kind: 'text', placeholder: 'e.g. ping', help: 'Case-insensitive substring match. Leave blank to match any text.' },
      // The field directly above says "Case-insensitive substring match", so
      // silence here reads as "same rules apply". It is not: messageMatchesFilter
      // lower-cases both sides for textContains and matches the regex against
      // raw text (triggerContext.ts). #4509 documented this on the
      // `condition.string` block and missed the trigger, which is the surface
      // most users actually reach for.
      {
        name: 'regex', label: 'Text matches regex', kind: 'text',
        placeholder: 'e.g. (?i)^(test|ping)', advanced: true,
        help: 'A regular expression matched against the message text. '
          + 'Case-sensitive, unlike "Text contains" above — prefix with (?i) to ignore case, e.g. (?i)^(test|ping).',
      },
      { name: 'channels', label: 'On channels', kind: 'channelMulti', advanced: true, help: 'Match messages that arrive on ANY of these channels (unified by name across your sources). An OR-list — leave none to match any channel. When set, this overrides the single-channel fields below.' },
      { name: 'channelName', label: 'On channel (name)', kind: 'text', placeholder: 'any', advanced: true, help: 'Match by channel name (case-insensitive) — portable across sources where the same channel sits in a different slot. Preferred over the channel # below. Ignored when "On channels" above is set.' },
      { name: 'channel', label: 'On channel #', kind: 'number', placeholder: 'any', advanced: true, help: 'Match by raw channel index. Note: the same channel can be a different index on different sources — use the name above for cross-source automations. Ignored when "On channels" above is set.' },
      { name: 'from', label: 'From node #', kind: 'number', placeholder: 'any', advanced: true, help: 'Only fire for messages from this node number.' },
      COOLDOWN,
      COOLDOWN_SCOPE,
      // `includeSelf` (bypasses the engine's #3914 self-origin guard, #4694) is
      // deliberately NOT a field here, same as `rateLimit` (also trigger.message-
      // only and also absent from this list) — both are template-internal params
      // set directly by bridge.ts, not general builder options. Exposing
      // `includeSelf` as a checkbox would let a user re-create the self-reply
      // loop #3914 exists to prevent; don't add one without a loop-safety story
      // for whatever automation would use it.
    ],
  },
  {
    type: 'trigger.nodeDiscovered',
    label: 'A new node is discovered',
    description: 'Fires the first time a node is seen. Note: new-vs-updated detection is coming in a later update — for now this behaves like “A node is updated”. Use that trigger meanwhile.',
    fields: [COOLDOWN, COOLDOWN_SCOPE],
  },
  {
    type: 'trigger.nodeUpdated',
    label: 'A node is updated',
    description: "Fires when a node's info changes (name, role, position…).",
    fields: [COOLDOWN, COOLDOWN_SCOPE],
  },
  {
    type: 'trigger.telemetry',
    label: 'Telemetry is received',
    description: 'Fires on a telemetry reading.',
    fields: [
      {
        name: 'telemetryType', label: 'Metric', kind: 'select', help: 'Only fire for this metric. Leave as "Any".',
        options: [
          { value: '', label: 'Any' },
          { value: 'batteryLevel', label: 'Battery level (%)' },
          { value: 'voltage', label: 'Voltage' },
          { value: 'temperature', label: 'Temperature' },
          { value: 'channelUtilization', label: 'Channel utilization' },
          { value: 'airUtilTx', label: 'Air util TX' },
          { value: 'noiseFloor', label: 'Noise floor (dBm) — local node only' },
        ],
      },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.meshBeacon',
    label: 'A MeshBeacon is received',
    description: 'Fires on a MeshBeacon broadcast from another node (firmware 2.8+).',
    fields: [
      {
        name: 'messageContains', label: 'Text contains', kind: 'text',
        help: 'Only fire when the beacon text contains this (case-insensitive). Leave blank for any beacon.',
      },
      {
        name: 'requireOffer', label: 'Only beacons offering a network', kind: 'checkbox',
        help: 'Ignore text-only beacons — fire only when the beacon advertises a channel, region, or preset.',
      },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.schedule',
    label: 'On a schedule',
    description: 'Fires on a cron schedule (no mesh event).',
    fields: [
      { name: 'cron', label: 'Cron expression', kind: 'text', placeholder: '0 * * * *', help: 'Standard 5-field cron, e.g. "0 * * * *" = top of every hour.' },
    ],
  },
  {
    type: 'trigger.system',
    label: 'A system event',
    description: 'Fires on a MeshMonitor system event.',
    fields: [
      {
        name: 'event', label: 'Event', kind: 'select',
        options: [
          { value: 'bootup', label: 'System start (MeshMonitor started)' },
          { value: 'source-connected', label: 'Source came online' },
          { value: 'source-disconnected', label: 'Source went offline' },
          { value: 'upgrade-available', label: 'Upgrade available (new release detected)' },
        ],
      },
    ],
  },
  {
    type: 'trigger.geofence',
    label: 'A node enters/leaves a region',
    description: 'Fires when a node crosses a geofence (checked on position updates). Draw a circle or polygon region on the map.',
    fields: [
      {
        name: 'event', label: 'Event', kind: 'select',
        options: [
          { value: 'enter', label: 'Enters the region' },
          { value: 'exit', label: 'Leaves the region' },
          { value: 'dwell', label: 'Moves while inside the region' },
        ],
      },
      { name: 'shape', label: 'Region', kind: 'geofence', help: 'Draw a circle (center + radius) or a polygon on the map, or anchor the fence to a waypoint so it follows the waypoint when it moves.' },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.becameMobile',
    label: 'A watched node becomes mobile',
    description: 'Fires when a hand-selected node flips from stationary to mobile (MeshMonitor’s >100 m position-history heuristic). Useful for tamper / theft alerts on fixed sites.',
    fields: [
      { name: 'nodeNums', label: 'Watch nodes', kind: 'nodeMulti', help: 'Pick the nodes to watch. Stationary nodes (mobile = 0) are listed first with a Stationary badge.' },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.leftHome',
    label: 'A watched node leaves its home position',
    description: 'Fires when a hand-selected node moves farther than a threshold from its home/anchor position. Home is seeded from position-history inliers when available (else the first live fix), then gently averaged while within half the threshold. Use “Reset homes from history” on a saved automation to clear and re-seed. Default threshold is 300 m.',
    fields: [
      { name: 'nodeNums', label: 'Watch nodes', kind: 'nodeMulti', help: 'Pick the nodes to watch. Stationary nodes (mobile = 0) are listed first with a Stationary badge.' },
      { name: 'thresholdMeters', label: 'Threshold (meters)', kind: 'number', placeholder: '300', help: 'Alert when the node is farther than this many metres from its home position. Default 300. History seeding and live refine both use half this distance as the inlier / average radius.' },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.nodeStale',
    label: 'A node goes silent (heartbeat lost)',
    description: 'Fires once when a node has not been heard for longer than the threshold — a health/heartbeat alert. There is no packet to react to here, so silence is checked on a periodic tick (about once a minute) against every node on every source; narrow it with a “Source is one of…” condition. Works for Meshtastic and MeshCore. It will not fire again for that node until it is heard and then goes silent once more.',
    fields: [
      { name: 'staleAfterMinutes', label: 'Silent for (minutes)', kind: 'number', placeholder: '60', help: 'Fire when the node has not been heard for this many minutes. Silence is polled on a ~1-minute tick, so expect up to a minute of detection lag.' },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.nodeOnline',
    label: 'A silent node is heard again (recovery)',
    description: 'Fires once when a node that had been silent longer than the threshold is heard again — the recovery counterpart to “A node goes silent”. Works for Meshtastic and MeshCore.',
    fields: [
      { name: 'staleAfterMinutes', label: 'Was silent for (minutes)', kind: 'number', placeholder: '60', help: 'How long the node must have been silent to count as recovered when next heard. Match this to the value on your paired “goes silent” rule.' },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.nodeRebooted',
    label: 'A node reboots unexpectedly',
    description: 'Fires when a node’s uptime counter resets — the sign of an unexpected restart. Detected from the uptime telemetry a node already reports, by comparing each new reading against the last stored one; there is no extra polling and no packet is sent. Meshtastic only for now. It never fires on the first uptime reading for a node (no prior to compare).',
    fields: [
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.nodePowerChanged',
    label: 'A node switches power source (mains ↔ battery)',
    description: 'Fires when a node crosses between external/USB power and battery power. Detected from the battery telemetry a node already reports, by comparing each new reading against the last stored one; there is no extra polling and no packet is sent. It never fires on the first battery reading for a node (no prior to compare). On Meshtastic this uses the firmware’s convention (a battery value above 100% means powered); note that above 100 conflates “on USB / no battery” with “charging”, so it is a powered-state signal, not a clean “on wall power” flag. EXPERIMENTAL on MeshCore: the firmware has no powered flag, so this is a heuristic derived from battery voltage (≥ 4.2 V is treated as powered). A full or charging battery reads ~4.2 V and looks identical to wall power, so false “lost”/“restored” alerts are expected on MeshCore.',
    fields: [
      {
        name: 'direction', label: 'Direction', kind: 'select',
        help: 'Which transition to fire on. “Either” covers both losing and regaining external power.',
        options: [
          { value: 'either', label: 'Either direction' },
          { value: 'lost', label: 'Lost external power (now on battery)' },
          { value: 'restored', label: 'Regained external power' },
        ],
      },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
  {
    type: 'trigger.batteryTrend',
    label: 'A node’s battery is steadily draining',
    description: 'Fires when a node’s battery level falls by at least the given amount across a lookback window — the “solar node losing charge / not charging” alert. Computed from the battery-level telemetry a node already reports; battery history is checked on a slow periodic tick (about every 15 minutes) against every Meshtastic node on every source, so narrow it with a “Source is one of…” condition. It fires once per decline and re-arms only after the battery recovers (net drop back under the threshold). Meshtastic only — MeshCore has no battery history. Heuristic note: the protocol carries no charge-state field, so a falling level is a proxy for “not charging”, not a certainty — it can false-alarm under heavy load and does not know day from night.',
    fields: [
      { name: 'windowHours', label: 'Lookback window (hours)', kind: 'number', placeholder: '12', help: 'How far back to compare the battery level. A longer window smooths out brief load spikes but reacts more slowly.' },
      { name: 'minDropPercent', label: 'Minimum drop (percentage points)', kind: 'number', placeholder: '20', help: 'Fire when the battery level fell by at least this many points across the window (e.g. 80% → 55% is a 25-point drop).' },
      COOLDOWN,
      COOLDOWN_SCOPE,
    ],
  },
];

// ─── Comparison field registry (event / node / latest-telemetry) ─────────────

const SUBJECT_NODE_TRIGGERS = ['trigger.message', 'trigger.nodeDiscovered', 'trigger.nodeUpdated', 'trigger.telemetry', 'trigger.geofence', 'trigger.becameMobile', 'trigger.leftHome', 'trigger.meshBeacon', 'trigger.nodeStale', 'trigger.nodeOnline', 'trigger.nodeRebooted', 'trigger.nodePowerChanged', 'trigger.batteryTrend'];
const hasSubjectNode = (t: string) => SUBJECT_NODE_TRIGGERS.includes(t);

const EVENT_NUMERIC: Record<string, FieldOpt[]> = {
  'trigger.message': [
    { value: 'hops', label: 'Hop count' }, { value: 'from', label: 'Sender node #' },
    { value: 'channel', label: 'Channel #' }, { value: 'snr', label: 'SNR' }, { value: 'rssi', label: 'RSSI' },
    // #4340 Phase 3: booleans compared as 1/0 (the engine's asNumber() coerces
    // them). Needed to express Auto-Acknowledge's {Channel,Direct} ×
    // {ZeroHop,MultiHop} matrix, where ZeroHop means hops == 0 AND NOT viaMqtt.
    { value: 'isDM', label: 'Is a direct message (1 = yes, 0 = channel)' },
    { value: 'viaMqtt', label: 'Arrived via MQTT (1 = yes, 0 = RF)' },
    // #4340 Phase 4: derived, total (never NaN) form of the ZeroHop half of the
    // matrix above — computed via Auto-Acknowledge's own autoAckIsZeroHop() on
    // its own floored hop count, so a hopless packet (no hopStart) reads 1, not
    // NaN. See triggerContext.ts buildMessageContext for the derivation.
    { value: 'zeroHop', label: 'Direct RF, 0 hops (1 = yes; 0 = relayed or via MQTT)' },
    // #4594: the TRANSPORT the message reached MeshMonitor by — whether its
    // source is an MQTT Bridge / MQTT Broker rather than a radio. Distinct from
    // `viaMqtt` above, which is the packet's own upstream relay flag and is
    // routinely 1 on messages our radio did receive over RF.
    { value: 'viaMqttSource', label: 'Came in via an MQTT source (1 = yes, 0 = over RF)' },
  ],
  'trigger.telemetry': [{ value: 'value', label: 'Reading value' }, { value: 'nodeNum', label: 'Node #' }],
  'trigger.meshBeacon': [
    { value: 'nodeNum', label: 'Node #' },
    { value: 'hasOffer', label: 'Advertises a network (1 = yes, 0 = text only)' },
    { value: 'offerRegion', label: 'Offered region code' },
    { value: 'offerPreset', label: 'Offered modem preset' },
  ],
  'trigger.nodeUpdated': [{ value: 'nodeNum', label: 'Node #' }],
  'trigger.nodeDiscovered': [{ value: 'nodeNum', label: 'Node #' }],
  'trigger.nodeStale': [
    { value: 'nodeNum', label: 'Node #' },
    { value: 'ageMinutes', label: 'Minutes since last heard' },
    { value: 'staleAfterMinutes', label: 'Silence threshold (min)' },
  ],
  'trigger.nodeOnline': [
    { value: 'nodeNum', label: 'Node #' },
    { value: 'offlineDurationMinutes', label: 'Minutes offline' },
    { value: 'staleAfterMinutes', label: 'Silence threshold (min)' },
  ],
  'trigger.nodeRebooted': [
    { value: 'nodeNum', label: 'Node #' },
    { value: 'previousUptimeSeconds', label: 'Uptime before reset (s)' },
    { value: 'uptimeSeconds', label: 'Uptime after reset (s)' },
  ],
  'trigger.nodePowerChanged': [
    { value: 'nodeNum', label: 'Node #' },
    { value: 'batteryLevel', label: 'Battery level (%, >100 = powered)' },
    { value: 'powered', label: 'Now powered (1 = external, 0 = battery)' },
    { value: 'previousPowered', label: 'Was powered (1 = external, 0 = battery)' },
  ],
  'trigger.batteryTrend': [
    { value: 'nodeNum', label: 'Node #' },
    { value: 'dropPercent', label: 'Observed drop (percentage points)' },
    { value: 'windowHours', label: 'Lookback window (hours)' },
    { value: 'minDropPercent', label: 'Drop threshold (points)' },
    { value: 'startLevel', label: 'Battery at window start (%)' },
    { value: 'latestLevel', label: 'Latest battery (%)' },
  ],
  'trigger.becameMobile': [{ value: 'nodeNum', label: 'Node #' }, { value: 'mobile', label: 'Mobile flag (1)' }, { value: 'previousMobile', label: 'Previous mobile flag' }],
  'trigger.leftHome': [
    { value: 'nodeNum', label: 'Node #' },
    { value: 'distanceMeters', label: 'Distance from home (m)' },
    { value: 'thresholdMeters', label: 'Threshold (m)' },
    { value: 'latitude', label: 'Latitude' },
    { value: 'longitude', label: 'Longitude' },
    { value: 'homeLat', label: 'Home latitude' },
    { value: 'homeLon', label: 'Home longitude' },
  ],
};
const EVENT_STRING: Record<string, FieldOpt[]> = {
  'trigger.message': [
    { value: 'text', label: 'Message text' }, { value: 'fromId', label: 'Sender node id' }, { value: 'toId', label: 'Recipient node id' },
    { value: 'scopeName', label: 'MeshCore scope/region' },
  ],
  'trigger.telemetry': [{ value: 'telemetryType', label: 'Metric name' }],
  'trigger.meshBeacon': [
    { value: 'message', label: 'Beacon text' },
    { value: 'offerChannelName', label: 'Offered channel name' },
  ],
  'trigger.system': [
    { value: 'event', label: 'System event' },
    { value: 'latestVersion', label: 'Latest version (upgrade event)' },
    { value: 'currentVersion', label: 'Current version (upgrade event)' },
    { value: 'reason', label: 'Reason / detail' },
  ],
};

// Subject-node fields (resolved from the hydrated node record).
const NODE_NUMERIC: FieldOpt[] = [
  { value: 'node.batteryLevel', label: 'Battery level (%)' }, { value: 'node.voltage', label: 'Voltage' },
  { value: 'node.hopsAway', label: 'Hops away' }, { value: 'node.role', label: 'Role (number)' },
  { value: 'node.ageMinutes', label: 'Node age (minutes since heard)' },
  { value: 'node.channelUtilization', label: 'Channel utilization' }, { value: 'node.airUtilTx', label: 'Air util TX' },
  { value: 'node.snr', label: 'Last SNR' },
  { value: 'node.latitude', label: 'Latitude' }, { value: 'node.longitude', label: 'Longitude' }, { value: 'node.altitude', label: 'Altitude' },
  { value: 'node.mobile', label: 'Mobile flag (1 = mobile, 0 = stationary)' },
];
const NODE_STRING: FieldOpt[] = [
  { value: 'node.longName', label: 'Long name' }, { value: 'node.shortName', label: 'Short name' },
  { value: 'node.nodeId', label: 'Node id' }, { value: 'node.roleName', label: 'Role name (e.g. ROUTER)' },
  // #4340 Phase 3 — see NODE_COMPLETENESS in engineContext.ts. Three states, so
  // "complete or not yet known" is expressible with the `is one of` operator.
  { value: 'node.completeness', label: 'Node info completeness (complete / incomplete / unknown)' },
];
// Latest telemetry of a metric for the subject node.
const TELEMETRY_FIELDS: FieldOpt[] = [
  { value: 'telemetry.batteryLevel', label: 'Battery level' }, { value: 'telemetry.voltage', label: 'Voltage' },
  { value: 'telemetry.temperature', label: 'Temperature' }, { value: 'telemetry.relativeHumidity', label: 'Humidity' },
  { value: 'telemetry.barometricPressure', label: 'Pressure' }, { value: 'telemetry.channelUtilization', label: 'Channel utilization' },
  { value: 'telemetry.airUtilTx', label: 'Air util TX' }, { value: 'telemetry.current', label: 'Current' }, { value: 'telemetry.iaq', label: 'IAQ (air quality)' },
  { value: 'telemetry.noiseFloor', label: 'Noise floor (local node only)' },
];

export function numericFields(triggerType: string): FieldGroup[] {
  const groups: FieldGroup[] = [];
  if (EVENT_NUMERIC[triggerType]?.length) groups.push({ label: 'This event', options: EVENT_NUMERIC[triggerType] });
  if (hasSubjectNode(triggerType)) {
    groups.push({ label: 'Node', options: NODE_NUMERIC });
    groups.push({ label: 'Latest telemetry', options: TELEMETRY_FIELDS });
  }
  return groups;
}
export function stringFields(triggerType: string): FieldGroup[] {
  const groups: FieldGroup[] = [];
  if (EVENT_STRING[triggerType]?.length) groups.push({ label: 'This event', options: EVENT_STRING[triggerType] });
  if (hasSubjectNode(triggerType)) groups.push({ label: 'Node', options: NODE_STRING });
  return groups;
}
/** Grouped field options for a numeric/string condition under the given trigger. */
export function fieldsFor(blockType: string, triggerType: string): FieldGroup[] {
  return blockType === 'condition.string' ? stringFields(triggerType) : numericFields(triggerType);
}

const NUMERIC_OP_OPTIONS = [
  { value: '==', label: '= equals' }, { value: '!=', label: '≠ not equals' },
  { value: '>', label: '> greater than' }, { value: '<', label: '< less than' },
  { value: '>=', label: '≥ at least' }, { value: '<=', label: '≤ at most' },
];
// Exported (one word) so autoAckParity.test.ts (#4340 Phase 3, WP5) can
// cross-check these labels/values against conditionEvaluator.ts's stringCompare.
export const STRING_OP_OPTIONS = [
  { value: 'contains', label: 'contains' }, { value: 'eq', label: 'equals' },
  { value: 'startsWith', label: 'starts with' }, { value: 'endsWith', label: 'ends with' },
  { value: 'regex', label: 'matches regex' }, { value: 'notContains', label: "doesn't contain" },
  // #4340 Phase 3: membership in a comma/whitespace-separated list, mirroring
  // Auto-Acknowledge's own autoAckIgnoredNodes parser (meshtasticManager.ts,
  // separators + case-insensitivity) — see conditionEvaluator.ts's `in`/`notIn`.
  { value: 'in', label: 'is one of (comma list)' },
  { value: 'notIn', label: "isn't one of (comma list)" },
];

// ─── Conditions (IF) ─────────────────────────────────────────────────────────

export const CONDITIONS: BlockDef[] = [
  {
    type: 'condition.always',
    label: 'Always (no filtering)',
    description: 'A pass-through that always matches — use it to run the actions on every trigger, with no filtering.',
    fields: [],
  },
  {
    type: 'condition.numeric',
    label: 'Number comparison',
    description: 'Compare a number — event field, node field, or latest telemetry.',
    fields: [
      { name: 'field', label: 'Field', kind: 'fieldselect' },
      { name: 'op', label: 'Operator', kind: 'select', options: NUMERIC_OP_OPTIONS },
      { name: 'value', label: 'Value', kind: 'text', tokens: true, placeholder: 'e.g. 20 or {{ var.threshold }}', help: 'A number, or {{ var.name }} to compare against a variable.' },
    ],
  },
  {
    type: 'condition.string',
    label: 'Text comparison',
    // NOTE: a condition block's `description` is not rendered — only the
    // trigger's is (AutomationBuilder.tsx). Guidance for these operators has to
    // live in a field's `help`, which is why the casing note sits on `op` below.
    description: 'Compare text — message text, node name, role name…',
    fields: [
      { name: 'field', label: 'Field', kind: 'fieldselect' },
      {
        name: 'op', label: 'Operator', kind: 'select', options: STRING_OP_OPTIONS,
        // Casing is NOT uniform across these operators, and nothing said so
        // until a user hit it (#4507): stringCompare() lower-cases both sides
        // for every operator except `eq`, `neq` and `regex`. Only `eq` and
        // `regex` are named below because `neq` is deliberately absent from
        // STRING_OP_OPTIONS — naming an operator the dropdown doesn't offer
        // would be worse than saying nothing. See stringCompare() in
        // server/services/automation/conditionEvaluator.ts.
        help: '“Equals” and “matches regex” are case-sensitive. The other operators ignore case.',
      },
      // Two `value` variants sharing one param name: same stored key, so the
      // typed value survives switching operators, while the regex case gets its
      // own placeholder and help. They MUST stay mutually exclusive — both
      // visible would render a duplicate input on a duplicate React key.
      {
        name: 'value', label: 'Value', kind: 'text', tokens: true, placeholder: 'e.g. ROUTER',
        showIf: { field: 'op', notEquals: 'regex' },
      },
      // `(?i)` works because the evaluator compiles with RE2
      // (src/utils/safeRegex.ts) — plain JS RegExp rejects inline flags.
      {
        name: 'value', label: 'Value', kind: 'text', tokens: true,
        placeholder: 'e.g. (?i)^(test|ping)',
        help: 'Case-sensitive. Prefix with (?i) to ignore case — e.g. (?i)^(test|ping).',
        showIf: { field: 'op', equals: 'regex' },
      },
    ],
  },
  {
    type: 'condition.meshcoreScope',
    label: 'MeshCore message scope',
    description: 'Match a MeshCore message by its region scope — a specific region, unscoped (no region), or any scoped message. Meshtastic messages never match. Handy for nudging users who post unscoped or on a very broad region.',
    fields: [
      {
        name: 'mode', label: 'Match', kind: 'select',
        options: [
          { value: 'named', label: 'A specific region…' },
          { value: 'unscoped', label: 'Unscoped (no region)' },
          { value: 'scoped', label: 'Any scoped message' },
        ],
      },
      {
        name: 'regions', label: 'Region(s)', kind: 'regionSelect',
        placeholder: 'e.g. de, eu',
        help: 'Comma-separated region names to match (used when Match = a specific region). Case-insensitive.',
      },
      {
        name: 'includeUnscoped', label: 'Also match unscoped', kind: 'checkbox',
        help: 'When matching specific region(s), ALSO match messages sent with no region — e.g. “region de OR unscoped”.',
      },
    ],
  },
  {
    type: 'condition.sourceFilter',
    label: 'Source is one of…',
    description: 'Only continue for the selected source connection(s).',
    fields: [
      { name: 'sourceIds', label: 'Sources', kind: 'sourceMulti', help: 'Leave none selected to allow any source.' },
    ],
  },
  {
    type: 'condition.distance',
    label: 'Distance from a point',
    description: "Compare the node's distance from a location.",
    fields: [
      { name: 'op', label: 'Operator', kind: 'select', options: [{ value: '<', label: 'within (<)' }, { value: '>', label: 'farther than (>)' }] },
      { name: 'km', label: 'Distance (km)', kind: 'number', placeholder: '5' },
      { name: 'lat', label: 'Reference latitude', kind: 'number' },
      { name: 'lon', label: 'Reference longitude', kind: 'number' },
    ],
  },
  {
    type: 'condition.variable',
    label: 'Variable check',
    description: 'Check a user variable / flag.',
    fields: [
      { name: 'variable', label: 'Variable', kind: 'variable' },
      { name: 'op', label: 'Operator', kind: 'select', help: 'Leave blank to test "is set / true".', options: [{ value: '', label: 'is set / true' }, ...NUMERIC_OP_OPTIONS] },
      { name: 'value', label: 'Value', kind: 'text', tokens: true, placeholder: 'optional' },
    ],
  },
  {
    type: 'condition.timeRange',
    label: 'Time of day',
    description: 'Only within a time window.',
    fields: [
      { name: 'start', label: 'From (HH:MM)', kind: 'text', placeholder: '08:00' },
      { name: 'end', label: 'To (HH:MM)', kind: 'text', placeholder: '20:00' },
    ],
  },
];

const MOVEMENT_MESSAGE_HINTS: Record<string, string> = {
  'trigger.leftHome': 'A quiet little node {{ node.longName }} has left the Shire and gone off on an unexpected adventure.',
  'trigger.becameMobile': 'A wild stationary node {{ node.longName }} just uprooted itself and headed towards Isengard!',
};

// ─── Actions (THEN) ──────────────────────────────────────────────────────────

export const ACTIONS: BlockDef[] = [
  {
    type: 'action.tapback',
    label: 'Send a tapback (reaction)',
    description: 'React to the triggering message.',
    // #4340: protocol/content emoji (the glyphs actually sent over the mesh), not UI
    // iconography — UiIcon does not apply. Glyphs are interpolated from the shared
    // table so they cannot drift.
    fields: [
      {
        // 'fixed' | 'hopCount' — see TapbackEmojiMode in src/types/automation.ts.
        name: 'emojiMode', label: 'Emoji source', kind: 'select',
        options: [
          { value: 'fixed', label: 'A fixed emoji' },
          { value: 'hopCount', label: `The message's hop count (${HOP_COUNT_EMOJIS[0]} direct, ${HOP_COUNT_EMOJIS[1]}–${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]})` },
        ],
        help: `Hop count reacts with ${HOP_COUNT_EMOJIS[0]} for a direct (0-hop) message and ${HOP_COUNT_EMOJIS[1]}–${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]} above, clamping at ${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]} — the same table Auto-Acknowledge uses. A message that came in through an MQTT source (bridge or broker) reacts with ${MQTT_SOURCE_EMOJI} instead, whatever its hop count, because it never crossed this radio's RF link. Triggers with no hop information (Schedule, System) record a skipped no-op.`,
      },
      { name: 'emoji', label: 'Emoji', kind: 'emoji', placeholder: '👍', showIf: { field: 'emojiMode', notEquals: 'hopCount' } },
      { name: 'sourceIds', label: 'Send via sources', kind: 'sendSourceMulti', help: 'Which radios send the reaction (MeshCore sources are skipped — tapbacks are Meshtastic-only). Leave none to use the source that triggered the automation — but a source IS required for source-less triggers like System events and Schedules.' },
    ],
  },
  {
    type: 'action.sendMessage',
    label: 'Send a message',
    description: 'Send text to a channel or as a DM.',
    fields: [
      {
        name: 'text', label: 'Message', kind: 'textarea', tokens: true,
        placeholder: 'Hello {{ trigger.senderLabel }}!',
        placeholderByTrigger: MOVEMENT_MESSAGE_HINTS,
        help: 'Use {{ trigger.field }}, {{ node.longName }}, or {{ var.name }} to insert values. On Became mobile / Left home, prefer {{ node.longName }} (or {{ node.nodeId }}) — those triggers have no senderLabel.',
      },
      { name: 'sourceIds', label: 'Send via sources', kind: 'sendSourceMulti', help: 'Which radios to send through (MQTT sources are receive-only and excluded). Leave none to use the source that triggered the automation — but a source IS required for source-less triggers like System events and Schedules.' },
      { name: 'channels', label: 'On channels', kind: 'channelMulti', help: 'Channels to post to, unified by name + key across your sources (the correct local slot is resolved per source). Leave none to use the triggering channel.' },
      { name: 'to', label: 'DM to node #', kind: 'text', tokens: true, placeholder: 'blank = channel; {{ trigger.from }} replies to sender', advanced: true },
      { name: 'replyToTrigger', label: 'Reply to the triggering message', kind: 'checkbox', advanced: true, help: 'Meshtastic: threads the reply as a tapback. MeshCore has no tapback, so instead it auto-prepends the @[sender]: mention (using {{ trigger.senderLabel }} — sender name, else channel name, else id) to your text, so you don’t have to write it yourself. An existing @[…] mention in your text = no change.' },
      {
        name: 'maxAttempts', label: 'DM resend attempts', kind: 'number', advanced: true,
        placeholder: '1', // 1–3; mirrors SEND_MAX_ATTEMPTS_* in src/types/automation.ts.
        // Only meaningful for a DM — the queue hardcodes 1 attempt for channel
        // sends. Reuses Phase 2's showIf.truthy so an unset/blank/0 `to` hides it.
        showIf: { field: 'to', truthy: true },
        help: 'Resend this DM (1–3) until the recipient ACKs it — the same retry Auto-Acknowledge uses. Leave blank for a single send. Setting it routes the DM through the source’s outgoing queue, which also spaces sends 30 seconds apart. Meshtastic DMs only: ignored for channel messages and MeshCore.',
      },
      {
        name: 'scopeMode', label: 'MeshCore scope', kind: 'select', advanced: true,
        options: [
          { value: 'inherit', label: 'Inherit (channel / source default)' },
          { value: 'trigger', label: "Match the triggering message's scope" },
          { value: 'unscoped', label: 'Unscoped (flood, no region)' },
          { value: 'named', label: 'A specific region…' },
        ],
        help: 'Region a MeshCore message floods to (controls propagation). MeshCore only — ignored by Meshtastic sources.',
      },
      {
        name: 'scopeName', label: 'Region', kind: 'regionSelect', advanced: true, tokens: true,
        placeholder: 'e.g. paris', help: 'Used when MeshCore scope is "A specific region".',
      },
    ],
  },
  {
    type: 'action.nodeManage',
    label: 'Manage the node',
    description: 'Favorite / ignore / delete the subject node.',
    fields: [
      {
        name: 'op', label: 'Operation', kind: 'select',
        options: [
          { value: 'favorite', label: 'Favorite' }, { value: 'unfavorite', label: 'Unfavorite' },
          { value: 'ignore', label: 'Ignore' }, { value: 'unignore', label: 'Unignore' },
          { value: 'delete', label: 'Delete' },
        ],
      },
    ],
  },
  {
    type: 'action.requestData',
    label: 'Request data from a node',
    description: 'Ask a node for telemetry, position, a traceroute, etc. (e.g. poll a remote sensor on a schedule).',
    fields: [
      {
        name: 'op', label: 'Request', kind: 'select',
        options: [
          { value: 'telemetry', label: 'Telemetry' },
          { value: 'position', label: 'Position (Meshtastic)' },
          { value: 'traceroute', label: 'Traceroute / path' },
          { value: 'nodeinfo', label: 'Node info exchange (Meshtastic)' },
          { value: 'neighbors', label: 'Neighbor info' },
          { value: 'advert', label: 'Announce self (advert)' },
        ],
        help: 'Requests data from / about the target node. Ops a protocol can’t do are skipped.',
      },
      {
        name: 'telemetryType', label: 'Telemetry type', kind: 'select',
        options: [
          { value: 'device', label: 'Device' },
          { value: 'environment', label: 'Environment' },
          { value: 'airQuality', label: 'Air quality' },
          { value: 'power', label: 'Power' },
        ],
        help: 'Used when Request = Telemetry (Meshtastic). e.g. "Environment" for a remote weather sensor (#3835).',
      },
      { name: 'sourceIds', label: 'Via sources', kind: 'sendSourceMulti', help: 'Which radio(s) to send the request through. Leave none to use the triggering source — but a source IS required for source-less triggers (Schedule / System).' },
      { name: 'to', label: 'Target node', kind: 'text', tokens: true, advanced: true, placeholder: 'blank = triggering node; {{ trigger.from }}', help: 'Node # (Meshtastic) or contact public key (MeshCore). Leave blank to target the triggering node. Not used for "Announce self".' },
      { name: 'channel', label: 'Channel #', kind: 'number', advanced: true, placeholder: 'blank = triggering channel', help: 'Meshtastic: which channel to send the request on — e.g. a private sensor channel. Ignored by MeshCore.' },
    ],
  },
  {
    type: 'action.deviceReboot',
    label: 'Reboot the node',
    description: 'Reboot the physical device — e.g. reinitialize a flaky BLE bridge or MQTT proxy on a daily schedule.',
    fields: [
      { name: 'sourceIds', label: 'Reboot which node(s)', kind: 'sendSourceMulti', help: 'The connected node(s) to reboot. Leave none to use the source that triggered the automation — but a source IS required for source-less triggers like Schedules and System events. (MQTT sources have no physical device and are excluded.)' },
      { name: 'targetNodeNum', label: 'Remote target node #', kind: 'nodeNum', advanced: true, placeholder: 'blank = locally-connected node; 1017730782 or !3ca956de', help: 'Meshtastic remote-admin reboot: leave blank to reboot the locally-connected node; set a node number to reboot a remote node over the mesh (uses the session-passkey admin mechanism — the target must have granted admin access). Accepts a decimal node number or a hex id (!3ca956de). Ignored by MeshCore.' },
      { name: 'seconds', label: 'Reboot delay (seconds)', kind: 'number', advanced: true, placeholder: '10', help: 'Meshtastic: how long the device waits before rebooting (default 10s). Ignored by MeshCore.' },
    ],
  },
  {
    type: 'action.notify',
    label: 'Send a notification',
    description: 'Send an external notification (Apprise).',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', tokens: true, placeholder: 'MeshMonitor alert' },
      {
        name: 'body', label: 'Body', kind: 'textarea', tokens: true,
        placeholder: 'Node {{ trigger.fromId }} said {{ trigger.text }}',
        placeholderByTrigger: MOVEMENT_MESSAGE_HINTS,
      },
      {
        name: 'type', label: 'Severity', kind: 'select', advanced: true,
        options: [
          { value: 'info', label: 'Info' }, { value: 'success', label: 'Success' },
          { value: 'warning', label: 'Warning' }, { value: 'failure', label: 'Failure' },
        ],
        help: 'Apprise notification type (affects colour/icon on supported services).',
      },
      {
        name: 'urls', label: 'Apprise URL(s)', kind: 'textarea', advanced: true,
        placeholder: 'discord://… or tgram://… (one per line)',
        help: 'Optional. One Apprise service URL per line. Leave blank to use the Apprise API server’s configured targets.',
      },
    ],
  },
  {
    type: 'flow.setVar',
    label: 'Set a variable / flag',
    description: 'Write a user variable.',
    fields: [
      { name: 'variable', label: 'Variable', kind: 'variable' },
      {
        name: 'op', label: 'Action', kind: 'select',
        options: [
          { value: 'set', label: 'Set to value' }, { value: 'increment', label: 'Increment by' },
          { value: 'flag', label: 'Raise flag' }, { value: 'clear', label: 'Clear / lower flag' },
        ],
      },
      { name: 'value', label: 'Value', kind: 'text', tokens: true, placeholder: 'for Set / Increment' },
    ],
  },
  {
    type: 'action.nothing',
    label: 'Do nothing',
    description: 'A no-op. Use it when a rule should only contribute its IF result to a FINALLY (ANY/ALL/NONE) step without doing anything on its own.',
    fields: [],
  },
  {
    type: 'action.runScript',
    label: 'Run a script',
    description: 'Run a script from the server’s scripts folder. The trigger context is passed as MM_* environment variables; the script’s JSON output can be stored in a variable.',
    fields: [
      { name: 'scriptPath', label: 'Script', kind: 'scriptselect', help: 'A script file in the server’s scripts directory ($DATA_DIR/scripts).' },
      { name: 'resultVariable', label: 'Store result in', kind: 'variable', advanced: true, help: 'Optional. Stores the script’s JSON output in this variable — use a "json" variable and index it later as {{ var.name.field }}.' },
      { name: 'timeoutSeconds', label: 'Timeout (seconds)', kind: 'number', advanced: true, placeholder: '30' },
    ],
  },
  {
    type: 'action.delay',
    label: 'Pause',
    description: 'Wait a number of seconds before the next action runs. Use it to space out a sequence — e.g. let a repeater finish transmitting before you reply. Pauses only this run (max 300s); it is not durable across a restart.',
    fields: [
      { name: 'seconds', label: 'Seconds', kind: 'number', placeholder: '5', help: 'How long to wait before the next action (0–300).' },
    ],
  },
];

export const BLOCK_BY_TYPE: Record<string, BlockDef> = Object.fromEntries(
  [...TRIGGERS, ...CONDITIONS, ...ACTIONS].map((b) => [b.type, b]),
);
