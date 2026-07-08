/**
 * Builder catalog (#3653) — metadata driving the IFTTT/Maintainerr-style form.
 *
 * Each block type declares the param fields the builder renders. This is UI
 * metadata only; the engine validates the resulting graph server-side. Field
 * `kind` maps to an input renderer in AutomationBuilder.
 */

export type FieldKind = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'variable' | 'emoji' | 'fieldselect' | 'sourceMulti' | 'sendSourceMulti' | 'channelMulti' | 'geofence' | 'scriptselect' | 'regionSelect';

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
  help?: string;
  advanced?: boolean;
  /** This `text`/`textarea` field accepts `{{ }}` tokens → highlight + typo-check. */
  tokens?: boolean;
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

// ─── Triggers (WHEN) ─────────────────────────────────────────────────────────

export const TRIGGERS: BlockDef[] = [
  {
    type: 'trigger.message',
    label: 'A message is received',
    description: 'Fires when a text message arrives.',
    fields: [
      { name: 'textContains', label: 'Text contains', kind: 'text', placeholder: 'e.g. ping', help: 'Case-insensitive substring match. Leave blank to match any text.' },
      { name: 'regex', label: 'Text matches regex', kind: 'text', placeholder: 'e.g. ^(test|ping)', advanced: true, help: 'A regular expression matched against the message text.' },
      { name: 'channels', label: 'On channels', kind: 'channelMulti', advanced: true, help: 'Match messages that arrive on ANY of these channels (unified by name across your sources). An OR-list — leave none to match any channel. When set, this overrides the single-channel fields below.' },
      { name: 'channelName', label: 'On channel (name)', kind: 'text', placeholder: 'any', advanced: true, help: 'Match by channel name (case-insensitive) — portable across sources where the same channel sits in a different slot. Preferred over the channel # below. Ignored when "On channels" above is set.' },
      { name: 'channel', label: 'On channel #', kind: 'number', placeholder: 'any', advanced: true, help: 'Match by raw channel index. Note: the same channel can be a different index on different sources — use the name above for cross-source automations. Ignored when "On channels" above is set.' },
      { name: 'from', label: 'From node #', kind: 'number', placeholder: 'any', advanced: true, help: 'Only fire for messages from this node number.' },
      COOLDOWN,
    ],
  },
  {
    type: 'trigger.nodeDiscovered',
    label: 'A new node is discovered',
    description: 'Fires the first time a node is seen. Note: new-vs-updated detection is coming in a later update — for now this behaves like “A node is updated”. Use that trigger meanwhile.',
    fields: [COOLDOWN],
  },
  {
    type: 'trigger.nodeUpdated',
    label: 'A node is updated',
    description: "Fires when a node's info changes (name, role, position…).",
    fields: [COOLDOWN],
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
        ],
      },
      COOLDOWN,
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
      { name: 'shape', label: 'Region', kind: 'geofence', help: 'Draw a circle (center + radius) or a polygon on the map.' },
      COOLDOWN,
    ],
  },
];

// ─── Comparison field registry (event / node / latest-telemetry) ─────────────

const SUBJECT_NODE_TRIGGERS = ['trigger.message', 'trigger.nodeDiscovered', 'trigger.nodeUpdated', 'trigger.telemetry', 'trigger.geofence'];
const hasSubjectNode = (t: string) => SUBJECT_NODE_TRIGGERS.includes(t);

