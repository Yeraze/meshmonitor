/**
 * Per-source scoping for reads that take an OPTIONAL `sourceId` and decide
 * access inside the handler:
 *
 *   - `GET /nodes`, `GET /nodes/active`
 *   - `GET /messages/unread-counts`, `GET /messages/first-unread`
 *   - `GET /nodes/:nodeId/position-history`, `GET /nodes/:nodeId/positions`
 *   - `GET /connection`, `GET /connection/info`, `GET /virtual-node/status`
 *
 * and for the two install-wide jobs that are admin only:
 *
 *   - `POST /settings/auto-enrichment/run-now`
 *   - `POST /settings/position-estimation/run-now`
 *
 * Each read is driven through the real auth middleware with real permission
 * rows. Source B's rows carry marker values; a caller with grants on source A
 * only must never see one, in any field, so the tests search the serialized
 * body for them.
 *
 * Managers are fakes. Nothing is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';

import nodesRoutes from './nodesRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import messageRoutes from './messageRoutes.js';
import connectionRoutes from './connectionRoutes.js';
import statusRoutes from './statusRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadAllNodesAsDeviceInfo } from '../utils/dbNodeMapper.js';
import { getPermissionGate, isAdminGate } from '../auth/authMiddleware.js';
import { getDeviceSourceGate } from '../utils/deviceSourcePermission.js';
import { listPermittedSourceIds, loadSourcePermissions } from '../utils/sourceScopedAccess.js';
import { positionEstimationScheduler } from '../services/positionEstimationScheduler.js';
import { autoEnrichmentScheduler } from '../services/autoEnrichmentScheduler.js';

const SHARED_NUM = 0x11111111;
const SHARED_ID = '!11111111';
const ONLY_B_NUM = 0x0b0b0b0b;
const ONLY_B_ID = '!0b0b0b0b';
const LOCAL_ID = '!000003e7';

/** Values that exist on source B only. None may reach a caller without a grant on B. */
const B = {
  name: 'ZZ-MARKER-B',
  onlyName: 'ZZ-ONLY-B',
  lat: 22.2222,
  privateLat: 33.3333,
  nodeIp: '10.66.66.66',
  clientIp: '10.77.77.77',
  uptime: 424242,
};
const A = {
  name: 'AA-MARKER-A',
  lat: 11.1111,
  nodeIp: '10.11.11.11',
  clientIp: '10.12.12.12',
  uptime: 131313,
};
const B_MARKERS = [B.name, B.onlyName, String(B.lat), String(B.privateLat), B.nodeIp, B.clientIp, String(B.uptime)];

const text = (body: unknown): string => JSON.stringify(body ?? null);
const expectNoB = (body: unknown, sourceB: string): void => {
  const serialized = text(body);
  for (const marker of [...B_MARKERS, sourceB]) expect(serialized, `leaked ${marker}`).not.toContain(marker);
};

