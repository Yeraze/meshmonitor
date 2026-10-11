/**
 * Scheduled automations at save (#5515): the 5-minute minimum interval and the
 * start/end window. Real auth and a real database; only the engine reload is
 * stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

import automationRouter from './automationRoutes.js';

function graph(params: Record<string, unknown>) {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.schedule', params },
      { id: 'a', type: 'action.sendMessage', params: { text: 'Net is open' } },
    ],
    edges: [{ from: 't', to: 'a' }],
  };
}

describe('automation save routes: schedule minimum interval and window (#5515)', () => {
  let harness: RouteTestHarness;
  const createdIds: string[] = [];

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/automations', automationRouter) });
  });

  afterEach(async () => {
    for (const id of createdIds.splice(0)) await harness.db.automations.deleteAutomation(id).catch(() => {});
    await harness.cleanup();
    vi.clearAllMocks();
  });

  const writer = async () => {
    await harness.grant(harness.limited.id, 'automations', 'write');
    return harness.loginAs(harness.limited);
  };
  const create = async (agent: Awaited<ReturnType<typeof writer>>, params: Record<string, unknown>) => {
    const res = await agent.post('/api/automations').send({ name: 'Timed', config: graph(params) });
    if (res.body?.id) createdIds.push(res.body.id);
    return res;
  };

  it('accepts a cron at the 5-minute minimum and slower', async () => {
    const agent = await writer();
    expect((await create(agent, { cron: '*/5 * * * *' })).status).toBe(201);
    expect((await create(agent, { cron: '*/30 8-11 3 10 *' })).status).toBe(201);
  });

  it('rejects a cron that fires more often than every 5 minutes', async () => {
    const agent = await writer();
    const res = await create(agent, { cron: '* * * * *' });
    expect(res.status).toBe(400);
    expect(res.body.details[0]).toMatch(/fires every 60 s at its fastest; the minimum is every 5 minutes/);
    expect((await create(agent, { cron: '*/4 * * * *' })).status).toBe(400);
    expect((await create(agent, { cron: '*/30 * * * * *' })).status).toBe(400);
    // Slow overall, but two fires one minute apart.
    expect((await create(agent, { cron: '0,1 8 * * *' })).status).toBe(400);
  });

  it('rejects an invalid cron', async () => {
    const agent = await writer();
    const res = await create(agent, { cron: 'every day' });
    expect(res.status).toBe(400);
    expect(res.body.details[0]).toMatch(/not a valid cron expression/);
  });

  it('saves a start/end window with its time zone', async () => {
    const agent = await writer();
    const res = await create(agent, {
      cron: '*/30 * * * *', startAt: '2026-10-03T08:00', endAt: '2026-10-03T12:00', timezone: 'America/New_York',
    });
    expect(res.status).toBe(201);
    const saved = JSON.parse(res.body.config).nodes[0].params;
    expect(saved).toMatchObject({ startAt: '2026-10-03T08:00', endAt: '2026-10-03T12:00', timezone: 'America/New_York' });
  });

  it('rejects a window with no zone, an unknown zone, a bad date, or an end before the start', async () => {
    const agent = await writer();
    const bad = [
      { startAt: '2026-10-03T08:00' },
      { startAt: '2026-10-03T08:00', timezone: 'Mars/Olympus' },
      { startAt: 'tomorrow', timezone: 'UTC' },
      { startAt: '2026-10-03T12:00', endAt: '2026-10-03T08:00', timezone: 'UTC' },
    ];
    for (const params of bad) {
      const res = await create(agent, { cron: '0 * * * *', ...params });
      expect(res.status, JSON.stringify(params)).toBe(400);
    }
  });

  it('a rule that only runs scheduled path traces may tick each minute, but not faster', async () => {
    const agent = await writer();
    const traceGraph = (cron: string, extra: Array<Record<string, unknown>> = []) => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.schedule', params: { cron } },
        { id: 'p', type: 'action.tracePathSchedule', params: { sourceId: harness.sourceA, paths: [{ publicKey: 'ab'.repeat(32), intervalMinutes: 30 }] } },
        ...extra,
      ],
      edges: [{ from: 't', to: 'p' }, ...extra.map((n) => ({ from: 'p', to: String(n.id) }))],
    });
    const ok = await agent.post('/api/automations').send({ name: 'Traces', config: traceGraph('* * * * *') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    createdIds.push(ok.body.id);

    const seconds = await agent.post('/api/automations').send({ name: 'Traces', config: traceGraph('*/30 * * * * *') });
    expect(seconds.status).toBe(400);
    expect(seconds.body.details[0]).toMatch(/the minimum is every 60 s/);

    // Add a message send and the normal 5-minute minimum applies again.
    const mixed = await agent.post('/api/automations').send({
      name: 'Traces + send',
      config: traceGraph('* * * * *', [{ id: 's', type: 'action.sendMessage', params: { text: 'hi' } }]),
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body.details[0]).toMatch(/the minimum is every 5 minutes/);
  });

  it('PUT and import apply the same minimum', async () => {
    const agent = await writer();
    const ok = await create(agent, { cron: '0 * * * *' });
    const put = await agent.put(`/api/automations/${ok.body.id}`).send({ config: graph({ cron: '* * * * *' }) });
    expect(put.status).toBe(400);
    const imp = await agent.post('/api/automations/import').send({ name: 'Fast', config: graph({ cron: '*/2 * * * *' }) });
    expect(imp.status).toBe(400);
  });

  it('a rule saved before the limit can still be switched on and off, but not copied', async () => {
    const agent = await writer();
    // Written straight to the table, as a pre-#5515 save would have left it.
    const old = await harness.db.automations.createAutomation({
      name: 'Old fast rule', enabled: true, config: JSON.stringify(graph({ cron: '* * * * *' })),
    });
    createdIds.push(old.id);
    expect((await agent.post(`/api/automations/${old.id}/disable`)).status).toBe(200);
    expect((await agent.post(`/api/automations/${old.id}/enable`)).status).toBe(200);
    const copy = await agent.post(`/api/automations/${old.id}/duplicate`).send({});
    expect(copy.status).toBe(400);
    expect(copy.body.code).toBe('SCHEDULE_TOO_FREQUENT');
  });
});
