/**
 * Per-source scoping of `GET /poll`.
 *
 * The poll is built from several sources' rows and several permissions. Each
 * section must be gated on the caller's grants ON THE SOURCE the data comes
 * from: the named source, or with no `sourceId` each row's own source. Grants
 * used to be merged across sources and applied to rows merged from all of them.
 *
 * Driven through the real auth middleware with real permission rows. Source
 * B's rows carry marker values; a caller with grants on source A only must
 * never see one, in any field, so the tests search the serialized body.
 *
 * Managers are fakes. Nothing is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import pollRoutes, { POLL_SECTION_GATES } from './pollRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadVisibleNodesAcrossSources } from '../services/nodeDbMaintenanceService.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';

const SHARED_NUM = 0x11111111;
const SHARED_ID = '!11111111';
const ONLY_B_NUM = 0x0b0b0b0b;
const ONLY_B_ID = '!0b0b0b0b';

interface Marks {
  name: string;
  lat: number;
  channelName: string;
  psk: string;
  text: string;
  dmText: string;
  routePositions: string;
  localNum: number;
  localId: string;
  localName: string;
  firmware: string;
  deviceConfig: string;
  nodeIp: string;
  /** The radio's own node database. */
  deviceNodeNums: number[];
}

const A: Marks = {
  name: 'AA-NODE-A',
  lat: 11.1111,
  channelName: 'AA-CHANNEL-A',
  psk: 'AAAAPSKA',
  text: 'AA-TEXT-A',
  dmText: 'AA-DM-A',
  routePositions: '{"mark":"AA-ROUTE-A"}',
  localNum: 0x3e7,
  localId: '!000003e7',
  localName: 'AA-LOCAL-A',
  firmware: '2.7.11-AA',
  deviceConfig: 'AA-DEVICECONFIG-A',
  nodeIp: '10.11.11.11',
  deviceNodeNums: [SHARED_NUM],
};
/** Values that exist on source B only. None may reach a caller without a grant on B. */
const B: Marks = {
  name: 'ZZ-NODE-B',
  lat: 22.2222,
  channelName: 'ZZ-CHANNEL-B',
  psk: 'ZZZZPSKB',
  text: 'ZZ-TEXT-B',
  dmText: 'ZZ-DM-B',
  routePositions: '{"mark":"ZZ-ROUTE-B"}',
  localNum: 0x3e8,
  localId: '!000003e8',
  localName: 'ZZ-LOCAL-B',
  firmware: '2.7.22-ZZ',
  deviceConfig: 'ZZ-DEVICECONFIG-B',
  nodeIp: '10.66.66.66',
  deviceNodeNums: [SHARED_NUM, ONLY_B_NUM],
};
const B_ONLY_NAME = 'ZZ-ONLY-B';
const B_PRIVATE_LAT = 33.3333;
const B_MARKERS = [
  B.name, String(B.lat), B.channelName, B.psk, B.text, B.dmText, 'ZZ-ROUTE-B', B.localId, B.localName,
  B.firmware, B.deviceConfig, B.nodeIp, B_ONLY_NAME, ONLY_B_ID, String(ONLY_B_NUM), String(B_PRIVATE_LAT),
];

const text = (body: unknown): string => JSON.stringify(body ?? null);
const expectNoB = (body: unknown, sourceB: string): void => {
  const serialized = text(body);
  for (const marker of [...B_MARKERS, sourceB]) expect(serialized, `leaked ${marker}`).not.toContain(marker);
};

const ALL_KEYS = Object.keys(POLL_SECTION_GATES).sort();
const SOURCE_RESOURCES = [
  'channel_0', 'channel_1', 'channel_2', 'messages', 'nodes', 'nodes_private', 'traceroute', 'configuration', 'connection',
];

