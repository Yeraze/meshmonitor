/**
 * Builder catalog (#3653) — metadata driving the IFTTT/Maintainerr-style form.
 *
 * Each block type declares the param fields the builder renders. This is UI
 * metadata only; the engine validates the resulting graph server-side. Field
 * `kind` maps to an input renderer in AutomationBuilder.
 */

export type FieldKind = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'variable' | 'emoji';

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
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
];

// Field options available to numeric/string conditions, by trigger type.
export const TRIGGER_FIELDS: Record<string, { value: string; label: string }[]> = {
  'trigger.message': [
    { value: 'hops', label: 'Hop count' },
    { value: 'from', label: 'Sender node #' },
    { value: 'channel', label: 'Channel #' },
    { value: 'text', label: 'Message text' },
    { value: 'snr', label: 'SNR' },
    { value: 'rssi', label: 'RSSI' },
    { value: 'isDM', label: 'Is a direct message' },
  ],
  'trigger.telemetry': [
    { value: 'value', label: 'Reading value' },
    { value: 'nodeNum', label: 'Node #' },
  ],
  'trigger.nodeUpdated': [{ value: 'nodeNum', label: 'Node #' }],
  'trigger.nodeDiscovered': [{ value: 'nodeNum', label: 'Node #' }],
  'trigger.schedule': [],
};

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
    description: 'Compare a numeric field (battery, hops…).',
    fields: [
      { name: 'field', label: 'Field', kind: 'select', options: [] /* filled from trigger */ },
      { name: 'op', label: 'Operator', kind: 'select', options: NUMERIC_OP_OPTIONS },
      { name: 'value', label: 'Value', kind: 'text', placeholder: 'e.g. 20 or {{ var.threshold }}', help: 'A number, or {{ var.name }} to compare against a variable.' },
    ],
  },
  {
    type: 'condition.string',
    label: 'Text comparison',
    description: 'Compare a text field.',
    fields: [
      { name: 'field', label: 'Field', kind: 'select', options: [] },
      { name: 'op', label: 'Operator', kind: 'select', options: STRING_OP_OPTIONS },
      { name: 'value', label: 'Value', kind: 'text', placeholder: 'e.g. hello' },
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
