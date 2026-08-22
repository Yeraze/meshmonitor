import { describe, it, expect } from 'vitest';
import { deviceHealthTemplate } from './deviceHealth';
import { validateAutomationGraph, type AutomationGraph } from '../../../types/automation';
import type { BuiltAutomation } from './types';

function buildMany(values: Record<string, unknown>): BuiltAutomation[] {
  const built = deviceHealthTemplate.build(values);
  return Array.isArray(built) ? built : [built];
}

function node(config: AutomationGraph, id: string) {
  const n = config.nodes.find((x) => x.id === id);
  expect(n, `node "${id}" not found in ${JSON.stringify(config.nodes)}`).toBeDefined();
  return n!;
}

/** The single trigger node of a linear (one-rule, no-fanout) graph. */
function triggerNode(config: AutomationGraph) {
  return node(config, 't');
}

/** All condition/action nodes in a linear graph, in order. */
function chainTypes(config: AutomationGraph): string[] {
  return config.nodes.map((n) => n.type);
}

describe('deviceHealthTemplate', () => {
  it('has the expected template metadata', () => {
    expect(deviceHealthTemplate.id).toBe('device-health');
    expect(deviceHealthTemplate.name).toBe('Device Health');
    expect(deviceHealthTemplate.tags).toEqual(['Notifications', 'Health']);
    expect(deviceHealthTemplate.icon).toBe('notifications');
    // sanity: the enable checkboxes and their showIf thresholds are all declared.
    const names = deviceHealthTemplate.params.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining([
      'sourceIds', 'nodeNums',
      'lowBattery', 'lowBatteryThreshold',
      'lowVoltage', 'lowVoltageThreshold',
      'highTemp', 'highTempThreshold',
      'highChannelUtil', 'highChannelUtilThreshold',
      'heartbeatLost', 'staleAfterMinutes', 'backOnline',
      'rebootDetected', 'powerLost',
      'highNoiseFloor', 'highNoiseFloorThreshold',
      'batteryDeclining', 'trendWindowHours', 'trendMinDropPercent',
    ]));
  });

  it('every threshold field is gated by its enable checkbox via showIf.truthy', () => {
    const byName = Object.fromEntries(deviceHealthTemplate.params.map((p) => [p.name, p]));
    const pairs: Array<[string, string]> = [
      ['lowBatteryThreshold', 'lowBattery'],
      ['lowVoltageThreshold', 'lowVoltage'],
      ['highTempThreshold', 'highTemp'],
      ['highChannelUtilThreshold', 'highChannelUtil'],
      ['staleAfterMinutes', 'heartbeatLost'],
      ['highNoiseFloorThreshold', 'highNoiseFloor'],
      ['trendWindowHours', 'batteryDeclining'],
      ['trendMinDropPercent', 'batteryDeclining'],
    ];
    for (const [threshold, enable] of pairs) {
      expect(byName[threshold].showIf).toEqual({ field: enable, truthy: true });
    }
  });

  // ── floor ──
  it('floors to exactly one low-battery automation when nothing is enabled', () => {
    const built = buildMany({});
    expect(built).toHaveLength(1);
    expect(built[0].name).toBe('Device Health — Low battery');
    const { config } = built[0];
    expect(triggerNode(config).type).toBe('trigger.telemetry');
    expect(triggerNode(config).params!.telemetryType).toBe('batteryLevel');
    // default threshold 20 wired into the numeric condition
    const numeric = config.nodes.find((n) => n.type === 'condition.numeric')!;
    expect(numeric.params).toEqual({ field: 'value', op: '<', value: '20' });
    expect(validateAutomationGraph(config).valid).toBe(true);
  });

  it('the all-off floor still validates and its config is a single notify chain', () => {
    const { config } = buildMany({})[0];
    expect(chainTypes(config)).toEqual(['trigger.telemetry', 'condition.numeric', 'action.notify']);
    expect(node(config, 'a0').type).toBe('action.notify');
  });

  // ── per-alert trigger + threshold wiring ──
  it('maps each enabled alert to the right trigger and threshold', () => {
    const built = buildMany({
      lowBattery: true, lowBatteryThreshold: '15',
      lowVoltage: true, lowVoltageThreshold: '3.1',
      highTemp: true, highTempThreshold: '70',
      highChannelUtil: true, highChannelUtilThreshold: '50',
      heartbeatLost: true, staleAfterMinutes: '30',
      backOnline: true,
      rebootDetected: true,
      powerLost: true,
      highNoiseFloor: true, highNoiseFloorThreshold: '-85',
      batteryDeclining: true, trendWindowHours: '8', trendMinDropPercent: '25',
    });

    // one automation per enabled alert (10 toggles → 10 automations)
    expect(built).toHaveLength(10);

    const byName = Object.fromEntries(built.map((b) => [b.name, b.config]));

    const find = (cfg: AutomationGraph, type: string) => cfg.nodes.find((n) => n.type === type)!;

    // 1. low battery
    let cfg = byName['Device Health — Low battery'];
    expect(find(cfg, 'trigger.telemetry').params!.telemetryType).toBe('batteryLevel');
    expect(find(cfg, 'condition.numeric').params).toEqual({ field: 'value', op: '<', value: '15' });

    // 2. low voltage
    cfg = byName['Device Health — Low voltage'];
    expect(find(cfg, 'trigger.telemetry').params!.telemetryType).toBe('voltage');
    expect(find(cfg, 'condition.numeric').params).toEqual({ field: 'value', op: '<', value: '3.1' });

    // 3. high temperature
    cfg = byName['Device Health — High temperature'];
    expect(find(cfg, 'trigger.telemetry').params!.telemetryType).toBe('temperature');
    expect(find(cfg, 'condition.numeric').params).toEqual({ field: 'value', op: '>', value: '70' });

    // 4. high channel utilization
    cfg = byName['Device Health — High channel utilization'];
    expect(find(cfg, 'trigger.telemetry').params!.telemetryType).toBe('channelUtilization');
    expect(find(cfg, 'condition.numeric').params).toEqual({ field: 'value', op: '>', value: '50' });

    // 5. heartbeat lost
    cfg = byName['Device Health — Node silent'];
    expect(find(cfg, 'trigger.nodeStale').params).toEqual({ staleAfterMinutes: 30 });

    // 6. back online (shares the stale threshold)
    cfg = byName['Device Health — Back online'];
    expect(find(cfg, 'trigger.nodeOnline').params).toEqual({ staleAfterMinutes: 30 });

    // 7. reboot
    cfg = byName['Device Health — Reboot detected'];
    expect(find(cfg, 'trigger.nodeRebooted')).toBeDefined();

    // 8. power lost
    cfg = byName['Device Health — External power lost'];
    expect(find(cfg, 'trigger.nodePowerChanged').params).toEqual({ direction: 'lost' });

    // 9. high noise floor
    cfg = byName['Device Health — High noise floor'];
    expect(find(cfg, 'trigger.telemetry').params!.telemetryType).toBe('noiseFloor');
    expect(find(cfg, 'condition.numeric').params).toEqual({ field: 'value', op: '>', value: '-85' });

    // 10. battery declining
    cfg = byName['Device Health — Battery declining'];
    expect(find(cfg, 'trigger.batteryTrend').params).toEqual({ windowHours: 8, minDropPercent: 25 });

    // every automation carries a notify action and validates
    for (const b of built) {
      expect(b.config.nodes.some((n) => n.type === 'action.notify')).toBe(true);
      expect(b.name).toBeTruthy();
      expect(b.description).toBeTruthy();
      expect(validateAutomationGraph(b.config).valid, JSON.stringify(validateAutomationGraph(b.config).errors)).toBe(true);
    }
  });

  it('emits only the enabled alerts, not the floor, when at least one is on', () => {
    const built = buildMany({ rebootDetected: true });
    expect(built).toHaveLength(1);
    expect(built[0].name).toBe('Device Health — Reboot detected');
  });

  it('falls back to default thresholds when the enable box is on but the value is blank', () => {
    const { config } = buildMany({ lowBattery: true, lowBatteryThreshold: '' })[0];
    const numeric = config.nodes.find((n) => n.type === 'condition.numeric')!;
    expect(numeric.params).toEqual({ field: 'value', op: '<', value: '20' });
  });

  it('recurring telemetry alerts carry a per-node cooldown; event alerts do not', () => {
    const [lowBat] = buildMany({ lowBattery: true });
    expect(triggerNode(lowBat.config).params).toMatchObject({ cooldownSeconds: 3600, cooldownScope: 'node' });

    const [reboot] = buildMany({ rebootDetected: true });
    expect(triggerNode(reboot.config).params).not.toHaveProperty('cooldownSeconds');
  });

  // ── scoping conditions ──
  it('adds a sourceFilter first when sourceIds is set', () => {
    const { config } = buildMany({ lowBattery: true, sourceIds: ['source-a', 'source-b'] })[0];
    expect(chainTypes(config)).toEqual([
      'trigger.telemetry', 'condition.sourceFilter', 'condition.numeric', 'action.notify',
    ]);
    expect(node(config, 'c0').params).toEqual({ sourceIds: ['source-a', 'source-b'] });
  });

  it('adds a node.nodeId "in" filter (hex ids) when nodeNums is set', () => {
    const { config } = buildMany({ rebootDetected: true, nodeNums: [0x433d0c0c, 1] })[0];
    const strCond = config.nodes.find((n) => n.type === 'condition.string')!;
    expect(strCond.params).toEqual({ field: 'node.nodeId', op: 'in', value: '!433d0c0c,!00000001' });
  });

  it('omits scoping conditions when neither sources nor nodes are set', () => {
    const { config } = buildMany({ powerLost: true })[0];
    expect(config.nodes.some((n) => n.type === 'condition.sourceFilter')).toBe(false);
    expect(config.nodes.some((n) => n.type === 'condition.string')).toBe(false);
  });

  it('every produced config validates for a representative mix', () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { lowBattery: true },
      { lowBattery: true, lowVoltage: true, sourceIds: ['s1'], nodeNums: [123] },
      { heartbeatLost: true, backOnline: true, staleAfterMinutes: '45' },
      { batteryDeclining: true, trendWindowHours: '4', trendMinDropPercent: '10' },
    ];
    for (const values of cases) {
      for (const b of buildMany(values)) {
        const result = validateAutomationGraph(b.config);
        expect(result.valid, JSON.stringify(result.errors)).toBe(true);
      }
    }
  });
});
