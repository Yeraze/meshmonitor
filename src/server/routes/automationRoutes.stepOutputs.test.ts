/**
 * Automation routes with run-scoped step outputs (#5636): save-time name
 * checks, the dry run's sample output, and export / import / duplicate
 * keeping `outputName`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

import automationRouter from './automationRoutes.js';
import databaseService from '../../services/database.js';

const graph = (outputName: unknown = 'joke', text = '{{ steps.joke.output }}') => ({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: {} },
    { id: 'a0', type: 'action.runScript', params: { scriptPath: 'joke.py', outputName } },
    { id: 'a1', type: 'action.sendMessage', params: { text } },
  ],
  edges: [{ from: 't', to: 'a0' }, { from: 'a0', to: 'a1' }],
});
const EVENT = { kind: 'message', text: 'joke' };
const scriptParams = (config: string) => JSON.parse(config).nodes[1].params;

describe('automation routes — run-scoped step outputs (#5636)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/automations', automationRouter) });
  });
  afterEach(async () => {
    await harness.cleanup();
    vi.clearAllMocks();
  });

  const writer = async () => {
    await harness.grant(harness.limited.id, 'automations', 'write');
    await harness.grant(harness.limited.id, 'automations', 'read');
    return harness.loginAs(harness.limited);
  };

  it('POST / saves a named step output', async () => {
    const agent = await writer();
    const res = await agent.post('/api/automations').send({ name: 'Joke', config: graph() });
    expect(res.status).toBe(201);
    expect(scriptParams(res.body.config)).toEqual({ scriptPath: 'joke.py', outputName: 'joke' });
  });

  it('POST / rejects a malformed name and a name used twice', async () => {
    const agent = await writer();
    const bad = await agent.post('/api/automations').send({ name: 'Bad', config: graph('Not OK') });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0]).toMatch(/requires params\.outputName/);

    const twice = graph();
    twice.nodes.push({ id: 'a2', type: 'action.runScript', params: { scriptPath: 'b.py', outputName: 'joke' } });
    twice.edges.push({ from: 'a1', to: 'a2' });
    const dup = await agent.post('/api/automations').send({ name: 'Dup', config: twice });
    expect(dup.status).toBe(400);
    expect(dup.body.details[0]).toMatch(/reuses the run output name "joke"/);
  });

  it('a reference that will be empty does not block the save', async () => {
    const agent = await writer();
    const res = await agent.post('/api/automations').send({ name: 'Typo', config: graph('joke', '{{ steps.jok.output }}') });
    expect(res.status).toBe(201);
  });

  it('POST /test renders the sample output and sends nothing', async () => {
    const agent = await writer();
    const before = (await databaseService.automations.listAutomations()).length;
    const res = await agent.post('/api/automations/test')
      .send({ config: graph(), event: EVENT, stepOutputs: { joke: 'A mesh walks into a bar.', other: 5, __proto__: 'x', 'Bad Name': 'y' } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.actions[1]).toMatchObject({
      type: 'action.sendMessage', ok: true, resolvedParams: { action: 'sendMessage', text: 'A mesh walks into a bar.' },
    });
    // A dry run saves nothing.
    expect(await databaseService.automations.listAutomations()).toHaveLength(before);
  });

  it('POST /test with no sample shows the empty message as not sent', async () => {
    const agent = await writer();
    const res = await agent.post('/api/automations/test').send({ config: graph(), event: EVENT });
    expect(res.status).toBe(200);
    expect(res.body.actions[1].resolvedParams).toMatchObject({ skipped: true, emptySend: true });
  });

  it('export, import and duplicate all keep outputName', async () => {
    const agent = await writer();
    const created = await agent.post('/api/automations').send({ name: 'Joke', config: graph() });

    const exported = await agent.get(`/api/automations/${created.body.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body.config.nodes[1].params.outputName).toBe('joke');

    const imported = await agent.post('/api/automations/import').send({ name: 'Joke 2', config: exported.body.config });
    expect(imported.status).toBe(201);
    expect(scriptParams(imported.body.config).outputName).toBe('joke');

    const dup = await agent.post(`/api/automations/${created.body.id}/duplicate`).send({ name: 'Joke 3' });
    expect(dup.status).toBe(201);
    expect(scriptParams(dup.body.config).outputName).toBe('joke');
  });
});
