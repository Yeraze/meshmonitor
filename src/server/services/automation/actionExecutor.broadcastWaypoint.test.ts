/**
 * action.broadcastWaypoint in the executor (#5482): param interpolation and
 * range checks, the TX-disabled skip, and templates fed by a preceding
 * action.runScript `resultVariable`. The 30-minute floor, stable id and
 * onlyWhenChanged live in the dep (waypointService.automation.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { executeAction, type ActionDeps } from './actionExecutor.js';
import type { EngineEvalContext } from './engineContext.js';
import type { AutomationNode } from '../../../types/automation.js';
import type { VariableResolver } from './variableResolver.js';
import { TxDisabledError } from '../../errors/txDisabledError.js';

type WaypointArgs = Parameters<ActionDeps['broadcastWaypoint']>[0];

function deps(opts: { txDisabled?: boolean; scriptResult?: unknown } = {}) {
  const calls: WaypointArgs[] = [];
  const d: ActionDeps = {
    sendMessage: async () => 1,
    sendTapback: async () => 1,
    manageNode: async () => 1,
    requestData: async () => 1,
    rebootDevice: async () => 1,
    notify: async () => 1,
    runScript: async () => ({ success: true, stdout: '', returnValue: opts.scriptResult }),
    broadcastWaypoint: async (a) => {
      if (opts.txDisabled) throw new TxDisabledError();
      calls.push(a);
      return { waypointId: 9, sent: true, packetId: 77 };
    },
  };
  return { calls, deps: d };
}

function ctx(fields: Record<string, unknown> = {}): EngineEvalContext {
  const store = new Map<string, unknown>();
  const vars = {
    getValue: async (name: string) => store.get(name) ?? null,
    setValue: async (name: string, value: unknown) => { store.set(name, value); return { ok: true }; },
  } as unknown as VariableResolver;
  return {
    trigger: { triggerType: 'trigger.schedule', sourceId: null, subjectNodeNum: null, timestamp: 0, fields },
    vars,
    data: { getNode: async () => null, getTelemetry: async () => null },
    varCtx: { sourceId: null, nodeNum: null },
    now: 1_800_000_000_000,
    automationId: 'auto-1',
  } as EngineEvalContext;
}

const node = (type: string, params: Record<string, unknown>): AutomationNode => ({ id: 'a', type: type as any, params });

const base = { sourceId: 'src-1', waypointKey: 'border-north', latitude: 32.54, longitude: '-117.03' };

describe('action.broadcastWaypoint (#5482)', () => {
  it('resolves params and keys the waypoint by automation + waypointKey', async () => {
    const { calls, deps: d } = deps();
    const r = await executeAction(
      node('action.broadcastWaypoint', {
        ...base, name: 'Wait', description: 'lanes', icon: '🚗', expireHours: 2, channel: 1, hopLimit: 2, onlyWhenChanged: true,
      }),
      ctx(),
      d,
    );
    expect(r).toEqual({ waypointId: 9, sent: true, packetId: 77 });
    expect(calls[0]).toEqual({
      sourceId: 'src-1',
      automationKey: 'auto-1:border-north',
      latitude: 32.54,
      longitude: -117.03,
      name: 'Wait',
      description: 'lanes',
      icon: '🚗',
      expireAt: 1_800_000_000 + 7200,
      channel: 1,
      hopLimit: 2,
      onlyWhenChanged: true,
    });
  });

  it('defaults: channel 0, inherit hop limit, no expiry, send every run, default icon', async () => {
    const { calls, deps: d } = deps();
    await executeAction(node('action.broadcastWaypoint', base), ctx(), d);
    expect(calls[0]).toMatchObject({ channel: 0, hopLimit: null, expireAt: null, onlyWhenChanged: false, icon: null, name: '' });
  });

  it('takes values from a preceding runScript resultVariable', async () => {
    const c = ctx();
    const { calls, deps: d } = deps({ scriptResult: { lat: 32.55, lon: -117.02, minutes: 45, hours: 1 } });
    await executeAction(node('action.runScript', { scriptPath: 'bwt.py', resultVariable: 'wait' }), c, d);
    await executeAction(
      node('action.broadcastWaypoint', {
        ...base,
        latitude: '{{ var.wait.lat }}',
        longitude: '{{ var.wait.lon }}',
        name: 'San Ysidro {{ var.wait.minutes }}m',
        expireHours: '{{ var.wait.hours }}',
      }),
      c,
      d,
    );
    expect(calls[0]).toMatchObject({ latitude: 32.55, longitude: -117.02, name: 'San Ysidro 45m', expireAt: 1_800_000_000 + 3600 });
  });

  it('records a TX-disabled source as a skip, not a failure', async () => {
    const { deps: d } = deps({ txDisabled: true });
    const r = await executeAction(node('action.broadcastWaypoint', base), ctx(), d);
    expect(r).toEqual({ skipped: true, reason: 'TX_DISABLED' });
  });

  it.each([
    [{ latitude: '{{ var.missing }}' }, /latitude/],
    [{ longitude: 200 }, /longitude/],
    [{ expireHours: -1 }, /expireHours/],
    [{ channel: 9 }, /channel/],
    [{ channel: 'two' }, /channel/],
    [{ waypointKey: '' }, /waypoint key/],
    [{ sourceId: '' }, /no source/],
  ])('fails the step on a bad value %j', async (change, msg) => {
    const { calls, deps: d } = deps();
    await expect(executeAction(node('action.broadcastWaypoint', { ...base, ...change }), ctx(), d)).rejects.toThrow(msg);
    expect(calls).toHaveLength(0);
  });

  it('will not let a mesh-controlled trigger field pick the waypoint key', async () => {
    const { deps: d } = deps();
    await expect(
      executeAction(node('action.broadcastWaypoint', { ...base, waypointKey: '{{ trigger.text }}' }), ctx({ text: 'spam-1' }), d),
    ).rejects.toThrow(/waypoint key/);
  });
});
