/**
 * #5156 part 1: with `anonHideMqttNoConsent` on for a source, an ANONYMOUS
 * viewer does not see a node that declined ok_to_mqtt (and was never heard
 * over direct RF) on that source, nor its data. A signed-in user with the
 * same grants sees everything, and a source with the flag off is untouched.
 *
 * Driven through the real auth middleware with real permission rows, one
 * test per endpoint family. Managers are fakes; nothing is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import nodesRoutes from './nodesRoutes.js';
import messageRoutes from './messageRoutes.js';
import telemetryRoutes from './telemetryRoutes.js';
import neighborInfoRoutes from './neighborInfoRoutes.js';
import tracerouteRoutes from './tracerouteRoutes.js';
import analysisRoutes from './analysisRoutes.js';
import embedPublicRoutes from './embedPublicRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadAllNodesAsDeviceInfo } from '../utils/dbNodeMapper.js';
import { ANON_HIDE_MQTT_NO_CONSENT_SETTING } from '../utils/mqttConsentVisibility.js';

const HIDDEN = 0x5156_a001;
const HIDDEN_ID = '!5156a001';
const SHOWN = 0x5156_a002;
const SHOWN_ID = '!5156a002';
const RF = 0x5156_a003;
const RF_ID = '!5156a003';

/** Marker text per source, so a body can be searched for the hidden node's data. */
const mark = (sourceId: string) => ({
  hiddenName: `HIDDEN-${sourceId}`,
  shownName: `SHOWN-${sourceId}`,
  rfName: `RFNODE-${sourceId}`,
  text: `SECRET-SAYS-${sourceId}`,
});

const fakeManager = (sourceId: string): ISourceManager =>
  ({
    sourceId,
    sourceType: 'meshtastic_tcp',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: true }),
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
    getAllNodesAsync: vi.fn((id?: string) => loadAllNodesAsDeviceInfo(id)),
    getRecentMessages: vi.fn(async () => []),
  }) as unknown as ISourceManager;

async function seedSource(sourceId: string): Promise<void> {
  const m = mark(sourceId);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const base = { shortName: 'X', hwModel: 43, channel: 0, lastHeard: nowSec, latitude: 30.5, longitude: -80.5 };
  await databaseService.nodes.upsertNode(
    { ...base, nodeNum: HIDDEN, nodeId: HIDDEN_ID, longName: m.hiddenName, mqttOkToMqtt: false, mqttOkToMqttAt: nowSec, viaMqtt: true },
    sourceId,
  );
  await databaseService.nodes.upsertNode({ ...base, nodeNum: SHOWN, nodeId: SHOWN_ID, longName: m.shownName }, sourceId);
  await databaseService.nodes.upsertNode(
    { ...base, nodeNum: RF, nodeId: RF_ID, longName: m.rfName, mqttOkToMqtt: false, mqttOkToMqttAt: nowSec, rfDirectLastHeard: nowSec },
    sourceId,
  );
  for (const [telemetryType, value] of [['batteryLevel', 77.25], ['latitude', 30.5], ['longitude', -80.5]] as const) {
    await databaseService.telemetry.insertTelemetry(
      { nodeId: HIDDEN_ID, nodeNum: HIDDEN, telemetryType, timestamp: nowMs - 1000, value, createdAt: nowMs - 1000, channel: 0 },
      sourceId,
    );
  }
  await databaseService.messages.insertMessage(
    {
      id: `${sourceId}_${HIDDEN}_1`, fromNodeNum: HIDDEN, toNodeNum: 0xffffffff, fromNodeId: HIDDEN_ID, toNodeId: '!ffffffff',
      text: m.text, channel: 0, portnum: 1, timestamp: nowMs, rxTime: nowMs, createdAt: nowMs,
    } as never,
    sourceId,
  );
  await databaseService.neighbors.insertNeighborInfo(
    { nodeNum: SHOWN, neighborNodeNum: HIDDEN, snr: 5, timestamp: nowMs, createdAt: nowMs },
    sourceId,
  );
  await databaseService.traceroutes.insertTraceroute(
    {
      fromNodeNum: SHOWN, toNodeNum: RF, fromNodeId: SHOWN_ID, toNodeId: RF_ID,
      route: JSON.stringify([HIDDEN]), routeBack: '[]', snrTowards: null, snrBack: null,
      timestamp: nowMs, createdAt: nowMs,
    },
    sourceId,
  );
}