describe('reads with an optional sourceId: each row is checked on its own source', () => {
  let harness: RouteTestHarness;
  let limited: SeededUser;

  const fakeManager = (sourceId: string, marks: { nodeIp: string; clientIp: string }): ISourceManager =>
    ({
      sourceId,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: `name of ${sourceId}`, sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: 999, nodeId: LOCAL_ID, longName: 'local', shortName: 'L' }),
      // The real read, so the route's per-source filter is what the test sees.
      getAllNodesAsync: vi.fn((id?: string) => loadAllNodesAsDeviceInfo(id)),
      getConnectionStatus: vi.fn().mockResolvedValue({
        connected: true,
        nodeResponsive: true,
        configuring: false,
        nodeIp: marks.nodeIp,
        userDisconnected: false,
      }),
      virtualNodeServer: {
        isRunning: () => true,
        isAdminCommandsAllowed: () => false,
        getClientCount: () => 1,
        getClientDetails: () => [{ id: 'c1', ip: marks.clientIp, connectedAt: new Date(0), lastActivity: new Date(0) }],
      },
    }) as unknown as ISourceManager;

  /** One permission row carrying several actions (the harness's `grant` writes one action per row). */
  const give = async (
    resource: string,
    actions: Array<'read' | 'write' | 'viewOnMap'>,
    sourceId?: string,
    userId: number = limited.id,
  ): Promise<void> => {
    await databaseService.auth.createPermission({
      userId,
      resource,
      canRead: actions.includes('read'),
      canWrite: actions.includes('write'),
      canViewOnMap: actions.includes('viewOnMap'),
      sourceId: sourceId ?? null,
      grantedAt: Date.now(),
      grantedBy: null,
    } as never);
  };

  /** What a user needs to see a source's nodes, positions and unread state. */
  const giveReads = async (sourceId: string, userId: number = limited.id): Promise<void> => {
    await give('channel_0', ['read', 'viewOnMap'], sourceId, userId);
    await give('messages', ['read'], sourceId, userId);
  };

  const seed = async (sourceId: string, mark: { name: string; lat: number; uptime: number }, unread: number, firstUnreadAt: number): Promise<void> => {
    const nowSec = Math.floor(Date.now() / 1000);
    await databaseService.nodes.upsertNode(
      { nodeNum: SHARED_NUM, nodeId: SHARED_ID, longName: mark.name, shortName: 'S', hwModel: 43, channel: 0, lastHeard: nowSec, latitude: mark.lat, longitude: mark.lat },
      sourceId,
    );
    // Node rows outlive a test: clear a private override an earlier one set.
    await databaseService.setNodePositionOverrideAsync(SHARED_NUM, false, sourceId, undefined, undefined, undefined, false);
    const at = Date.now() - 60_000;
    for (const [telemetryType, value] of [['latitude', mark.lat], ['longitude', mark.lat], ['uptimeSeconds', mark.uptime]] as const) {
      await databaseService.telemetry.insertTelemetry(
        { nodeId: SHARED_ID, nodeNum: SHARED_NUM, telemetryType, timestamp: at, value, createdAt: at, channel: 0 },
        sourceId,
      );
    }
    for (let i = 0; i < unread; i++) {
      await databaseService.messages.insertMessage(
        {
          id: `${sourceId}_ch_${i}`, fromNodeNum: SHARED_NUM, toNodeNum: 0xffffffff, fromNodeId: SHARED_ID, toNodeId: '!ffffffff',
          text: `channel ${mark.name}`, channel: 0, portnum: 1, timestamp: firstUnreadAt + i, rxTime: firstUnreadAt + i, createdAt: firstUnreadAt + i,
        } as never,
        sourceId,
      );
      await databaseService.messages.insertMessage(
        {
          id: `${sourceId}_dm_${i}`, fromNodeNum: SHARED_NUM, toNodeNum: 999, fromNodeId: SHARED_ID, toNodeId: LOCAL_ID,
          text: `dm ${mark.name}`, channel: -1, portnum: 1, timestamp: firstUnreadAt + i, rxTime: firstUnreadAt + i, createdAt: firstUnreadAt + i,
        } as never,
        sourceId,
      );
    }
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/', nodesRoutes);
        app.use('/settings', settingsRoutes);
        app.use('/messages', messageRoutes);
        app.use('/connection', connectionRoutes);
        app.use('/', statusRoutes);
      },
    });
    limited = harness.limited;
    // A is registered first, so it is the primary Meshtastic source.
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceA, A));
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceB, B));
    await seed(harness.sourceA, A, 1, 2_000_000);
    await seed(harness.sourceB, B, 2, 1_000_000);
    // A node only source B has heard.
    await databaseService.nodes.upsertNode(
      { nodeNum: ONLY_B_NUM, nodeId: ONLY_B_ID, longName: B.onlyName, shortName: 'O', hwModel: 43, channel: 0, lastHeard: Math.floor(Date.now() / 1000) },
      harness.sourceB,
    );
  });

  afterEach(async () => {
    // Message rows outlive a test; the counts below depend on them.
    await databaseService.messages.deleteAllMessages(harness.sourceA);
    await databaseService.messages.deleteAllMessages(harness.sourceB);
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await sourceManagerRegistry.removeManager(harness.sourceB);
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  const names = (body: Array<{ longName?: string; user?: { longName?: string } }>): string[] =>
    body.map((n) => n.longName ?? n.user?.longName ?? '').sort();

  // ── GET /nodes, GET /nodes/active ─────────────────────────────────────────
  describe.each(['/nodes', '/nodes/active'])('GET %s', (url) => {
    it('with no sourceId, returns only the rows of the source the caller holds a channel grant on', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get(url);

      expect(res.status).toBe(200);
      expect(names(res.body)).toEqual([A.name]);
      expectNoB(res.body, harness.sourceB);
    });

    it('naming a source the caller holds nothing on returns no rows', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get(url).query({ sourceId: harness.sourceB });

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('naming the permitted source returns that source only', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get(url).query({ sourceId: harness.sourceA });

      expect(names(res.body)).toEqual([A.name]);
      expectNoB(res.body, harness.sourceB);
    });

    it('gives an anonymous caller nothing', async () => {
      const agent = await harness.loginAs(null);

      const res = await agent.get(url);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('checks the channel on the row\'s own source: channel_0 on A does not show channel-0 rows of B', async () => {
      // The grant that used to leak: a channel grant on A, merged across sources.
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      await give('channel_1', ['viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const res = await agent.get(url);

      expect(names(res.body)).toEqual([A.name]);
      expectNoB(res.body, harness.sourceB);
    });

    it('an admin and a user with grants on every source see every source', async () => {
      const admin = await harness.loginAs(harness.admin);
      const all = await admin.get(url);
      expect(text(all.body)).toContain(B.onlyName);

      await giveReads(harness.sourceA);
      await giveReads(harness.sourceB);
      const agent = await harness.loginAs(limited);
      const mine = await agent.get(url);

      // The shared node (one merged row on /nodes, one row per source on
      // /nodes/active) and the node only B has heard. The admin also sees
      // rows on sources outside this test.
      expect(names(mine.body)).toContain(B.onlyName);
      expect(new Set(mine.body.map((n: { nodeNum: number }) => n.nodeNum))).toEqual(new Set([SHARED_NUM, ONLY_B_NUM]));
      for (const name of names(mine.body)) expect(names(all.body)).toContain(name);
    });

    it('a private position override on B is hidden unless nodes_private:read is held on B', async () => {
      await databaseService.setNodePositionOverrideAsync(SHARED_NUM, true, harness.sourceB, B.privateLat, B.privateLat, 0, true);
      await giveReads(harness.sourceA);
      await giveReads(harness.sourceB);
      // On A only: it used to unmask every source's private overrides.
      await give('nodes_private', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const hidden = await agent.get(url);
      expect(text(hidden.body)).not.toContain(String(B.privateLat));
      const named = await agent.get(url).query({ sourceId: harness.sourceB });
      expect(text(named.body)).not.toContain(String(B.privateLat));

      await give('nodes_private', ['read'], harness.sourceB);
      const shown = await agent.get(url).query({ sourceId: harness.sourceB });
      expect(text(shown.body)).toContain(String(B.privateLat));
    });
  });

  it('GET /nodes reads uptime only from the sources of the rows it returns', async () => {
    await giveReads(harness.sourceA);
    const agent = await harness.loginAs(limited);

    const res = await agent.get('/nodes');

    expect(res.body[0].uptimeSeconds).toBe(A.uptime);
    expect(text(res.body)).not.toContain(String(B.uptime));
  });

  // ── GET /messages/unread-counts, GET /messages/first-unread ───────────────
  describe('GET /messages/unread-counts', () => {
    it('with no sourceId, counts only the sources the caller may read', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/messages/unread-counts');

      expect(res.status).toBe(200);
      // A holds 1 unread channel message and 1 unread DM; B holds 2 of each.
      expect(res.body).toEqual({ channels: { 0: 1 }, directMessages: { [SHARED_ID]: 1 } });
    });

    it('403s naming a source the caller holds nothing on', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/messages/unread-counts').query({ sourceId: harness.sourceB });

      expect(res.status).toBe(403);
      expectNoB(res.body, harness.sourceB);
    });

    it('checks each channel on its own source: channel_0:read on A does not count B\'s channel 0', async () => {
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
      // Reaches the handler for B (messages:read) without channel_0 there.
      await give('messages', ['read'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/messages/unread-counts');

      expect(res.body.channels).toEqual({ 0: 1 });
      // No channel grant on B, so B's DM sender is not visible either.
      expect(res.body.directMessages ?? {}).toEqual({});
    });

    it('a channel grant on A does not open the same channel number on B', async () => {
      const at = 3_000_000;
      await databaseService.messages.insertMessage(
        {
          id: `${harness.sourceB}_ch1`, fromNodeNum: SHARED_NUM, toNodeNum: 0xffffffff, fromNodeId: SHARED_ID, toNodeId: '!ffffffff',
          text: `channel one ${B.name}`, channel: 1, portnum: 1, timestamp: at, rxTime: at, createdAt: at,
        } as never,
        harness.sourceB,
      );
      await give('channel_0', ['read'], harness.sourceA);
      await give('channel_0', ['read'], harness.sourceB);
      await give('channel_1', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      // Channel 1 has unread messages on B only, and the grant is on A only.
      expect((await agent.get('/messages/unread-counts')).body.channels).toEqual({ 0: 3 });
      expect((await agent.get('/messages/unread-counts').query({ sourceId: harness.sourceB })).body.channels).toEqual({ 0: 2 });
      expect((await agent.get('/messages/first-unread')).body.data.channels).toEqual({ 0: 1_000_000 });

      await give('channel_1', ['read'], harness.sourceB);
      expect((await agent.get('/messages/unread-counts')).body.channels).toEqual({ 0: 3, 1: 1 });
    });

    it('sums every source for a user with grants on both, as it does for an admin', async () => {
      const admin = await harness.loginAs(harness.admin);
      const all = await admin.get('/messages/unread-counts');
      expect(all.body.channels).toEqual({ 0: 3 });

      await giveReads(harness.sourceA);
      await giveReads(harness.sourceB);
      const agent = await harness.loginAs(limited);
      const mine = await agent.get('/messages/unread-counts');

      expect(mine.body).toEqual({ channels: { 0: 3 }, directMessages: { [SHARED_ID]: 3 } });
    });

    it('403s for an anonymous caller and for a signed-in user with no grant', async () => {
      expect((await (await harness.loginAs(null)).get('/messages/unread-counts')).status).toBe(403);
      expect((await (await harness.loginAs(limited)).get('/messages/unread-counts')).status).toBe(403);
    });
  });

  describe('GET /messages/first-unread', () => {
    it('with no sourceId, reads only the sources the caller may read', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/messages/first-unread');

      expect(res.status).toBe(200);
      // B's oldest unread is older (1_000_000) and must not be the answer.
      expect(res.body.data).toEqual({ channels: { 0: 2_000_000 }, directMessages: { [SHARED_ID]: 2_000_000 } });
    });

    it('403s naming a source the caller holds nothing on', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);
      expect((await agent.get('/messages/first-unread').query({ sourceId: harness.sourceB })).status).toBe(403);
    });

    it('returns the oldest across both sources for a user with grants on both, as for an admin', async () => {
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.get('/messages/first-unread')).body.data.channels).toEqual({ 0: 1_000_000 });

      await giveReads(harness.sourceA);
      await giveReads(harness.sourceB);
      const agent = await harness.loginAs(limited);
      expect((await agent.get('/messages/first-unread')).body.data).toEqual({
        channels: { 0: 1_000_000 },
        directMessages: { [SHARED_ID]: 1_000_000 },
      });
    });

    it('403s for an anonymous caller', async () => {
      expect((await (await harness.loginAs(null)).get('/messages/first-unread')).status).toBe(403);
    });
  });

  // ── GET /nodes/:nodeId/position-history, /positions ───────────────────────
  describe.each(['position-history', 'positions'])('GET /nodes/:nodeId/%s', (leaf) => {
    const url = `/nodes/${SHARED_ID}/${leaf}`;
    // Distinct latitudes: telemetry rows outlive a test, so a source holds
    // one fix per test run so far, all with that source's latitude.
    const lats = (body: Array<{ latitude: number }>): number[] => [...new Set(body.map((p) => p.latitude))].sort();

    it('with no sourceId, returns only the fixes of the source the caller may see the node on', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get(url);

      expect(res.status).toBe(200);
      expect(lats(res.body)).toEqual([A.lat]);
      expectNoB(res.body, harness.sourceB);
    });

    it('403s naming a source the caller holds nothing on', async () => {
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get(url).query({ sourceId: harness.sourceB });

      expect(res.status).toBe(403);
      expectNoB(res.body, harness.sourceB);
    });

    it('naming the permitted source returns that source\'s fixes only', async () => {
      // It used to return every source's fixes once the caller passed the check on A.
      await giveReads(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get(url).query({ sourceId: harness.sourceA });

      expect(lats(res.body)).toEqual([A.lat]);
      expectNoB(res.body, harness.sourceB);
    });

    it('an admin naming one source gets that source only; with none, every source', async () => {
      const admin = await harness.loginAs(harness.admin);
      expect(lats((await admin.get(url).query({ sourceId: harness.sourceB })).body)).toEqual([B.lat]);
      expect(lats((await admin.get(url)).body)).toEqual([A.lat, B.lat]);
    });

    it('a user with grants on both sources gets both', async () => {
      await giveReads(harness.sourceA);
      await giveReads(harness.sourceB);
      const agent = await harness.loginAs(limited);
      expect(lats((await agent.get(url)).body)).toEqual([A.lat, B.lat]);
    });

    it('403s for an anonymous caller', async () => {
      expect((await (await harness.loginAs(null)).get(url)).status).toBe(403);
    });

    it('leaves out a source where the position is private and nodes_private:read is not held there', async () => {
      await databaseService.setNodePositionOverrideAsync(SHARED_NUM, true, harness.sourceB, B.privateLat, B.privateLat, 0, true);
      await giveReads(harness.sourceA);
      await giveReads(harness.sourceB);
      await give('nodes_private', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      expect(lats((await agent.get(url)).body)).toEqual([A.lat]);
      const named = await agent.get(url).query({ sourceId: harness.sourceB });
      expect(named.status).toBe(200);
      expect(named.body).toEqual([]);

      await give('nodes_private', ['read'], harness.sourceB);
      expect(lats((await agent.get(url)).body)).toEqual([A.lat, B.lat]);
    });
  });

  // ── Connection reads ──────────────────────────────────────────────────────
  const REDUCED = { connected: true, nodeResponsive: true, configuring: false, userDisconnected: false };

  describe('GET /connection', () => {
    it('gives a caller without connection:read on the source the link flags and nothing else', async () => {
      const anon = await harness.loginAs(null);
      expect((await anon.get('/connection').query({ sourceId: harness.sourceB })).body).toEqual(REDUCED);
      expect((await anon.get('/connection')).body).toEqual(REDUCED);

      // sources:read alone used to be enough for the address.
      await give('sources', ['read']);
      await give('connection', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);
      const res = await agent.get('/connection').query({ sourceId: harness.sourceB });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(REDUCED);
      expectNoB(res.body, harness.sourceB);
    });

    it('gives the full status without the address to connection:read, and the address with sources:read too', async () => {
      await give('connection', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);
      const withoutAddress = await agent.get('/connection').query({ sourceId: harness.sourceA });
      expect(withoutAddress.body).toEqual(REDUCED);
      expect(text(withoutAddress.body)).not.toContain(A.nodeIp);

      await give('sources', ['read']);
      const withAddress = await agent.get('/connection').query({ sourceId: harness.sourceA });
      expect(withAddress.body).toEqual({ ...REDUCED, nodeIp: A.nodeIp });
      // No sourceId is the primary source (A).
      expect((await agent.get('/connection')).body.nodeIp).toBe(A.nodeIp);
    });

    it('gives an admin the address of either source', async () => {
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.get('/connection').query({ sourceId: harness.sourceB })).body.nodeIp).toBe(B.nodeIp);
    });
  });

  describe('GET /connection/info', () => {
    it('401s for an anonymous caller', async () => {
      expect((await (await harness.loginAs(null)).get('/connection/info')).status).toBe(401);
    });

    it('gives a signed-in caller without connection:read on the source the link flags only', async () => {
      await give('sources', ['read']);
      await give('connection', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/connection/info').query({ sourceId: harness.sourceB });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(REDUCED);
    });

    it('gives ports to connection:read and addresses to connection:read with sources:read', async () => {
      await give('connection', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);
      const ports = await agent.get('/connection/info').query({ sourceId: harness.sourceA });
      expect(ports.body).toMatchObject({ ...REDUCED, isOverridden: false });
      expect(ports.body.tcpPort).toEqual(expect.any(Number));
      expect(ports.body).not.toHaveProperty('nodeIp');
      expect(ports.body).not.toHaveProperty('defaultIp');

      await give('sources', ['read']);
      const full = await agent.get('/connection/info').query({ sourceId: harness.sourceA });
      expect(full.body.nodeIp).toBe(A.nodeIp);
      expect(full.body).toHaveProperty('defaultIp');
    });

    it('gives an admin everything', async () => {
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.get('/connection/info').query({ sourceId: harness.sourceB })).body.nodeIp).toBe(B.nodeIp);
    });
  });

  describe('GET /virtual-node/status', () => {
    const ids = (body: { sources: Array<{ sourceId: string }> }): string[] => body.sources.map((s) => s.sourceId).sort();

    it('401s for an anonymous caller', async () => {
      expect((await (await harness.loginAs(null)).get('/virtual-node/status')).status).toBe(401);
    });

    it('lists no source to a signed-in user with no connection:read', async () => {
      await give('sources', ['read']);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/virtual-node/status');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sources: [] });
    });

    it('lists only the sources the caller holds connection:read on, without client addresses', async () => {
      await give('connection', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/virtual-node/status');

      expect(ids(res.body)).toEqual([harness.sourceA]);
      expect(res.body.sources[0]).toMatchObject({ enabled: true, clientCount: 1, clients: [] });
      expect(text(res.body)).not.toContain(A.clientIp);
      expectNoB(res.body, harness.sourceB);
    });

    it('adds the client list for a caller who also holds sources:read', async () => {
      await give('connection', ['read'], harness.sourceA);
      await give('sources', ['read']);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/virtual-node/status');

      expect(ids(res.body)).toEqual([harness.sourceA]);
      expect(res.body.sources[0].clients[0].ip).toBe(A.clientIp);
      expectNoB(res.body, harness.sourceB);
    });

    it('lists every source with its clients to an admin', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.get('/virtual-node/status');
      expect(ids(res.body)).toEqual([harness.sourceA, harness.sourceB].sort());
      expect(text(res.body)).toContain(B.clientIp);
    });
  });

  // ── Install-wide jobs: admin only ─────────────────────────────────────────
  describe('install-wide jobs are admin only', () => {
    let estimation: ReturnType<typeof vi.spyOn>;
    let enrichment: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      estimation = vi.spyOn(positionEstimationScheduler, 'runNow').mockResolvedValue({
        estimatedNodeCount: 0, observationCount: 0, anchorCount: 0, rejectedNodeCount: 0, durationMs: 0,
      } as never);
      enrichment = vi.spyOn(autoEnrichmentScheduler, 'runNow').mockResolvedValue({
        startedAt: 0, finishedAt: 0, nodesFilled: 0, fieldsCopied: 0, pushesSent: 0, pushesFailed: 0, pushesPending: 0, trigger: 'manual',
      } as never);
    });

    it.each(['/settings/position-estimation/run-now', '/settings/auto-enrichment/run-now'])(
      'POST %s: 403 for settings:write on every source, and the job does not run',
      async (url) => {
        await give('settings', ['read', 'write'], harness.sourceA);
        await give('settings', ['read', 'write'], harness.sourceB);
        const agent = await harness.loginAs(limited);

        const res = await agent.post(url).send({});

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN_ADMIN');
        expect(estimation).not.toHaveBeenCalled();
        expect(enrichment).not.toHaveBeenCalled();
      },
    );

    it.each(['/settings/position-estimation/run-now', '/settings/auto-enrichment/run-now'])(
      'POST %s: 401 for an anonymous caller',
      async (url) => {
        const res = await (await harness.loginAs(null)).post(url).send({});
        expect(res.status).toBe(401);
        expect(estimation).not.toHaveBeenCalled();
        expect(enrichment).not.toHaveBeenCalled();
      },
    );

    it('an admin runs each job', async () => {
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.post('/settings/position-estimation/run-now').send({})).status).toBe(200);
      expect(estimation).toHaveBeenCalledTimes(1);
      expect((await admin.post('/settings/auto-enrichment/run-now').send({})).status).toBe(200);
      expect(enrichment).toHaveBeenCalledTimes(1);
    });

    it('the status reads stay open to settings:read and carry install-wide totals only', async () => {
      await give('settings', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);
      for (const url of ['/settings/position-estimation/status', '/settings/auto-enrichment/status']) {
        const res = await agent.get(url);
        expect(res.status).toBe(200);
        expectNoB(res.body, harness.sourceB);
        expect(text(res.body)).not.toContain(harness.sourceA);
      }
    });
  });

  // ── The permitted-source list ─────────────────────────────────────────────
  describe('listPermittedSourceIds / loadSourcePermissions', () => {
    it('lists the sources a grant is held on, with one grants query however many sources there are', async () => {
      await give('nodes', ['read'], harness.sourceA);
      await give('nodes', ['write'], harness.sourceB);
      const user = { id: limited.id, username: limited.username, isAdmin: false } as never;
      const perSource = vi.spyOn(databaseService, 'checkPermissionAsync');
      const grants = vi.spyOn(databaseService.auth, 'getPermissionsForUser');

      expect(await listPermittedSourceIds(user, 'nodes', 'read')).toEqual([harness.sourceA]);
      expect(await listPermittedSourceIds(user, 'nodes', 'write')).toEqual([harness.sourceB]);
      expect(await listPermittedSourceIds(user, 'settings', 'read')).toEqual([]);

      expect(perSource).not.toHaveBeenCalled();
      expect(grants).toHaveBeenCalledTimes(3);
    });

    it('agrees with checkPermissionAsync for every resource, action and source', async () => {
      await give('nodes', ['read'], harness.sourceA);
      await give('channel_0', ['viewOnMap'], harness.sourceB);
      await give('sources', ['read']);
      const user = { id: limited.id, username: limited.username, isAdmin: false } as never;
      const permissions = await loadSourcePermissions(user);
      for (const resource of ['nodes', 'channel_0', 'sources', 'settings'] as const) {
        for (const action of ['read', 'write', 'viewOnMap'] as const) {
          for (const sourceId of [harness.sourceA, harness.sourceB]) {
            expect(permissions.can(resource, action, sourceId), `${resource}:${action}@${sourceId}`).toBe(
              await databaseService.checkPermissionAsync(limited.id, resource, action, sourceId),
            );
          }
        }
      }
    });

    it('refuses to list sources for an admin, who is not limited to a list', async () => {
      const permissions = await loadSourcePermissions({ id: harness.admin.id, isAdmin: true } as never);
      expect(permissions.isAdmin).toBe(true);
      expect(permissions.can('nodes', 'write', 'any-source')).toBe(true);
      expect(() => permissions.sourcesWhere(() => true)).toThrow(/check isAdmin first/);
    });

    it('is "all" for an admin and empty for no user', async () => {
      expect(await listPermittedSourceIds({ id: harness.admin.id, isAdmin: true } as never, 'nodes', 'read')).toBe('all');
      expect(await listPermittedSourceIds(null, 'nodes', 'read')).toEqual([]);
    });
  });
});

