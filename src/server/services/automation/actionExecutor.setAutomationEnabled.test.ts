/**
 * action.setAutomationEnabled (#5445) — executor unit tests.
 *
 * The executor resolves params and routes to `deps.setAutomationEnabled`; the
 * DB write + engine reload live behind that dep (the engine supplies it), so a
 * small in-memory fake stands in for it here.
 */
import { describe, it, expect } from 'vitest';
import { executeAction, actionStepDetail, type ActionDeps, type SetAutomationEnabledResult } from './actionExecutor.js';
import type { EngineEvalContext } from './engineContext.js';
import type { TriggerContext } from './triggerContext.js';
import type { AutomationNode } from '../../../types/automation.js';
import type { VariableResolver } from './variableResolver.js';

/** Fake store of automations keyed by id → { name, enabled }. */
function fakeDeps(store: Record<string, { name: string; enabled: boolean }>) {
  const calls: Array<{ automationId: string; mode: string; enabled?: boolean }> = [];
  const unused = async () => { throw new Error('not used'); };
  const deps: ActionDeps = {
    sendMessage: unused, sendTapback: unused, manageNode: unused, requestData: unused,
    rebootDevice: unused, notify: unused,
    runScript: async () => ({ success: true, stdout: '' }),
    async setAutomationEnabled(a): Promise<SetAutomationEnabledResult | null> {
      calls.push(a);
      const row = store[a.automationId];
      if (!row) return null;
      const previous = row.enabled;
      row.enabled = a.mode === 'toggle' ? !previous : Boolean(a.enabled);
      return { automationId: a.automationId, name: row.name, previous, enabled: row.enabled };
    },
  };
  return { deps, calls };
}

function ctx(fields: Record<string, unknown> = {}, automationId?: string): EngineEvalContext {
  const trigger: TriggerContext = {
    triggerType: 'trigger.message', sourceId: 'default', subjectNodeNum: 111, timestamp: 1000, fields,
  };
  const varMap: Record<string, unknown> = { target: 'auto-b', on: 'false' };
  const vars = { getValue: async (name: string) => varMap[name] ?? null } as unknown as VariableResolver;
  return {
    trigger, vars, data: { getNode: async () => null, getTelemetry: async () => null },
    varCtx: { sourceId: 'default', nodeNum: 111 }, now: 1000, automationId,
  };
}

const node = (params: Record<string, unknown>): AutomationNode =>
  ({ id: 'a', type: 'action.setAutomationEnabled', params });

describe('executeAction — action.setAutomationEnabled (#5445)', () => {
  it('set enabled=true enables the target and reports the resolved params', async () => {
    const store = { 'auto-b': { name: 'Rule B', enabled: false } };
    const { deps, calls } = fakeDeps(store);
    const out = await executeAction(node({ automationId: 'auto-b', enabled: true }), ctx(), deps);
    expect(calls).toEqual([{ automationId: 'auto-b', mode: 'set', enabled: true }]);
    expect(store['auto-b'].enabled).toBe(true);
    expect(out).toEqual({ automationId: 'auto-b', name: 'Rule B', mode: 'set', enabled: true, previous: false });
  });

  it('set enabled="false" (string from the builder) disables the target', async () => {
    const store = { 'auto-b': { name: 'Rule B', enabled: true } };
    const { deps } = fakeDeps(store);
    const out = await executeAction(node({ automationId: 'auto-b', mode: 'set', enabled: 'false' }), ctx(), deps);
    expect(store['auto-b'].enabled).toBe(false);
    expect(out).toMatchObject({ enabled: false, previous: true, mode: 'set' });
  });

  it('toggle flips the current state and ignores enabled', async () => {
    const store = { 'auto-b': { name: 'Rule B', enabled: true } };
    const { deps, calls } = fakeDeps(store);
    await executeAction(node({ automationId: 'auto-b', mode: 'toggle', enabled: true }), ctx(), deps);
    expect(store['auto-b'].enabled).toBe(false);
    expect(calls[0]).toEqual({ automationId: 'auto-b', mode: 'toggle', enabled: undefined });
    await executeAction(node({ automationId: 'auto-b', mode: 'toggle' }), ctx(), deps);
    expect(store['auto-b'].enabled).toBe(true);
  });

  it('resolves a templated id and a templated enabled', async () => {
    const store = { 'auto-b': { name: 'Rule B', enabled: true } };
    const { deps, calls } = fakeDeps(store);
    await executeAction(node({ automationId: '{{ var.target }}', enabled: '{{ var.on }}' }), ctx(), deps);
    expect(calls[0]).toEqual({ automationId: 'auto-b', mode: 'set', enabled: false });
    expect(store['auto-b'].enabled).toBe(false);
  });

  it('resolves an id from a trigger field', async () => {
    const store = { 'auto-b': { name: 'Rule B', enabled: false } };
    const { deps } = fakeDeps(store);
    await executeAction(node({ automationId: '{{ trigger.text }}', enabled: true }), ctx({ text: ' auto-b ' }), deps);
    expect(store['auto-b'].enabled).toBe(true);
  });

  it('an unknown id fails the step with a clear error', async () => {
    const { deps } = fakeDeps({});
    await expect(executeAction(node({ automationId: 'nope', enabled: false }), ctx(), deps))
      .rejects.toThrow('no automation with id "nope"');
  });

  it('a template that resolves to blank fails rather than guessing', async () => {
    const { deps, calls } = fakeDeps({});
    await expect(executeAction(node({ automationId: '{{ var.missing }}', enabled: false }), ctx(), deps))
      .rejects.toThrow(/no automation id/);
    expect(calls).toHaveLength(0);
  });

  it('an enabled value that is not true/false fails before any write', async () => {
    const store = { 'auto-b': { name: 'Rule B', enabled: true } };
    const { deps, calls } = fakeDeps(store);
    await expect(executeAction(node({ automationId: 'auto-b', enabled: 'maybe' }), ctx(), deps))
      .rejects.toThrow(/must be true or false/);
    expect(calls).toHaveLength(0);
    expect(store['auto-b'].enabled).toBe(true);
  });

  it('fails cleanly when the deps do not provide the capability', async () => {
    const { deps } = fakeDeps({});
    delete deps.setAutomationEnabled;
    await expect(executeAction(node({ automationId: 'x', enabled: true }), ctx(), deps))
      .rejects.toThrow(/not available/);
  });

  it('self-disable sets the halt flag on the run context', async () => {
    const store = { self: { name: 'One shot', enabled: true } };
    const { deps } = fakeDeps(store);
    const c = ctx({}, 'self');
    await executeAction(node({ automationId: 'self', enabled: false }), c, deps);
    expect(c.halt?.reason).toMatch(/disabled itself/);
  });

  it('disabling a different automation does not halt the run', async () => {
    const store = { 'auto-b': { name: 'Rule B', enabled: true } };
    const { deps } = fakeDeps(store);
    const c = ctx({}, 'self');
    await executeAction(node({ automationId: 'auto-b', enabled: false }), c, deps);
    expect(c.halt).toBeUndefined();
  });

  it('actionStepDetail summarises only this action type', () => {
    const value = { automationId: 'auto-b', name: 'Rule B', mode: 'set', enabled: false, previous: true };
    expect(actionStepDetail(node({}), value)).toEqual(value);
    expect(actionStepDetail({ id: 'n', type: 'action.notify', params: {} }, { anything: 1 })).toBeUndefined();
  });
});
