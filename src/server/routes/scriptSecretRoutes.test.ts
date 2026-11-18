/**
 * /api/script-secrets — admin-only, write-only. Uses the real route harness
 * (session + auth middleware + :memory: DB). The key assertion: no response
 * body and no audit row ever contains a stored value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import scriptSecretRoutes from './scriptSecretRoutes.js';
import { ScriptSecretStore, setScriptSecretStoreForTesting } from '../services/scriptSecretStore.js';
import { getScriptSecretsSnapshot, setScriptSecretsSnapshot } from '../utils/scriptSecretsSnapshot.js';
import databaseService from '../../services/database.js';

const VALUE = 'sk-live-ROUTE-SENTINEL-7d1e44';
const KEY = 'c'.repeat(64);

describe('/api/script-secrets', () => {
  let harness: RouteTestHarness;
  const bodies: string[] = [];

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use(express.json());
        app.use('/api/script-secrets', scriptSecretRoutes);
      },
    });
    setScriptSecretStoreForTesting(new ScriptSecretStore(KEY, true));
    for (const row of await databaseService.scriptSecrets.listMetadata()) {
      await databaseService.scriptSecrets.delete(row.name);
    }
    setScriptSecretsSnapshot(new Map());
    bodies.length = 0;
  });

  afterEach(async () => {
    // Nothing any route returned may carry the value.
    for (const body of bodies) expect(body).not.toContain(VALUE);
    setScriptSecretStoreForTesting(null);
    setScriptSecretsSnapshot(new Map());
    await harness.cleanup();
  });

  const record = <T extends { text: string }>(res: T): T => {
    bodies.push(res.text);
    return res;
  };

  it('rejects anonymous callers', async () => {
    const agent = await harness.loginAs(null);
    expect(record(await agent.get('/api/script-secrets')).status).toBe(401);
    expect(record(await agent.put('/api/script-secrets/WEATHER_KEY').send({ value: VALUE })).status).toBe(401);
  });

  it('rejects non-admins, even with settings:write', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write');
    await harness.grant(harness.limited.id, 'automation', 'write');
    const agent = await harness.loginAs(harness.limited);
    expect(record(await agent.get('/api/script-secrets')).status).toBe(403);
    expect(record(await agent.put('/api/script-secrets/WEATHER_KEY').send({ value: VALUE })).status).toBe(403);
    expect(record(await agent.delete('/api/script-secrets/WEATHER_KEY')).status).toBe(403);
    expect(await databaseService.scriptSecrets.count()).toBe(0);
  });

  it('creates, lists, replaces and deletes without ever returning the value', async () => {
    const agent = await harness.loginAs(harness.admin);

    const created = record(await agent.put('/api/script-secrets/WEATHER_KEY').send({ value: VALUE }));
    expect(created.status).toBe(200);
    expect(created.body).toEqual({
      success: true,
      data: { name: 'WEATHER_KEY', updatedAt: expect.any(Number), created: true },
    });
    expect(getScriptSecretsSnapshot().get('WEATHER_KEY')).toBe(VALUE);

    const list = record(await agent.get('/api/script-secrets'));
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      success: true,
      data: {
        canStore: true,
        secrets: [{ name: 'WEATHER_KEY', updatedAt: expect.any(Number), status: 'ok' }],
      },
    });

    const replaced = record(await agent.put('/api/script-secrets/WEATHER_KEY').send({ value: `${VALUE}-2` }));
    expect(replaced.body.data.created).toBe(false);

    const deleted = record(await agent.delete('/api/script-secrets/WEATHER_KEY'));
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ success: true });
    expect(getScriptSecretsSnapshot().has('WEATHER_KEY')).toBe(false);

    const missing = record(await agent.delete('/api/script-secrets/WEATHER_KEY'));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('audits by name only', async () => {
    const agent = await harness.loginAs(harness.admin);
    record(await agent.put('/api/script-secrets/AUDIT_KEY').send({ value: VALUE }));
    record(await agent.delete('/api/script-secrets/AUDIT_KEY'));
    const { logs } = await databaseService.getAuditLogsAsync({ limit: 50 });
    const ours = logs.filter(
      (l: { action: string; details: string | null }) =>
        l.action.startsWith('script_secret_') && (l.details ?? '').includes('AUDIT_KEY'),
    );
    expect(ours.map((l: { action: string }) => l.action)).toEqual(
      expect.arrayContaining(['script_secret_created', 'script_secret_deleted']),
    );
    for (const log of ours) {
      expect(JSON.stringify(log)).not.toContain(VALUE);
      expect(JSON.stringify(log)).toContain('AUDIT_KEY');
    }
  });

  it('returns the validation codes', async () => {
    const agent = await harness.loginAs(harness.admin);
    const cases: Array<[string, unknown, number, string]> = [
      ['lower', VALUE, 400, 'INVALID_SECRET_NAME'],
      ['PATH', VALUE, 400, 'RESERVED_SECRET_NAME'],
      ['PARAM_CITY', VALUE, 400, 'RESERVED_SECRET_NAME'],
      ['SESSION_SECRET', VALUE, 400, 'RESERVED_SECRET_NAME'],
      ['GOOD_NAME', '', 400, 'INVALID_SECRET_VALUE'],
      ['GOOD_NAME', 'x'.repeat(4097), 400, 'INVALID_SECRET_VALUE'],
      ['GOOD_NAME', `${VALUE}\u0000`, 400, 'INVALID_SECRET_VALUE'],
    ];
    for (const [name, value, status, code] of cases) {
      const res = record(await agent.put(`/api/script-secrets/${name}`).send({ value }));
      expect(res.status, `${name}`).toBe(status);
      expect(res.body.code, `${name}`).toBe(code);
    }
    expect(await databaseService.scriptSecrets.count()).toBe(0);
  });

  it('returns TOO_MANY_SECRETS at the cap', async () => {
    for (let i = 0; i < 50; i++) await databaseService.scriptSecrets.upsert(`CAP_${i}`, '{}');
    const agent = await harness.loginAs(harness.admin);
    const res = record(await agent.put('/api/script-secrets/ONE_MORE').send({ value: VALUE }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOO_MANY_SECRETS');
  });

  it('returns 409 SESSION_SECRET_REQUIRED and reports canStore=false without SESSION_SECRET', async () => {
    setScriptSecretStoreForTesting(new ScriptSecretStore(KEY, false));
    const agent = await harness.loginAs(harness.admin);
    const list = record(await agent.get('/api/script-secrets'));
    expect(list.body.data.canStore).toBe(false);
    expect(list.body.data.reason).toMatch(/SESSION_SECRET/);
    const res = record(await agent.put('/api/script-secrets/WEATHER_KEY').send({ value: VALUE }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SESSION_SECRET_REQUIRED');
  });
});