// ── Guard: every connection / status route is classified ────────────────────

interface RegisteredRoute {
  method: string;
  path: string;
  handlers: unknown[];
}

function registeredRoutes(router: Router): RegisteredRoute[] {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack;
  return stack
    .filter((layer) => layer.route)
    .flatMap((layer) => {
      const route = layer.route!;
      return Object.keys(route.methods)
        .filter((m) => route.methods[m])
        .map((method) => ({ method, path: route.path, handlers: route.stack.map((l) => l.handle) }));
    });
}

/**
 * How a connection or status route decides who gets what:
 *  - `device`: requireDeviceSourcePermission(), the permission on the one device acted on.
 *  - `admin-only`: requireAdmin().
 *  - `reduced`: no permission middleware. Every caller it admits gets the link
 *    flags; the handler adds the rest only for `connection:read` on the source
 *    (and the addresses only with `sources:read` too). Tested above.
 *  - `listed`: no permission middleware. The handler lists only the sources the
 *    caller holds `connection:read` on. Tested above.
 */
type Kind = 'device' | 'admin-only' | 'reduced' | 'listed';

const CLASSIFIED: Record<'connection' | 'status', Record<string, Kind>> = {
  connection: {
    'GET /': 'reduced',
    'GET /info': 'reduced',
    'POST /disconnect': 'device',
    'POST /reconnect': 'device',
    'POST /configure': 'admin-only',
  },
  status: {
    'GET /virtual-node/status': 'listed',
    'GET /automation/airtime-status': 'device',
  },
};

