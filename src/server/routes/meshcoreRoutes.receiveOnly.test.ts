/**
 * Route test — MeshCore receive-only mode (#4547), 409 TX_DISABLED mapping.
 *
 * Covers Phase 1 WP4 (docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE1_SPEC.md
 * §2.5 / §3.5): the `requireMeshcoreTx()` middleware on every unconditional
 * transmitting route, the inline `rejectIfReceiveOnly()` guard on the two
 * conditional routes, and the `failIfTxDisabled()` catch-block mapping for a
 * mid-request race.
 *
 * Uses `createRouteTestApp()` per CLAUDE.md: real express-session + real auth
 * middleware + real checkPermissionAsync against the singleton's `:memory:`
 * SQLite DB. Only `sourceManagerRegistry` is mocked (non-DB) with a stub
 * MeshCore manager whose `isReceiveOnly()` flag is toggled per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import meshcoreRoutes from './meshcoreRoutes.js';
import { requireMeshcoreTx } from './meshcoreRouteShared.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { TxDisabledError } from '../errors/txDisabledError.js';
import { MESHCORE_RECEIVE_ONLY_MESSAGE } from '../constants/meshcoreTx.js';

const VALID_PK = 'a'.repeat(64);

/**
 * A MeshCore manager stub exposing every method reached by the routes under
 * test, with success-shaped defaults so the "receive-only OFF" negative
 * control exercises real handler logic (not just an unrelated 500/400).
 * `isReceiveOnly()` reads a mutable flag toggled per-test via `setReceiveOnly`.
 * Individual methods can be overridden per-test to simulate a mid-request
 * race (the manager throwing `TxDisabledError` after the pre-check passed).
 */
function makeStubManager(sourceId: string) {
  let receiveOnly = false;
  return {
    sourceId,
    sourceType: 'meshcore' as const,
    setReceiveOnly: (v: boolean) => { receiveOnly = v; },
    isReceiveOnly: () => receiveOnly,
    canTransmit: () => !receiveOnly,

    // ---- reads / connection ----
    getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
    getLocalNode: () => null,
    getContacts: () => [],
    getAllNodes: async () => [],
    getRecentMessages: (_limit?: number) => [],
    getChannelMessages: async () => [],
    getChannelMessageCounts: async () => ({}),
    getChannelLatestTimestamps: async () => ({}),
    isConnected: () => true,
    getLastMeshTxAt: () => 0,
    recordMeshTx: (_now?: number) => {},

    // ---- messaging (RF) ----
    sendMessage: async (..._args: unknown[]) => true,
    loginToRoom: async (..._args: unknown[]) => true,
    loginToRoomWithOutcome: async (..._args: unknown[]) => 'ok' as const,
    sendRoomPost: async (..._args: unknown[]) => true,
    getRoomServers: () => [],
    isRoomLoggedIn: () => false,

    // ---- contacts (RF) ----
    resetContactPath: async (..._args: unknown[]) => true,
    discoverContactPath: async (..._args: unknown[]) => true,
    discoverNodes: async (..._args: unknown[]) => ({ returned: 0, newCount: 0, nodes: [] }),
    discoverRegions: async () => ({ regions: [], byRepeater: {} }),
    traceContactPath: async (..._args: unknown[]) => ({ hops: [], lastSnr: 0 }),
    pingContactZeroHop: async (..._args: unknown[]) => ({
      ok: true, hopHash: 'aa', rttMs: 1, snrToTarget: 1, snrFromTarget: 1,
    }),
    shareContact: async (..._args: unknown[]) => ({ ok: true }),
    getNeighbours: async (..._args: unknown[]) => ({ neighbours: [] }),
    // POST /neighbors/request's remote branch 404s unless this resolves to a
    // Repeater (advType 2) contact — see meshcoreContactsRoutes.ts:1011.
    resolveContactByPrefix: (_prefix: string) => ({ publicKey: VALID_PK, advType: 2, advName: 'stub-repeater', name: 'stub-repeater' }),
    getContact: (_pk: string) => null,

    // ---- serial-only contacts ----
    setContactOutPath: async (..._args: unknown[]) => ({ applied: true, ackConfirmed: true }),
    removeContact: async (..._args: unknown[]) => true,
    forgetLocalContact: async (..._args: unknown[]) => true,
    exportContact: async (..._args: unknown[]) => [1, 2, 3],
    importContact: async (..._args: unknown[]) => true,
    setNodeFavorite: async (..._args: unknown[]) => {},

    // ---- neighbors (conditional route) ----
    // Mirrors the real manager: the remote branch (publicKey present) throws
    // only while receive-only; the local branch (no publicKey) never gates.
    requestNeighbors: async (publicKey?: string) => {
      if (publicKey && receiveOnly) throw new TxDisabledError(MESHCORE_RECEIVE_ONLY_MESSAGE);
      return { neighbors: [] };
    },

    // ---- admin ----
    loginToNode: async (..._args: unknown[]) => true,
    sendCliCommand: async (..._args: unknown[]) => ({ reply: 'ok', elapsedMs: 1 }),
    sendLocalCliCommand: async (command: string) => ({ reply: `ok:${command}`, elapsedMs: 1 }),
    requestNodeStatus: async (..._args: unknown[]) => ({ battery: 100 }),

    // ---- device ----
    connect: async () => true,
    disconnect: async () => {},
    getStatsCore: async () => ({}),
    getStatsRadio: async () => ({}),
    getStatsPackets: async () => ({}),
    sendAdvert: async () => true,

    // ---- serial-only device config ----
    setRespondToDiscovery: async (_enabled: boolean) => {},
    syncDeviceTime: async () => ({ ok: true }),

    // ---- automation ----
    getAutoPathfindingStatus: () => ({ enabled: false, lastRunAt: null }),
    startAutoPathfinding: async () => {},
    getAutoAnnounceStatus: () => ({ lastRunAt: null }),
    runAutoAnnounceCycle: async (_trigger: string) => ({ sent: true }),
    startAutoAnnounce: async () => {},
    startTimerTriggers: async () => {},
    runTimerTrigger: async (_id: string) => ({ ok: true }),
    resetAutoResponderRegexCache: () => {},
    previewAnnouncementMessage: async (_msg: string) => '',
  };
}

