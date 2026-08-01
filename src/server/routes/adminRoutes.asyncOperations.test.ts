/**
 * Async remote-admin dispatch (#4482).
 *
 * A remote admin command used to hold the HTTP request open for up to 75s
 * (45s passkey poll + 30s routing ACK), which produced upstream 502s behind a
 * reverse proxy. The request now returns 202 with an operation id and the mesh
 * wait happens in the background.
 *
 * What these pin down: the request returns promptly even when the mesh side is
 * still blocked, parameter validation still fails fast with a 400 rather than
 * becoming a failed async operation, the LOCAL path stays synchronous, and
 * ignore/unignore now get the routing ACK that only favorites used to.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import adminRoutes from './adminRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { adminOperationService } from '../services/adminOperationService.js';
import { TxDisabledError } from '../errors/txDisabledError.js';
import { loadProtobufDefinitions } from '../protobufLoader.js';

const LOCAL_NODE_NUM = 1;
const REMOTE_NODE_NUM = 0x0badbeef;

describe('adminRoutes — async remote-admin operations (#4482)', () => {
  let harness: RouteTestHarness;

  function makeFakeManager(overrides: Record<string, unknown>): ISourceManager {
    return {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: LOCAL_NODE_NUM, nodeId: '!00000001', longName: 'Local', shortName: 'LOC' }),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      isTxEnabled: vi.fn().mockReturnValue(true),
      getSessionPasskey: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
      sendAdminCommand: vi.fn().mockResolvedValue(undefined),
      sendAdminCommandAwaitAck: vi.fn().mockResolvedValue({ acked: true, errorReason: 0, timedOut: false }),
      updateCachedDeviceConfig: vi.fn(),
      getSecurityKeys: vi.fn().mockReturnValue({ publicKey: 'pub', privateKey: 'priv' }),
      ...overrides,
    } as unknown as ISourceManager;
  }

  /** Poll the operation endpoint until it settles (or the attempt budget runs out). */
  async function waitForSettled(agent: any, operationId: string, attempts = 60) {
    for (let i = 0; i < attempts; i++) {
      const res = await agent.get(`/operations/${operationId}`);
      const op = res.body?.data;
      if (op && (op.status === 'succeeded' || op.status === 'failed')) return op;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`operation ${operationId} never settled`);
  }

  // The command builders encode real protobufs; without the definitions loaded
  // every build throws and each case fails for the wrong reason.
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', adminRoutes) });
    adminOperationService.clear();
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(harness.sourceA);
    adminOperationService.clear();
    await harness.cleanup();
  });

  describe('remote commands return 202 without waiting for the mesh', () => {
    it('responds 202 with an operation id while the passkey request is still outstanding', async () => {
      // Never resolves for the life of the test — stands in for a node that is
      // not answering. Before #4482 this response would not arrive for 45s.
      const requestRemoteSessionPasskey = vi.fn(() => new Promise(() => {}));
      await sourceManagerRegistry.addManager(makeFakeManager({
        getSessionPasskey: vi.fn().mockReturnValue(null),
        requestRemoteSessionPasskey,
      }));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/commands').send({
        command: 'reboot',
        nodeNum: REMOTE_NODE_NUM,
        sourceId: harness.sourceA,
      });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ success: true });
      expect(typeof res.body.operationId).toBe('string');
      // The background task starts synchronously up to its first await, so by
      // the time this is serialized the operation may already have advanced to
      // 'awaiting_passkey'. Either way it must not be terminal — the whole
      // point is that the response landed while the mesh work is outstanding.
      expect(['pending', 'awaiting_passkey']).toContain(res.body.status);
      expect(requestRemoteSessionPasskey).toHaveBeenCalledWith(REMOTE_NODE_NUM);
    });

    it('reports the passkey wait as a transient status, then settles succeeded', async () => {
      let releasePasskey: (v: Uint8Array) => void = () => {};
      const gate = new Promise<Uint8Array>((resolve) => { releasePasskey = resolve; });
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      await sourceManagerRegistry.addManager(makeFakeManager({
        getSessionPasskey: vi.fn().mockReturnValue(null),
        requestRemoteSessionPasskey: vi.fn(() => gate),
        sendAdminCommand,
      }));

      const agent = await harness.loginAs(harness.admin);
      const accepted = await agent.post('/commands').send({
        command: 'reboot', nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA,
      });
      const { operationId } = accepted.body;

      // Mid-flight: readable, not yet terminal, and nothing has been sent.
      await new Promise((r) => setTimeout(r, 20));
      const midFlight = await agent.get(`/operations/${operationId}`);
      expect(midFlight.status).toBe(200);
      expect(midFlight.body.data.status).toBe('awaiting_passkey');
      expect(sendAdminCommand).not.toHaveBeenCalled();

      releasePasskey(new Uint8Array([9]));
      const settled = await waitForSettled(agent, operationId);
      expect(settled.status).toBe('succeeded');
      expect(settled.result.message).toContain('reboot');
      expect(sendAdminCommand).toHaveBeenCalled();
    });

    it('records a passkey timeout as a failed operation with a machine code', async () => {
      await sourceManagerRegistry.addManager(makeFakeManager({
        getSessionPasskey: vi.fn().mockReturnValue(null),
        requestRemoteSessionPasskey: vi.fn().mockResolvedValue(null),
      }));

      const agent = await harness.loginAs(harness.admin);
      const accepted = await agent.post('/commands').send({
        command: 'reboot', nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA,
      });

      const settled = await waitForSettled(agent, accepted.body.operationId);
      expect(settled.status).toBe('failed');
      expect(settled.error.code).toBe('PASSKEY_TIMEOUT');
    });

    it('records a TX-disabled send as a failed operation carrying TX_DISABLED', async () => {
      await sourceManagerRegistry.addManager(makeFakeManager({
        sendAdminCommand: vi.fn().mockRejectedValue(new TxDisabledError('tx off')),
      }));

      const agent = await harness.loginAs(harness.admin);
      const accepted = await agent.post('/commands').send({
        command: 'reboot', nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA,
      });

      const settled = await waitForSettled(agent, accepted.body.operationId);
      expect(settled.status).toBe('failed');
      expect(settled.error.code).toBe('TX_DISABLED');
    });
  });

  describe('validation still fails fast', () => {
    it('rejects bad params with 400 instead of opening an operation', async () => {
      await sourceManagerRegistry.addManager(makeFakeManager({}));
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post('/commands').send({
        command: 'setOwner', nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA,
      });

      expect(res.status).toBe(400);
      expect(res.body.operationId).toBeUndefined();
      expect(adminOperationService.size()).toBe(0);
    });

    it('rejects an unknown command with 400', async () => {
      await sourceManagerRegistry.addManager(makeFakeManager({}));
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post('/commands').send({
        command: 'notARealCommand', nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA,
      });

      expect(res.status).toBe(400);
      expect(adminOperationService.size()).toBe(0);
    });
  });

  describe('local-node commands stay synchronous', () => {
    it('returns 200 with the result inline and opens no operation', async () => {
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommand }));
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post('/commands').send({
        command: 'reboot', nodeNum: LOCAL_NODE_NUM, sourceId: harness.sourceA,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(res.body.operationId).toBeUndefined();
      expect(sendAdminCommand).toHaveBeenCalled();
      expect(adminOperationService.size()).toBe(0);
    });
  });

  describe('ignore/unignore ACK parity (part B)', () => {
    it.each(['setIgnoredNode', 'removeIgnoredNode'])(
      '%s on a remote node waits for the routing ACK and reports it',
      async (command) => {
        const sendAdminCommandAwaitAck = vi.fn().mockResolvedValue({ acked: true, errorReason: 0, timedOut: false });
        const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
        await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommandAwaitAck, sendAdminCommand }));

        const agent = await harness.loginAs(harness.admin);
        const accepted = await agent.post('/commands').send({
          command, nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA, targetNodeNum: 42,
        });

        const settled = await waitForSettled(agent, accepted.body.operationId);
        expect(settled.status).toBe('succeeded');
        expect(settled.result.ack).toMatchObject({ acked: true, timedOut: false, status: 'confirmed' });
        // The ACK-aware path was used, not fire-and-forget.
        expect(sendAdminCommandAwaitAck).toHaveBeenCalled();
        expect(sendAdminCommand).not.toHaveBeenCalled();
      },
    );

    it('surfaces a routing rejection so the UI can avoid an optimistic update', async () => {
      await sourceManagerRegistry.addManager(makeFakeManager({
        sendAdminCommandAwaitAck: vi.fn().mockResolvedValue({ acked: false, errorReason: 34, timedOut: false }),
      }));

      const agent = await harness.loginAs(harness.admin);
      const accepted = await agent.post('/commands').send({
        command: 'setIgnoredNode', nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA, targetNodeNum: 42,
      });

      const settled = await waitForSettled(agent, accepted.body.operationId);
      expect(settled.result.ack).toMatchObject({ acked: false, timedOut: false });
      expect(settled.result.ack.status).not.toBe('confirmed');
    });

    it('ignore on the LOCAL node stays fire-and-forget (no ACK to wait for)', async () => {
      const sendAdminCommandAwaitAck = vi.fn();
      const sendAdminCommand = vi.fn().mockResolvedValue(undefined);
      await sourceManagerRegistry.addManager(makeFakeManager({ sendAdminCommandAwaitAck, sendAdminCommand }));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/commands').send({
        command: 'setIgnoredNode', nodeNum: LOCAL_NODE_NUM, sourceId: harness.sourceA, targetNodeNum: 42,
      });

      expect(res.status).toBe(200);
      expect(sendAdminCommand).toHaveBeenCalled();
      expect(sendAdminCommandAwaitAck).not.toHaveBeenCalled();
    });
  });

  describe('POST /ensure-session-passkey (follow-up)', () => {
    it('answers immediately from cache without opening an operation', async () => {
      const requestRemoteSessionPasskey = vi.fn(() => new Promise(() => {}));
      await sourceManagerRegistry.addManager(makeFakeManager({
        getSessionPasskey: vi.fn().mockReturnValue(new Uint8Array([1])),
        getSessionPasskeyStatus: vi.fn().mockReturnValue({ hasPasskey: true, remainingSeconds: 250 }),
        requestRemoteSessionPasskey,
      }));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/ensure-session-passkey')
        .send({ nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, hasPasskey: true, remainingSeconds: 250 });
      expect(res.body.operationId).toBeUndefined();
      expect(requestRemoteSessionPasskey).not.toHaveBeenCalled();
    });

    it('returns 202 while acquisition is outstanding, then settles with the status', async () => {
      let release: (v: Uint8Array) => void = () => {};
      const gate = new Promise<Uint8Array>((resolve) => { release = resolve; });
      await sourceManagerRegistry.addManager(makeFakeManager({
        getSessionPasskey: vi.fn().mockReturnValue(null),
        requestRemoteSessionPasskey: vi.fn(() => gate),
        getSessionPasskeyStatus: vi.fn().mockReturnValue({ hasPasskey: true, remainingSeconds: 300 }),
      }));

      const agent = await harness.loginAs(harness.admin);
      const accepted = await agent.post('/ensure-session-passkey')
        .send({ nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA });

      // Would have blocked ~45s before the follow-up.
      expect(accepted.status).toBe(202);
      expect(typeof accepted.body.operationId).toBe('string');

      release(new Uint8Array([7]));
      const settled = await waitForSettled(agent, accepted.body.operationId);
      expect(settled.status).toBe('succeeded');
      expect(settled.result).toMatchObject({ hasPasskey: true, remainingSeconds: 300 });
    });

    it('records a timeout as PASSKEY_TIMEOUT', async () => {
      await sourceManagerRegistry.addManager(makeFakeManager({
        getSessionPasskey: vi.fn().mockReturnValue(null),
        requestRemoteSessionPasskey: vi.fn().mockResolvedValue(null),
      }));

      const agent = await harness.loginAs(harness.admin);
      const accepted = await agent.post('/ensure-session-passkey')
        .send({ nodeNum: REMOTE_NODE_NUM, sourceId: harness.sourceA });

      const settled = await waitForSettled(agent, accepted.body.operationId);
      expect(settled.status).toBe('failed');
      expect(settled.error.code).toBe('PASSKEY_TIMEOUT');
    });

    it('still answers the local node synchronously', async () => {
      await sourceManagerRegistry.addManager(makeFakeManager({}));
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post('/ensure-session-passkey')
        .send({ nodeNum: LOCAL_NODE_NUM, sourceId: harness.sourceA });

      expect(res.status).toBe(200);
      expect(res.body.operationId).toBeUndefined();
      expect(adminOperationService.size()).toBe(0);
    });
  });

  describe('GET /operations/:id', () => {
    it('404s an unknown id', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/operations/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    });

    it('404s another user\'s operation rather than revealing it exists', async () => {
      const operation = adminOperationService.create({
        command: 'reboot', sourceId: harness.sourceA, destinationNodeNum: REMOTE_NODE_NUM,
        userId: harness.admin.id + 999,
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/operations/${operation.id}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    });

    it('404s an owned operation for a requester who is not its owner, session-less included', async () => {
      // An owned operation must not fall visible just because the requester has
      // no session userId — two null principals used to share visibility.
      const operation = adminOperationService.create({
        command: 'reboot', sourceId: harness.sourceA, destinationNodeNum: REMOTE_NODE_NUM,
        userId: harness.admin.id + 12345,
      });

      const agent = await harness.loginAs(harness.admin);
      expect((await agent.get(`/operations/${operation.id}`)).status).toBe(404);
    });

    it('lets the owner read their own operation', async () => {
      const operation = adminOperationService.create({
        command: 'reboot', sourceId: harness.sourceA, destinationNodeNum: REMOTE_NODE_NUM,
        userId: harness.admin.id,
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/operations/${operation.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: operation.id, command: 'reboot' });
    });

    it('requires admin', async () => {
      const operation = adminOperationService.create({
        command: 'reboot', sourceId: harness.sourceA, destinationNodeNum: REMOTE_NODE_NUM, userId: null,
      });

      const anon = await harness.loginAs(null);
      expect((await anon.get(`/operations/${operation.id}`)).status).toBe(401);

      const limited = await harness.loginAs(harness.limited);
      expect((await limited.get(`/operations/${operation.id}`)).status).toBe(403);
    });
  });
});