describe('guard: connection and status routes are classified', () => {
  const routers = { connection: connectionRoutes, status: statusRoutes } as const;
  const key = (r: RegisteredRoute): string => `${r.method.toUpperCase()} ${r.path}`;

  const detected = (route: RegisteredRoute): Kind | 'permission' | 'ungated' => {
    if (route.handlers.some((h) => getDeviceSourceGate(h))) return 'device';
    if (route.handlers.some((h) => isAdminGate(h))) return 'admin-only';
    if (route.handlers.some((h) => getPermissionGate(h))) return 'permission';
    return 'ungated';
  };

  it.each(['connection', 'status'] as const)('every %s route has a class, and its middleware matches it', (name) => {
    const routes = registeredRoutes(routers[name]);
    // A new route must be added to CLASSIFIED, with a test for what it returns to whom.
    expect(routes.map(key).sort()).toEqual(Object.keys(CLASSIFIED[name]).sort());
    for (const route of routes) {
      const kind = CLASSIFIED[name][key(route)];
      const expected = kind === 'reduced' || kind === 'listed' ? 'ungated' : kind;
      expect(detected(route), key(route)).toBe(expected);
    }
  });

  it('every hasPermission() call in the connection, status and nodes routes names a source', () => {
    // A check made inside a handler is invisible to the enumeration above. With
    // three arguments it passes on a grant for ANY source.
    for (const file of ['./connectionRoutes.ts', './statusRoutes.ts', './nodesRoutes.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      const calls = [...source.matchAll(/\bhasPermission\(([^()]*)\)/g)].map((m) => m[1]);
      expect(calls.filter((args) => args.split(',').length < 4), file).toEqual([]);
    }
  });

  it('the node and unread reads no longer merge channel grants across sources', () => {
    // `filterNodesByChannelPermission(rows, user)` with no source checks every
    // row against grants merged from all sources. These handlers return rows
    // from several sources, so they must check per row (loadNodeViewAccess).
    const nodes = readFileSync(fileURLToPath(new URL('./nodesRoutes.ts', import.meta.url)), 'utf8');
    expect(nodes).not.toMatch(/filterNodesByChannelPermission\(/);
    const messages = readFileSync(fileURLToPath(new URL('./messageRoutes.ts', import.meta.url)), 'utf8');
    const calls = [...messages.matchAll(/\bfilterNodesByChannelPermission\(([^()]*)\)/g)].map((m) => m[1]);
    expect(calls.filter((args) => args.split(',').length < 3)).toEqual([]);
    // The deprecated all-sources position read must not come back.
    expect(nodes).not.toMatch(/getPositionTelemetryByNodeAsync\(/);
  });
});
