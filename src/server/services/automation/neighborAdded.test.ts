/**
 * trigger.neighborAdded (#6274): the once-per-episode crossing formula, the
 * self-origin guard (drops only when the NEIGHBOUR is our own key), tokens, and
 * graph validation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { NodeDataProvider } from './engineContext.js';
import type { AutomationGraph } from '../../../types/automation.js';
import { validateAutomationGraph } from '../../../types/automation.js';
import type { NeighborSightingData } from '../dataEventEmitter.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

const H = 3_600_000;
const T0 = 1_800_000_000_000;
const REPORTER = 'aa'.repeat(32);
const NEIGHBOR = 'bb'.repeat(32);

function recorder() {
  const calls: Array<{ fn: string; args: any }> = [];
  const mk = (fn: string, ret: unknown) => async (a: unknown) => { calls.push({ fn, args: a }); return ret as never; };
  const deps = {
    sendMessage: mk('sendMessage', 1), sendTapback: mk('sendTapback', 2), manageNode: mk('manageNode', 3),
    notify: mk('notify', 4), requestData: mk('requestData', 5), rebootDevice: mk('rebootDevice', 6),
    runScript: mk('runScript', { success: true, stdout: '' }),
  } as unknown as ActionDeps;
  return { calls, deps };
}

const graph = (confirmHours?: number | string): AutomationGraph => ({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.neighborAdded', params: confirmHours === undefined ? {} : { confirmHours } },
    { id: 'n', type: 'action.notify', params: { title: 'nb', body: '{{ trigger.reporterName }}|{{ trigger.neighborPublicKey }}|{{ trigger.snr }}|{{ trigger.confirmedAfterHours }}|{{ trigger.sightings }}' } },
  ],
  edges: [{ from: 't', to: 'n' }],
});

const sighting = (first: number, prevLast: number, last: number, over: Partial<NeighborSightingData> = {}): NeighborSightingData => ({
  reporterPublicKey: REPORTER, reporterName: 'Hilltop', neighborPublicKey: NEIGHBOR,
  firstSeenAt: first, prevLastHeardAt: prevLast, lastHeardAt: last, snr: 6.5, sightings: 3, ...over,
});

describe('trigger.neighborAdded engine (#6274)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let resolver: VariableResolver;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(drizzleDb, 'sqlite'));
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const data: NodeDataProvider = {
    getNode: async () => null,
    getTelemetry: async () => null,
    getSelfPublicKey: async () => REPORTER,
  } as NodeDataProvider;
  const engineWith = (deps: ActionDeps, provider: NodeDataProvider = data) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: provider, now: () => 1_000 });
  const create = (name: string, g: AutomationGraph) => autos.createAutomation({ name, enabled: true, config: JSON.stringify(g) });

  it('fires only on the sighting that crosses confirmHours (default 72 h), with tokens', async () => {
    const { calls, deps } = recorder();
    await create('nb', graph());
    const engine = engineWith(deps);
    await engine.load();

    // before the window: no fire
    expect(await engine.onNeighborSighting(sighting(T0, T0 + 10 * H, T0 + 20 * H), 'src')).toBe(0);
    // crossing sighting: prev < 72 h <= last
    expect(await engine.onNeighborSighting(sighting(T0, T0 + 70 * H, T0 + 73 * H), 'src')).toBe(1);
    expect(calls[0].args.body).toBe(`Hilltop|${NEIGHBOR}|6.5|73|3`);
    // later sightings (prev already past the window): no fire again
    expect(await engine.onNeighborSighting(sighting(T0, T0 + 73 * H, T0 + 80 * H), 'src')).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('honours a per-automation confirmHours; a long gap crossing straight over still fires once', async () => {
    const { calls, deps } = recorder();
    await create('six', graph(6));
    await create('week', graph(168));
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onNeighborSighting(sighting(T0, T0 + 2 * H, T0 + 7 * H), 'src')).toBe(1); // only the 6 h rule
    expect(await engine.onNeighborSighting(sighting(T0, T0 + 100 * H, T0 + 169 * H), 'src')).toBe(1); // only the 168 h rule
    expect(calls).toHaveLength(2);
  });

  it('drops the event only when the NEIGHBOUR is our own key; a reporter that is us still fires', async () => {
    const { calls, deps } = recorder();
    await create('nb', graph(6));
    const engine = engineWith(deps); // getSelfPublicKey => REPORTER
    await engine.load();
    // reporter is our own repeater: fires
    expect(await engine.onNeighborSighting(sighting(T0, T0, T0 + 7 * H), 'src')).toBe(1);
    // neighbour is our own key: dropped
    expect(await engine.onNeighborSighting(sighting(T0, T0, T0 + 7 * H, { neighborPublicKey: REPORTER }), 'src')).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('minSnr style conditions read trigger.snr', async () => {
    const { calls, deps } = recorder();
    const g = graph(6);
    g.nodes.splice(1, 0, { id: 'c', type: 'condition.numeric', params: { field: 'snr', op: '>=', value: '10' } } as never);
    g.edges = [{ from: 't', to: 'c' }, { from: 'c', to: 'n' }];
    await create('snr', g);
    const engine = engineWith(deps);
    await engine.load();
    await engine.onNeighborSighting(sighting(T0, T0, T0 + 7 * H, { snr: 4 }), 'src');
    expect(calls).toHaveLength(0);
    await engine.onNeighborSighting(sighting(T0, T0, T0 + 7 * H, { snr: 12 }), 'src');
    expect(calls).toHaveLength(1);
  });

  it('validates confirmHours: blank ok, 6..336 whole hours only', () => {
    expect(validateAutomationGraph(graph()).valid).toBe(true);
    expect(validateAutomationGraph(graph(6)).valid).toBe(true);
    expect(validateAutomationGraph(graph(336)).valid).toBe(true);
    expect(validateAutomationGraph(graph('')).valid).toBe(true);
    for (const bad of [5, 337, 12.5, 'abc', 0, -3]) {
      expect(validateAutomationGraph(graph(bad as number)).valid).toBe(false);
    }
  });
});
