/**
 * trigger.telemetry — the trigger was dead from the day it shipped: nothing
 * called dataEventEmitter.emitTelemetry, so `telemetry:batch` never reached the
 * engine. These tests pin the revived path and its safety rails:
 *
 *  - an emitted reading reaches the engine through the real emitter batch and
 *    the real event router, and fires;
 *  - the cooldown floor: at most once per node per hour, whatever the saved
 *    cooldown says;
 *  - the loop guard: a reading that answers our own telemetry request never fires;
 *  - LocalStats (noiseFloor) from our own node fire; our other telemetry is
 *    still dropped by the #3914 self-origin guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import { routeEventToEngine } from './automationEngineSingleton.js';
import type { ActionDeps } from './actionExecutor.js';
import type { NodeDataProvider } from './engineContext.js';
import {
  effectiveTelemetryCooldown,
  TELEMETRY_TRIGGER_MIN_COOLDOWN_SECONDS,
  type AutomationGraph,
} from '../../../types/automation.js';
import { dataEventEmitter, type DataEvent } from '../dataEventEmitter.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

const LOCAL = 0x11111111;
const REMOTE = 0x22222222;
const OTHER = 0x33333333;
const HOUR_MS = 3600 * 1000;

function recorder() {
  const calls: Array<{ fn: string; args: any }> = [];
  const deps: ActionDeps = {
    sendMessage: async (a) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
    sendTapback: async (a) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
    manageNode: async (a) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
    notify: async (a) => { calls.push({ fn: 'notify', args: a }); return 4; },
    requestData: async (a) => { calls.push({ fn: 'requestData', args: a }); return 5; },
    rebootDevice: async (a) => { calls.push({ fn: 'rebootDevice', args: a }); return 6; },
    runScript: async (a) => { calls.push({ fn: 'runScript', args: a }); return { success: true, stdout: '' }; },
  };
  return { calls, deps };
}

function telemetryGraph(params: Record<string, unknown> = {}): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.telemetry', params },
      { id: 'n', type: 'action.notify', params: { title: 't', body: '{{ trigger.nodeNum }} {{ trigger.telemetryType }}={{ trigger.value }}' } },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

describe('effectiveTelemetryCooldown', () => {
  it('raises an unset / zero / short cooldown to one hour per node', () => {
    expect(effectiveTelemetryCooldown(0, 'automation')).toEqual({ cooldownSeconds: 3600, cooldownScope: 'node' });
    expect(effectiveTelemetryCooldown(NaN, 'automation')).toEqual({ cooldownSeconds: 3600, cooldownScope: 'node' });
    expect(effectiveTelemetryCooldown(60, 'node')).toEqual({ cooldownSeconds: 3600, cooldownScope: 'node' });
    expect(TELEMETRY_TRIGGER_MIN_COOLDOWN_SECONDS).toBe(3600);
  });

  it('keeps a longer cooldown', () => {
    expect(effectiveTelemetryCooldown(7200, 'node')).toEqual({ cooldownSeconds: 7200, cooldownScope: 'node' });
  });

  it('turns per-source-per-node into per-node, so one node on two sources fires once', () => {
    expect(effectiveTelemetryCooldown(7200, 'sourceNode').cooldownScope).toBe('node');
    expect(effectiveTelemetryCooldown(0, 'sourceNode').cooldownScope).toBe('node');
  });

  it('keeps a user-chosen whole-automation window (stricter than per node)', () => {
    expect(effectiveTelemetryCooldown(600, 'automation')).toEqual({ cooldownSeconds: 3600, cooldownScope: 'automation' });
  });
});

describe('trigger.telemetry in the engine', () => {
  let close: () => void;
  let autos: AutomationsRepository;
  let resolver: VariableResolver;
  let clock: number;

  beforeEach(() => {
    const t = createTestDb();
    close = () => t.sqlite.close();
    autos = new AutomationsRepository(t.db, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(t.db, 'sqlite'));
    clock = 1_000_000;
  });
  afterEach(() => { close(); automationTraceBus.reset(); automationTraceBus.setSink(null); vi.useRealTimers(); });

  const data: NodeDataProvider = {
    getNode: async () => null,
    getTelemetry: async () => null,
    getLocalNodeNum: async () => LOCAL,
  };
  const engineWith = (deps: ActionDeps) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => clock });
  const createEnabled = (graph: AutomationGraph) =>
    autos.createAutomation({ name: 'tel', enabled: true, config: JSON.stringify(graph) });

  it('fires on a reading emitted by ingest (emitter batch → router → engine)', async () => {
    vi.useFakeTimers();
    const { calls, deps } = recorder();
    await createEnabled(telemetryGraph({ telemetryType: 'batteryLevel' }));
    const engine = engineWith(deps);
    await engine.load();

    const events: DataEvent[] = [];
    const listener = (e: DataEvent) => { if (e.type === 'telemetry:batch') events.push(e); };
    dataEventEmitter.on('data', listener);
    try {
      dataEventEmitter.emitTelemetry(
        REMOTE,
        { nodeId: '!22222222', nodeNum: REMOTE, telemetryType: 'batteryLevel', timestamp: 1, value: 12, unit: '%', createdAt: 1 },
        'src-a',
        { answersOwnRequest: false },
      );
      await vi.advanceTimersByTimeAsync(1_100);
    } finally {
      dataEventEmitter.off('data', listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0].sourceId).toBe('src-a');

    await routeEventToEngine(engine, events[0]);
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
    expect(calls[0].args.body).toBe(`${REMOTE} batteryLevel=12`);
  });

  it('fires at most once per node per hour when no cooldown is saved', async () => {
    const { calls, deps } = recorder();
    await createEnabled(telemetryGraph());
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onTelemetry(REMOTE, 'batteryLevel', 50, '%', 'src-a')).toBe(1);
    // Same node, other metric, other source, minutes later: all inside the floor.
    expect(await engine.onTelemetry(REMOTE, 'voltage', 3.9, 'V', 'src-a')).toBe(0);
    clock += 30 * 60 * 1000;
    expect(await engine.onTelemetry(REMOTE, 'batteryLevel', 49, '%', 'src-b')).toBe(0);
    // A different node has its own window.
    expect(await engine.onTelemetry(OTHER, 'batteryLevel', 80, '%', 'src-a')).toBe(1);
    // An hour after the first fire, the node may fire again.
    clock += 30 * 60 * 1000;
    expect(await engine.onTelemetry(REMOTE, 'batteryLevel', 48, '%', 'src-a')).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('raises a short saved cooldown to the floor', async () => {
    const { deps } = recorder();
    await createEnabled(telemetryGraph({ cooldownSeconds: 60, cooldownScope: 'node' }));
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onTelemetry(REMOTE, 'batteryLevel', 50, '%', 'src-a')).toBe(1);
    clock += 61 * 1000;
    expect(await engine.onTelemetry(REMOTE, 'batteryLevel', 50, '%', 'src-a')).toBe(0);
    clock += HOUR_MS;
    expect(await engine.onTelemetry(REMOTE, 'batteryLevel', 50, '%', 'src-a')).toBe(1);
  });

  it('never fires on a reading that answers our own telemetry request (loop guard)', async () => {
    const { calls, deps } = recorder();
    // The loop shape: telemetry → request telemetry back from that node.
    await createEnabled({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.telemetry', params: {} },
        { id: 'r', type: 'action.requestData', params: { op: 'telemetry' } },
      ],
      edges: [{ from: 't', to: 'r' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onTelemetry(REMOTE, 'batteryLevel', 50, '%', 'src-a', { answersOwnRequest: true })).toBe(0);
    expect(calls).toHaveLength(0);
    // An unsolicited reading still fires (once) and requests data.
    expect(await engine.onTelemetry(REMOTE, 'batteryLevel', 50, '%', 'src-a')).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['requestData']);
  });

  it('fires on our own LocalStats noise floor (exempt from the self-origin guard)', async () => {
    const { calls, deps } = recorder();
    await createEnabled(telemetryGraph({ telemetryType: 'noiseFloor' }));
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onTelemetry(LOCAL, 'noiseFloor', -90, 'dBm', 'src-a', { localStats: true })).toBe(1);
    expect(calls[0].args.body).toBe(`${LOCAL} noiseFloor=-90`);
  });

  it('still drops our own non-LocalStats telemetry (#3914)', async () => {
    const { calls, deps } = recorder();
    await createEnabled(telemetryGraph());
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onTelemetry(LOCAL, 'batteryLevel', 10, '%', 'src-a')).toBe(0);
    expect(await engine.onTelemetry(LOCAL, 'batteryLevel', 10, '%', 'src-a', { answersOwnRequest: false, localStats: false })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('LocalStats exemption does not override the loop guard', async () => {
    const { deps } = recorder();
    await createEnabled(telemetryGraph());
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onTelemetry(LOCAL, 'noiseFloor', -90, 'dBm', 'src-a', { localStats: true, answersOwnRequest: true })).toBe(0);
  });

  it('router passes the loop-guard and LocalStats flags through', async () => {
    const onTelemetry = vi.fn().mockResolvedValue(0);
    const engine = { onTelemetry } as unknown as AutomationEngineService;
    await routeEventToEngine(engine, {
      type: 'telemetry:batch',
      sourceId: 'src-a',
      timestamp: 1,
      data: {
        [REMOTE]: [{ nodeId: '!22222222', nodeNum: REMOTE, telemetryType: 'batteryLevel', timestamp: 1, value: 5, unit: '%', createdAt: 1, answersOwnRequest: true }],
        [LOCAL]: [{ nodeId: '!11111111', nodeNum: LOCAL, telemetryType: 'noiseFloor', timestamp: 1, value: -90, unit: 'dBm', createdAt: 1, localStats: true }],
      },
    } as unknown as DataEvent);
    expect(onTelemetry).toHaveBeenCalledWith(REMOTE, 'batteryLevel', 5, '%', 'src-a', { answersOwnRequest: true, localStats: false });
    expect(onTelemetry).toHaveBeenCalledWith(LOCAL, 'noiseFloor', -90, 'dBm', 'src-a', { answersOwnRequest: false, localStats: true });
  });
});
