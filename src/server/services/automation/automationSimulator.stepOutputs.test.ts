/**
 * Dry run with run-scoped step outputs (#5636): a sample output stands in for
 * the script, later steps render it, and nothing is run, sent or saved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { simulateAutomation } from './automationSimulator.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import type { AutomationGraph } from '../../../types/automation.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import * as scriptRunner from '../../utils/scriptRunner.js';

const graph = (text: string, scriptParams: Record<string, unknown> = { outputName: 'joke' }): AutomationGraph => ({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: {} },
    { id: 'a0', type: 'action.runScript', params: { scriptPath: 'joke.py', ...scriptParams } },
    { id: 'a1', type: 'action.sendMessage', params: { text } },
  ],
  edges: [{ from: 't', to: 'a0' }, { from: 'a0', to: 'a1' }],
});
const event = { kind: 'message' as const, text: 'joke', from: 111 };

describe('simulateAutomation — sample step output (#5636)', () => {
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let varsRepo: AutomationVariablesRepository;

  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    varsRepo = new AutomationVariablesRepository(t.db, 'sqlite');
  });
  afterEach(() => { sqlite.close(); vi.restoreAllMocks(); });

  it('renders a text sample into the later message', async () => {
    const r = await simulateAutomation({ graph: graph('> {{ steps.joke.output }}'), varsRepo, event, stepOutputs: { joke: 'A mesh walks into a bar.\n' } });
    expect(r.status).toBe('completed');
    expect(r.actions[1]).toMatchObject({ type: 'action.sendMessage', ok: true, resolvedParams: { action: 'sendMessage', text: '> A mesh walks into a bar.' } });
  });

  it('parses a JSON sample the way real stdout is parsed, so paths resolve', async () => {
    const r = await simulateAutomation({
      graph: graph('{{ steps.joke.output.setup }} / {{ steps.joke.output.n }} / {{ steps.joke.ok }}'),
      varsRepo, event, stepOutputs: { joke: '{"setup":"knock knock","n":2}' },
    });
    expect((r.actions[1].resolvedParams as any).text).toBe('knock knock / 2 / true');
  });

  it('with no sample the script prints nothing, and the empty message is shown as not sent', async () => {
    const r = await simulateAutomation({ graph: graph('{{ steps.joke.output }}'), varsRepo, event });
    expect(r.status).toBe('completed');
    expect(r.actions[1].resolvedParams).toEqual({ skipped: true, emptySend: true, reason: 'the message text rendered empty, so nothing was sent' });
    expect(r.steps[2]).toMatchObject({ outcome: 'action:ok', detail: { skipped: true, reason: 'the message text rendered empty, so nothing was sent' } });
  });

  it('ignores a sample for a name no step stores', async () => {
    const r = await simulateAutomation({ graph: graph('[{{ steps.other.output }}]'), varsRepo, event, stepOutputs: { other: 'x' } });
    expect((r.actions[1].resolvedParams as any).text).toBe('[]');
  });

  it('never runs a script, and writes nothing', async () => {
    const spy = vi.spyOn(scriptRunner, 'runScript');
    await varsRepo.createVariable({ name: 'saved', type: 'json', scope: 'global' });
    const def = await varsRepo.getVariableByName('saved');
    const r = await simulateAutomation({
      graph: graph('{{ steps.joke.output }}', { outputName: 'joke', resultVariable: 'saved' }),
      varsRepo, event, stepOutputs: { joke: '{"a":1}' },
    });
    expect(spy).not.toHaveBeenCalled();
    expect(r.variableWrites).toEqual([{ name: 'saved', op: 'set', value: { a: 1 } }]);
    expect(await varsRepo.getRawValue(def!.id, '')).toBeNull(); // recorded, not persisted
  });

  it('two dry runs do not share outputs', async () => {
    const [a, b] = await Promise.all([
      simulateAutomation({ graph: graph('{{ steps.joke.output }}'), varsRepo, event, stepOutputs: { joke: 'AAA' } }),
      simulateAutomation({ graph: graph('{{ steps.joke.output }}'), varsRepo, event, stepOutputs: { joke: 'BBB' } }),
    ]);
    expect((a.actions[1].resolvedParams as any).text).toBe('AAA');
    expect((b.actions[1].resolvedParams as any).text).toBe('BBB');
  });

  describe('a variable write a real run would refuse is shown as failed', () => {
    it('unknown variable', async () => {
      const r = await simulateAutomation({ graph: graph('after', { resultVariable: 'gone' }), varsRepo, event });
      expect(r.status).toBe('failed');
      expect(r.actions[0]).toMatchObject({ ok: false, error: 'script "joke.py" ran, but its result was not stored in variable "gone": unknown variable "gone"' });
      expect(r.steps[1]).toMatchObject({ outcome: 'action:error' });
      expect(r.variableWrites).toEqual([]);
      expect(r.actions[1]).toMatchObject({ ok: true }); // the run goes on
    });

    it('read-only variable', async () => {
      await varsRepo.createVariable({ name: 'ro', type: 'string', scope: 'global', readonly: true });
      const r = await simulateAutomation({ graph: graph('after', { resultVariable: 'ro' }), varsRepo, event });
      expect(r.actions[0].error).toMatch(/variable "ro" is readonly/);
    });

    it('wrong-type variable', async () => {
      await varsRepo.createVariable({ name: 'num', type: 'integer', scope: 'global' });
      const r = await simulateAutomation({
        graph: graph('after', { resultVariable: 'num', outputName: 'joke' }), varsRepo, event, stepOutputs: { joke: 'not a number' },
      });
      expect(r.actions[0].error).toMatch(/value not representable as integer/);
    });

    it('an acceptable write is still recorded', async () => {
      await varsRepo.createVariable({ name: 'num', type: 'integer', scope: 'global' });
      const r = await simulateAutomation({
        graph: graph('after', { resultVariable: 'num', outputName: 'joke' }), varsRepo, event, stepOutputs: { joke: '42' },
      });
      expect(r.status).toBe('completed');
      expect(r.variableWrites).toEqual([{ name: 'num', op: 'set', value: 42 }]);
    });

    it('flow.setVar to an unknown variable is a variable error, as in a real run', async () => {
      const g: AutomationGraph = {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: {} },
          { id: 's', type: 'flow.setVar', params: { variable: 'gone', op: 'set', value: 'x' } },
        ],
        edges: [{ from: 't', to: 's' }],
      };
      const r = await simulateAutomation({ graph: g, varsRepo, event });
      expect(r.steps[1]).toMatchObject({ outcome: 'setVar:error', error: 'unknown variable "gone"' });
      expect(r.variableWrites).toEqual([]);
    });
  });
});
