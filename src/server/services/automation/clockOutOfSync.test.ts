/**
 * trigger.clockOutOfSync engine entry point (#6273): the edge rule, per-rule
 * threshold, tokens, validation, and the rate limit carried by the template.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { NodeDataProvider } from './engineContext.js';
import type { AutomationGraph } from '../../../types/automation.js';
import { validateAutomationGraph } from '../../../types/automation.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

const KEY = 'ab'.repeat(32);

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

function clockGraph(params: Record<string, unknown> = {}): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.clockOutOfSync', params },
      {
        id: 'n', type: 'action.notify',
        params: { title: 'clock', body: 'key={{ trigger.publicKey }} off={{ trigger.offsetSeconds }} text={{ trigger.offsetText }} dir={{ trigger.direction }} via={{ trigger.sampleSource }} thr={{ trigger.thresholdSeconds }} src={{ trigger.sourceId }}' },
      },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

describe('trigger.clockOutOfSync engine (#6273)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let autos: AutomationsRepository;
  let resolver: VariableResolver;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    autos = new AutomationsRepository(t.db, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(t.db, 'sqlite'));
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const data: NodeDataProvider = { getNode: async () => null, getTelemetry: async () => null };
  const engineWith = (deps: ActionDeps) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => 1_000 });
  const create = (name: string, graph: AutomationGraph) =>
    autos.createAutomation({ name, enabled: true, config: JSON.stringify(graph) });

  it('validates the threshold: blank is fine, 120..86400 whole seconds only', () => {
    expect(validateAutomationGraph(clockGraph()).valid).toBe(true);
    expect(validateAutomationGraph(clockGraph({ thresholdSeconds: 120 })).valid).toBe(true);
    expect(validateAutomationGraph(clockGraph({ thresholdSeconds: '86400' })).valid).toBe(true);
    for (const bad of [119, 86401, 300.5, 'abc']) {
      expect(validateAutomationGraph(clockGraph({ thresholdSeconds: bad })).valid).toBe(false);
    }
  });

  it('fires on in, out, out and exposes the tokens (default threshold 300 s)', async () => {
    const { calls, deps } = recorder();
    await create('clock', clockGraph());
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onClockOffset(KEY, 8040, [600, 3], 'advert', 'srcA')).toBe(1);
    expect(calls[0].args.body).toBe(`key=${KEY} off=8040 text=2h 14m behind dir=behind via=advert thr=300 src=srcA`);
  });

  it('truth table: out-out-out no; out-in-out-out fires again; one bad sample no; missing prev2 counts as in sync', async () => {
    const { calls, deps } = recorder();
    await create('clock', clockGraph());
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onClockOffset(KEY, 900, [800, 700], 'advert', 's')).toBe(0); // episode continues
    expect(await engine.onClockOffset(KEY, 900, [5, 4], 'advert', 's')).toBe(0);     // one bad sample
    expect(await engine.onClockOffset(KEY, 900, [5, 800], 'advert', 's')).toBe(0);   // out after in
    expect(await engine.onClockOffset(KEY, 900, [800, 5], 'advert', 's')).toBe(1);   // second consecutive bad
    expect(await engine.onClockOffset(KEY, 900, [800], 'advert', 's')).toBe(1);      // prev2 missing
    expect(await engine.onClockOffset(KEY, 900, [], 'advert', 's')).toBe(0);         // no history
    expect(calls).toHaveLength(2);
  });

  it('reads an ahead clock and a never-set clock', async () => {
    const { calls, deps } = recorder();
    await create('clock', clockGraph());
    const engine = engineWith(deps);
    await engine.load();

    await engine.onClockOffset(KEY, -900, [-800, 0], 'advert', 's');
    expect(calls[0].args.body).toContain('text=15m ahead dir=ahead');
    const never = 25 * 365 * 86400;
    await engine.onClockOffset('cd'.repeat(32), never, [never, 0], 'device', 's');
    expect(calls[1].args.body).toContain('text=Clock not set dir=notSet via=device');
  });

  it('applies each rule\'s own threshold and shows it in the token', async () => {
    const { calls, deps } = recorder();
    await create('tight', clockGraph({ thresholdSeconds: 120 }));
    await create('loose', clockGraph({ thresholdSeconds: 3600 }));
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onClockOffset(KEY, 900, [800, 5], 'advert', 's')).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.body).toContain('thr=120');
  });

  it('does not fire when no clockOutOfSync automation is loaded', async () => {
    const { calls, deps } = recorder();
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onClockOffset(KEY, 900, [800, 5], 'advert', 's')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('honours the stored rate limit (10 an hour from the template)', async () => {
    const { calls, deps } = recorder();
    await create('clock', clockGraph({ rateLimit: { maxActions: 2, windowSeconds: 3600 } }));
    const engine = engineWith(deps);
    await engine.load();
    for (let i = 0; i < 5; i++) await engine.onClockOffset(`${i}`.repeat(64), 900, [800, 5], 'advert', 's');
    expect(calls).toHaveLength(2);
  });
});
