/**
 * Automations Repository Tests (#3653)
 *
 * CRUD + run-log coverage for the global Automation Engine tables against a real
 * in-memory SQLite database (migration 098 applied via createTestDb).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from './automations.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SAMPLE_CONFIG = JSON.stringify({
  version: 1,
  nodes: [
    { id: 'n1', type: 'trigger.message', params: { textContains: 'ping' } },
    { id: 'n2', type: 'action.tapback', params: { emoji: '👍' } },
  ],
  edges: [{ from: 'n1', to: 'n2' }],
});

describe('AutomationsRepository', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: AutomationsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new AutomationsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', async () => {
    expect(await repo.listAutomations()).toEqual([]);
  });

  it('creates and retrieves an automation', async () => {
    const created = await repo.createAutomation({
      name: 'Ping responder',
      description: 'reply to ping',
      config: SAMPLE_CONFIG,
      createdByUserId: 7,
    });

    expect(created.id).toBeTruthy();
    expect(created.name).toBe('Ping responder');
    expect(created.description).toBe('reply to ping');
    expect(created.enabled).toBe(false); // defaults disabled
    expect(created.config).toBe(SAMPLE_CONFIG);
    expect(created.createdByUserId).toBe(7);
    expect(created.createdAt).toBeGreaterThan(0);

    const fetched = await repo.getAutomation(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Ping responder');
    expect(JSON.parse(fetched!.config).nodes).toHaveLength(2);
  });

  it('returns null for a missing automation', async () => {
    expect(await repo.getAutomation('nope')).toBeNull();
  });

  it('updates fields and leaves others intact', async () => {
    const created = await repo.createAutomation({ name: 'A', config: '{}' });
    const updated = await repo.updateAutomation(created.id, { name: 'B', enabled: true });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('B');
    expect(updated!.enabled).toBe(true);
    expect(updated!.config).toBe('{}'); // untouched
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it('returns null when updating a missing automation', async () => {
    expect(await repo.updateAutomation('nope', { name: 'x' })).toBeNull();
  });

  it('toggles enabled and filters enabled-only', async () => {
    const a = await repo.createAutomation({ name: 'A', config: '{}', enabled: true });
    await repo.createAutomation({ name: 'B', config: '{}', enabled: false });

    const enabled = await repo.listEnabledAutomations();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe(a.id);

    await repo.setEnabled(a.id, false);
    expect(await repo.listEnabledAutomations()).toHaveLength(0);
  });

  it('deletes an automation and its runs', async () => {
    const a = await repo.createAutomation({ name: 'A', config: '{}' });
    await repo.createRun({ automationId: a.id, status: 'completed' });

    expect(await repo.deleteAutomation(a.id)).toBe(true);
    expect(await repo.getAutomation(a.id)).toBeNull();
    expect(await repo.listRuns(a.id)).toEqual([]);
  });

  it('returns false when deleting a missing automation', async () => {
    expect(await repo.deleteAutomation('nope')).toBe(false);
  });

  it('records runs and lists them most-recent-first', async () => {
    const a = await repo.createAutomation({ name: 'A', config: '{}' });

    const r1 = await repo.createRun({
      automationId: a.id,
      sourceId: 'default',
      status: 'completed',
      triggerEvent: JSON.stringify({ from: 123 }),
      log: JSON.stringify([{ node: 'n1', outcome: 'fired' }]),
    });
    expect(r1.sourceId).toBe('default');
    expect(r1.status).toBe('completed');

    await repo.createRun({ automationId: a.id, status: 'failed' });

    const runs = await repo.listRuns(a.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.automationId === a.id)).toBe(true);
  });

  it('updates a run and finds it by status', async () => {
    const a = await repo.createAutomation({ name: 'A', config: '{}' });
    const run = await repo.createRun({ automationId: a.id, status: 'pending' });

    await repo.updateRun(run.id, { status: 'waiting', state: JSON.stringify({ vars: { count: 1 } }) });

    const waiting = await repo.listRunsByStatus('waiting');
    expect(waiting).toHaveLength(1);
    expect(waiting[0].id).toBe(run.id);
    expect(JSON.parse(waiting[0].state!).vars.count).toBe(1);
  });

  it('cancels active (pending/waiting) runs but leaves terminal runs', async () => {
    const a = await repo.createAutomation({ name: 'A', config: '{}' });
    await repo.createRun({ automationId: a.id, status: 'pending' });
    await repo.createRun({ automationId: a.id, status: 'waiting' });
    await repo.createRun({ automationId: a.id, status: 'completed' });

    await repo.cancelActiveRuns(a.id);

    const runs = await repo.listRuns(a.id);
    const byStatus = runs.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStatus.cancelled).toBe(2);
    expect(byStatus.completed).toBe(1);
    expect(byStatus.pending).toBeUndefined();
    expect(byStatus.waiting).toBeUndefined();
  });
});
