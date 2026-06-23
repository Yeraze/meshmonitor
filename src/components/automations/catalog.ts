/**
 * Builder catalog (#3653) — metadata driving the IFTTT/Maintainerr-style form.
 *
 * Each block type declares the param fields the builder renders. This is UI
 * metadata only; the engine validates the resulting graph server-side. Field
 * `kind` maps to an input renderer in AutomationBuilder.
 */

export type FieldKind = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'variable' | 'emoji' | 'fieldselect' | 'sourceMulti';

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
      { name: 'channel', label: 'On channel #', kind: 'number', placeholder: 'any', advanced: true },
      { name: 'from', label: 'From node #', kind: 'number', placeholder: 'any', advanced: true, help: 'Only fire for messages from this node number.' },
      COOLDOWN,
    ],
  },
  {
    type: 'trigger.nodeDiscovered',
    label: 'A new node is discovered',
    description: 'Fires the first time a node is seen.',
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
    description: 'Fires when a node crosses a circular geofence (checked on position updates).',
    fields: [
      {
        name: 'event', label: 'Event', kind: 'select',
        options: [
          { value: 'enter', label: 'Enters the region' },
          { value: 'exit', label: 'Leaves the region' },
          { value: 'dwell', label: 'Moves while inside the region' },
        ],
      },
      { name: 'lat', label: 'Center latitude', kind: 'number', placeholder: 'e.g. 27.95' },
      { name: 'lon', label: 'Center longitude', kind: 'number', placeholder: 'e.g. -82.46' },
      { name: 'radiusKm', label: 'Radius (km)', kind: 'number', placeholder: 'e.g. 1' },
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
    type: 'condition.numeric',
    label: 'Number comparison',
    description: 'Compare a number — event field, node field, or latest telemetry.',
    fields: [
      { name: 'field', label: 'Field', kind: 'fieldselect' },
      { name: 'op', label: 'Operator', kind: 'select', options: NUMERIC_OP_OPTIONS },
      { name: 'value', label: 'Value', kind: 'text', placeholder: 'e.g. 20 or {{ var.threshold }}', help: 'A number, or {{ var.name }} to compare against a variable.' },
    ],
  },
  {
    type: 'condition.string',
    label: 'Text comparison',
    description: 'Compare text — message text, node name, role name…',
    fields: [
      { name: 'field', label: 'Field', kind: 'fieldselect' },
      { name: 'op', label: 'Operator', kind: 'select', options: STRING_OP_OPTIONS },
      { name: 'value', label: 'Value', kind: 'text', placeholder: 'e.g. ROUTER' },
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
      { name: 'value', label: 'Value', kind: 'text', placeholder: 'optional' },
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
    fields: [{ name: 'emoji', label: 'Emoji', kind: 'emoji', placeholder: '👍' }],
  },
  {
    type: 'action.sendMessage',
    label: 'Send a message',
    description: 'Send text to a channel or as a DM.',
    fields: [
      { name: 'text', label: 'Message', kind: 'textarea', placeholder: 'Hello {{ trigger.fromId }}!', help: 'Use {{ trigger.field }} or {{ var.name }} to insert values.' },
      { name: 'channel', label: 'On channel #', kind: 'number', placeholder: 'trigger channel' },
      { name: 'to', label: 'DM to node #', kind: 'text', placeholder: 'blank = channel; {{ trigger.from }} replies to sender', advanced: true },
      { name: 'replyToTrigger', label: 'Reply to the triggering message', kind: 'checkbox', advanced: true },
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
    type: 'action.notify',
    label: 'Send a notification',
    description: 'Send an external notification (Apprise).',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', placeholder: 'MeshMonitor alert' },
      { name: 'body', label: 'Body', kind: 'textarea', placeholder: 'Node {{ trigger.fromId }} said {{ trigger.text }}' },
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
      { name: 'value', label: 'Value', kind: 'text', placeholder: 'for Set / Increment' },
    ],
  },
];

export const BLOCK_BY_TYPE: Record<string, BlockDef> = Object.fromEntries(
  [...TRIGGERS, ...CONDITIONS, ...ACTIONS].map((b) => [b.type, b]),
);
