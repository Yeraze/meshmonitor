/**
 * Device Health template (Automation Template Gallery, Device Health epic #4558
 * Phase F — final). Quick-creates a set of node-health notification automations,
 * one per alert the operator enables.
 *
 * Unlike Auto-Ack (one automation) or the MT↔MC Bridge (a fixed pair), this
 * template's `build()` returns a VARIABLE-length ARRAY: one `BuiltAutomation`
 * per ENABLED alert. Each alert maps to a distinct health trigger (a telemetry
 * reading crossing a threshold, a node going silent/recovering, a reboot, a
 * power-source switch, or a slow battery decline) and fires an `action.notify`
 * (Apprise) with a tokenised title/body describing what happened.
 *
 * FLOOR (keeps catalog.integrity.test.ts green): if the operator enables
 * nothing, `build()` still emits ONE automation — the low-battery alert — so the
 * array is never empty and every permutation yields ≥1 valid graph.
 *
 * Every automation is built via the shared `compile()` (`../compile.ts`), never
 * hand-assembled nodes/edges — same as autoAck.ts / bridge.ts — so each installed
 * automation stays `decompile()`-able back into the friendly builder UI.
 *
 * FLOOD SAFETY: the recurring telemetry-threshold alerts (battery/voltage/temp/
 * channel-util/noise) fire on EVERY reading while the value stays over the line,
 * so each carries a per-node cooldown (`cooldownSeconds` + `cooldownScope:'node'`,
 * real catalog fields — see catalog.ts COOLDOWN) to bound the notifications. The
 * event-style triggers (nodeStale/nodeOnline/nodeRebooted/nodePowerChanged/
 * batteryTrend) already fire once per event and re-arm on the reverse edge, so
 * they don't need one.
 */
import { compile, type WorkflowForm, type FormBlock } from '../compile';
import type { AutomationTemplate, BuiltAutomation, ParamSpec } from './types';

// ─── value coercion ──────────────────────────────────────────────────────────

