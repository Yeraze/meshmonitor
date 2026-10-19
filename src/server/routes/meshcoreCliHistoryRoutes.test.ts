/**
 * MeshCore CLI history (#5892): the recording at the three HTTP entry points
 * (remote console, local console, time-sync button), redaction in both the
 * history and the audit log, and per-source read isolation on both GET routes.
 *
 * Real-middleware harness; only the source-manager registry is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { unifiedCliHistoryRouter } from './meshcoreCliHistoryRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { NewMeshCoreCliHistoryRow } from '../../db/repositories/meshcoreCliHistory.js';

const h = vi.hoisted(() => ({
  stubs: new Map<string, Record<string, any>>(),
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => h.stubs.get(id),
    getAllManagers: () => Array.from(h.stubs.values()),
  },
}));

const KEY = 'cd'.repeat(32);

function stub(sourceId: string) {
  return {
    sourceId,
    sourceType: 'meshcore' as const,
    isReceiveOnly: () => false,
    canTransmit: () => true,
    isConnected: () => true,
    getLastMeshTxAt: () => 0,
    recordMeshTx: vi.fn(),
    getContact: (k: string) => (k === KEY ? { publicKey: KEY, advName: 'Hill Repeater' } : undefined),
    getLocalNode: () => ({ name: 'Base Companion' }),
    resolveContactByPrefix: () => undefined,
    sendCliCommand: vi.fn().mockResolvedValue({ reply: 'v1.9.0', elapsedMs: 420 }),
    sendLocalCliCommand: vi.fn().mockResolvedValue({ reply: 'OK', elapsedMs: 12 }),
    syncNodeTime: vi.fn().mockResolvedValue({ status: 'ok', reply: 'OK - clock set', elapsedMs: 900 }),
  };
}

const histRow = (over: Partial<NewMeshCoreCliHistoryRow>): NewMeshCoreCliHistoryRow => ({
  sourceId: 'rt-source-a',
  timestamp: Date.now(),
  targetKind: 'remote',
  targetPublicKey: KEY,
  targetName: null,
  origin: 'user',
  userId: null,
  username: 'someone',
  command: 'ver',
  outcome: 'ok',
  reply: null,
  error: null,
  elapsedMs: null,
  ipAddress: null,
  ...over,
});

describe('MeshCore CLI history (#5892)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    h.stubs.clear();
    h.stubs.set('rt-source-a', stub('rt-source-a'));
    h.stubs.set('rt-source-b', stub('rt-source-b'));
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/sources/:id/meshcore', meshcoreRoutes);
        app.use('/meshcore/cli-history', unifiedCliHistoryRouter);
      },
    });
    await harness.db.meshcoreCliHistory.deleteBySourceId(harness.sourceA);
    await harness.db.meshcoreCliHistory.deleteBySourceId(harness.sourceB);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const a = () => h.stubs.get(harness.sourceA)!;
  const historyOf = (sourceId: string) => harness.db.meshcoreCliHistory.list({ scopes: 'all', sourceIds: [sourceId] });
  const waitForRows = async (sourceId: string, n: number) => {
    await vi.waitFor(async () => { expect(await historyOf(sourceId)).toHaveLength(n); });
    return historyOf(sourceId);
  };

  describe('recording', () => {
    it('remote console: records an ok command with user, target and reply', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(`/sources/${harness.sourceA}/meshcore/admin/cli`).send({ publicKey: KEY, command: 'ver' });
      expect(res.status).toBe(200);
      const [row] = await waitForRows(harness.sourceA, 1);
      expect(row).toMatchObject({
        targetKind: 'remote',
        targetPublicKey: KEY,
        targetName: 'Hill Repeater',
        origin: 'user',
        userId: harness.limited.id,
        username: harness.limited.username,
        command: 'ver',
        outcome: 'ok',
        reply: 'v1.9.0',
        elapsedMs: 420,
      });
      expect(await historyOf(harness.sourceB)).toEqual([]);
    });

    it('remote console: records a blocked danger command without sending it', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(`/sources/${harness.sourceA}/meshcore/admin/cli`).send({ publicKey: KEY, command: 'reboot' });
      expect(res.status).toBe(400);
      expect(a().sendCliCommand).not.toHaveBeenCalled();
      const [row] = await waitForRows(harness.sourceA, 1);
      expect(row).toMatchObject({ command: 'reboot', outcome: 'blocked', error: 'DANGER_CONFIRM_REQUIRED' });
    });

    it('remote console: records a timeout and a failure', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      a().sendCliCommand.mockRejectedValueOnce(new Error('CLI command timed out after 15000ms'));
      expect((await agent.post(`/sources/${harness.sourceA}/meshcore/admin/cli`).send({ publicKey: KEY, command: 'stats' })).status).toBe(504);
      a().sendCliCommand.mockRejectedValueOnce(new Error('bridge exploded'));
      expect((await agent.post(`/sources/${harness.sourceA}/meshcore/admin/cli`).send({ publicKey: KEY, command: 'neighbors' })).status).toBe(502);
      const rows = await waitForRows(harness.sourceA, 2);
      const byCmd = Object.fromEntries(rows.map(r => [r.command, r]));
      expect(byCmd.stats).toMatchObject({ outcome: 'timeout', error: 'CLI command timed out after 15000ms' });
      expect(byCmd.neighbors).toMatchObject({ outcome: 'failed', error: 'bridge exploded' });
    });

    it('remote console: redacts the secret in history AND the audit log', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      a().sendCliCommand.mockResolvedValueOnce({ reply: 'password now: hunter2', elapsedMs: 1 });
      await agent.post(`/sources/${harness.sourceA}/meshcore/admin/cli`).send({ publicKey: KEY, command: 'password hunter2' });
      const [row] = await waitForRows(harness.sourceA, 1);
      expect(row.command).toBe('password ********');
      expect(row.reply).toBe('password now: ********');
      // The radio still got the real command.
      expect(a().sendCliCommand).toHaveBeenCalledWith(KEY, 'password hunter2', expect.anything());

      await vi.waitFor(async () => {
        const logs = await harness.db.auth.getAuditLogEntries(50, 0);
        const entry = logs.find(l => l.action === 'meshcore_remote_cli');
        expect(entry).toBeDefined();
        expect(entry!.details).toContain('password ********');
        expect(entry!.details).not.toContain('hunter2');
      });
    });

    it('local console: records ok, blocked and failed commands', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(`/sources/${harness.sourceA}/meshcore/cli`).send({ command: 'set guest.password gpw' })).status).toBe(200);
      expect((await agent.post(`/sources/${harness.sourceA}/meshcore/cli`).send({ command: 'erase' })).status).toBe(400);
      a().sendLocalCliCommand.mockRejectedValueOnce(new Error('Serial port not open'));
      expect((await agent.post(`/sources/${harness.sourceA}/meshcore/cli`).send({ command: 'ver' })).status).toBe(400);

      const rows = await waitForRows(harness.sourceA, 3);
      const byCmd = Object.fromEntries(rows.map(r => [r.command, r]));
      expect(byCmd['set guest.password ********']).toMatchObject({ targetKind: 'local', targetPublicKey: null, targetName: 'Base Companion', outcome: 'ok', reply: 'OK' });
      expect(byCmd.erase).toMatchObject({ outcome: 'blocked' });
      expect(byCmd.ver).toMatchObject({ outcome: 'failed', error: 'Serial port not open' });
      expect(JSON.stringify(rows)).not.toContain('gpw');
    });

    it('time-sync button: records the push and its outcome', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(`/sources/${harness.sourceA}/meshcore/nodes/${KEY}/time-sync`)).status).toBe(200);
      const [row] = await waitForRows(harness.sourceA, 1);
      expect(row).toMatchObject({ targetKind: 'remote', targetPublicKey: KEY, command: 'clock sync', outcome: 'ok', reply: 'OK - clock set', username: harness.limited.username });
    });

    it('time-sync button: a refused push is recorded as failed', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      a().syncNodeTime.mockResolvedValueOnce({ status: 'rejected', reply: 'ERR: clock cannot go backwards' });
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(`/sources/${harness.sourceA}/meshcore/nodes/${KEY}/time-sync`)).status).toBe(409);
      const [row] = await waitForRows(harness.sourceA, 1);
      expect(row).toMatchObject({ outcome: 'failed', error: 'CLOCK_PUSH_REJECTED', reply: 'ERR: clock cannot go backwards' });
    });
  });

  describe('reading', () => {
    beforeEach(async () => {
      const t = Date.now();
      await harness.db.meshcoreCliHistory.record(histRow({ sourceId: harness.sourceA, targetKind: 'remote', command: 'a-remote', timestamp: t - 3 }));
      await harness.db.meshcoreCliHistory.record(histRow({ sourceId: harness.sourceA, targetKind: 'local', targetPublicKey: null, command: 'a-local', timestamp: t - 2 }));
      await harness.db.meshcoreCliHistory.record(histRow({ sourceId: harness.sourceB, targetKind: 'remote', command: 'b-remote', timestamp: t - 1 }));
    });

    const perSource = (sid: string, qs = '') => `/sources/${sid}/meshcore/cli-history${qs}`;
    const commands = (body: any) => (body.data.entries as Array<{ command: string }>).map(e => e.command).sort();

    it('rejects anonymous callers on both routes', async () => {
      const anon = await harness.loginAs(null);
      expect((await anon.get(perSource(harness.sourceA))).status).toBe(401);
      expect((await anon.get('/meshcore/cli-history')).status).toBe(401);
    });

    it('a user with no grant on the source is refused', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(perSource(harness.sourceA));
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('remote_admin:read shows only remote rows; configuration:read only local', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'read', harness.sourceA);
      let agent = await harness.loginAs(harness.limited);
      let res = await agent.get(perSource(harness.sourceA));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(commands(res.body)).toEqual(['a-remote']);

      await harness.revokeAll(harness.limited.id);
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      agent = await harness.loginAs(harness.limited);
      res = await agent.get(perSource(harness.sourceA));
      expect(commands(res.body)).toEqual(['a-local']);
    });

    it('access to source A never shows source B on either route', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      expect((await agent.get(perSource(harness.sourceB))).status).toBe(403);

      const unified = await agent.get('/meshcore/cli-history');
      expect(unified.status).toBe(200);
      expect(commands(unified.body)).toEqual(['a-local', 'a-remote']);
      expect(JSON.stringify(unified.body)).not.toContain(harness.sourceB);

      const asked = await agent.get(`/meshcore/cli-history?source=${harness.sourceB}`);
      expect(asked.status).toBe(200);
      expect(asked.body.data.entries).toEqual([]);
    });

    it('admins see every source; filters and the cursor work', async () => {
      const agent = await harness.loginAs(harness.admin);
      const all = await agent.get('/meshcore/cli-history');
      expect(commands(all.body)).toEqual(['a-local', 'a-remote', 'b-remote']);

      const onlyB = await agent.get(`/meshcore/cli-history?source=${harness.sourceB}`);
      expect(commands(onlyB.body)).toEqual(['b-remote']);

      const local = await agent.get(perSource(harness.sourceA, '?target=local'));
      expect(commands(local.body)).toEqual(['a-local']);

      const byKey = await agent.get(perSource(harness.sourceA, `?target=${KEY}`));
      expect(commands(byKey.body)).toEqual(['a-remote']);

      const page1 = await agent.get('/meshcore/cli-history?limit=2');
      expect(page1.body.data.entries).toHaveLength(2);
      expect(page1.body.data.nextBefore).toEqual(page1.body.data.entries[1].timestamp);
      expect(page1.body.data.nextBeforeId).toEqual(page1.body.data.entries[1].id);
      const page2 = await agent.get(
        `/meshcore/cli-history?limit=2&before=${page1.body.data.nextBefore}&beforeId=${page1.body.data.nextBeforeId}`,
      );
      expect(page2.body.data.entries).toHaveLength(1);
      expect(page2.body.data.nextBefore).toBeNull();
      expect(page2.body.data.nextBeforeId).toBeNull();
      // A tie-break id makes no sense without the timestamp it breaks.
      expect((await agent.get('/meshcore/cli-history?beforeId=3')).status).toBe(400);
    });

    it('400 on a bad filter', async () => {
      const agent = await harness.loginAs(harness.admin);
      for (const qs of ['?limit=0', '?limit=9999', '?before=abc', '?target=nope', '?from=-1']) {
        const res = await agent.get(perSource(harness.sourceA, qs));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_QUERY');
      }
    });
  });
});
