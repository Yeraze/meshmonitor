/**
 * action.setSourceForwardingEnabled (#5537) — executor unit tests. The
 * executor resolves params and routes to `deps.setSourceForwardingEnabled`; a
 * small in-memory fake stands in for the settings write.
 */
import { describe, it, expect } from 'vitest';
import {
  executeAction,
  actionStepDetail,
  type ActionDeps,
  type SetSourceForwardingEnabledResult,
} from './actionExecutor.js';
import type { EngineEvalContext } from './engineContext.js';
import type { TriggerContext } from './triggerContext.js';
import type { AutomationNode } from '../../../types/automation.js';
import type { VariableResolver } from './variableResolver.js';

function fakeDeps(store: Record<string, { name: string; enabled: boolean }>) {
  const calls: Array<{ sourceId: string; mode: string; enabled?: boolean }> = [];
  const sends: string[] = [];
  const recordSend = (name: string) => async () => { sends.push(name); return null; };
  const deps: ActionDeps = {
    sendMessage: recordSend('sendMessage'), sendTapback: recordSend('sendTapback'),
    manageNode: recordSend('manageNode'), requestData: recordSend('requestData'),
    rebootDevice: recordSend('rebootDevice'), notify: recordSend('notify'),
    broadcastWaypoint: recordSend('broadcastWaypoint'),
    runScript: async () => ({ success: true, stdout: '' }),
    async setSourceForwardingEnabled(a): Promise<SetSourceForwardingEnabledResult | null> {
      calls.push(a);
      const row = store[a.sourceId];
      if (!row) return null;
      const previous = row.enabled;
      row.enabled = a.mode === 'toggle' ? !previous : Boolean(a.enabled);
      return { sourceId: a.sourceId, sourceName: row.name, previous, enabled: row.enabled };
    },
  };
  return { deps, calls, sends };
}

function ctx(): EngineEvalContext {
  const trigger: TriggerContext = {
    triggerType: 'trigger.schedule', sourceId: null as unknown as string, subjectNodeNum: 0, timestamp: 1000, fields: {},
  };
  const varMap: Record<string, unknown> = { on: 'true' };
  const vars = { getValue: async (name: string) => varMap[name] ?? null } as unknown as VariableResolver;
  return {
    trigger, vars, data: { getNode: async () => null, getTelemetry: async () => null },
    varCtx: { sourceId: 'default', nodeNum: 0 }, now: 1000,
  };
}

const node = (params: Record<string, unknown>): AutomationNode =>
  ({ id: 'f', type: 'action.setSourceForwardingEnabled', params });

describe('executeAction — action.setSourceForwardingEnabled (#5537)', () => {
  it('set enabled="false" turns the source off and sends nothing', async () => {
    const store = { 'src-a': { name: 'MC Base', enabled: true } };
    const { deps, calls, sends } = fakeDeps(store);
    const out = await executeAction(node({ sourceId: 'src-a', mode: 'set', enabled: 'false' }), ctx(), deps);
    expect(calls).toEqual([{ sourceId: 'src-a', mode: 'set', enabled: false }]);
    expect(store['src-a'].enabled).toBe(false);
    expect(out).toEqual({ sourceId: 'src-a', sourceName: 'MC Base', mode: 'set', enabled: false, previous: true });
    expect(sends).toEqual([]);
  });

  it('set enabled=true turns it back on', async () => {
    const store = { 'src-a': { name: 'MC Base', enabled: false } };
    const { deps } = fakeDeps(store);
    await executeAction(node({ sourceId: 'src-a', enabled: true }), ctx(), deps);
    expect(store['src-a'].enabled).toBe(true);
  });

  it('a templated enabled resolves at run time', async () => {
    const store = { 'src-a': { name: 'MC Base', enabled: false } };
    const { deps } = fakeDeps(store);
    await executeAction(node({ sourceId: 'src-a', enabled: '{{ var.on }}' }), ctx(), deps);
    expect(store['src-a'].enabled).toBe(true);
  });

  it('toggle flips the current state and ignores enabled', async () => {
    const store = { 'src-a': { name: 'MC Base', enabled: true } };
    const { deps, calls } = fakeDeps(store);
    await executeAction(node({ sourceId: 'src-a', mode: 'toggle', enabled: 'nonsense' }), ctx(), deps);
    expect(calls[0]).toEqual({ sourceId: 'src-a', mode: 'toggle', enabled: undefined });
    expect(store['src-a'].enabled).toBe(false);
    await executeAction(node({ sourceId: 'src-a', mode: 'toggle' }), ctx(), deps);
    expect(store['src-a'].enabled).toBe(true);
  });

  it('fails the step for an unknown source, a blank source, or an unparseable enabled', async () => {
    const { deps } = fakeDeps({});
    await expect(executeAction(node({ sourceId: 'nope', enabled: true }), ctx(), deps)).rejects.toThrow(/no source with id "nope"/);
    await expect(executeAction(node({ sourceId: ' ', enabled: true }), ctx(), deps)).rejects.toThrow(/no source/);
    await expect(executeAction(node({ sourceId: 'nope', enabled: 'maybe' }), ctx(), deps)).rejects.toThrow(/must be true or false/);
  });

  it('fails cleanly when the deps lack the action', async () => {
    const { deps } = fakeDeps({});
    delete deps.setSourceForwardingEnabled;
    await expect(executeAction(node({ sourceId: 'src-a', enabled: true }), ctx(), deps)).rejects.toThrow(/not available here/);
  });

  it('records the target and new state in the run-log step detail', () => {
    expect(actionStepDetail(node({}), { sourceId: 'src-a', sourceName: 'MC Base', mode: 'set', enabled: false, previous: true }))
      .toEqual({ sourceId: 'src-a', sourceName: 'MC Base', mode: 'set', enabled: false, previous: true });
  });
});
