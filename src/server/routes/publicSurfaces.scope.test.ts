/**
 * Per-source scoping for the public and token-facing surfaces:
 *
 *   - the v1 API (`/api/v1/sources/{id}/…`), read with API tokens. A token
 *     carries its creator's permissions, so every read is checked on the source
 *     in the path;
 *   - the anonymous embed routes (`/api/embed/:profileId/…`), where the profile
 *     alone decides what is shown;
 *   - MeshCore ids on the telemetry routes;
 *   - `POST /system/restart`, admin only.
 *
 * Real auth middleware, real API tokens and real permission rows. Source B's
 * rows carry marker values; a caller with grants on source A only must never
 * see one, in any field, so the tests search the serialized body for them.
 *
 * Managers are fakes. Nothing is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Router } from 'express';

import v1Router from './v1/index.js';
import nodesRouter from './v1/nodes.js';
import networkRouter from './v1/network.js';
import telemetryRouter from './v1/telemetry.js';
import traceroutesRouter from './v1/traceroutes.js';
import messagesRouter from './v1/messages.js';
import channelsRouter from './v1/channels.js';
import packetsRouter from './v1/packets.js';
import statusRouter from './v1/status.js';
import positionHistoryRouter from './v1/positionHistory.js';
import actionsRouter from './v1/actions.js';
import sourcesRouter from './v1/sources.js';
import metricsRouter from './v1/metrics.js';
import solarRouter from './v1/solar.js';
import translateRouter from './v1/translate.js';
import channelDatabaseRouter from './v1/channelDatabase.js';
import { getAttachSourceGate } from './v1/sourceParam.js';
import embedPublicRoutes from './embedPublicRoutes.js';
import telemetryRoutes from './telemetryRoutes.js';
import systemRoutes, { setSystemCallbacks } from './systemRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { isAdminGate, getPermissionGate } from '../auth/authMiddleware.js';
import { SOURCEY_RESOURCES } from '../../types/permission.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';

const idOf = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;

// Node numbers unique to this file: node rows outlive a test.
const SHARED = 0x7e000001; // heard on A and on B, channel 0
const ONLY_B = 0x7e0b0002; // heard on B only
const PRIV_A = 0x7e0a0003; // on A: reports a position AND has a private override
const HIDDEN_A = 0x7e0a0004; // on A: hidden from the map
const CH1_A = 0x7e0a0005; // on A: heard on channel 1
const POSCH_A = 0x7e0a0006; // on A: heard on channel 0, position arrived on channel 1
const VIRT_A = 0x7e0a0007; // on A: heard on a channel-database channel
const LOCAL_A = 0x7e0a0999;
const LOCAL_B = 0x7e0b0999;
const MC_KEY = 'c'.repeat(64);

/** Values that exist on source B only. None may reach a caller without a grant on B. */
const B = {
  name: 'ZZ-MARKER-B',
  onlyName: 'ZZ-ONLY-B',
  localName: 'ZZ-LOCAL-B',
  lat: 22.2222,
  uptime: 424242,
  temp: 77.7777,
  text: 'zz-text-b',
};
const A = {
  name: 'AA-MARKER-A',
  localName: 'AA-LOCAL-A',
  lat: 11.1111,
  uptime: 131313,
  temp: 55.5555,
  privateLat: 33.3333, // the private override on PRIV_A
  privateDeviceLat: 44.4444, // what PRIV_A's radio reports
  hiddenName: 'AA-HIDDEN',
  ch1Name: 'AA-CHANNEL-ONE',
  posChName: 'AA-POS-CHANNEL',
  posChLat: 66.6666,
  virtName: 'AA-VIRTUAL',
};
const B_MARKERS = [B.name, B.onlyName, B.localName, String(B.lat), String(B.uptime), String(B.temp), B.text, idOf(ONLY_B), String(ONLY_B)];

const text = (body: unknown): string => (typeof body === 'string' ? body : JSON.stringify(body ?? null));