const EVENT_NUMERIC: Record<string, FieldOpt[]> = {
  'trigger.message': [
    { value: 'hops', label: 'Hop count' }, { value: 'from', label: 'Sender node #' },
    { value: 'channel', label: 'Channel #' }, { value: 'snr', label: 'SNR' }, { value: 'rssi', label: 'RSSI' },
  ],
  'trigger.telemetry': [{ value: 'value', label: 'Reading value' }, { value: 'nodeNum', label: 'Node #' }],
  'trigger.nodeUpdated': [{ value: 'nodeNum', label: 'Node #' }],
  'trigger.nodeDiscovered': [{ value: 'nodeNum', label: 'Node #' }],
};
const EVENT_STRING: Record<string, FieldOpt[]> = {
  'trigger.message': [
    { value: 'text', label: 'Message text' }, { value: 'fromId', label: 'Sender node id' }, { value: 'toId', label: 'Recipient node id' },
    { value: 'scopeName', label: 'MeshCore scope/region' },
  ],
  'trigger.telemetry': [{ value: 'telemetryType', label: 'Metric name' }],
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
];
const NODE_STRING: FieldOpt[] = [
  { value: 'node.longName', label: 'Long name' }, { value: 'node.shortName', label: 'Short name' },
  { value: 'node.nodeId', label: 'Node id' }, { value: 'node.roleName', label: 'Role name (e.g. ROUTER)' },
];
// Latest telemetry of a metric for the subject node.
const TELEMETRY_FIELDS: FieldOpt[] = [
  { value: 'telemetry.batteryLevel', label: 'Battery level' }, { value: 'telemetry.voltage', label: 'Voltage' },
  { value: 'telemetry.temperature', label: 'Temperature' }, { value: 'telemetry.relativeHumidity', label: 'Humidity' },
  { value: 'telemetry.barometricPressure', label: 'Pressure' }, { value: 'telemetry.channelUtilization', label: 'Channel utilization' },
  { value: 'telemetry.airUtilTx', label: 'Air util TX' }, { value: 'telemetry.current', label: 'Current' }, { value: 'telemetry.iaq', label: 'IAQ (air quality)' },
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
const STRING_OP_OPTIONS = [
  { value: 'contains', label: 'contains' }, { value: 'eq', label: 'equals' },
  { value: 'startsWith', label: 'starts with' }, { value: 'endsWith', label: 'ends with' },
  { value: 'regex', label: 'matches regex' }, { value: 'notContains', label: "doesn't contain" },
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
    description: 'Compare text — message text, node name, role name…',
    fields: [
      { name: 'field', label: 'Field', kind: 'fieldselect' },
      { name: 'op', label: 'Operator', kind: 'select', options: STRING_OP_OPTIONS },
      { name: 'value', label: 'Value', kind: 'text', tokens: true, placeholder: 'e.g. ROUTER' },
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

// ─── Actions (THEN) ──────────────────────────────────────────────────────────

export const ACTIONS: BlockDef[] = [
  {
    type: 'action.tapback',
    label: 'Send a tapback (reaction)',
    description: 'React to the triggering message.',
    fields: [
      { name: 'emoji', label: 'Emoji', kind: 'emoji', placeholder: '👍' },
      { name: 'sourceIds', label: 'Send via sources', kind: 'sendSourceMulti', help: 'Which radios send the reaction (MeshCore sources are skipped — tapbacks are Meshtastic-only). Leave none to use the source that triggered the automation — but a source IS required for source-less triggers like System events and Schedules.' },
    ],
  },
  {
    type: 'action.sendMessage',
    label: 'Send a message',
    description: 'Send text to a channel or as a DM.',
    fields: [
      { name: 'text', label: 'Message', kind: 'textarea', tokens: true, placeholder: 'Hello {{ trigger.senderLabel }}!', help: 'Use {{ trigger.field }} or {{ var.name }} to insert values. {{ trigger.senderLabel }} is the universal "who sent this" label (works on Meshtastic and MeshCore).' },
      { name: 'sourceIds', label: 'Send via sources', kind: 'sendSourceMulti', help: 'Which radios to send through (MQTT sources are receive-only and excluded). Leave none to use the source that triggered the automation — but a source IS required for source-less triggers like System events and Schedules.' },
      { name: 'channels', label: 'On channels', kind: 'channelMulti', help: 'Channels to post to, unified by name + key across your sources (the correct local slot is resolved per source). Leave none to use the triggering channel.' },
      { name: 'to', label: 'DM to node #', kind: 'text', tokens: true, placeholder: 'blank = channel; {{ trigger.from }} replies to sender', advanced: true },
      { name: 'replyToTrigger', label: 'Reply to the triggering message', kind: 'checkbox', advanced: true, help: 'Meshtastic: threads the reply as a tapback. MeshCore has no tapback, so instead it auto-prepends the @[sender]: mention (using {{ trigger.senderLabel }} — sender name, else channel name, else id) to your text, so you don’t have to write it yourself. An existing @[…] mention in your text = no change.' },
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
      { name: 'seconds', label: 'Reboot delay (seconds)', kind: 'number', advanced: true, placeholder: '10', help: 'Meshtastic: how long the device waits before rebooting (default 10s). Ignored by MeshCore.' },
    ],
  },
  {
    type: 'action.notify',
    label: 'Send a notification',
    description: 'Send an external notification (Apprise).',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', tokens: true, placeholder: 'MeshMonitor alert' },
      { name: 'body', label: 'Body', kind: 'textarea', tokens: true, placeholder: 'Node {{ trigger.fromId }} said {{ trigger.text }}' },
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