describe('GET /poll: every section is gated on the source its data comes from', () => {
  let harness: RouteTestHarness;
  let limited: SeededUser;
  let anonymousRows: Array<Record<string, unknown>>;
  let managers: Record<string, ISourceManager>;

  const fakeManager = (sourceId: string, marks: Marks): ISourceManager =>
    ({
      sourceId,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: `name of ${sourceId}`, sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({
        nodeNum: marks.localNum, nodeId: marks.localId, longName: marks.localName, shortName: 'L',
        firmwareVersion: marks.firmware, rebootCount: 3,
      }),
      // The real read and the real row mapping (the one MeshtasticManager
      // uses), so the route's per-source filter is what the test sees.
      getAllNodesAsync: vi.fn((id?: string) => loadVisibleNodesAcrossSources(id ? [id] : ALL_SOURCES, (row) => row)),
      getConnectionStatus: vi.fn().mockResolvedValue({
        connected: true, nodeResponsive: true, configuring: false, nodeIp: marks.nodeIp, userDisconnected: false,
      }),
      getDeviceConfig: vi.fn().mockResolvedValue({ basic: { nodeAddress: marks.nodeIp }, lora: { mark: marks.deviceConfig } }),
      getDeviceNodeNums: vi.fn().mockReturnValue(marks.deviceNodeNums),
      isLocalNodeBridged: vi.fn().mockReturnValue(false),
    }) as unknown as ISourceManager;

  /** One permission row carrying several actions. */
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

  /** Every per-source grant the poll looks at, on one source. */
  const giveEverythingOn = async (sourceId: string, userId: number = limited.id): Promise<void> => {
    for (const resource of SOURCE_RESOURCES) await give(resource, ['read', 'write', 'viewOnMap'], sourceId, userId);
  };

  const seed = async (sourceId: string, marks: Marks, unread: number): Promise<void> => {
    const nowSec = Math.floor(Date.now() / 1000);
    const now = Date.now();
    await databaseService.nodes.upsertNode(
      { nodeNum: SHARED_NUM, nodeId: SHARED_ID, longName: marks.name, shortName: 'S', hwModel: 43, channel: 0, lastHeard: nowSec, latitude: marks.lat, longitude: marks.lat },
      sourceId,
    );
    // Node rows outlive a test: clear a private override an earlier one set.
    await databaseService.setNodePositionOverrideAsync(SHARED_NUM, false, sourceId, undefined, undefined, undefined, false);
    await databaseService.channels.upsertChannel({ id: 0, name: marks.channelName, psk: marks.psk, role: 1 }, sourceId);
    await databaseService.channels.upsertChannel({ id: 1, name: `${marks.channelName}-1`, psk: marks.psk, role: 2 }, sourceId);
    for (let i = 0; i < unread; i++) {
      await databaseService.messages.insertMessage(
        {
          id: `${sourceId}_ch_${i}`, fromNodeNum: SHARED_NUM, toNodeNum: 0xffffffff, fromNodeId: SHARED_ID, toNodeId: '!ffffffff',
          text: marks.text, channel: 0, portnum: 1, timestamp: now - i, rxTime: now - i, createdAt: now - i,
        } as never,
        sourceId,
      );
      await databaseService.messages.insertMessage(
        {
          id: `${sourceId}_ch1_${i}`, fromNodeNum: SHARED_NUM, toNodeNum: 0xffffffff, fromNodeId: SHARED_ID, toNodeId: '!ffffffff',
          text: `${marks.text}-ch1`, channel: 1, portnum: 1, timestamp: now - i, rxTime: now - i, createdAt: now - i,
        } as never,
        sourceId,
      );
      await databaseService.messages.insertMessage(
        {
          id: `${sourceId}_dm_${i}`, fromNodeNum: SHARED_NUM, toNodeNum: marks.localNum, fromNodeId: SHARED_ID, toNodeId: marks.localId,
          text: marks.dmText, channel: -1, portnum: 1, timestamp: now - i, rxTime: now - i, createdAt: now - i,
        } as never,
        sourceId,
      );
    }
    await databaseService.traceroutes.insertTraceroute(
      {
        fromNodeNum: marks.localNum, toNodeNum: SHARED_NUM, fromNodeId: marks.localId, toNodeId: SHARED_ID,
        route: '[1]', routeBack: '[1]', snrTowards: '[1]', snrBack: '[1]', routePositions: marks.routePositions,
        channel: 0, timestamp: now - 1000, createdAt: now - 1000,
      } as never,
      sourceId,
    );
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({ mount: (app) => app.use('/', pollRoutes) });
    limited = harness.limited;
    anonymousRows = (await databaseService.auth.getPermissionsForUser(harness.anonymous.id)) as never;
    // A is registered first, so it is the primary Meshtastic source.
    managers = { [harness.sourceA]: fakeManager(harness.sourceA, A), [harness.sourceB]: fakeManager(harness.sourceB, B) };
    await sourceManagerRegistry.addManager(managers[harness.sourceA]);
    await sourceManagerRegistry.addManager(managers[harness.sourceB]);
    await seed(harness.sourceA, A, 1);
    await seed(harness.sourceB, B, 2);
    // A node only source B has heard, with telemetry only B holds.
    await databaseService.nodes.upsertNode(
      { nodeNum: ONLY_B_NUM, nodeId: ONLY_B_ID, longName: B_ONLY_NAME, shortName: 'O', hwModel: 43, channel: 0, lastHeard: Math.floor(Date.now() / 1000) },
      harness.sourceB,
    );
    const at = Date.now() - 60_000;
    await databaseService.telemetry.insertTelemetry(
      { nodeId: SHARED_ID, nodeNum: SHARED_NUM, telemetryType: 'temperature', timestamp: at, value: 21, createdAt: at, channel: 0 } as never,
      harness.sourceB,
    );
    // The admin's every-source read uses a short-lived cache of telemetry
    // types; the rows above were written past the service that clears it.
    databaseService.invalidateTelemetryTypesCache();
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await databaseService.messages.deleteAllMessages(sourceId);
      await databaseService.nodes.deleteNodeRecord(0x0a0a0a01, sourceId);
      await databaseService.traceroutes.deleteAllTraceroutes(sourceId);
      await databaseService.telemetry.deleteAllTelemetry(sourceId);
      await sourceManagerRegistry.removeManager(sourceId);
    }
    // Put the anonymous account back as seeded.
    await harness.revokeAll(harness.anonymous.id);
    for (const row of anonymousRows) {
      const { id: _id, ...rest } = row;
      await databaseService.auth.createPermission(rest as never);
    }
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  type Body = {
    connection?: Record<string, unknown>;
    nodes?: Array<{ nodeNum: number; user?: { longName?: string } }>;
    messages?: Array<{ text: string; channel: number }>;
    unreadCounts?: { channels?: Record<string, number>; directMessages?: Record<string, number> };
    channels?: Array<{ id: number; name: string; psk?: string }>;
    telemetryNodes?: { nodes: string[]; weather: string[]; unmapped: string[]; pkc: string[] };
    config?: Record<string, unknown>;
    deviceConfig?: unknown;
    traceroutes?: Array<{ routePositions?: string }>;
    deviceNodeNums?: number[];
  };
  const nodeNames = (body: Body): string[] => (body.nodes ?? []).map((n) => n.user?.longName ?? '').sort();

  /** What a caller holding nothing on the source gets: the reply shape, with nothing in it. */
  const expectEmptySections = (body: Body): void => {
    expect(body.nodes).toEqual([]);
    expect(body.channels).toEqual([]);
    expect(body.messages ?? []).toEqual([]);
    expect(body.unreadCounts).toEqual({ channels: {} });
    expect(body.traceroutes).toEqual([]);
    expect(body.deviceNodeNums).toEqual([]);
    expect(body).not.toHaveProperty('deviceConfig');
    expect(body.config).not.toHaveProperty('localNodeInfo');
    expect(body.config).not.toHaveProperty('deviceMetadata');
    expect(body.config).not.toHaveProperty('meshtasticNodeIp');
    // The link flags only: the app shell waits on `connected`.
    expect(body.connection).toEqual({ connected: true, nodeResponsive: true, configuring: false, userDisconnected: false });
  };

  // ── Grants on A only ──────────────────────────────────────────────────────
  describe('a caller with grants on source A only', () => {
    beforeEach(async () => {
      await giveEverythingOn(harness.sourceA);
      await give('info', ['read']);
    });

    it('with no sourceId, gets only what comes from A, in every section', async () => {
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/poll');
      const body = res.body as Body;

      expect(res.status).toBe(200);
      expectNoB(body, harness.sourceB);
      expect(nodeNames(body)).toEqual([A.name]);
      expect(body.channels?.map((c) => c.name)).toEqual([A.channelName, `${A.channelName}-1`]);
      // A holds 1 unread message per channel and 1 unread DM; B holds 2 of each.
      expect(body.unreadCounts).toEqual({ channels: { 0: 1, 1: 1 }, directMessages: { [SHARED_ID]: 1 } });
      expect(body.traceroutes?.map((t) => t.routePositions)).toEqual([A.routePositions]);
      // The shared node has telemetry on B only: not marked from it.
      expect(body.telemetryNodes).toMatchObject({ nodes: [], weather: [], pkc: [] });
      // The device sections describe the primary source, which is A.
      expect(text(body.deviceConfig)).toContain(A.deviceConfig);
      expect(body.config?.localNodeInfo).toMatchObject({ nodeId: A.localId, longName: A.localName });
      expect(body.deviceNodeNums).toEqual([SHARED_NUM]);
    });

    it('naming B gets the reply shape with nothing from B in it', async () => {
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/poll').query({ sourceId: harness.sourceB });

      expect(res.status).toBe(200);
      expectNoB(res.body, harness.sourceB);
      expectEmptySections(res.body);
      expect(res.body.telemetryNodes).toMatchObject({ nodes: [], weather: [], unmapped: [], pkc: [] });
      // B's node rows are not even read for a caller who holds nothing there.
      expect((managers[harness.sourceB] as unknown as { getAllNodesAsync: unknown }).getAllNodesAsync).not.toHaveBeenCalled();
    });

    it('naming A gets A', async () => {
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/poll').query({ sourceId: harness.sourceA });
      const body = res.body as Body;

      expect(res.status).toBe(200);
      expectNoB(body, harness.sourceB);
      expect(nodeNames(body)).toEqual([A.name]);
      expect(body.messages?.map((m) => m.text).sort()).toEqual([A.dmText, A.text, `${A.text}-ch1`].sort());
      expect(body.channels?.map((c) => c.psk)).toEqual([A.psk, A.psk]);
      expect(body.unreadCounts).toEqual({ channels: { 0: 1, 1: 1 }, directMessages: { [SHARED_ID]: 1 } });
      expect(body.traceroutes).toHaveLength(1);
      expect(text(body.deviceConfig)).toContain(A.deviceConfig);
      expect(body.config?.localNodeInfo).toMatchObject({ nodeId: A.localId });
      expect(body.deviceNodeNums).toEqual([SHARED_NUM]);
    });

    it('is not handed a reply built for another caller: no shared cache, and an ETag from the admin does not match', async () => {
      const admin = await harness.loginAs(harness.admin);
      const full = await admin.get('/poll').query({ sourceId: harness.sourceB });
      expect(text(full.body)).toContain(B.name);

      const agent = await harness.loginAs(limited);
      const mine = await agent
        .get('/poll')
        .query({ sourceId: harness.sourceB })
        .set('If-None-Match', String(full.headers.etag ?? '"none"'));

      expect(mine.status).toBe(200);
      expectNoB(mine.body, harness.sourceB);
      expectEmptySections(mine.body);
      expect(String(mine.headers['cache-control'] ?? '')).not.toContain('public');
    });
  });

  // ── One grant on A must not open the same section on B ────────────────────
  describe('a grant on A is not a grant on B', () => {
    it('channel_0 on A does not show channel-0 nodes, channels or counts of B', async () => {
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
      // Reaches B's rows through another channel, without channel_0 there.
      await give('channel_1', ['read', 'viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/poll');
      const body = res.body as Body;

      expect(nodeNames(body)).toEqual([A.name]);
      expect(body.channels?.map((c) => c.name)).toEqual([A.channelName, `${B.channelName}-1`]);
      // Channel 0 from A only (1), channel 1 from B only (2).
      expect(body.unreadCounts?.channels).toEqual({ 0: 1, 1: 2 });

      const named = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect((named.body as Body).nodes).toEqual([]);
      expect((named.body as Body).channels?.map((c) => c.name)).toEqual([`${B.channelName}-1`]);
      // channel_0:read is the door to channel messages on a source.
      expect((named.body as Body).messages ?? []).toEqual([]);
      expect((named.body as Body).unreadCounts?.channels).toEqual({ 1: 2 });
    });

    it('messages:read on A does not show B\'s DMs or DM counts', async () => {
      await give('messages', ['read'], harness.sourceA);
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const named = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(text(named.body)).not.toContain(B.dmText);
      expect((named.body as Body).messages?.map((m) => m.text)).toEqual([B.text, B.text]);
      expect((named.body as Body).unreadCounts).toEqual({ channels: { 0: 2 } });

      const unscoped = await agent.get('/poll');
      expect((unscoped.body as Body).unreadCounts).toEqual({ channels: { 0: 3 }, directMessages: { [SHARED_ID]: 1 } });
    });

    it('channel write on A does not return B\'s PSK', async () => {
      await give('channel_0', ['read', 'write'], harness.sourceA);
      await give('channel_0', ['read'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      for (const query of [{}, { sourceId: harness.sourceB }]) {
        const res = await agent.get('/poll').query(query);
        expect(text(res.body)).toContain(B.channelName);
        expect(text(res.body)).not.toContain(B.psk);
      }
      const own = await agent.get('/poll').query({ sourceId: harness.sourceA });
      expect(text(own.body)).toContain(A.psk);
    });

    it('configuration:read on A does not return B\'s device config', async () => {
      await give('configuration', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const named = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(named.body).not.toHaveProperty('deviceConfig');
      expectNoB(named.body, harness.sourceB);

      const own = await agent.get('/poll').query({ sourceId: harness.sourceA });
      expect(text(own.body.deviceConfig)).toContain(A.deviceConfig);
    });

    it('configuration:read on B only does not return the primary\'s device config when no source is named', async () => {
      await give('configuration', ['read'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/poll');

      expect(res.body).not.toHaveProperty('deviceConfig');
      expect(text(res.body)).not.toContain(A.deviceConfig);
    });

    it('traceroute:read on A does not return B\'s traceroutes', async () => {
      await give('traceroute', ['read'], harness.sourceA);
      // The rows are on channel 0: viewable on both, readable on A only.
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      await give('channel_0', ['viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const named = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(named.body.traceroutes).toEqual([]);
      const unscoped = await agent.get('/poll');
      expect((unscoped.body as Body).traceroutes?.map((t) => t.routePositions)).toEqual([A.routePositions]);
    });

    it('a traceroute on a channel the caller cannot view on that source is not returned', async () => {
      await give('traceroute', ['read'], harness.sourceA);
      await give('traceroute', ['read'], harness.sourceB);
      // The rows are on channel 0. Viewable on A, not on B.
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      await give('channel_1', ['viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/poll');

      expect((res.body as Body).traceroutes?.map((t) => t.routePositions)).toEqual([A.routePositions]);
    });

    it('without traceroute:read there are no traceroutes', async () => {
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      for (const query of [{}, { sourceId: harness.sourceA }]) {
        const res = await agent.get('/poll').query(query);
        expect(res.body.traceroutes).toEqual([]);
      }
    });

    it('nodes_private on A does not unmask a private position held on B', async () => {
      await databaseService.setNodePositionOverrideAsync(SHARED_NUM, true, harness.sourceB, B_PRIVATE_LAT, B_PRIVATE_LAT, 0, true);
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceB);
      await give('nodes_private', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      for (const query of [{}, { sourceId: harness.sourceB }]) {
        const res = await agent.get('/poll').query(query);
        expect(text(res.body)).not.toContain(String(B_PRIVATE_LAT));
      }

      await give('nodes_private', ['read'], harness.sourceB);
      const shown = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(text(shown.body)).toContain(String(B_PRIVATE_LAT));
    });

    it('a private position the caller may not see does not count as a known position in telemetry availability', async () => {
      // The node only B has heard has no GPS fix; its one position is private.
      await databaseService.setNodePositionOverrideAsync(ONLY_B_NUM, true, harness.sourceB, B_PRIVATE_LAT, B_PRIVATE_LAT, 0, true);
      await give('info', ['read']);
      await give('channel_0', ['viewOnMap'], harness.sourceB);
      await give('nodes_private', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      for (const query of [{}, { sourceId: harness.sourceB }]) {
        const res = await agent.get('/poll').query(query);
        expect(res.body.telemetryNodes.unmapped).toContain(ONLY_B_ID);
      }

      await give('nodes_private', ['read'], harness.sourceB);
      const shown = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(shown.body.telemetryNodes.unmapped).not.toContain(ONLY_B_ID);
      await databaseService.setNodePositionOverrideAsync(ONLY_B_NUM, false, harness.sourceB, undefined, undefined, undefined, false);
    });

    it('the local node and firmware of a source need a grant on that source', async () => {
      await give('channel_0', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const named = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(named.body.config).not.toHaveProperty('localNodeInfo');
      expect(named.body.config).not.toHaveProperty('deviceMetadata');
      expectNoB(named.body, harness.sourceB);

      const own = await agent.get('/poll').query({ sourceId: harness.sourceA });
      expect(own.body.config.localNodeInfo).toMatchObject({ nodeId: A.localId, longName: A.localName });
      expect(own.body.config.deviceMetadata).toMatchObject({ firmwareVersion: A.firmware });
    });

    it('device node numbers are limited to the nodes the caller may see on that source', async () => {
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      expect((await agent.get('/poll').query({ sourceId: harness.sourceB })).body.deviceNodeNums).toEqual([]);
      expect((await agent.get('/poll').query({ sourceId: harness.sourceA })).body.deviceNodeNums).toEqual([SHARED_NUM]);
      expect((await agent.get('/poll')).body.deviceNodeNums).toEqual([SHARED_NUM]);
    });

    it('telemetry availability is read from the source the node row is on', async () => {
      await give('info', ['read']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      // B holds the only telemetry for the shared node.
      for (const query of [{}, { sourceId: harness.sourceA }]) {
        const res = await agent.get('/poll').query(query);
        expect(res.body.telemetryNodes.weather).toEqual([]);
      }

      await give('channel_0', ['viewOnMap'], harness.sourceB);
      const withB = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(withB.body.telemetryNodes.weather).toEqual([SHARED_ID]);
    });

    it('telemetry availability lists only nodes on a channel the caller may view on that source', async () => {
      // Heard on channel 1 of A. The caller views channel 0 there.
      await databaseService.nodes.upsertNode(
        { nodeNum: 0x0a0a0a01, nodeId: '!0a0a0a01', longName: 'AA-CH1-A', shortName: 'C', hwModel: 43, channel: 1, lastHeard: Math.floor(Date.now() / 1000), publicKey: 'a2V5' },
        harness.sourceA,
      );
      await give('info', ['read']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      for (const query of [{}, { sourceId: harness.sourceA }]) {
        const res = await agent.get('/poll').query(query);
        expect(text(res.body)).not.toContain('!0a0a0a01');
        expect(text(res.body)).not.toContain('AA-CH1-A');
      }

      await give('channel_1', ['viewOnMap'], harness.sourceA);
      const shown = await agent.get('/poll').query({ sourceId: harness.sourceA });
      expect(shown.body.telemetryNodes.pkc).toContain('!0a0a0a01');
    });

    it('without info:read there is no telemetry section', async () => {
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      for (const query of [{}, { sourceId: harness.sourceA }]) {
        expect((await agent.get('/poll').query(query)).body).not.toHaveProperty('telemetryNodes');
      }
    });
  });

  // ── The node address: sources:read alone (#5619) ──────────────────────────
  describe('the node address', () => {
    it('is shown on sources:read alone, with no connection:read', async () => {
      await give('sources', ['read']);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/poll').query({ sourceId: harness.sourceB });

      expect(res.body.connection.nodeIp).toBe(B.nodeIp);
      expect(res.body.config).toHaveProperty('meshtasticNodeIp');
      // The address is all that grant opens.
      expect(res.body.nodes).toEqual([]);
      expect(res.body).not.toHaveProperty('deviceConfig');
    });

    it('is withheld without sources:read, whatever is held on the source', async () => {
      await giveEverythingOn(harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/poll').query({ sourceId: harness.sourceA });

      expect(res.body.connection).not.toHaveProperty('nodeIp');
      expect(res.body.config).not.toHaveProperty('meshtasticNodeIp');
    });

    it('the source\'s own port goes with the address; everyone else gets the default', async () => {
      await databaseService.sources.updateSource(harness.sourceB, { config: { host: B.nodeIp, port: 14403 } });
      await giveEverythingOn(harness.sourceB);
      const agent = await harness.loginAs(limited);

      const without = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(without.body.config.meshtasticTcpPort).not.toBe(14403);
      expect(text(without.body.config)).not.toContain(B.nodeIp);

      await give('sources', ['read']);
      const withGrant = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expect(withGrant.body.config).toMatchObject({ meshtasticNodeIp: B.nodeIp, meshtasticTcpPort: 14403 });
    });
  });

  // ── Grants everywhere, and the admin ──────────────────────────────────────
  describe('a caller with every grant on every source', () => {
    beforeEach(async () => {
      await giveEverythingOn(harness.sourceA);
      await giveEverythingOn(harness.sourceB);
      await give('info', ['read']);
      await give('sources', ['read']);
    });

    it.each([
      ['source A', (h: RouteTestHarness) => ({ sourceId: h.sourceA })],
      ['source B', (h: RouteTestHarness) => ({ sourceId: h.sourceB })],
      ['no sourceId', () => ({})],
    ])('gets the admin\'s reply for %s', async (_label, query) => {
      const admin = await harness.loginAs(harness.admin);
      const agent = await harness.loginAs(limited);

      const all = await admin.get('/poll').query(query(harness));
      const mine = await agent.get('/poll').query(query(harness));

      expect(mine.status).toBe(200);
      expect(Object.keys(mine.body).sort()).toEqual(Object.keys(all.body).sort());
      // The install's seeded Broadcast node sits on a source outside this
      // test, where the admin sees it and this caller holds nothing.
      const BROADCAST = 0xffffffff;
      all.body.nodes = all.body.nodes.filter((node: { nodeNum: number }) => node.nodeNum !== BROADCAST);
      const telemetry = all.body.telemetryNodes as Record<string, unknown>;
      for (const [list, ids] of Object.entries(telemetry)) {
        if (Array.isArray(ids)) telemetry[list] = ids.filter((id) => id !== '!ffffffff');
      }
      telemetry.unmappedCount = (telemetry.unmapped as string[]).length;
      if (!('sourceId' in query(harness))) {
        // One known difference, the same as on GET /api/messages/unread-counts:
        // with no source named the admin's single query counts DMs to the
        // PRIMARY's node only (A: 1), while this caller is counted source by
        // source, each against its own node (A: 1, B: 2).
        expect(all.body.unreadCounts.directMessages).toEqual({ [SHARED_ID]: 1 });
        expect(mine.body.unreadCounts.directMessages).toEqual({ [SHARED_ID]: 3 });
        mine.body.unreadCounts.directMessages = all.body.unreadCounts.directMessages;
      }
      for (const key of Object.keys(all.body)) {
        expect(mine.body[key], `section ${key}`).toEqual(all.body[key]);
      }
    });
  });

  describe('an admin', () => {
    it('gets every section for a named source, and every section but messages with none named', async () => {
      const admin = await harness.loginAs(harness.admin);

      const named = await admin.get('/poll').query({ sourceId: harness.sourceB });
      const unscoped = await admin.get('/poll');

      expect(Object.keys(named.body).sort()).toEqual(ALL_KEYS);
      // No messages section without a sourceId, for any caller (as before).
      expect(Object.keys(unscoped.body).sort()).toEqual(ALL_KEYS.filter((key) => key !== 'messages'));
      expect(nodeNames(named.body)).toEqual([B_ONLY_NAME, B.name].sort());
      expect(text(named.body.deviceConfig)).toContain(B.deviceConfig);
      expect(named.body.deviceNodeNums).toEqual([SHARED_NUM, ONLY_B_NUM]);
      expect(named.body.traceroutes).toHaveLength(1);
      expect(unscoped.body.traceroutes).toHaveLength(2);
      expect(unscoped.body.channels).toHaveLength(4);
      expect(unscoped.body.unreadCounts.channels).toEqual({ 0: 3, 1: 3 });
    });

    it('costs no permission query', async () => {
      const rows = vi.spyOn(databaseService.auth, 'getPermissionsForUser');
      const check = vi.spyOn(databaseService, 'checkPermissionAsync');
      const admin = await harness.loginAs(harness.admin);
      rows.mockClear();
      check.mockClear();

      await admin.get('/poll').query({ sourceId: harness.sourceA });
      await admin.get('/poll');

      expect(rows).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
    });
  });

  it('loads a caller\'s grants once per request, whatever the number of rows, channels and sources', async () => {
    await giveEverythingOn(harness.sourceA);
    await giveEverythingOn(harness.sourceB);
    await give('info', ['read']);
    await give('sources', ['read']);
    const agent = await harness.loginAs(limited);
    const rows = vi.spyOn(databaseService.auth, 'getPermissionsForUser');
    const check = vi.spyOn(databaseService, 'checkPermissionAsync');
    const set = vi.spyOn(databaseService, 'getUserPermissionSetAsync');

    for (const query of [{}, { sourceId: harness.sourceA }]) {
      rows.mockClear();
      await agent.get('/poll').query(query);
      expect(rows).toHaveBeenCalledTimes(1);
    }
    expect(check).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  // ── Anonymous ─────────────────────────────────────────────────────────────
  describe('a caller with no login', () => {
    beforeEach(async () => {
      await harness.revokeAll(harness.anonymous.id);
    });

    it.each([
      ['no sourceId', () => ({})],
      ['a named source', (h: RouteTestHarness) => ({ sourceId: h.sourceB })],
    ])('gets nothing with no public grants (%s)', async (_label, query) => {
      const agent = await harness.loginAs(null);

      const res = await agent.get('/poll').query(query(harness));

      expect(res.status).toBe(200);
      expectNoB(res.body, harness.sourceB);
      expect(text(res.body)).not.toContain(A.name);
      expectEmptySections(res.body);
      expect(res.body).not.toHaveProperty('telemetryNodes');
    });

    it('with public grants on A, gets A\'s rows only, and never an address or a device identity', async () => {
      const anon = harness.anonymous.id;
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceA, anon);
      await give('traceroute', ['read'], harness.sourceA, anon);
      await give('configuration', ['read'], harness.sourceA, anon);
      await give('sources', ['read'], undefined, anon);
      const agent = await harness.loginAs(null);

      for (const query of [{}, { sourceId: harness.sourceA }]) {
        const res = await agent.get('/poll').query(query);
        const body = res.body as Body;
        expectNoB(body, harness.sourceB);
        expect(nodeNames(body)).toEqual([A.name]);
        expect(body.channels?.map((c) => c.name)).toEqual([A.channelName]);
        expect(body.traceroutes).toHaveLength(1);
        // No login: no address, even with sources:read on the anonymous account.
        expect(text(body)).not.toContain(A.nodeIp);
        expect(body.config).not.toHaveProperty('localNodeInfo');
        expect(body.config).not.toHaveProperty('deviceMetadata');
      }

      const named = await agent.get('/poll').query({ sourceId: harness.sourceB });
      expectNoB(named.body, harness.sourceB);
      expect(named.body.nodes).toEqual([]);
      expect(named.body.traceroutes).toEqual([]);
    });
  });

  // ── Guard: every key of the reply has a declared gate ─────────────────────
  describe('guard', () => {
    it('no reply carries a top-level key without a declared gate', async () => {
      await giveEverythingOn(harness.sourceA);
      await give('info', ['read']);
      await give('sources', ['read']);
      const declared = new Set(Object.keys(POLL_SECTION_GATES));
      const seen = new Set<string>();

      for (const user of [harness.admin, limited, null]) {
        const agent = await harness.loginAs(user);
        for (const query of [{}, { sourceId: harness.sourceA }, { sourceId: harness.sourceB }]) {
          const res = await agent.get('/poll').query(query);
          for (const key of Object.keys(res.body)) {
            seen.add(key);
            expect(declared.has(key), `"${key}" is in the poll reply but has no entry in POLL_SECTION_GATES`).toBe(true);
          }
        }
      }
      // And nothing is declared that the route no longer returns.
      expect([...seen].sort()).toEqual(ALL_KEYS);
    });
  });
});
