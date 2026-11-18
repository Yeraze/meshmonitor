/**
 * The Automation Engine honors the per-source airtime cutoff: every action
 * that transmits on the mesh is held back while its source's Channel
 * Utilization is over the cutoff, the dep is never called, and the run log
 * says why. Actions that send nothing on the mesh are never gated, sources
 * without a utilization figure fail open, and a manual "Run now" bypasses the
 * cutoff but records that it did.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  executeAction,
  actionStepDetail,
  isAirtimeSkip,
  isAllAirtimeSkipped,
  type ActionDeps,
} from './actionExecutor.js';
import type { AirtimeGateVerdict, EngineEvalContext, NodeDataProvider } from './engineContext.js';
import type { AutomationNode } from '../../../types/automation.js';
import type { VariableResolver } from './variableResolver.js';

const GATED: AirtimeGateVerdict = { gated: true, channelUtilization: 42.5, threshold: 30, measuredFrom: 'local' };
const CLEAR: AirtimeGateVerdict = { gated: false, channelUtilization: 12, threshold: 30, measuredFrom: 'local' };

type GateFn = NodeDataProvider['getAirtimeGate'];

function ctx(opts: {
  gate?: GateFn;
  protocols?: Record<string, string>;
  over?: Partial<EngineEvalContext>;
  fields?: Record<string, unknown>;
} = {}): EngineEvalContext {
  const vars = { getValue: async () => null, setValue: async () => ({ ok: true }) } as unknown as VariableResolver;
  const protocols = opts.protocols ?? { mt: 'meshtastic', mt2: 'meshtastic', mc: 'meshcore', rn: 'reticulum' };
  const data: NodeDataProvider = {
    getNode: async () => null,
    getTelemetry: async () => null,
    getSourceProtocol: async (id) => (id ? protocols[id] ?? null : null),
    getChannels: async () => [{ id: 2, name: 'gauntlet', role: 2 }],
    ...(opts.gate ? { getAirtimeGate: opts.gate } : {}),
  };
  return {
    trigger: {
      triggerType: 'trigger.message',
      sourceId: 'mt',
      subjectNodeNum: 0x1234,
      timestamp: 0,
      fields: { channel: 0, packetId: 77, from: 0x1234, text: 'ping', ...(opts.fields ?? {}) },
    },
    vars,
    data,
    varCtx: { sourceId: 'mt', nodeNum: 0x1234 },
    now: 1_800_000_000_000,
    automationId: 'auto-1',
    ...(opts.over ?? {}),
  } as EngineEvalContext;
}

/** Every dep a vi.fn; each resolves `{ sent: true }`. */
function mkDeps() {
  const sent = async () => ({ sent: true });
  return {
    sendMessage: vi.fn(sent),
    sendTapback: vi.fn(sent),
    manageNode: vi.fn(sent),
    requestData: vi.fn(sent),
    runScheduledTrace: vi.fn(sent),
    rebootDevice: vi.fn(sent),
    notify: vi.fn(sent),
    runScript: vi.fn(async () => ({ success: true, stdout: 'ok' })),
    broadcastWaypoint: vi.fn(sent),
    setAutomationEnabled: vi.fn(async () => ({ automationId: 'x', name: 'x', previous: true, enabled: true })),
    setSourceForwardingEnabled: vi.fn(async () => ({ sourceId: 'mt', sourceName: 'mt', previous: true, enabled: true })),
    sleep: vi.fn(async () => {}),
  };
}

const node = (type: string, params: Record<string, unknown> = {}): AutomationNode =>
  ({ id: 'a', type, params } as AutomationNode);

const gatedOn = (...busy: string[]): GateFn => async (sid) => (busy.includes(sid) ? GATED : CLEAR);

