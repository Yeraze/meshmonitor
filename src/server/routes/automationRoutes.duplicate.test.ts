/**
 * Automation "Duplicate" route (#5024).
 *
 * `POST /api/automations/:id/duplicate` copies a source rule verbatim (config,
 * description) with a caller-supplied or defaulted name, forces enabled=false,
 * and returns the new row. Same permission gate as create/edit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../services/automation/automationEngineSingleton.js', () => ({
  getAutomationEngine: vi.fn(),
  reloadAutomations: vi.fn().mockResolvedValue(undefined),
}));

import automationRouter from './automationRoutes.js';
import databaseService from '../../services/database.js';

const VALID_CONFIG = JSON.stringify({
  nodes: [
    { id: 'trg', type: 'trigger.message', fields: {} },
    { id: 'act', type: 'action.nothing', fields: {} },
  ],
  edges: [{ source: 'trg', target: 'act' }],
});

async function seedSource(name: string, extras: Partial<{ description: string; enabled: boolean }> = {}) {
  return databaseService.automations.createAutomation({
    name,
    description: extras.description ?? 'Source description',
    enabled: extras.enabled ?? true,
    config: VALID_CONFIG,
    createdByUserId: null,
  });
}

describe('POST /api/automations/:id/duplicate', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/automations', automationRouter),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
    vi.clearAllMocks();
  });

  it('rejects a user without automations:write with 403 and does not insert', async () => {
    const source = await seedSource('Alpha');
    const agent = await harness.loginAs(harness.limited);
    const before = (await databaseService.automations.listAutomations()).length;
    const res = await agent.post(`/api/automations/${source.id}/duplicate`).send({ name: 'clone' });
    expect(res.status).toBe(403);
    const after = (await databaseService.automations.listAutomations()).length;
    expect(after).toBe(before);
  });

  it('creates a disabled clone with the requested name and identical config', async () => {
    const source = await seedSource('Alpha', { description: 'orig' });
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${source.id}/duplicate`).send({ name: 'Copy of Alpha' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.id).not.toBe(source.id);
    expect(res.body.name).toBe('Copy of Alpha');
    expect(res.body.enabled).toBe(false);
    expect(res.body.description).toBe('orig');
    // config is persisted as a JSON string; deep-equal after re-parse both sides.
    expect(JSON.parse(res.body.config)).toEqual(JSON.parse(source.config));
  });

  it('defaults the name to "<source name> (copy)" when the body has no name', async () => {
    const source = await seedSource('Alpha');
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${source.id}/duplicate`).send({});
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Alpha (copy)');
    expect(res.body.enabled).toBe(false);
  });

  it('defaults the name when the body is empty (no Content-Type)', async () => {
    const source = await seedSource('Beta');
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${source.id}/duplicate`);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Beta (copy)');
  });

  it('returns 404 with AUTOMATION_NOT_FOUND when the source id is unknown', async () => {
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/automations/missing-id/duplicate').send({ name: 'clone' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AUTOMATION_NOT_FOUND');
  });

  it('rejects an over-long name with 400 INVALID_NAME', async () => {
    const source = await seedSource('Gamma');
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${source.id}/duplicate`).send({ name: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME');
  });

  it('trims leading/trailing whitespace on the caller-supplied name', async () => {
    const source = await seedSource('Delta');
    await harness.grant(harness.limited.id, 'automations', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/api/automations/${source.id}/duplicate`).send({ name: '   Padded Name   ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Padded Name');
  });
});
