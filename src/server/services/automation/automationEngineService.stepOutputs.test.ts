/**
 * Run-scoped step outputs through the live engine (#5636): each run has its
 * own store, the output never reaches run history or the live trace, an empty
 * send is logged as skipped, a refused variable write is logged as failed, and
 * a node-scoped variable saves on a MeshCore trigger.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { DbMessage } from '../../../services/database.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import type { AutomationGraph } from '../../../types/automation.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

const FAR_FUTURE = 9_000_000_000_000;
const SECRET = 'SCRIPT-OUTPUT-7f3a';

function message(over: Partial<DbMessage> = {}): DbMessage {
  const from = (over.fromNodeNum as number) ?? 111;
  return {
    id: `default_${from}_42`, fromNodeNum: from, toNodeNum: 4294967295,
    fromNodeId: `!${from.toString(16).padStart(8, '0')}`, toNodeId: '!ffffffff',
    text: 'joke', channel: 0, portnum: 1, timestamp: 1000, hopStart: 3, hopLimit: 3, createdAt: 1000,
    ...over,
  } as DbMessage;
}

/** script → (pause) → send the script's output. */
const jokeGraph = (text = '{{ steps.joke.output }}'): AutomationGraph => ({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: {} },
    { id: 'a0', type: 'action.runScript', params: { scriptPath: 'joke.py', outputName: 'joke' } },
    { id: 'a1', type: 'action.delay', params: { seconds: 1 } },
    { id: 'a2', type: 'action.sendMessage', params: { text } },
  ],
  edges: [{ from: 't', to: 'a0' }, { from: 'a0', to: 'a1' }, { from: 'a1', to: 'a2' }],
});