describe('public and token-facing surfaces are scoped per source', () => {
  let harness: RouteTestHarness;
  let limited: SeededUser;
  let shutdown: ReturnType<typeof vi.fn>;

  const expectNoB = (body: unknown): void => {
    const serialized = text(body);
    for (const marker of [...B_MARKERS, harness.sourceB]) expect(serialized, `leaked ${marker}`).not.toContain(marker);
  };

  const fakeManager = (sourceId: string, localNum: number, localName: string): ISourceManager =>
    ({
      sourceId,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: localNum, nodeId: idOf(localNum), longName: localName, shortName: 'L' }),
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, nodeResponsive: true, configuring: false, nodeIp: '10.0.0.1' }),
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

  /** What a read-only add-on user holds on a source: every read the v1 mounts ask for, on channel 0. */
  const giveReads = async (sourceId: string): Promise<void> => {
    await give('nodes', ['read', 'viewOnMap'], sourceId);
    await give('messages', ['read'], sourceId);
    await give('traceroute', ['read'], sourceId);
    await give('packetmonitor', ['read'], sourceId);
    await give('channel_0', ['read', 'viewOnMap'], sourceId);
  };

  /** Every per-source grant, on both sources, and the install-wide ones. */
  const giveEverything = async (): Promise<void> => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      for (const resource of SOURCEY_RESOURCES) await give(resource, ['read', 'write', 'viewOnMap'], sourceId);
    }
    for (const resource of ['info', 'dashboard']) await give(resource, ['read', 'write']);
  };

  const node = (sourceId: string, nodeNum: number, fields: Record<string, unknown>): Promise<unknown> =>
    databaseService.nodes.upsertNode(
      { nodeNum, nodeId: idOf(nodeNum), shortName: 'N', hwModel: 43, channel: 0, lastHeard: Math.floor(Date.now() / 1000), ...fields } as never,
      sourceId,
    );

  const sample = (sourceId: string, nodeNum: number, telemetryType: string, value: number): Promise<unknown> => {
    const at = Date.now() - 60_000;
    return databaseService.telemetry.insertTelemetry(
      { nodeId: idOf(nodeNum), nodeNum, telemetryType, timestamp: at, value, createdAt: at, channel: 0 },
      sourceId,
    );
  };

  const traceroute = (sourceId: string, from: number, to: number, channel = 0): Promise<unknown> =>
    databaseService.traceroutes.insertTraceroute(
      {
        fromNodeNum: from, toNodeNum: to, fromNodeId: idOf(from), toNodeId: idOf(to),
        route: '[]', routeBack: '[]', snrTowards: '[20]', snrBack: '[20]', channel,
        timestamp: Date.now() - 60_000, createdAt: Date.now() - 60_000,
      } as never,
      sourceId,
    );

  const neighbor = (sourceId: string, nodeNum: number, neighborNodeNum: number): Promise<unknown> =>
    databaseService.neighbors.insertNeighborInfo(
      { nodeNum, neighborNodeNum, snr: 5, timestamp: Date.now(), createdAt: Date.now() },
      sourceId,
    );

  const heard = (sourceId: string, nodeNum: number): Promise<unknown> =>
    databaseService.packetLog.insertPacketLog(
      {
        timestamp: Date.now() - 60_000, from_node: nodeNum, from_node_id: idOf(nodeNum), portnum: 1, encrypted: false,
        rssi: -70, hop_start: 3, hop_limit: 3, direction: 'rx',
      } as never,
      sourceId,
    );

  const message = (sourceId: string, id: string, body: string): Promise<unknown> =>
    databaseService.messages.insertMessage(
      {
        id, fromNodeNum: SHARED, toNodeNum: 0xffffffff, fromNodeId: idOf(SHARED), toNodeId: '!ffffffff',
        text: body, channel: 0, portnum: 1, timestamp: Date.now(), rxTime: Date.now(), createdAt: Date.now(),
      } as never,
      sourceId,
    );

  const profile = (id: string, fields: Record<string, unknown> = {}) =>
    databaseService.embedProfiles.createAsync({
      id, name: id, enabled: true, channels: [0], tileset: 'osm', defaultLat: 0, defaultLng: 0, defaultZoom: 10,
      showTooltips: true, showPopups: true, showLegend: true, showPaths: false, showNeighborInfo: true,
      showTraceroutes: true, showMqttNodes: true, pollIntervalSeconds: 30, allowedOrigins: [], sourceId: null,
      ...fields,
    } as never);

  const PROFILE_IDS = ['zz-embed-a', 'zz-embed-b', 'zz-embed-all', 'zz-embed-any-channel', 'zz-embed-quiet'];

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/v1', v1Router);
        app.use('/api/embed', embedPublicRoutes);
        app.use('/', telemetryRoutes);
        app.use('/', systemRoutes);
      },
    });
    limited = harness.limited;
    shutdown = vi.fn();
    setSystemCallbacks({ gracefulShutdown: shutdown } as never);

    // A is registered first, so it is the primary Meshtastic source.
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceA, LOCAL_A, A.localName));
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceB, LOCAL_B, B.localName));
    await databaseService.settings.setSourceSetting(harness.sourceA, 'localNodeNum', String(LOCAL_A));
    await databaseService.settings.setSourceSetting(harness.sourceB, 'localNodeNum', String(LOCAL_B));

    await node(harness.sourceA, SHARED, { longName: A.name, latitude: A.lat, longitude: A.lat });
    await node(harness.sourceA, LOCAL_A, { longName: A.localName, latitude: 1.5, longitude: 1.5 });
    await node(harness.sourceA, PRIV_A, { longName: 'AA-PRIVATE', latitude: A.privateDeviceLat, longitude: A.privateDeviceLat });
    await node(harness.sourceA, HIDDEN_A, { longName: A.hiddenName, latitude: 12.5, longitude: 12.5, hideFromMap: true });
    await node(harness.sourceA, CH1_A, { longName: A.ch1Name, latitude: 13.5, longitude: 13.5, channel: 1 });
    await node(harness.sourceA, POSCH_A, { longName: A.posChName, latitude: A.posChLat, longitude: A.posChLat, positionChannel: 1 });
    await node(harness.sourceA, VIRT_A, { longName: A.virtName, latitude: 14.5, longitude: 14.5, channel: CHANNEL_DB_OFFSET + 1 });
    await node(harness.sourceB, SHARED, { longName: B.name, latitude: B.lat, longitude: B.lat });
    await node(harness.sourceB, ONLY_B, { longName: B.onlyName, latitude: 23.5, longitude: 23.5 });
    await node(harness.sourceB, LOCAL_B, { longName: B.localName, latitude: 24.5, longitude: 24.5 });
    // Node rows outlive a test: reset the flags an earlier one set.
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await databaseService.setNodePositionOverrideAsync(SHARED, false, sourceId, undefined, undefined, undefined, false);
    }
    await databaseService.setNodePositionOverrideAsync(PRIV_A, true, harness.sourceA, A.privateLat, A.privateLat, 0, true);

    await sample(harness.sourceA, SHARED, 'temperature', A.temp);
    await sample(harness.sourceA, SHARED, 'uptimeSeconds', A.uptime);
    await sample(harness.sourceA, PRIV_A, 'latitude', A.privateDeviceLat);
    await sample(harness.sourceA, PRIV_A, 'longitude', A.privateDeviceLat);
    await sample(harness.sourceA, PRIV_A, 'temperature', 9.5);
    await sample(harness.sourceB, SHARED, 'temperature', B.temp);
    await sample(harness.sourceB, SHARED, 'uptimeSeconds', B.uptime);

    await traceroute(harness.sourceA, LOCAL_A, SHARED);
    await traceroute(harness.sourceA, LOCAL_A, HIDDEN_A);
    await traceroute(harness.sourceA, LOCAL_A, PRIV_A);
    await traceroute(harness.sourceB, LOCAL_B, ONLY_B);
    await neighbor(harness.sourceA, LOCAL_A, SHARED);
    await neighbor(harness.sourceA, LOCAL_A, HIDDEN_A);
    await neighbor(harness.sourceA, LOCAL_A, PRIV_A);
    await neighbor(harness.sourceB, LOCAL_B, ONLY_B);
    await heard(harness.sourceA, SHARED);
    await heard(harness.sourceB, ONLY_B);
    await message(harness.sourceA, `${harness.sourceA}_pub_1`, 'aa-text-a');
    await message(harness.sourceB, `${harness.sourceB}_pub_1`, B.text);

    await profile('zz-embed-a', { sourceId: harness.sourceA });
    await profile('zz-embed-b', { sourceId: harness.sourceB });
    await profile('zz-embed-all');
    await profile('zz-embed-any-channel', { sourceId: harness.sourceA, channels: [] });
    await profile('zz-embed-quiet', { sourceId: harness.sourceA, showNeighborInfo: false, showTraceroutes: false });
  });

  afterEach(async () => {
    for (const id of PROFILE_IDS) await databaseService.embedProfiles.deleteAsync(id);
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await databaseService.messages.deleteAllMessages(sourceId);
      await databaseService.traceroutes.deleteAllTraceroutes(sourceId);
      await databaseService.neighbors.deleteAllNeighborInfo(sourceId);
      await sourceManagerRegistry.removeManager(sourceId);
    }
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  const api = (token: string) => ({
    get: (path: string) => request(harness.app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
  });

  /** Every per-source v1 read, relative to `/sources/{id}`. */
  const SOURCE_READS = [
    '/nodes',
    '/nodes?active=true',
    `/nodes/${idOf(SHARED)}`,
    `/nodes/${idOf(SHARED)}/position-history`,
    `/nodes/${SHARED}/copy-candidates`,
    '/network',
    '/network/topology',
    '/network/direct-neighbors',
    '/telemetry',
    '/telemetry?type=temperature',
    '/telemetry/count',
    `/telemetry/${idOf(SHARED)}`,
    `/telemetry?nodeId=${idOf(SHARED)}`,
    '/traceroutes',
    '/messages',
    '/messages/search?q=text',
    '/packets',
    '/channels',
    '/status',
  ];

  // ── v1: a token of a user with grants on A only ───────────────────────────
  describe('v1 API: a token carries its creator\'s grants, checked on the source in the path', () => {
    it.each(SOURCE_READS)('GET /sources/A%s shows nothing of B; on B it is refused', async (path) => {
      await giveReads(harness.sourceA);
      await give('info', ['read']);
      const client = api(await harness.tokenFor(limited));

      const onA = await client.get(`/sources/${harness.sourceA}${path}`);
      expect(onA.status, text(onA.body)).toBe(200);
      expectNoB(onA.body);

      const viaDefault = await client.get(`/sources/default${path}`);
      expect(viaDefault.status).toBe(200);
      expectNoB(viaDefault.body);

      const onB = await client.get(`/sources/${harness.sourceB}${path}`);
      // `/status` is gated on the install-wide `info:read`: it opens, with the
      // link state only (asserted below).
      expect(onB.status).toBe(path === '/status' ? 200 : 403);
      // The refusal names the source the caller asked for, and nothing from it.
      for (const marker of B_MARKERS) expect(text(onB.body), `leaked ${marker}`).not.toContain(marker);
    });

    it('the reads return this source\'s rows (the scope is not "nothing")', async () => {
      await giveReads(harness.sourceA);
      await give('info', ['read']);
      const client = api(await harness.tokenFor(limited));
      const at = (path: string) => client.get(`/sources/${harness.sourceA}${path}`);

      expect(text((await at('/nodes')).body)).toContain(A.name);
      expect((await at(`/nodes/${idOf(SHARED)}`)).body.data.uptimeSeconds).toBe(A.uptime);
      expect(text((await at('/network/topology')).body)).toContain(A.name);
      expect(Object.keys((await at('/network/direct-neighbors')).body.data)).toEqual([String(SHARED)]);
      expect(text((await at('/telemetry?type=temperature')).body)).toContain(String(A.temp));
      expect((await at('/telemetry/count')).body.count).toBe(
        await databaseService.telemetry.getTelemetryCount(harness.sourceA),
      );
      expect(text((await at('/messages')).body)).toContain('aa-text-a');
      expect((await at('/status')).body.data).toEqual({
        localNodeNum: LOCAL_A, localNodeId: idOf(LOCAL_A), longName: A.localName, shortName: 'N', connected: true, nodeResponsive: true,
      });
    });

    it('GET /sources lists only the sources the user reads, and /metrics exports only those', async () => {
      await giveReads(harness.sourceA);
      const client = api(await harness.tokenFor(limited));

      const sources = await client.get('/sources');
      expect(sources.body.data.map((s: { id: string }) => s.id)).toEqual([harness.sourceA]);
      expectNoB(sources.body);

      const metrics = await client.get('/metrics');
      expect(metrics.status).toBe(200);
      expect(metrics.text).toContain(`source="${harness.sourceA}"`);
      expectNoB(metrics.text);
      // Per-node series follow the channel grant: CH1_A is on a channel not granted.
      expect(metrics.text).toContain(idOf(SHARED));
      expect(metrics.text).not.toContain(idOf(CH1_A));
    });

    it('GET /sources/B/status gives the link state and no node identity without nodes:read on B', async () => {
      await giveReads(harness.sourceA);
      await give('info', ['read']);
      const client = api(await harness.tokenFor(limited));

      const res = await client.get(`/sources/${harness.sourceB}/status`);

      expect(res.body.data).toEqual({
        localNodeNum: null, localNodeId: null, longName: null, shortName: null, connected: true, nodeResponsive: true,
      });
    });

    it('a channel grant on A does not show that channel\'s rows on B', async () => {
      await give('nodes', ['read'], harness.sourceA);
      await give('nodes', ['read'], harness.sourceB);
      await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
      const client = api(await harness.tokenFor(limited));

      for (const path of ['/nodes', '/network/topology', '/telemetry', '/telemetry?type=temperature', `/telemetry/${idOf(SHARED)}`]) {
        const res = await client.get(`/sources/${harness.sourceB}${path}`);
        expectNoB(res.body);
      }
      expect((await client.get(`/sources/${harness.sourceB}/nodes`)).body.count).toBe(0);
      expect((await client.get(`/sources/${harness.sourceB}/telemetry/${idOf(SHARED)}`)).status).toBe(403);
    });

    it('nodes and topology leave out a node on a channel the user cannot view, and a position from such a channel', async () => {
      await giveReads(harness.sourceA);
      const client = api(await harness.tokenFor(limited));

      for (const path of ['/nodes', '/network/topology']) {
        const body = text((await client.get(`/sources/${harness.sourceA}${path}`)).body);
        expect(body).not.toContain(A.ch1Name);
        expect(body).not.toContain(A.virtName);
        expect(body).toContain(A.posChName);
        expect(body).not.toContain(String(A.posChLat));
      }
    });

    it('topology edges and the traceroute count need traceroute:read on the source', async () => {
      await give('nodes', ['read'], harness.sourceA);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const client = api(await harness.tokenFor(limited));

      expect((await client.get(`/sources/${harness.sourceA}/network/topology`)).body.data.edges).toEqual([]);
      expect((await client.get(`/sources/${harness.sourceA}/network`)).body.data.tracerouteCount).toBe(0);

      await give('traceroute', ['read'], harness.sourceA);
      expect((await client.get(`/sources/${harness.sourceA}/network/topology`)).body.data.edges).toHaveLength(3);
      expect((await client.get(`/sources/${harness.sourceA}/network`)).body.data.tracerouteCount).toBe(3);
    });

    it('copy-candidates lists another source only with nodes:read on it', async () => {
      await giveReads(harness.sourceA);
      const client = api(await harness.tokenFor(limited));
      const url = `/sources/${harness.sourceA}/nodes/${SHARED}/copy-candidates`;

      expect((await client.get(url)).body.data).toEqual([]);

      await give('nodes', ['read'], harness.sourceB);
      const shown = await client.get(url);
      expect(shown.body.data.map((c: { sourceId: string }) => c.sourceId)).toEqual([harness.sourceB]);
    });

    // ── Private position overrides ──────────────────────────────────────────
    const PRIVATE_READS = [
      '/nodes',
      '/nodes?active=true',
      `/nodes/${idOf(PRIV_A)}`,
      '/network/topology',
    ];

    it.each(PRIVATE_READS)('GET /sources/A%s hides a private override without nodes_private:read on A, and shows it with it', async (path) => {
      await giveReads(harness.sourceA);
      // On B only: a grant on another source must not unmask A's override.
      await give('nodes_private', ['read'], harness.sourceB);
      const client = api(await harness.tokenFor(limited));

      const hidden = await client.get(`/sources/${harness.sourceA}${path}`);
      expect(hidden.status).toBe(200);
      expect(text(hidden.body)).not.toContain(String(A.privateLat));
      // The node is still listed, at the position its radio reports.
      expect(text(hidden.body)).toContain('AA-PRIVATE');
      expect(text(hidden.body)).toContain(String(A.privateDeviceLat));

      await give('nodes_private', ['read'], harness.sourceA);
      const shown = await client.get(`/sources/${harness.sourceA}${path}`);
      expect(text(shown.body)).toContain(String(A.privateLat));
    });

    it('position telemetry and position history of a private node need nodes_private:read on A', async () => {
      await giveReads(harness.sourceA);
      await give('nodes_private', ['read'], harness.sourceB);
      const client = api(await harness.tokenFor(limited));
      const at = (path: string) => client.get(`/sources/${harness.sourceA}${path}`);
      const telemetryReads = [`/telemetry/${idOf(PRIV_A)}`, `/telemetry?nodeId=${idOf(PRIV_A)}`, '/telemetry?type=latitude', '/telemetry'];

      for (const path of telemetryReads) {
        const res = await at(path);
        expect(res.status).toBe(200);
        expect(text(res.body), path).not.toContain(String(A.privateDeviceLat));
      }
      // Other telemetry of the node is not position data.
      expect(text((await at(`/telemetry/${idOf(PRIV_A)}`)).body)).toContain('temperature');
      const history = await at(`/nodes/${idOf(PRIV_A)}/position-history`);
      expect(history.status).toBe(403);
      expect(history.body.required).toEqual({ resource: 'nodes_private', action: 'read' });

      await give('nodes_private', ['read'], harness.sourceA);
      for (const path of telemetryReads) {
        expect(text((await at(path)).body), path).toContain(String(A.privateDeviceLat));
      }
      expect((await at(`/nodes/${idOf(PRIV_A)}/position-history`)).status).toBe(200);
    });

    it('telemetry by type leaves out rows heard on a channel the user cannot view, and rows of nodes on one', async () => {
      const at = Date.now() - 30_000;
      // A row of a visible node, heard on channel 1.
      await databaseService.telemetry.insertTelemetry(
        { nodeId: idOf(SHARED), nodeNum: SHARED, telemetryType: 'temperature', timestamp: at, value: 88.8888, createdAt: at, channel: 1 },
        harness.sourceA,
      );
      // A channel-0 row of a node last heard on channel 1.
      await sample(harness.sourceA, CH1_A, 'temperature', 99.9999);
      await giveReads(harness.sourceA);
      const client = api(await harness.tokenFor(limited));

      for (const path of ['/telemetry?type=temperature', '/telemetry']) {
        const body = text((await client.get(`/sources/${harness.sourceA}${path}`)).body);
        expect(body, path).not.toContain('88.8888');
        expect(body, path).not.toContain('99.9999');
      }
      expect(text((await client.get(`/sources/${harness.sourceA}/telemetry?type=temperature`)).body)).toContain(String(A.temp));

      await give('channel_1', ['read', 'viewOnMap'], harness.sourceA);
      const shown = text((await client.get(`/sources/${harness.sourceA}/telemetry?type=temperature`)).body);
      expect(shown).toContain('88.8888');
      expect(shown).toContain('99.9999');
    });

    it('a MeshCore id on the v1 telemetry and position-history routes needs nodes:viewOnMap on the source', async () => {
      await give('nodes', ['read'], harness.sourceA);
      await give('nodes', ['read', 'viewOnMap'], harness.sourceB);
      const client = api(await harness.tokenFor(limited));

      expect((await client.get(`/sources/${harness.sourceA}/telemetry/${MC_KEY}`)).status).toBe(403);
      expect((await client.get(`/sources/${harness.sourceA}/telemetry?nodeId=${MC_KEY}`)).status).toBe(403);
      expect((await client.get(`/sources/${harness.sourceA}/nodes/${MC_KEY}/position-history`)).status).toBe(403);
      expect((await client.get(`/sources/${harness.sourceB}/telemetry/${MC_KEY}`)).status).toBe(200);
    });

    it('a token of a user with every grant gets what an admin token gets, key for key', async () => {
      const adminClient = api(await harness.tokenFor(harness.admin));
      const asAdmin: Record<string, unknown> = {};
      for (const path of SOURCE_READS) {
        for (const sourceId of [harness.sourceA, harness.sourceB]) {
          const res = await adminClient.get(`/sources/${sourceId}${path}`);
          expect(res.status, path).toBe(200);
          asAdmin[`${sourceId}${path}`] = res.body;
        }
      }
      // The admin sees every private override and every channel.
      expect(text(asAdmin[`${harness.sourceA}/nodes`])).toContain(String(A.privateLat));
      expect(text(asAdmin[`${harness.sourceA}/nodes`])).toContain(A.virtName);

      await giveEverything();
      const client = api(await harness.tokenFor(limited));
      const stable = (body: unknown): unknown =>
        JSON.parse(JSON.stringify(body, (key, value) => (key === 'lastUpdated' ? 0 : value)));

      {
        for (const path of SOURCE_READS) {
          for (const sourceId of [harness.sourceA, harness.sourceB]) {
            const res = await client.get(`/sources/${sourceId}${path}`);
            expect(res.status, path).toBe(200);
            const admin = asAdmin[`${sourceId}${path}`];
            if (path.startsWith('/nodes') && !path.includes('/', 7) || path === '/network/topology' || path.startsWith('/telemetry')) {
              // The one difference: VIRT_A is on a channel-database channel.
              // Those are granted per channel entry, not per source, and the
              // user holds none. Compare without it.
              const withoutVirtual = (body: unknown): unknown =>
                JSON.parse(JSON.stringify(body, (_k, value) =>
                  Array.isArray(value) ? value.filter((row) => row?.nodeNum !== VIRT_A) : value));
              const mine = withoutVirtual(stable(res.body)) as { count?: number };
              const theirs = withoutVirtual(stable(admin)) as { count?: number };
              delete mine.count;
              delete theirs.count;
              expect(mine, `${sourceId}${path}`).toEqual(theirs);
            } else {
              expect(stable(res.body), `${sourceId}${path}`).toEqual(stable(admin));
            }
          }
        }
      }
    }, 60_000);

    it('a read-only add-on user gets the node, status and message fields it got before', async () => {
      await giveReads(harness.sourceA);
      await give('info', ['read']);
      const client = api(await harness.tokenFor(limited));
      const admin = api(await harness.tokenFor(harness.admin));

      const mine = (await client.get(`/sources/${harness.sourceA}/nodes`)).body.data.find((n: { nodeNum: number }) => n.nodeNum === SHARED);
      const theirs = (await admin.get(`/sources/${harness.sourceA}/nodes`)).body.data.find((n: { nodeNum: number }) => n.nodeNum === SHARED);
      expect(mine).toEqual(theirs);

      for (const path of ['/status', '/messages']) {
        expect((await client.get(`/sources/${harness.sourceA}${path}`)).body)
          .toEqual((await admin.get(`/sources/${harness.sourceA}${path}`)).body);
      }
    });

    it('reads the grants once per request in each handler, however many rows it returns', async () => {
      await giveReads(harness.sourceA);
      const client = api(await harness.tokenFor(limited));
      const grants = vi.spyOn(databaseService.auth, 'getPermissionsForUser');

      for (const path of ['/nodes', '/network/topology', '/telemetry', '/channels', '/messages', '/traceroutes']) {
        grants.mockClear();
        await client.get(`/sources/${harness.sourceA}${path}`);
        // attachSource's check at the door, and the handler's one load.
        expect(grants.mock.calls.length, path).toBeLessThanOrEqual(2);
      }
    });

    it('refuses a token that is missing or wrong', async () => {
      expect((await request(harness.app).get(`/api/v1/sources/${harness.sourceA}/nodes`)).status).toBe(401);
      expect((await api('mm_v1_not-a-token').get(`/sources/${harness.sourceA}/nodes`)).status).toBe(401);
    });
  });

  // ── Embeds ────────────────────────────────────────────────────────────────
  describe('anonymous embeds show only what the profile names', () => {
    const embed = (id: string, path: string) => request(harness.app).get(`/api/embed/${id}/${path}`);
    const DATA = ['nodes', 'neighborinfo', 'traceroutes'];

    it.each(DATA)('GET /:profile/%s never shows a private override, on a one-source or an all-source profile', async (path) => {
      for (const id of ['zz-embed-a', 'zz-embed-all', 'zz-embed-any-channel']) {
        const res = await embed(id, path);
        expect(res.status).toBe(200);
        expect(text(res.body), id).not.toContain(String(A.privateLat));
        // The node is left out altogether: not at its reported position either.
        expect(text(res.body), id).not.toContain('AA-PRIVATE');
        expect(text(res.body), id).not.toContain(String(PRIV_A));
      }
    });

    it.each(DATA)('GET /:profile/%s stays inside the profile\'s source', async (path) => {
      const onA = await embed('zz-embed-a', path);
      expect(text(onA.body)).toContain(A.name);
      expectNoB(onA.body);

      // Each profile's reply is built from that profile: B's is not A's.
      const onB = await embed('zz-embed-b', path);
      expect(text(onB.body)).toContain(B.onlyName);
      expect(text(onB.body)).not.toContain(A.name);
      expect(text(onB.body)).not.toContain(A.localName);
    });

    it.each(DATA)('GET /:profile/%s leaves out hidden nodes, other channels and positions from other channels', async (path) => {
      for (const id of ['zz-embed-a', 'zz-embed-all']) {
        const body = text((await embed(id, path)).body);
        for (const marker of [A.hiddenName, String(HIDDEN_A), A.ch1Name, A.posChName, String(A.posChLat), A.virtName]) {
          expect(body, `${id} ${marker}`).not.toContain(marker);
        }
      }
    });

    it('an empty channel list means every device channel, never a channel-database channel', async () => {
      const body = text((await embed('zz-embed-any-channel', 'nodes')).body);
      expect(body).toContain(A.ch1Name);
      expect(body).toContain(A.posChName);
      expect(body).not.toContain(A.virtName);
    });

    it('a traceroute heard on a channel outside the profile is not drawn', async () => {
      await databaseService.traceroutes.deleteAllTraceroutes(harness.sourceA);
      await traceroute(harness.sourceA, LOCAL_A, SHARED, 1);

      expect((await embed('zz-embed-a', 'traceroutes')).body).toEqual([]);
      // The forward and the return leg of the one traceroute.
      expect((await embed('zz-embed-any-channel', 'traceroutes')).body).toHaveLength(2);
    });

    it('serves links and paths only when the profile turns them on', async () => {
      for (const path of ['neighborinfo', 'traceroutes']) {
        const res = await embed('zz-embed-quiet', path);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      expect((await embed('zz-embed-quiet', 'nodes')).status).toBe(200);
    });

    it('returns the same node fields as before, and no override or privacy column', async () => {
      const res = await embed('zz-embed-a', 'nodes');
      const shared = res.body.find((n: { nodeNum: number }) => n.nodeNum === SHARED);

      expect(Object.keys(shared).sort()).toEqual(
        ['channel', 'firstHeard', 'hopsAway', 'lastHeard', 'nodeId', 'nodeNum', 'position', 'role', 'snr', 'user', 'viaMqtt'].filter(
          (k) => k in shared,
        ),
      );
      expect(Object.keys(shared.position).sort()).toEqual(['altitude', 'latitude', 'longitude'].filter((k) => k in shared.position));
      expect(Object.keys(shared.user).sort()).toEqual(['hwModel', 'longName', 'shortName']);
      expect(text(res.body)).not.toMatch(/Override|IsPrivate/);
    });

    it('404s for an unknown or disabled profile, and sends no cache header', async () => {
      expect((await embed('zz-embed-missing', 'nodes')).status).toBe(404);
      await databaseService.embedProfiles.updateAsync('zz-embed-a', { enabled: false } as never);
      expect((await embed('zz-embed-a', 'nodes')).status).toBe(404);

      const res = await embed('zz-embed-b', 'nodes');
      expect(res.headers['cache-control']).toBeUndefined();
    });

    it('reads the nodes once per request, with no query per node', async () => {
      const read = vi.spyOn(databaseService.nodes, 'getActiveNodes');
      const one = vi.spyOn(databaseService.nodes, 'getNode');
      const grants = vi.spyOn(databaseService.auth, 'getPermissionsForUser');

      for (const path of DATA) await embed('zz-embed-all', path);

      expect(read).toHaveBeenCalledTimes(DATA.length);
      expect(one).not.toHaveBeenCalled();
      // The viewer is anonymous; the profile decides. No grant is consulted
      // by the embed handlers (the harness's own optionalAuth aside).
      expect(grants).not.toHaveBeenCalled();
    });
  });

  // ── MeshCore ids on the telemetry routes ──────────────────────────────────
  describe('a MeshCore id on the telemetry routes needs nodes:viewOnMap on the source', () => {
    const urls = (sourceId: string): string[] => [
      `/telemetry/${MC_KEY}?sourceId=${sourceId}`,
      `/telemetry/${MC_KEY}/rates?sourceId=${sourceId}`,
      `/telemetry/${MC_KEY}/smarthops?sourceId=${sourceId}`,
      `/telemetry/${MC_KEY}/linkquality?sourceId=${sourceId}`,
      `/telemetry/${MC_KEY}/signal-trend?sourceId=${sourceId}`,
    ];

    it('is refused for a signed-in user without the grant, and with it on another source only', async () => {
      await give('info', ['read', 'write']);
      await give('dashboard', ['read']);
      await give('nodes', ['read'], harness.sourceA);
      await give('nodes', ['read', 'viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      for (const url of urls(harness.sourceA)) {
        expect((await agent.get(url)).status, url).toBe(403);
      }
      const purge = await agent.delete(`/telemetry/${MC_KEY}/temperature?sourceId=${harness.sourceA}`);
      expect(purge.status).toBe(403);
      // The same refusal for an API token on the route that takes one.
      const token = await harness.tokenFor(limited);
      const byToken = await request(harness.app)
        .delete(`/telemetry/${MC_KEY}/temperature?sourceId=${harness.sourceA}`)
        .set('Authorization', `Bearer ${token}`);
      expect(byToken.status).toBe(403);
    });

    it('is allowed with nodes:viewOnMap on that source, and for an admin', async () => {
      await give('info', ['read']);
      await give('nodes', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);
      const admin = await harness.loginAs(harness.admin);

      for (const url of urls(harness.sourceA)) {
        expect((await agent.get(url)).status, url).toBe(200);
        expect((await admin.get(url)).status, url).toBe(200);
      }
    });

    it('is refused for an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      for (const url of urls(harness.sourceA)) {
        expect((await agent.get(url)).status, url).toBe(403);
      }
    });
  });

  // ── POST /system/restart ──────────────────────────────────────────────────
  describe('POST /system/restart is admin only', () => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 650));

    it('403s for settings:write on every source, by session and by token, and does not restart', async () => {
      await give('settings', ['read', 'write'], harness.sourceA);
      await give('settings', ['read', 'write'], harness.sourceB);

      const bySession = await (await harness.loginAs(limited)).post('/system/restart').send({});
      expect(bySession.status).toBe(403);
      expect(bySession.body.code).toBe('FORBIDDEN_ADMIN');

      const byToken = await request(harness.app)
        .post('/system/restart')
        .set('Authorization', `Bearer ${await harness.tokenFor(limited)}`)
        .send({});
      expect(byToken.status).toBe(403);
      expect(byToken.body.code).toBe('FORBIDDEN_ADMIN');

      await settle();
      expect(shutdown).not.toHaveBeenCalled();
    });

    it('401s for an anonymous caller', async () => {
      const res = await (await harness.loginAs(null)).post('/system/restart').send({});
      expect(res.status).toBe(401);
      await settle();
      expect(shutdown).not.toHaveBeenCalled();
    });

    it('an admin restarts, with the reply it had before', async () => {
      const res = await (await harness.loginAs(harness.admin)).post('/system/restart').send({});
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['action', 'message', 'success']);
      await settle();
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });
});