/** `sourceMulti` fields store a plain array of source ids (mirrors autoAck.ts). */
function asSourceIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** `nodeMulti` fields store a plain array of node numbers (AutomationBuilder.tsx). */
function asNodeNums(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** A checkbox is enabled only when explicitly true; absent/false = off. */
function isEnabled(v: unknown): boolean {
  return v === true;
}

/** Parse a number field, falling back to the alert's default for blank/invalid. */
function numOr(v: unknown, fallback: number): number {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Meshtastic-style hex node id ("!433d0c0c") — what the `node.nodeId` field resolves to. */
function toNodeId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

// ─── defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  lowBattery: 20,        // %
  lowVoltage: 3.3,       // V
  highTemp: 60,          // °
  highChannelUtil: 40,   // %
  staleAfterMinutes: 60, // min (shared by heartbeat-lost + back-online)
  highNoiseFloor: -90,   // dBm
  trendWindowHours: 6,   // h
  trendMinDropPercent: 15, // percentage points
  cooldownSeconds: 3600, // per-node throttle on the recurring telemetry alerts
} as const;

// ─── params ──────────────────────────────────────────────────────────────────

const PARAMS: ParamSpec[] = [
  {
    name: 'sourceIds', label: 'Only watch these sources', kind: 'sourceMulti',
    help: 'Leave none selected to watch every source. Recommended for the periodic checks (silent / battery-declining), which otherwise scan every node on every source.',
  },
  {
    name: 'nodeNums', label: 'Only watch these nodes', kind: 'nodeMulti',
    help: 'Leave none selected to watch every node.',
  },

  // 1. Low battery %
  { name: 'lowBattery', label: 'Alert on low battery %', kind: 'checkbox' },
  {
    name: 'lowBatteryThreshold', label: 'Battery below (%)', kind: 'number',
    placeholder: String(DEFAULTS.lowBattery), showIf: { field: 'lowBattery', truthy: true },
    help: 'Notify when a node reports a battery level below this.',
  },

  // 2. Low voltage
  { name: 'lowVoltage', label: 'Alert on low voltage', kind: 'checkbox' },
  {
    name: 'lowVoltageThreshold', label: 'Voltage below (V)', kind: 'number',
    placeholder: String(DEFAULTS.lowVoltage), showIf: { field: 'lowVoltage', truthy: true },
    help: 'Notify when a node reports a battery voltage below this.',
  },

  // 3. High temperature
  { name: 'highTemp', label: 'Alert on high temperature', kind: 'checkbox' },
  {
    name: 'highTempThreshold', label: 'Temperature above (°)', kind: 'number',
    placeholder: String(DEFAULTS.highTemp), showIf: { field: 'highTemp', truthy: true },
    help: 'Notify when a node reports a temperature above this.',
  },

  // 4. High channel utilization
  { name: 'highChannelUtil', label: 'Alert on high channel utilization', kind: 'checkbox' },
  {
    name: 'highChannelUtilThreshold', label: 'Channel utilization above (%)', kind: 'number',
    placeholder: String(DEFAULTS.highChannelUtil), showIf: { field: 'highChannelUtil', truthy: true },
    help: 'Notify when a node reports channel utilization above this.',
  },

  // 5. Heartbeat lost + 6. Back online (share one threshold)
  { name: 'heartbeatLost', label: 'Alert when a node goes silent (heartbeat lost)', kind: 'checkbox' },
  {
    name: 'staleAfterMinutes', label: 'Silent for (minutes)', kind: 'number',
    placeholder: String(DEFAULTS.staleAfterMinutes), showIf: { field: 'heartbeatLost', truthy: true },
    help: 'How long without being heard counts as silent. Also used by the "back online" recovery alert below so the pair stays matched.',
  },
  { name: 'backOnline', label: 'Alert when a silent node is heard again', kind: 'checkbox' },

  // 7. Reboot detected
  { name: 'rebootDetected', label: 'Alert on unexpected reboot (Meshtastic)', kind: 'checkbox' },

  // 8. External power lost
  { name: 'powerLost', label: 'Alert when a node loses external power (Meshtastic)', kind: 'checkbox' },

  // 9. High noise floor (local node only)
  { name: 'highNoiseFloor', label: 'Alert on high noise floor (local node only)', kind: 'checkbox' },
  {
    name: 'highNoiseFloorThreshold', label: 'Noise floor above (dBm)', kind: 'number',
    placeholder: String(DEFAULTS.highNoiseFloor), showIf: { field: 'highNoiseFloor', truthy: true },
    help: 'Notify when the noise floor rises above this (a higher / less-negative dBm is noisier). Noise floor is reported by the locally-connected node only.',
  },

  // 10. Battery declining (trend)
  { name: 'batteryDeclining', label: 'Alert when a battery is steadily draining (Meshtastic)', kind: 'checkbox' },
  {
    name: 'trendWindowHours', label: 'Trend lookback window (hours)', kind: 'number',
    placeholder: String(DEFAULTS.trendWindowHours), showIf: { field: 'batteryDeclining', truthy: true },
    help: 'How far back to compare the battery level.',
  },
  {
    name: 'trendMinDropPercent', label: 'Minimum drop (percentage points)', kind: 'number',
    placeholder: String(DEFAULTS.trendMinDropPercent), showIf: { field: 'batteryDeclining', truthy: true },
    help: 'Fire when the battery fell by at least this many points across the window.',
  },
];

// ─── shared assembly ─────────────────────────────────────────────────────────

interface Common {
  sourceIds: string[];
  nodeIds: string[]; // hex node ids for the `node.nodeId in …` filter
}

/**
 * Conditions common to every alert: scope to the chosen sources, then to the
 * chosen nodes. Ordered source-first to mirror autoAck.ts / autoAckConverter.ts.
 */
function commonConditions(common: Common): FormBlock[] {
  const conditions: FormBlock[] = [];
  if (common.sourceIds.length > 0) {
    conditions.push({ type: 'condition.sourceFilter', params: { sourceIds: common.sourceIds } });
  }
  if (common.nodeIds.length > 0) {
    // `in` (comma list) against the hydrated node id — the string operator that
    // parses a comma/whitespace list case-insensitively (conditionEvaluator.ts).
    conditions.push({ type: 'condition.string', params: { field: 'node.nodeId', op: 'in', value: common.nodeIds.join(',') } });
  }
  return conditions;
}

interface AlertParts {
  nameSuffix: string;
  description: string;
  trigger: FormBlock;
  /** The telemetry-threshold check, if this alert has one. */
  threshold?: FormBlock;
  notify: { title: string; body: string; type: string };
}

function assemble(parts: AlertParts, common: Common): BuiltAutomation {
  const conditions = commonConditions(common);
  if (parts.threshold) conditions.push(parts.threshold);
  const form: WorkflowForm = {
    trigger: parts.trigger,
    rules: [{ conditions, actions: [{ type: 'action.notify', params: parts.notify }] }],
    combine: null,
  };
  return {
    name: `Device Health — ${parts.nameSuffix}`,
    description: parts.description,
    config: compile(form),
  };
}

/** A telemetry trigger with a per-node cooldown to bound repeat notifications. */
function telemetryTrigger(telemetryType: string): FormBlock {
  return {
    type: 'trigger.telemetry',
    params: { telemetryType, cooldownSeconds: DEFAULTS.cooldownSeconds, cooldownScope: 'node' },
  };
}

function numericThreshold(op: string, value: number): FormBlock {
  // Value stored as a string to match autoAck.ts's convention; the engine's
  // asNumber() coerces it (conditionEvaluator.ts).
  return { type: 'condition.numeric', params: { field: 'value', op, value: String(value) } };
}

// ─── per-alert builders (order = install order; index 0 is the floor) ─────────

interface AlertSpec {
  key: string; // the enable-checkbox param
  build(values: Record<string, unknown>, common: Common): BuiltAutomation;
}

const ALERTS: AlertSpec[] = [
  {
    key: 'lowBattery',
    build: (v, c) => {
      const t = numOr(v.lowBatteryThreshold, DEFAULTS.lowBattery);
      return assemble({
        nameSuffix: 'Low battery',
        description: `Notify when a node's battery level drops below ${t}%.`,
        trigger: telemetryTrigger('batteryLevel'),
        threshold: numericThreshold('<', t),
        notify: {
          title: 'Low battery: {{ node.longName }}',
          body: `{{ node.longName }} ({{ node.nodeId }}) battery is {{ trigger.value }}% — below ${t}%.`,
          type: 'warning',
        },
      }, c);
    },
  },
  {
    key: 'lowVoltage',
    build: (v, c) => {
      const t = numOr(v.lowVoltageThreshold, DEFAULTS.lowVoltage);
      return assemble({
        nameSuffix: 'Low voltage',
        description: `Notify when a node's battery voltage drops below ${t}V.`,
        trigger: telemetryTrigger('voltage'),
        threshold: numericThreshold('<', t),
        notify: {
          title: 'Low voltage: {{ node.longName }}',
          body: `{{ node.longName }} ({{ node.nodeId }}) voltage is {{ trigger.value }}V — below ${t}V.`,
          type: 'warning',
        },
      }, c);
    },
  },
  {
    key: 'highTemp',
    build: (v, c) => {
      const t = numOr(v.highTempThreshold, DEFAULTS.highTemp);
      return assemble({
        nameSuffix: 'High temperature',
        description: `Notify when a node reports a temperature above ${t}°.`,
        trigger: telemetryTrigger('temperature'),
        threshold: numericThreshold('>', t),
        notify: {
          title: 'High temperature: {{ node.longName }}',
          body: `{{ node.longName }} ({{ node.nodeId }}) is {{ trigger.value }}° — above ${t}°.`,
          type: 'warning',
        },
      }, c);
    },
  },
  {
    key: 'highChannelUtil',
    build: (v, c) => {
      const t = numOr(v.highChannelUtilThreshold, DEFAULTS.highChannelUtil);
      return assemble({
        nameSuffix: 'High channel utilization',
        description: `Notify when a node reports channel utilization above ${t}%.`,
        trigger: telemetryTrigger('channelUtilization'),
        threshold: numericThreshold('>', t),
        notify: {
          title: 'High channel utilization: {{ node.longName }}',
          body: `{{ node.longName }} ({{ node.nodeId }}) channel utilization is {{ trigger.value }}% — above ${t}%.`,
          type: 'warning',
        },
      }, c);
    },
  },
  {
    key: 'heartbeatLost',
    build: (v, c) => {
      const mins = numOr(v.staleAfterMinutes, DEFAULTS.staleAfterMinutes);
      return assemble({
        nameSuffix: 'Node silent',
        description: `Notify when a node has not been heard for ${mins} minutes.`,
        trigger: { type: 'trigger.nodeStale', params: { staleAfterMinutes: mins } },
        notify: {
          title: 'Node silent: {{ node.longName }}',
          body: '{{ node.longName }} ({{ node.nodeId }}) has not been heard for {{ trigger.ageMinutes }} minutes (threshold {{ trigger.staleAfterMinutes }}).',
          type: 'warning',
        },
      }, c);
    },
  },
  {
    key: 'backOnline',
    build: (v, c) => {
      const mins = numOr(v.staleAfterMinutes, DEFAULTS.staleAfterMinutes);
      return assemble({
        nameSuffix: 'Back online',
        description: `Notify when a node that was silent for ${mins} minutes is heard again.`,
        trigger: { type: 'trigger.nodeOnline', params: { staleAfterMinutes: mins } },
        notify: {
          title: 'Node back online: {{ node.longName }}',
          body: '{{ node.longName }} ({{ node.nodeId }}) is back after {{ trigger.offlineDurationMinutes }} minutes of silence.',
          type: 'success',
        },
      }, c);
    },
  },
  {
    key: 'rebootDetected',
    build: (_v, c) => assemble({
      nameSuffix: 'Reboot detected',
      description: 'Notify when a node\'s uptime counter resets (an unexpected reboot). Meshtastic only.',
      trigger: { type: 'trigger.nodeRebooted', params: {} },
      notify: {
        title: 'Node rebooted: {{ node.longName }}',
        body: '{{ node.longName }} ({{ node.nodeId }}) rebooted — uptime reset from {{ trigger.previousUptimeSeconds }}s to {{ trigger.uptimeSeconds }}s.',
        type: 'warning',
      },
    }, c),
  },
  {
    key: 'powerLost',
    build: (_v, c) => assemble({
      nameSuffix: 'External power lost',
      description: 'Notify when a node switches from external power to battery. Meshtastic only.',
      trigger: { type: 'trigger.nodePowerChanged', params: { direction: 'lost' } },
      notify: {
        title: 'External power lost: {{ node.longName }}',
        body: '{{ node.longName }} ({{ node.nodeId }}) switched to battery power (level {{ trigger.batteryLevel }}%).',
        type: 'warning',
      },
    }, c),
  },
  {
    key: 'highNoiseFloor',
    build: (v, c) => {
      const t = numOr(v.highNoiseFloorThreshold, DEFAULTS.highNoiseFloor);
      return assemble({
        nameSuffix: 'High noise floor',
        description: `Notify when the noise floor rises above ${t} dBm (local node only).`,
        trigger: telemetryTrigger('noiseFloor'),
        threshold: numericThreshold('>', t),
        notify: {
          title: 'High noise floor: {{ node.longName }}',
          body: `{{ node.longName }} ({{ node.nodeId }}) noise floor is {{ trigger.value }} dBm — above ${t} dBm.`,
          type: 'warning',
        },
      }, c);
    },
  },
  {
    key: 'batteryDeclining',
    build: (v, c) => {
      const windowHours = numOr(v.trendWindowHours, DEFAULTS.trendWindowHours);
      const minDropPercent = numOr(v.trendMinDropPercent, DEFAULTS.trendMinDropPercent);
      return assemble({
        nameSuffix: 'Battery declining',
        description: `Notify when a node's battery falls by at least ${minDropPercent} points over ${windowHours}h. Meshtastic only.`,
        trigger: { type: 'trigger.batteryTrend', params: { windowHours, minDropPercent } },
        notify: {
          title: 'Battery declining: {{ node.longName }}',
          body: '{{ node.longName }} ({{ node.nodeId }}) dropped {{ trigger.dropPercent }} points over {{ trigger.windowHours }}h — now {{ trigger.latestLevel }}%.',
          type: 'warning',
        },
      }, c);
    },
  },
];

// ─── build ───────────────────────────────────────────────────────────────────

function build(values: Record<string, unknown>): BuiltAutomation[] {
  const common: Common = {
    sourceIds: asSourceIds(values.sourceIds),
    nodeIds: asNodeNums(values.nodeNums).map(toNodeId),
  };

  const built = ALERTS.filter((a) => isEnabled(values[a.key])).map((a) => a.build(values, common));

  // Floor: nothing enabled → the low-battery alert (ALERTS[0]) so the array is
  // never empty and catalog.integrity.test.ts's "all toggles off" row still
  // yields ≥1 valid automation.
  if (built.length === 0) return [ALERTS[0].build(values, common)];
  return built;
}

export const deviceHealthTemplate: AutomationTemplate = {
  id: 'device-health',
  name: 'Device Health',
  description: 'Get notified when a node’s health slips — low battery or voltage, high temperature or channel utilization, a lost heartbeat, a reboot, a power-source switch, a noisy RF floor, or a steadily draining battery. Installs one automation per alert you enable.',
  icon: 'notifications',
  tags: ['Notifications', 'Health'],
  params: PARAMS,
  build,
};