describe('AutomationEngineService — run-scoped step outputs (#5636)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let varsRepo: AutomationVariablesRepository;
  let resolver: VariableResolver;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    varsRepo = new AutomationVariablesRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(varsRepo);
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const data = { getNode: async () => null, getTelemetry: async () => null };

  /** Deps whose script echoes the triggering text; `sleep` is under test control. */
  function harness(over: Partial<ActionDeps> = {}) {
    const sent: any[] = [];
    const notified: any[] = [];
    const deps: ActionDeps = {
      sendMessage: async (a) => { sent.push(a); return 1; },
      sendTapback: async () => 2,
      manageNode: async () => 3,
      requestData: async () => 5,
      rebootDevice: async () => 6,
      notify: async (a) => { notified.push(a); return 4; },
      broadcastWaypoint: async () => 7,
      runScript: async (a) => ({ success: true, stdout: `out:${a.env.MESSAGE}` }),
      sleep: async () => {},
      ...over,
    };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => 1_000_000 });
    return { engine, sent, notified };
  }

  const createEnabled = (name: string, graph: AutomationGraph) =>
    autos.createAutomation({ name, enabled: true, config: JSON.stringify(graph) });

  it('a later step reads the script output of the same run', async () => {
    await createEnabled('joke', jokeGraph('{{ steps.joke.ok }}: {{ steps.joke.output }}'));
    const { engine, sent } = harness();
    await engine.load();
    await engine.onMessage(message({ text: 'tell me' }), 'default');
    expect(sent.map((s) => s.text)).toEqual(['true: out:tell me']);
  });

  it('a script step that a condition skipped stores nothing, so the reference renders empty', async () => {
    await createEnabled('gated', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'f', type: 'flow.fanout', params: {} },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 99 } },
        { id: 's', type: 'action.runScript', params: { scriptPath: 'joke.py', outputName: 'joke' } },
        { id: 'n', type: 'action.nothing', params: {} },
        { id: 'col', type: 'flow.collapse', params: { mode: 'ALWAYS' } },
        { id: 'm', type: 'action.sendMessage', params: { text: '[{{ steps.joke.output }}|{{ steps.joke.ok }}]' } },
      ],
      edges: [
        { from: 't', to: 'f' }, { from: 'f', to: 'c' }, { from: 'c', to: 's' }, { from: 'f', to: 'n' },
        { from: 's', to: 'col' }, { from: 'n', to: 'col' }, { from: 'col', to: 'm' },
      ],
    });
    let ran = 0;
    const { engine, sent } = harness({ runScript: async () => { ran++; return { success: true, stdout: 'x' }; } });
    await engine.load();
    await engine.onMessage(message(), 'default');
    expect(ran).toBe(0);
    expect(sent.map((x) => x.text)).toEqual(['[|]']);
  });

  it('two interleaved runs of the same automation never see each other\'s output', async () => {
    await createEnabled('joke', jokeGraph());
    // Hold every run at its Pause step until both scripts have finished, so
    // the two runs overlap for certain.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let waiting = 0;
    let bothWaiting!: () => void;
    const bothAtPause = new Promise<void>((r) => { bothWaiting = r; });
    const { engine, sent } = harness({
      sleep: async () => { if (++waiting === 2) bothWaiting(); await gate; },
    });
    await engine.load();

    const runA = engine.onMessage(message({ fromNodeNum: 111, text: 'AAA' }), 'default');
    const runB = engine.onMessage(message({ fromNodeNum: 222, text: 'BBB' }), 'default');
    await bothAtPause; // both scripts ran; both outputs are stored
    release();
    await Promise.all([runA, runB]);

    // Each reply carries its OWN run's output, addressed off its own trigger.
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.text).sort()).toEqual(['out:AAA', 'out:BBB']);
  });

  it('nothing is left over for the next run', async () => {
    // First event stores an output; the second run's script fails, so its
    // message must render empty rather than reuse the first run's output.
    let n = 0;
    await createEnabled('joke', jokeGraph());
    const { engine, sent } = harness({
      runScript: async () => (++n === 1 ? { success: true, stdout: 'first' } : { success: false, stdout: '', error: 'boom' }),
    });
    await engine.load();
    await engine.onMessage(message({ text: 'one' }), 'default');
    await engine.onMessage(message({ text: 'two' }), 'default');
    expect(sent.map((s) => s.text)).toEqual(['first']);
  });

  it('the output is in neither the run log nor the live trace', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('joke', jokeGraph());
    const { engine, sent } = harness({ runScript: async () => ({ success: true, stdout: SECRET, returnValue: { secret: SECRET } }) });
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onMessage(message({ text: 'tell me' }), 'default');
    expect(sent).toHaveLength(1); // the output did reach the message

    const runs = await autos.listRuns(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(JSON.stringify(runs[0])).not.toContain(SECRET);
    expect(JSON.parse(runs[0].log as string)).toEqual([
      { nodeId: 't', type: 'trigger.message', outcome: 'activated' },
      { nodeId: 'a0', type: 'action.runScript', outcome: 'action:ok' },
      { nodeId: 'a1', type: 'action.delay', outcome: 'action:ok' },
      { nodeId: 'a2', type: 'action.sendMessage', outcome: 'action:ok' },
    ]);

    const fired = got.filter((g) => g.outcome === 'fired');
    expect(fired).toHaveLength(1);
    expect(JSON.stringify(got)).not.toContain(SECRET);
    expect(fired[0].actions).toEqual([
      { nodeId: 'a0', ok: true }, { nodeId: 'a1', ok: true }, { nodeId: 'a2', ok: true },
    ]);
  });

  it('an over-size output is cut and the run log says so, without the output', async () => {
    const a = await createEnabled('joke', jokeGraph('got {{ steps.joke.ok }}'));
    const { engine } = harness({ runScript: async () => ({ success: true, stdout: SECRET + 'x'.repeat(70 * 1024) }) });
    await engine.load();
    await engine.onMessage(message(), 'default');
    const run = (await autos.listRuns(a.id))[0];
    expect(run.log as string).not.toContain(SECRET);
    expect(JSON.parse(run.log as string)[1]).toEqual({
      nodeId: 'a0', type: 'action.runScript', outcome: 'action:ok',
      detail: { reason: 'output "joke" was cut to 64 KiB for this run' },
    });
  });

  it('an empty message is not sent and the run log records the skip with its reason', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('joke', jokeGraph());
    const { engine, sent } = harness({ runScript: async () => ({ success: true, stdout: '  \n' }) });
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);
    await engine.onMessage(message(), 'default');

    expect(sent).toHaveLength(0);
    const run = (await autos.listRuns(a.id))[0];
    expect(run.status).toBe('completed');
    const skip = { skipped: true, reason: 'the message text rendered empty, so nothing was sent' };
    expect(JSON.parse(run.log as string)[3]).toEqual({ nodeId: 'a2', type: 'action.sendMessage', outcome: 'action:ok', detail: skip });
    expect(got.find((g) => g.outcome === 'fired').steps[3].detail).toEqual(skip);
  });

  it('a refused variable write fails the step in the run log, and later steps still run', async () => {
    const a = await createEnabled('store', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a0', type: 'action.runScript', params: { scriptPath: 's.py', resultVariable: 'no_such_var' } },
        { id: 'a1', type: 'action.sendMessage', params: { text: 'still here' } },
      ],
      edges: [{ from: 't', to: 'a0' }, { from: 'a0', to: 'a1' }],
    });
    const { engine, sent } = harness();
    await engine.load();
    await engine.onMessage(message(), 'default');

    const run = (await autos.listRuns(a.id))[0];
    expect(run.status).toBe('failed');
    expect(JSON.parse(run.log as string)[1]).toEqual({
      nodeId: 'a0', type: 'action.runScript', outcome: 'action:error',
      error: 'script "s.py" ran, but its result was not stored in variable "no_such_var": unknown variable "no_such_var"',
    });
    expect(sent.map((s) => s.text)).toEqual(['still here']);
  });

  it.each([
    ['a read-only variable', { name: 'v', type: 'string' as const, scope: 'global' as const, readonly: true }, /variable "v" is readonly/],
    ['a wrong-type variable', { name: 'v', type: 'integer' as const, scope: 'global' as const }, /value not representable as integer/],
  ])('reports a write refused by %s', async (_label, def, error) => {
    await varsRepo.createVariable(def);
    const a = await createEnabled('store', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a0', type: 'action.runScript', params: { scriptPath: 's.py', resultVariable: 'v' } },
      ],
      edges: [{ from: 't', to: 'a0' }],
    });
    const { engine } = harness({ runScript: async () => ({ success: true, stdout: 'not a number' }) });
    await engine.load();
    await engine.onMessage(message(), 'default');
    const run = (await autos.listRuns(a.id))[0];
    expect(run.status).toBe('failed');
    expect(JSON.parse(run.log as string)[1].error).toMatch(error);
  });

  describe('node-scoped variables on MeshCore triggers', () => {
    const KEY_A = 'a1'.repeat(32);
    const KEY_B = 'b2'.repeat(32);
    const mcDm = (fromPublicKey: string, text: string): MeshCoreMessage =>
      ({ id: `mc-${text}`, fromPublicKey, toPublicKey: 'ee'.repeat(32), text, timestamp: 1000 } as MeshCoreMessage);

    /** Reply with what the sender last said, then remember what they said now. */
    const lastSaid = (scriptVar = 'last'): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a0', type: 'action.sendMessage', params: { text: 'last: {{ var.last }}', to: '{{ trigger.from }}' } },
        { id: 'a1', type: 'action.runScript', params: { scriptPath: 'echo.py', resultVariable: scriptVar } },
      ],
      edges: [{ from: 't', to: 'a0' }, { from: 'a0', to: 'a1' }],
    });

    it('saves per MeshCore sender and reads it back on that sender\'s next message', async () => {
      const def = await varsRepo.createVariable({ name: 'last', type: 'string', scope: 'node' });
      const a = await createEnabled('last', lastSaid());
      const mcData = { ...data, getSourceProtocol: async () => 'meshcore' };
      const sent: any[] = [];
      const engine = new AutomationEngineService({
        automationsRepo: autos, varResolver: resolver, data: mcData, now: () => 1_000_000,
        deps: {
          sendMessage: async (x) => { sent.push(x); return 1; },
          sendTapback: async () => 2, manageNode: async () => 3, notify: async () => 4,
          runScript: async (x) => ({ success: true, stdout: String(x.env.MESSAGE) }),
        } as ActionDeps,
      });
      await engine.load();

      await engine.onMeshCoreMessage(mcDm(KEY_A, 'alpha-1'), 'mc1');
      await engine.onMeshCoreMessage(mcDm(KEY_B, 'bravo-1'), 'mc1');
      await engine.onMeshCoreMessage(mcDm(KEY_A, 'alpha-2'), 'mc1');
      await engine.onMeshCoreMessage(mcDm(KEY_B, 'bravo-2'), 'mc1');

      // Every run completed: the write no longer fails for want of a node number.
      expect((await autos.listRuns(a.id)).map((r) => r.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
      // Each sender reads back only what THEY said.
      expect(sent.map((s) => `${String(s.destination).slice(0, 2)}|${s.text}`)).toEqual([
        'a1|last: ', 'b2|last: ', 'a1|last: alpha-1', 'b2|last: bravo-1',
      ]);
      expect(await varsRepo.getEffectiveValue(def.id, `mc:${KEY_A}`)).toBe('alpha-2');
      expect(await varsRepo.getEffectiveValue(def.id, `mc:${KEY_B}`)).toBe('bravo-2');
    });

    it('a MeshCore channel post has no sender key, so the write is refused — and now reported', async () => {
      await varsRepo.createVariable({ name: 'last', type: 'string', scope: 'node' });
      const a = await createEnabled('last', lastSaid());
      const { engine } = harness({ runScript: async () => ({ success: true, stdout: 'x' }) });
      await engine.load();
      await engine.onMeshCoreMessage({ id: 'c', fromPublicKey: 'channel-0', text: 'hi', timestamp: 1000 } as MeshCoreMessage, 'mc1');
      const run = (await autos.listRuns(a.id))[0];
      expect(run.status).toBe('failed');
      expect(run.log as string).toContain('missing scope context for \\"last\\" (node)');
    });

    it('Meshtastic senders keep their numeric key', async () => {
      const def = await varsRepo.createVariable({ name: 'last', type: 'string', scope: 'node' });
      await createEnabled('last', lastSaid());
      const { engine } = harness({ runScript: async (x) => ({ success: true, stdout: String(x.env.MESSAGE) }) });
      await engine.load();
      await engine.onMessage(message({ fromNodeNum: 111, text: 'from-mt' }), 'default');
      expect(await varsRepo.getEffectiveValue(def.id, '111')).toBe('from-mt');
    });
  });
});