type StubManager = ReturnType<typeof makeStubManager>;

// The registry mock is hoisted; build it once and mutate the manager map from
// inside each test via the exported `__managers` handle.
const managers = new Map<string, StubManager>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => managers.get(sourceId),
    getAllManagers: () => Array.from(managers.values()),
  },
}));

describe('MeshCore receive-only — 409 TX_DISABLED mapping (#4547)', () => {
  let harness: RouteTestHarness;
  let mgr: StubManager;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    mgr = makeStubManager(harness.sourceA);
    managers.set(harness.sourceA, mgr);
  });

  afterEach(async () => {
    managers.clear();
    await harness.cleanup();
  });

  const base = (sourceId: string) => `/sources/${sourceId}/meshcore`;

  /** Every unconditionally-gated route from spec §2.5.2, with a valid request. */
  const unconditionalRoutes: Array<{
    name: string;
    method: 'get' | 'post';
    path: string;
    body?: Record<string, unknown>;
  }> = [
    { name: 'POST /messages/send', method: 'post', path: '/messages/send', body: { text: 'hi' } },
    { name: 'POST /rooms/login', method: 'post', path: '/rooms/login', body: { publicKey: VALID_PK, password: '' } },
    { name: 'POST /rooms/login-with-saved', method: 'post', path: '/rooms/login-with-saved', body: { publicKey: VALID_PK } },
    { name: 'POST /rooms/post', method: 'post', path: '/rooms/post', body: { roomPublicKey: VALID_PK, text: 'hi' } },
    { name: 'POST /contacts/:publicKey/reset-path', method: 'post', path: `/contacts/${VALID_PK}/reset-path` },
    { name: 'POST /contacts/:publicKey/discover-path', method: 'post', path: `/contacts/${VALID_PK}/discover-path` },
    { name: 'POST /discover', method: 'post', path: '/discover', body: { mode: 'nearby' } },
    { name: 'POST /regions/discover', method: 'post', path: '/regions/discover' },
    { name: 'POST /contacts/:publicKey/trace-path', method: 'post', path: `/contacts/${VALID_PK}/trace-path` },
    { name: 'POST /contacts/:publicKey/ping', method: 'post', path: `/contacts/${VALID_PK}/ping` },
    { name: 'POST /contacts/:publicKey/share', method: 'post', path: `/contacts/${VALID_PK}/share` },
    { name: 'GET /contacts/:publicKey/neighbours', method: 'get', path: `/contacts/${VALID_PK}/neighbours` },
    { name: 'POST /nodes/:publicKey/telemetry/poll', method: 'post', path: `/nodes/${VALID_PK}/telemetry/poll`, body: { type: 'status' } },
    { name: 'POST /nodes/:publicKey/neighbours/poll', method: 'post', path: `/nodes/${VALID_PK}/neighbours/poll` },
    { name: 'POST /admin/login', method: 'post', path: '/admin/login', body: { publicKey: VALID_PK, password: '' } },
    { name: 'POST /admin/cli', method: 'post', path: '/admin/cli', body: { publicKey: VALID_PK, command: 'ver' } },
    { name: 'POST /admin/login-with-saved', method: 'post', path: '/admin/login-with-saved', body: { publicKey: VALID_PK } },
    { name: 'GET /admin/status/:publicKey', method: 'get', path: `/admin/status/${VALID_PK}` },
    { name: 'POST /advert', method: 'post', path: '/advert' },
    { name: 'POST /automation/announce/send', method: 'post', path: '/automation/announce/send' },
    { name: 'POST /automation/timers/:triggerId/run', method: 'post', path: '/automation/timers/t1/run' },
  ];

  it('sanity: exactly 21 unconditional routes are under test (spec §2.5.2)', () => {
    expect(unconditionalRoutes).toHaveLength(21);
  });

  describe.each(unconditionalRoutes)('$name', ({ method, path }) => {
    it('returns 409 TX_DISABLED while receive-only', async () => {
      mgr.setReceiveOnly(true);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent[method](base(harness.sourceA) + path).send({});
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        success: false,
        code: 'TX_DISABLED',
        error: MESHCORE_RECEIVE_ONLY_MESSAGE,
      });
    });

    it('does not return 409 while receive-only is off', async () => {
      mgr.setReceiveOnly(false);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent[method](base(harness.sourceA) + path).send({});
      expect(res.status).not.toBe(409);
    });
  });

  describe('ordering — 403 beats 409', () => {
    it('an unauthorized caller on a receive-only source gets 403, not 409', async () => {
      mgr.setReceiveOnly(true);
      // No grants for `limited` — requirePermission must fire before requireMeshcoreTx.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(base(harness.sourceA) + '/messages/send').send({ text: 'hi' });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /cli (local, conditional — meshcoreAdminRoutes.ts:230)', () => {
    it('returns 409 for the advert verb while receive-only', async () => {
      mgr.setReceiveOnly(true);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(base(harness.sourceA) + '/cli').send({ command: 'advert' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'TX_DISABLED' });
    });

    it('does not gate the ver verb while receive-only', async () => {
      mgr.setReceiveOnly(true);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(base(harness.sourceA) + '/cli').send({ command: 'ver' });
      expect(res.status).not.toBe(409);
    });

    it('advert still works when receive-only is off', async () => {
      mgr.setReceiveOnly(false);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(base(harness.sourceA) + '/cli').send({ command: 'advert' });
      expect(res.status).not.toBe(409);
    });
  });

  describe('POST /neighbors/request (conditional — meshcoreContactsRoutes.ts:1011)', () => {
    it('returns 409 when a publicKey is supplied (remote branch) while receive-only', async () => {
      mgr.setReceiveOnly(true);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(base(harness.sourceA) + '/neighbors/request')
        .send({ publicKey: VALID_PK });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'TX_DISABLED' });
    });

    it('does not return 409 without a publicKey (local branch) while receive-only', async () => {
      mgr.setReceiveOnly(true);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(base(harness.sourceA) + '/neighbors/request').send({});
      expect(res.status).not.toBe(409);
      expect(res.status).toBe(200);
    });
  });

  describe('serial-config / read / connect routes stay unaffected while receive-only', () => {
    beforeEach(() => {
      mgr.setReceiveOnly(true);
    });

    it('POST /config/discoverable still succeeds', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(base(harness.sourceA) + '/config/discoverable')
        .send({ enabled: true });
      expect(res.status).toBe(200);
    });

    it('POST /config/sync-time still succeeds', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(base(harness.sourceA) + '/config/sync-time').send({});
      expect(res.status).toBe(200);
    });

    it('PUT /contacts/:publicKey/out-path still succeeds', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .put(base(harness.sourceA) + `/contacts/${VALID_PK}/out-path`)
        .send({ outPath: '' });
      expect(res.status).toBe(200);
    });

    it('GET /contacts still succeeds', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base(harness.sourceA) + '/contacts');
      expect(res.status).toBe(200);
    });

    it('GET /messages still succeeds', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base(harness.sourceA) + '/messages');
      expect(res.status).toBe(200);
    });
  });

  describe('race mapping — mid-request TxDisabledError maps to 409, not 500', () => {
    it('POST /messages/send: receive-only OFF at the pre-check, but the primitive throws', async () => {
      mgr.setReceiveOnly(false); // requireMeshcoreTx() passes
      mgr.sendMessage = async () => {
        throw new TxDisabledError(MESHCORE_RECEIVE_ONLY_MESSAGE);
      };
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(base(harness.sourceA) + '/messages/send').send({ text: 'hi' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'TX_DISABLED' });
    });

    it('POST /neighbors/request (conditional, no pre-check): the primitive throws and still maps to 409', async () => {
      // No middleware gates this route at all, so the only way it can 409 is
      // the manager primitive itself throwing — simulate that directly rather
      // than relying on the receive-only flag (see the dedicated conditional
      // test above for the flag-driven path).
      mgr.setReceiveOnly(false);
      mgr.requestNeighbors = async () => {
        throw new TxDisabledError(MESHCORE_RECEIVE_ONLY_MESSAGE);
      };
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(base(harness.sourceA) + '/neighbors/request')
        .send({ publicKey: VALID_PK });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'TX_DISABLED' });
    });
  });
});

describe('requireMeshcoreTx() fails closed when the manager is unresolved (code review, #4550)', () => {
  /**
   * meshcoreRouteGuard always populates res.locals.meshcoreManager before
   * requireMeshcoreTx runs in the real router chain, so this exercises the
   * middleware directly to prove it refuses the request rather than passing
   * it through when that invariant is somehow violated (guard skipped, or a
   * future manager type lacking isReceiveOnly()).
   */
  it('returns 404 and never calls next() when res.locals.meshcoreManager is absent', () => {
    const req = { params: { id: 'missing-source' } } as unknown as Request;
    const jsonMock = vi.fn();
    const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    const res = { locals: {}, status: statusMock } as unknown as Response;
    const next = vi.fn();

    requireMeshcoreTx()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      error: 'No MeshCore manager for source missing-source',
    });
  });
});