describe('Automation Engine airtime cutoff — gated actions', () => {
  const cases: Array<[string, AutomationNode, keyof ReturnType<typeof mkDeps>]> = [
    ['sendMessage (channel)', node('action.sendMessage', { text: 'hello', sourceIds: ['mt'] }), 'sendMessage'],
    ['sendMessage (DM)', node('action.sendMessage', { text: 'hello', to: 99, sourceIds: ['mt'] }), 'sendMessage'],
    ['sendMessage (unified channel)', node('action.sendMessage', { text: 'hello', sourceIds: ['mt'], channels: [{ name: 'gauntlet', protocol: 'meshtastic' }] }), 'sendMessage'],
    ['tapback', node('action.tapback', { emoji: '👍', sourceIds: ['mt'] }), 'sendTapback'],
    ['requestData telemetry', node('action.requestData', { op: 'telemetry', sourceIds: ['mt'] }), 'requestData'],
    ['requestData traceroute', node('action.requestData', { op: 'traceroute', sourceIds: ['mt'] }), 'requestData'],
    ['requestData advert', node('action.requestData', { op: 'advert', sourceIds: ['mt'] }), 'requestData'],
    ['broadcastWaypoint', node('action.broadcastWaypoint', { sourceId: 'mt', waypointKey: 'home', latitude: 1, longitude: 2, name: 'Home' }), 'broadcastWaypoint'],
    ['remote deviceReboot', node('action.deviceReboot', { sourceIds: ['mt'], targetNodeNum: 4660 }), 'rebootDevice'],
  ];

  for (const [label, n, dep] of cases) {
    it(`${label}: skipped and the dep is never called`, async () => {
      const deps = mkDeps();
      const r = await executeAction(n, ctx({ gate: gatedOn('mt') }), deps as unknown as ActionDeps);
      expect(deps[dep]).not.toHaveBeenCalled();
      expect(isAllAirtimeSkipped(r)).toBe(true);
      const skip = (Array.isArray(r) ? r[0] : r) as Record<string, unknown>;
      expect(skip).toMatchObject({ skipped: true, airtimeCutoff: true, sourceId: 'mt', channelUtilization: 42.5, threshold: 30 });
      expect(String(skip.reason)).toMatch(/42\.5% is over the 30% cutoff/);
      // A live skip never carries the message text.
      expect(skip.text).toBeUndefined();
    });

    it(`${label}: sends when the source is under its cutoff`, async () => {
      const deps = mkDeps();
      await executeAction(n, ctx({ gate: gatedOn() }), deps as unknown as ActionDeps);
      expect(deps[dep]).toHaveBeenCalledTimes(1);
    });
  }

  it('tracePathSchedule: gated before the dep, so a skipped path keeps its due slot', async () => {
    const deps = mkDeps();
    const path = { publicKey: 'a'.repeat(64), intervalMinutes: 10 };
    const r = await executeAction(
      node('action.tracePathSchedule', { paths: [path], sourceIds: ['mc'] }),
      ctx({ gate: gatedOn('mc') }),
      deps as unknown as ActionDeps,
    );
    expect(deps.runScheduledTrace).not.toHaveBeenCalled();
    expect(isAllAirtimeSkipped(r)).toBe(true);
  });

  it('a MeshCore tapback is gated too (when its provider reports a verdict)', async () => {
    const deps = mkDeps();
    const c = ctx({
      gate: gatedOn('mc'),
      fields: { protocol: 'meshcore', meshcoreMessageId: 'm1' },
      over: { trigger: { triggerType: 'trigger.message', sourceId: 'mc', subjectNodeNum: null, timestamp: 0, fields: { protocol: 'meshcore', meshcoreMessageId: 'm1' } } },
    });
    const r = await executeAction(node('action.tapback', { emoji: '👍', sourceIds: ['mc'] }), c, deps as unknown as ActionDeps);
    expect(deps.sendTapback).not.toHaveBeenCalled();
    expect(isAirtimeSkip(r)).toBe(true);
  });
});

describe('Automation Engine airtime cutoff — actions that send nothing on the mesh', () => {
  const cases: Array<[string, AutomationNode, keyof ReturnType<typeof mkDeps>]> = [
    ['local deviceReboot', node('action.deviceReboot', { sourceIds: ['mt'] }), 'rebootDevice'],
    ['nodeManage', node('action.nodeManage', { op: 'favorite', nodeNum: 5 }), 'manageNode'],
    ['notify', node('action.notify', { body: 'hi' }), 'notify'],
    ['runScript', node('action.runScript', { scriptPath: 'x.sh' }), 'runScript'],
    ['setAutomationEnabled', node('action.setAutomationEnabled', { automationId: 'x', mode: 'set', enabled: true }), 'setAutomationEnabled'],
    ['setSourceForwardingEnabled', node('action.setSourceForwardingEnabled', { sourceId: 'mt', mode: 'set', enabled: true }), 'setSourceForwardingEnabled'],
    ['delay', node('action.delay', { seconds: 1 }), 'sleep'],
  ];
  for (const [label, n, dep] of cases) {
    it(`${label}: runs even while the source is over its cutoff`, async () => {
      const deps = mkDeps();
      const gate = vi.fn(gatedOn('mt'));
      const r = await executeAction(n, ctx({ gate }), deps as unknown as ActionDeps);
      expect(deps[dep]).toHaveBeenCalledTimes(1);
      expect(isAllAirtimeSkipped(r)).toBe(false);
      expect(gate).not.toHaveBeenCalled();
    });
  }
});