// ── Guard: every v1 and embed route is classified ───────────────────────────

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

const key = (r: RegisteredRoute): string => `${r.method.toUpperCase()} ${r.path}`;
const sourceOf = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

/**
 * How a v1 route decides who gets what. Every route sits behind
 * `requireAPIToken()`, so the caller is the token's creator.
 *
 *  - `source`: mounted under `/sources/:sourceId` behind `attachSource()`,
 *    which checks the grant on that source. The handler reads the source from
 *    `requireScopedSourceId()` and nothing else. Tested above.
 *  - `source-route`: the same, with `attachSource()` on the route itself.
 *  - `pair`: names two sources in the body; read is checked on one and write
 *    on the other, in the handler.
 *  - `cross-source`: computes its own source set from the caller's
 *    `nodes:read` / `nodes:write` per source (the shared enrichment handlers).
 *  - `listed`: lists or exports only the sources the caller holds a grant on.
 *  - `global`: install-wide data with no per-source rows.
 *  - `global-permission`: the same, behind an install-wide `requirePermission`.
 */
type V1Kind = 'source' | 'source-route' | 'pair' | 'cross-source' | 'listed' | 'global' | 'global-permission';

const V1: Record<string, { router: Router; file: string; mount: string | null; routes: Record<string, V1Kind> }> = {
  nodes: {
    router: nodesRouter, file: './v1/nodes.ts', mount: "attachSource('nodes', 'read')",
    routes: {
      'GET /': 'source',
      'GET /:nodeId': 'source',
      'GET /:nodeNum/copy-candidates': 'source',
      'POST /:nodeNum/copy-nodeinfo': 'pair',
      'GET /enrichment/analysis': 'cross-source',
      'POST /enrichment/apply': 'cross-source',
    },
  },
  positionHistory: {
    router: positionHistoryRouter, file: './v1/positionHistory.ts', mount: "attachSource('nodes', 'read')",
    routes: { 'GET /:nodeId/position-history': 'source' },
  },
  network: {
    router: networkRouter, file: './v1/network.ts', mount: "attachSource('nodes', 'read')",
    routes: { 'GET /': 'source', 'GET /direct-neighbors': 'source', 'GET /topology': 'source' },
  },
  telemetry: {
    router: telemetryRouter, file: './v1/telemetry.ts', mount: "attachSource('nodes', 'read')",
    routes: { 'GET /': 'source', 'GET /count': 'source', 'GET /:nodeId': 'source' },
  },
  traceroutes: {
    router: traceroutesRouter, file: './v1/traceroutes.ts', mount: "attachSource('traceroute', 'read')",
    routes: { 'GET /': 'source', 'GET /:fromNodeId/:toNodeId': 'source' },
  },
  messages: {
    router: messagesRouter, file: './v1/messages.ts', mount: "attachSource('messages', 'read')",
    routes: { 'GET /': 'source', 'GET /search': 'source', 'GET /:messageId': 'source', 'POST /': 'source' },
  },
  channels: {
    router: channelsRouter, file: './v1/channels.ts', mount: "attachSource('messages', 'read')",
    routes: { 'GET /': 'source', 'GET /:channelId': 'source' },
  },
  packets: {
    router: packetsRouter, file: './v1/packets.ts', mount: "attachSource('packetmonitor', 'read')",
    routes: { 'GET /': 'source', 'GET /:id': 'source' },
  },
  status: {
    router: statusRouter, file: './v1/status.ts', mount: "attachSource('info', 'read')",
    routes: { 'GET /': 'source' },
  },
  actions: {
    router: actionsRouter, file: './v1/actions.ts', mount: null,
    routes: {
      'POST /traceroute': 'source-route',
      'POST /request-position': 'source-route',
      'POST /request-nodeinfo': 'source-route',
      'POST /request-neighbors': 'source-route',
    },
  },
  sources: { router: sourcesRouter, file: './v1/sources.ts', mount: null, routes: { 'GET /': 'listed' } },
  metrics: { router: metricsRouter, file: './v1/metrics.ts', mount: null, routes: { 'GET /': 'listed' } },
  solar: { router: solarRouter, file: './v1/solar.ts', mount: null, routes: { 'GET /': 'global', 'GET /range': 'global' } },
  translate: { router: translateRouter, file: './v1/translate.ts', mount: null, routes: { 'POST /': 'global-permission' } },
  channelDatabase: {
    router: channelDatabaseRouter, file: './v1/channelDatabase.ts', mount: null,
    routes: {
      'GET /': 'global',
      'GET /retroactive-decrypt/progress': 'global',
      'GET /:id': 'global',
      'POST /': 'global',
      'PUT /reorder': 'global',
      'POST /import-meshcore': 'global',
      'PUT /:id': 'global',
      'DELETE /:id': 'global',
      'POST /:id/retroactive-decrypt': 'global',
      'GET /:id/permissions': 'global',
      'PUT /:id/permissions/:userId': 'global',
      'DELETE /:id/permissions/:userId': 'global',
    },
  },
};