describe('anonymous MQTT-consent filter (#5156) across endpoint families', () => {
  let harness: RouteTestHarness;
  let A: string;
  let B: string;

  const grantAll = async (userId: number, sourceId: string): Promise<void> => {
    await databaseService.auth.createPermission({
      userId, resource: 'channel_0', canRead: true, canWrite: false, canViewOnMap: true, sourceId, grantedAt: Date.now(), grantedBy: null,
    } as never);
    for (const resource of ['messages', 'info', 'traceroute', 'nodes']) {
      await harness.grant(userId, resource, 'read', sourceId);
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/', nodesRoutes);
        app.use('/messages', messageRoutes);
        app.use('/', telemetryRoutes);
        app.use('/neighbor-info', neighborInfoRoutes);
        app.use('/traceroutes', tracerouteRoutes);
        app.use('/analysis', analysisRoutes);
      },
    });
    A = harness.sourceA;
    B = harness.sourceB;
    await sourceManagerRegistry.addManager(fakeManager(A));
    await sourceManagerRegistry.addManager(fakeManager(B));
    await seedSource(A);
    await seedSource(B);
    for (const userId of [harness.anonymous.id, harness.limited.id]) {
      await grantAll(userId, A);
      await grantAll(userId, B);
    }
    // Flag on A only: B proves per-source isolation.
    await databaseService.settings.setSourceSetting(A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '1');
    await databaseService.settings.setSourceSetting(B, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '0');
  });

  afterEach(async () => {
    await databaseService.settings.setSourceSetting(A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '0');
    await databaseService.messages.deleteAllMessages(A);
    await databaseService.messages.deleteAllMessages(B);
    for (const id of [A, B]) {
      await databaseService.neighbors.deleteAllNeighborInfo(id);
      await databaseService.traceroutes.deleteAllTraceroutes(id);
    }
    await sourceManagerRegistry.removeManager(A);
    await sourceManagerRegistry.removeManager(B);
    await harness.revokeAll(harness.anonymous.id);
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  const body = (res: { body: unknown }): string => JSON.stringify(res.body ?? null);

  describe('node list (GET /nodes, /nodes/active)', () => {
    it.each(['/nodes', '/nodes/active'])('%s?sourceId=A: anonymous loses the hidden node; RF-heard and unknown stay', async (url) => {
      const anon = await harness.loginAs(null);
      const res = await anon.get(url).query({ sourceId: A });
      expect(res.status).toBe(200);
      const text = body(res);
      expect(text).not.toContain(mark(A).hiddenName);
      expect(text).toContain(mark(A).shownName);
      expect(text).toContain(mark(A).rfName);
    });

    it.each(['/nodes', '/nodes/active'])('%s with no source: the flag on A leaves B\'s copy of the node visible', async (url) => {
      const anon = await harness.loginAs(null);
      const text = body(await anon.get(url));
      expect(text).not.toContain(mark(A).hiddenName);
      expect(text).toContain(mark(B).hiddenName);
    });

    it('a signed-in user with the same grants sees the node', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/nodes').query({ sourceId: A });
      expect(res.status).toBe(200);
      expect(body(res)).toContain(mark(A).hiddenName);
    });

    it('flag off: anonymous sees the node', async () => {
      await databaseService.settings.setSourceSetting(A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '0');
      const anon = await harness.loginAs(null);
      const res = await anon.get('/nodes').query({ sourceId: A });
      expect(body(res)).toContain(mark(A).hiddenName);
    });
  });

  describe('telemetry (GET /telemetry/:nodeId)', () => {
    it('anonymous gets none of the hidden node\'s telemetry on A; signed-in does', async () => {
      const anon = await harness.loginAs(null);
      const anonRes = await anon.get(`/telemetry/${HIDDEN_ID}`).query({ sourceId: A });
      expect(body(anonRes)).not.toContain('77.25');

      const anonB = await anon.get(`/telemetry/${HIDDEN_ID}`).query({ sourceId: B });
      expect(body(anonB)).toContain('77.25');

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/telemetry/${HIDDEN_ID}`).query({ sourceId: A });
      expect(res.status).toBe(200);
      expect(body(res)).toContain('77.25');
    });
  });

  describe('channel messages (GET /messages/channel/0)', () => {
    it('anonymous does not get the hidden node\'s messages on A; signed-in does', async () => {
      const anon = await harness.loginAs(null);
      const anonRes = await anon.get('/messages/channel/0').query({ sourceId: A });
      expect(anonRes.status).toBe(200);
      expect(body(anonRes)).not.toContain(mark(A).text);

      const anonB = await anon.get('/messages/channel/0').query({ sourceId: B });
      expect(body(anonB)).toContain(mark(B).text);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/messages/channel/0').query({ sourceId: A });
      expect(body(res)).toContain(mark(A).text);
    });
  });

  describe('neighbor links (GET /neighbor-info/:nodeNum)', () => {
    // The per-node read: the unscoped latest-per-pair read behind GET
    // /neighbor-info picks one row per pair across ALL sources before it
    // scopes, so two sources holding the same pair can't both be shown there.
    const edgesToHidden = (res: { body: unknown }): number =>
      (Array.isArray(res.body) ? res.body : []).filter((e: { neighborNodeNum?: number }) => Number(e.neighborNodeNum) === HIDDEN).length;
    const url = `/neighbor-info/${SHOWN}`;

    it('anonymous loses edges touching the hidden node on A; signed-in keeps them', async () => {
      const anon = await harness.loginAs(null);
      expect(edgesToHidden(await anon.get(url).query({ sourceId: A }))).toBe(0);
      expect(edgesToHidden(await anon.get(url).query({ sourceId: B }))).toBe(1);

      const agent = await harness.loginAs(harness.limited);
      expect(edgesToHidden(await agent.get(url).query({ sourceId: A }))).toBe(1);
    });
  });

  describe('traceroutes (GET /traceroutes/history) — a hidden relay drops the route', () => {
    it('anonymous gets no route through the hidden node on A; signed-in does', async () => {
      const url = `/traceroutes/history/${SHOWN}/${RF}`;
      const anon = await harness.loginAs(null);
      const anonRes = await anon.get(url).query({ sourceId: A });
      expect(anonRes.status).toBe(200);
      expect(anonRes.body).toHaveLength(0);
      expect(await anon.get(url).query({ sourceId: B }).then((r) => r.body)).toHaveLength(1);

      const agent = await harness.loginAs(harness.limited);
      expect(await agent.get(url).query({ sourceId: A }).then((r) => r.body)).toHaveLength(1);
    });
  });

  describe('map positions (GET /analysis/positions, via buildPositionFilter)', () => {
    const positionsOf = (res: { body: { items?: Array<{ nodeNum: number; sourceId: string }> } }, sourceId: string) =>
      (res.body.items ?? []).filter((p) => Number(p.nodeNum) === HIDDEN && p.sourceId === sourceId).length;

    it('anonymous gets no positions of the hidden node on A; signed-in does', async () => {
      const anon = await harness.loginAs(null);
      const anonRes = await anon.get('/analysis/positions').query({ sources: `${A},${B}` });
      expect(anonRes.status).toBe(200);
      expect(positionsOf(anonRes, A)).toBe(0);
      expect(positionsOf(anonRes, B)).toBeGreaterThan(0);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/analysis/positions').query({ sources: A });
      expect(positionsOf(res, A)).toBeGreaterThan(0);
    });
  });

  describe('embeds (GET /api/embed/:profileId/nodes, always anonymous)', () => {
    it('the hidden node is left out of an embed of A, kept in an embed of B', async () => {
      const app = express();
      app.use('/api/embed', embedPublicRoutes);
      const profile = (id: string, sourceId: string) => databaseService.embedProfiles.createAsync({
        id, name: id, enabled: true, channels: [0], tileset: 'osm', defaultLat: 0, defaultLng: 0, defaultZoom: 10,
        showTooltips: true, showPopups: true, showLegend: true, showPaths: true, showNeighborInfo: true,
        showTraceroutes: true, showMqttNodes: true, pollIntervalSeconds: 30, allowedOrigins: [], sourceId,
      });
      await profile('mqtt-consent-a', A);
      await profile('mqtt-consent-b', B);
      try {
        const resA = await request(app).get('/api/embed/mqtt-consent-a/nodes');
        expect(resA.status).toBe(200);
        expect(JSON.stringify(resA.body)).not.toContain(mark(A).hiddenName);
        expect(JSON.stringify(resA.body)).toContain(mark(A).shownName);
        const resB = await request(app).get('/api/embed/mqtt-consent-b/nodes');
        expect(JSON.stringify(resB.body)).toContain(mark(B).hiddenName);
      } finally {
        await databaseService.embedProfiles.deleteAsync('mqtt-consent-a').catch(() => {});
        await databaseService.embedProfiles.deleteAsync('mqtt-consent-b').catch(() => {});
      }
    });
  });
});