describe('Automation Engine airtime cutoff — per target and fail open', () => {
  it('multi-source: the busy source is skipped, the quiet one sends (partial)', async () => {
    const deps = mkDeps();
    const r = await executeAction(
      node('action.sendMessage', { text: 'hello', sourceIds: ['mt', 'mt2'] }),
      ctx({ gate: gatedOn('mt') }),
      deps as unknown as ActionDeps,
    ) as unknown[];
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage.mock.calls[0][0]).toMatchObject({ sourceId: 'mt2' });
    expect(isAirtimeSkip(r[0])).toBe(true);
    expect(isAllAirtimeSkipped(r)).toBe(false);
  });

  it.each([
    ['null verdict (MeshCore / Reticulum / MQTT)', (async () => null) as GateFn],
    ['a throwing provider', (async () => { throw new Error('boom'); }) as GateFn],
    ['no provider hook', undefined],
  ])('fails open on %s', async (_label, gate) => {
    const deps = mkDeps();
    await executeAction(node('action.sendMessage', { text: 'hello', sourceIds: ['mt'] }), ctx({ gate }), deps as unknown as ActionDeps);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('the empty-send rule wins over the gate (nothing to send, nothing to ask)', async () => {
    const deps = mkDeps();
    const gate = vi.fn(gatedOn('mt'));
    const r = await executeAction(node('action.sendMessage', { text: '   ', sourceIds: ['mt'] }), ctx({ gate }), deps as unknown as ActionDeps);
    expect(r).toMatchObject({ emptySend: true });
    expect(gate).not.toHaveBeenCalled();
  });

  it('protocol skips win over the gate (Reticulum with no destination)', async () => {
    const deps = mkDeps();
    const gate = vi.fn(gatedOn('rn'));
    const r = await executeAction(node('action.sendMessage', { text: 'hi', sourceIds: ['rn'] }), ctx({ gate }), deps as unknown as ActionDeps);
    expect(r).toMatchObject({ skipped: true });
    expect(isAirtimeSkip(r)).toBe(false);
    expect(gate).not.toHaveBeenCalled();
  });

  it('a missing target still fails the step before the gate is asked', async () => {
    const deps = mkDeps();
    const gate = vi.fn(gatedOn('mt'));
    const c = ctx({ gate, over: { trigger: { triggerType: 'trigger.schedule', sourceId: 'mt', subjectNodeNum: null, timestamp: 0, fields: {} } } });
    await expect(executeAction(node('action.requestData', { op: 'telemetry', sourceIds: ['mt'] }), c, deps as unknown as ActionDeps))
      .rejects.toThrow(/no target node/);
    expect(gate).not.toHaveBeenCalled();
  });

  it('a TX-disabled source under its cutoff still records TX_DISABLED', async () => {
    const deps = mkDeps();
    const { TxDisabledError } = await import('../../errors/txDisabledError.js');
    deps.sendMessage.mockImplementation(async () => { throw new TxDisabledError(); });
    const r = await executeAction(node('action.sendMessage', { text: 'hi', sourceIds: ['mt'] }), ctx({ gate: gatedOn() }), deps as unknown as ActionDeps);
    expect(r).toEqual({ skipped: true, reason: 'TX_DISABLED' });
  });
});

describe('Automation Engine airtime cutoff — manual run and dry run', () => {
  it('a manual Run now sends anyway and records the bypass on the context', async () => {
    const deps = mkDeps();
    const c = ctx({ gate: gatedOn('mt'), over: { manual: true } });
    await executeAction(node('action.sendMessage', { text: 'hello', sourceIds: ['mt'] }), c, deps as unknown as ActionDeps);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(c.airtimeBypassed).toEqual([{ sourceId: 'mt', channelUtilization: 42.5, threshold: 30 }]);
  });

  it('a dry run keeps the rendered text on the skip', async () => {
    const deps = mkDeps();
    const r = await executeAction(
      node('action.sendMessage', { text: 'hello {{ trigger.text }}', sourceIds: ['mt'] }),
      ctx({ gate: gatedOn('mt'), over: { dryRun: true } }),
      deps as unknown as ActionDeps,
    );
    expect(r).toMatchObject({ airtimeCutoff: true, text: 'hello ping' });
  });
});

describe('actionStepDetail for airtime skips', () => {
  const skip = (sid: string, text?: string) => ({
    skipped: true, airtimeCutoff: true, sourceId: sid, channelUtilization: 42.5, threshold: 30,
    reason: 'airtime cutoff: channel utilization 42.5% is over the 30% cutoff, so nothing was sent',
    ...(text ? { text } : {}),
  });
  const send = node('action.sendMessage');

  it('one skip: the figures and reason, never the text', () => {
    expect(actionStepDetail(send, skip('mt', 'secret'))).toEqual({
      skipped: true, airtimeCutoff: true, sourceId: 'mt', channelUtilization: 42.5, threshold: 30,
      reason: 'airtime cutoff: channel utilization 42.5% is over the 30% cutoff, so nothing was sent',
    });
  });

  it('every target skipped: one row listing the sources', () => {
    const d = actionStepDetail(send, [skip('mt', 'secret'), skip('mt2', 'secret')])!;
    expect(d).toMatchObject({ skipped: true, airtimeCutoff: true, sourceIds: ['mt', 'mt2'] });
    expect(JSON.stringify(d)).not.toContain('secret');
  });

  it('some targets sent: partial, with the held-back sources', () => {
    const d = actionStepDetail(send, [skip('mt'), { sent: true }])!;
    expect(d).toMatchObject({ partial: true, airtimeCutoff: true, airtimeSkipped: ['mt'] });
    expect(String(d.reason)).toMatch(/partly sent/);
    expect(d.skipped).toBeUndefined();
  });

  it('no airtime skip: unchanged (undefined for a plain send)', () => {
    expect(actionStepDetail(send, { sent: true })).toBeUndefined();
    expect(actionStepDetail(send, [{ skipped: true, reason: 'TX_DISABLED' }])).toBeUndefined();
  });
});