describe('guard: v1 routes are classified', () => {
  it.each(Object.keys(V1))('every %s route has a class', (name) => {
    const entry = V1[name];
    // A new route must be added here, with a test for what it returns to whom.
    expect(registeredRoutes(entry.router).map(key).sort()).toEqual(Object.keys(entry.routes).sort());
  });

  it('every per-source router is mounted behind attachSource, and the others are not under /sources/:sourceId', () => {
    const index = sourceOf('./v1/index.ts');
    const mounts = [...index.matchAll(/router\.use\(\s*'(\/sources\/:sourceId\/[a-z-]+)',\s*([^;]*?)\);/gs)]
      .map((m) => ({ path: m[1], rest: m[2].replace(/\s+/g, ' ').trim() }));
    expect(mounts.map((m) => m.path).sort()).toEqual([
      '/sources/:sourceId/actions', '/sources/:sourceId/channels', '/sources/:sourceId/messages',
      '/sources/:sourceId/network', '/sources/:sourceId/nodes', '/sources/:sourceId/packets',
      '/sources/:sourceId/status', '/sources/:sourceId/telemetry', '/sources/:sourceId/traceroutes',
    ]);
    for (const mount of mounts) {
      if (mount.path.endsWith('/actions')) continue; // gated per route, below
      expect(mount.rest, mount.path).toMatch(/^attachSource\('[a-z_]+', 'read'\),/);
    }
    for (const [name, entry] of Object.entries(V1)) {
      if (entry.mount === null) continue;
      const routerName = `${name}Router`;
      const mount = mounts.find((m) => m.rest.split(',').map((s) => s.trim()).includes(routerName));
      expect(mount, routerName).toBeDefined();
      expect(mount!.rest.startsWith(entry.mount), `${routerName}: ${mount!.rest}`).toBe(true);
    }
    // No per-source router is also mounted at the root, where no source is checked.
    expect(index).not.toMatch(/router\.use\('\/(nodes|network|telemetry|traceroutes|messages|channels|packets|status)'/);
  });

  it('every actions route carries its own attachSource gate, for a write', () => {
    for (const route of registeredRoutes(actionsRouter)) {
      const gate = route.handlers.map((h) => getAttachSourceGate(h)).find((g) => g !== undefined);
      expect(gate, key(route)).toBeDefined();
      expect(gate!.action, key(route)).toBe('write');
    }
  });

  it('a per-source handler reads its source from requireScopedSourceId(), never "every source"', () => {
    for (const [name, entry] of Object.entries(V1)) {
      const kinds = Object.values(entry.routes);
      if (!kinds.includes('source')) continue;
      const code = sourceOf(entry.file);
      // The old fallbacks: `sourceId ?? ALL_SOURCES`, and grants merged across sources.
      expect(code, name).not.toMatch(/ALL_SOURCES/);
      expect(code, name).not.toMatch(/req\.(query|params|body)\.sourceId/);
      expect(code, name).not.toMatch(/resolvedSourceIdFromPath|getUserPermissionSetAsync/);
      expect(code, name).not.toMatch(/\b(filterNodesByChannelPermission|maskNodeLocationByChannel|maskTelemetryByChannel|maskTraceroutesByChannel|checkNodeChannelAccess)\(/);
      const scoped = [...code.matchAll(/requireScopedSourceId\(req, res\)/g)].length;
      expect(scoped, name).toBe(kinds.filter((k) => k === 'source').length);
    }
  });

  it('no v1 handler checks a per-source permission without naming a source', () => {
    for (const entry of Object.values(V1)) {
      const code = sourceOf(entry.file);
      const calls = [...code.matchAll(/\b(?:hasPermission|checkPermissionAsync)\(([^()]*)\)/g)].map((m) => m[1].split(',').map((a) => a.trim()));
      const unscoped = calls.filter((args) => args.length < 4 && (SOURCEY_RESOURCES as readonly string[]).includes(args[1]?.replace(/['"`]/g, '')));
      expect(unscoped, entry.file).toEqual([]);
    }
    // The one requirePermission() on a v1 route that names no source gates a
    // route that reads no source's rows (it translates the caller's own text).
    for (const [name, entry] of Object.entries(V1)) {
      for (const route of registeredRoutes(entry.router)) {
        const gated = route.handlers.some((h) => getPermissionGate(h) !== undefined);
        expect(gated, `${name} ${key(route)}`).toBe(entry.routes[key(route)] === 'global-permission');
      }
    }
  });
});

/**
 * How an embed route decides what an anonymous viewer gets:
 *  - `profile-config`: the profile's own display settings.
 *  - `profile-nodes`: built from `visibleEmbedNodes(profile)`, the one rule for
 *    which nodes a profile shows and where. Tested above.
 *  - `public-layers`: GeoJSON layers flagged publicly visible; no node data.
 */
type EmbedKind = 'profile-config' | 'profile-nodes' | 'public-layers';

const EMBED: Record<string, EmbedKind> = {
  'GET /:profileId/config': 'profile-config',
  'GET /:profileId/nodes': 'profile-nodes',
  'GET /:profileId/neighborinfo': 'profile-nodes',
  'GET /:profileId/traceroutes': 'profile-nodes',
  'GET /:profileId/geojson/layers': 'public-layers',
  'GET /:profileId/geojson/layers/:id/data': 'public-layers',
};

describe('guard: embed routes are classified', () => {
  const code = sourceOf('./embedPublicRoutes.ts');

  it('every embed route has a class and sits behind the profile middleware', () => {
    const routes = registeredRoutes(embedPublicRoutes);
    // A new route must be added to EMBED, with a test for what it shows.
    expect(routes.map(key).sort()).toEqual(Object.keys(EMBED).sort());
    for (const route of routes) {
      // The profile middleware, then the handler. No admin or permission gate:
      // the viewer is anonymous and the profile decides.
      expect(route.handlers, key(route)).toHaveLength(2);
      expect(route.handlers.some((h) => isAdminGate(h) || getPermissionGate(h)), key(route)).toBe(false);
    }
    expect([...code.matchAll(/createEmbedCspMiddleware\(\)/g)]).toHaveLength(routes.length);
  });

  it('every node-bearing embed route draws from visibleEmbedNodes(), the only node read', () => {
    const nodeRoutes = Object.values(EMBED).filter((kind) => kind === 'profile-nodes').length;
    expect([...code.matchAll(/await visibleEmbedNodes\(profile\)/g)]).toHaveLength(nodeRoutes);
    // One node read in the file: inside visibleEmbedNodes. A handler that
    // reads nodes itself skips the private / hidden / channel rules.
    expect([...code.matchAll(/\.nodes\.(getActiveNodes|getAllNodes|getNode)\(/g)]).toHaveLength(1);
    expect(code).toMatch(/if \(node\.positionOverrideIsPrivate\) continue;/);
    expect(code).toMatch(/if \(node\.hideFromMap\) continue;/);
    // No response is cached by the server.
    expect(code).not.toMatch(/Cache-Control|new Map<string, .*>\(\);\s*\/\/ cache/);
  });
});
