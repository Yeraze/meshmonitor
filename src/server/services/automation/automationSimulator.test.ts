import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { simulateAutomation } from './automationSimulator.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import type { AutomationGraph } from '../../../types/automation.js';

describe('simulateAutomation', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let varsRepo: AutomationVariablesRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    varsRepo = new AutomationVariablesRepository(t.db, 'sqlite');
  });
  afterEach(() => db.close());

  it('message → numeric condition (true) → tapback: resolved params, no IO', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: '0' } },
        { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'true' }],
    };
    const r = await simulateAutomation({
      graph, varsRepo,
      event: { kind: 'message', text: 'ping me', from: 111, hopStart: 3, hopLimit: 3, packetId: 42 },
    });
    expect(r.matched).toBe(true);
    expect(r.status).toBe('completed');
    expect(r.conditionResults['c']).toBe(true);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].type).toBe('action.tapback');
    expect((r.actions[0].resolvedParams as any).emoji).toBe('👍');
    expect((r.actions[0].resolvedParams as any).replyId).toBe(42); // reply to triggering packet
  });

  // #4340 Phase 2: the simulator has no lastFired map and never gates on
  // cooldownScope — a dry-run must always show the operator what WOULD happen,
  // regardless of the rule's real-world cooldown state. Pinned so nobody adds
  // cooldown modelling to the tester later without a deliberate decision.
  it('cooldownScope is a no-op in the simulator: the same subject fires on every dry-run', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'node' } },
        { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const opts = { graph, varsRepo, event: { kind: 'message' as const, text: 'ping', from: 111 }, now: 1_000_000 };
    const first = await simulateAutomation(opts);
    const second = await simulateAutomation(opts); // same subject, same `now` — still fires
    expect(first.matched).toBe(true);
    expect(first.actions).toHaveLength(1);
    expect(second.matched).toBe(true);
    expect(second.actions).toHaveLength(1);
  });

  it('false branch is not taken (condition routes correctly)', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: '0' } },
        { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'true' }],
    };
    const r = await simulateAutomation({ graph, varsRepo, event: { kind: 'message', text: 'hi', hopStart: 3, hopLimit: 1 } });
    expect(r.conditionResults['c']).toBe(false); // hops = 2
    expect(r.actions).toHaveLength(0);
  });

  it('trigger pre-filter miss → skipped with no evaluation', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const r = await simulateAutomation({ graph, varsRepo, event: { kind: 'message', text: 'hello' } });
    expect(r.matched).toBe(false);
    expect(r.status).toBe('skipped');
    expect(r.actions).toHaveLength(0);
  });

  it('node.* condition resolves from supplied node facts', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.telemetry', params: {} },
        { id: 'c', type: 'condition.numeric', params: { field: 'node.batteryLevel', op: '<', value: '20' } },
        { id: 'a', type: 'action.notify', params: { body: 'low battery' } },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'true' }],
    };
    const r = await simulateAutomation({
      graph, varsRepo,
      event: { kind: 'telemetry', nodeNum: 5, telemetryType: 'batteryLevel', value: 14 },
      node: { batteryLevel: 14 },
    });
    expect(r.conditionResults['c']).toBe(true);
    expect(r.actions[0].type).toBe('action.notify');
    expect((r.actions[0].resolvedParams as any).body).toBe('low battery');
  });

  it('records simulated variable writes WITHOUT persisting them', async () => {
    await varsRepo.createVariable({ name: 'welcomed', type: 'flag', scope: 'node' });
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'f', type: 'flow.setVar', params: { variable: 'welcomed', op: 'flag' } },
      ],
      edges: [{ from: 't', to: 'f' }],
    };
    const r = await simulateAutomation({ graph, varsRepo, event: { kind: 'message', from: 111, text: 'hi' } });
    expect(r.variableWrites).toEqual([{ name: 'welcomed', op: 'flag' }]);
    // Nothing was persisted: the flag is still unset.
    const def = await varsRepo.getVariableByName('welcomed');
    const stored = await varsRepo.getEffectiveValue(def!.id, 'node:111', Date.now());
    expect(stored).toBeNull();
  });

  it('applies variable overrides and interpolates action text', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.telemetry', params: {} },
        { id: 'c', type: 'condition.numeric', params: { field: 'value', op: '>', value: '{{ var.threshold }}' } },
        { id: 'a', type: 'action.sendMessage', params: { text: 'value {{ trigger.value }} over limit' } },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'true' }],
    };
    const r = await simulateAutomation({
      graph, varsRepo,
      event: { kind: 'telemetry', nodeNum: 7, telemetryType: 'temperature', value: 30 },
      variables: { threshold: 25 },
    });
    expect(r.conditionResults['c']).toBe(true);
    expect((r.actions[0].resolvedParams as any).text).toBe('value 30 over limit');
  });

  it('system upgrade-available: prefilter + version fields', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.system', params: { event: 'upgrade-available' } },
        { id: 'a', type: 'action.notify', params: { body: '{{ trigger.latestVersion }}' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const hit = await simulateAutomation({ graph, varsRepo, event: { kind: 'system', event: 'upgrade-available', latestVersion: '9.9.9' } });
    expect(hit.matched).toBe(true);
    expect((hit.actions[0].resolvedParams as any).body).toBe('9.9.9');

    const miss = await simulateAutomation({ graph, varsRepo, event: { kind: 'system', event: 'bootup' } });
    expect(miss.matched).toBe(false);
  });

  it('schedule trigger dry-runs as matched (cron tick assumed)', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.schedule', params: { cron: '0 * * * *' } },
        { id: 'a', type: 'action.notify', params: { body: 'tick' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const r = await simulateAutomation({ graph, varsRepo, event: { kind: 'schedule' } });
    expect(r.matched).toBe(true);
    expect(r.status).toBe('completed');
    expect(r.actions).toHaveLength(1);
  });

  it('sourceFilter: the test panel can set the event source so the condition can pass', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'c', type: 'condition.sourceFilter', params: { sourceIds: ['src-A'] } },
        { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'true' }],
    };
    const pass = await simulateAutomation({ graph, varsRepo, event: { kind: 'message', text: 'hi', sourceId: 'src-A' } });
    expect(pass.conditionResults['c']).toBe(true);
    expect(pass.actions).toHaveLength(1);

    const fail = await simulateAutomation({ graph, varsRepo, event: { kind: 'message', text: 'hi', sourceId: 'other' } });
    expect(fail.conditionResults['c']).toBe(false);
  });

  // ── action.tapback emojiMode=hopCount (#4340) ───────────────────────────
  it("tapback emojiMode 'hopCount': dry-run resolves the derived emoji, no IO", async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a', type: 'action.tapback', params: { emojiMode: 'hopCount' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const r = await simulateAutomation({
      graph, varsRepo,
      event: { kind: 'message', text: 'ping', from: 111, hopStart: 3, hopLimit: 0, packetId: 1 },
    });
    expect(r.status).toBe('completed');
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].type).toBe('action.tapback');
    expect((r.actions[0].resolvedParams as any).emoji).toBe('3️⃣');
  });

  it("tapback emojiMode 'hopCount' with no hop fields: the recorded skip surfaces as the action's resolved params", async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a', type: 'action.tapback', params: { emojiMode: 'hopCount' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const r = await simulateAutomation({
      graph, varsRepo,
      event: { kind: 'message', text: 'ping', from: 111 }, // no hopStart/hopLimit
    });
    expect(r.status).toBe('completed');
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].ok).toBe(true); // a recorded skip is not an execution failure
    expect(r.actions[0].resolvedParams).toMatchObject({ skipped: true, reason: expect.stringMatching(/no hop count/) });
  });

  // #4340 Phase 3, WP3: drift guard. automationSimulator.ts (the SOURCE file) is
  // NOT edited for this feature — recordingDeps().sendMessage already spreads
  // its received argument object (`{ action: 'sendMessage', ...a }`), so a new
  // ActionDeps.sendMessage field reaches the dry-run for free. This test pins
  // that so a future refactor of recordingDeps can't silently drop it.
  it('maxAttempts (#4340 Phase 3): dry-run surfaces it via the recordingDeps spread with no simulator source change', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a', type: 'action.sendMessage', params: { text: 'pong', to: '{{ trigger.from }}', maxAttempts: 2 } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const r = await simulateAutomation({
      graph, varsRepo,
      event: { kind: 'message', text: 'ping', from: 111, packetId: 1 },
    });
    expect(r.status).toBe('completed');
    expect(r.actions).toHaveLength(1);
    expect((r.actions[0].resolvedParams as any).maxAttempts).toBe(2);
    // Dry-run performs no real send: the recorded result carries no queue
    // artifact (messageId/queued) — proof no messageQueue was reached.
    expect((r.actions[0].resolvedParams as any).queued).toBeUndefined();
    expect((r.actions[0].resolvedParams as any).messageId).toBeUndefined();
  });

  it('runScript: dry-run records the action without spawning a process', async () => {
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a', type: 'action.runScript', params: { scriptPath: 'foo.sh' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    };
    const r = await simulateAutomation({ graph, varsRepo, event: { kind: 'message', text: 'hi' } });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].type).toBe('action.runScript');
    expect((r.actions[0].resolvedParams as any).scriptPath).toBe('foo.sh');
  });
});
