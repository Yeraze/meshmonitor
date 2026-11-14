/**
 * #5156 review: the anonymous MQTT-consent filter on the remaining endpoint
 * families that can name a node — route-segment records (best VISIBLE row),
 * packet distribution, direct-neighbour stats, ATAK contacts, the node's
 * source list, tracked assets — and the fail-closed route behaviour.
 *
 * Flag on source A only. Real auth middleware, real permission rows; nothing
 * is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import nodesRoutes from './nodesRoutes.js';
import packetRoutes from './packetRoutes.js';
import telemetryRoutes from './telemetryRoutes.js';
import routeSegmentRoutes from './routeSegmentRoutes.js';
import atakRoutes from './atakRoutes.js';
import assetRoutes from './assetRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadAllNodesAsDeviceInfo } from '../utils/dbNodeMapper.js';
import { ANON_HIDE_MQTT_NO_CONSENT_SETTING } from '../utils/mqttConsentVisibility.js';

const HIDDEN = 0x5156_b001;
const HIDDEN_ID = '!5156b001';
const SHOWN = 0x5156_b002;
const SHOWN_ID = '!5156b002';
const OTHER = 0x5156_b003;
const OTHER_ID = '!5156b003';

const fakeManager = (sourceId: string): ISourceManager =>
  ({
    sourceId,
    sourceType: 'meshtastic_tcp',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: true }),
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
    getAllNodesAsync: vi.fn((id?: string) => loadAllNodesAsDeviceInfo(id)),
  }) as unknown as ISourceManager;

describe('anonymous MQTT-consent filter (#5156): remaining endpoint families', () => {
  let harness: RouteTestHarness;
  let A: string;
  let previousPacketLog: string | null;

  const give = async (userId: number, resource: string, actions: Array<'read' | 'viewOnMap'>): Promise<void> => {
    await databaseService.auth.createPermission({
      userId, resource, canRead: actions.includes('read'), canWrite: false, canViewOnMap: actions.includes('viewOnMap'),
      sourceId: A, grantedAt: Date.now(), grantedBy: null,
    } as never);
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/', nodesRoutes);
        app.use('/packets', packetRoutes);
        app.use('/', telemetryRoutes);
        app.use('/route-segments', routeSegmentRoutes);
        app.use('/sources/:id/atak', atakRoutes);
        app.use('/assets', assetRoutes);
      },
    });
    A = harness.sourceA;
    await sourceManagerRegistry.addManager(fakeManager(A));

    const nowSec = Math.floor(Date.now() / 1000);
    const nowMs = Date.now();
    const base = { shortName: 'X', hwModel: 43, channel: 0, lastHeard: nowSec, latitude: 30.5, longitude: -80.5 };
    await databaseService.nodes.upsertNode(
      { ...base, nodeNum: HIDDEN, nodeId: HIDDEN_ID, longName: 'HIDDEN-NODE', mqttOkToMqtt: false, mqttOkToMqttAt: nowSec },
      A,
    );
    await databaseService.nodes.upsertNode({ ...base, nodeNum: SHOWN, nodeId: SHOWN_ID, longName: 'SHOWN-NODE' }, A);
    await databaseService.nodes.upsertNode({ ...base, nodeNum: OTHER, nodeId: OTHER_ID, longName: 'OTHER-NODE' }, A);

    // Route segments: the longest names the hidden node; the next one does not.
    await databaseService.traceroutes.insertRouteSegment(
      { fromNodeNum: SHOWN, toNodeNum: HIDDEN, fromNodeId: SHOWN_ID, toNodeId: HIDDEN_ID, distanceKm: 100, isRecordHolder: false, timestamp: nowMs, createdAt: nowMs },
      A,
    );
    await databaseService.traceroutes.insertRouteSegment(
      { fromNodeNum: SHOWN, toNodeNum: OTHER, fromNodeId: SHOWN_ID, toNodeId: OTHER_ID, distanceKm: 50, isRecordHolder: false, timestamp: nowMs, createdAt: nowMs },
      A,
    );

    // Packets: zero-hop receptions from both nodes on channel 0.
    previousPacketLog = await databaseService.getSettingAsync('packet_log_enabled');
    await databaseService.settings.setSetting('packet_log_enabled', '1');
    for (const [from, count] of [[HIDDEN, 5], [SHOWN, 2]] as const) {
      for (let i = 0; i < count; i++) {
        await databaseService.packetLog.insertPacketLog(
          {
            packet_id: from + i, timestamp: nowMs - i, from_node: from, to_node: 0xffffffff, channel: 0, portnum: 1,
            encrypted: false, rssi: -70, hop_start: 3, hop_limit: 3, direction: 'rx',
          },
          A,
        );
      }
    }

    await databaseService.atakContacts.upsertContact({
      uid: 'atak-hidden', sourceId: A, nodeNum: HIDDEN, callsign: 'HIDDEN-CALL', deviceCallsign: null, team: null, role: null,
      battery: null, latitude: 30.5, longitude: -80.5, altitude: null, speed: null, course: null, lastSeen: nowMs, createdAt: nowMs,
    });
    await databaseService.atakContacts.upsertContact({
      uid: 'atak-shown', sourceId: A, nodeNum: SHOWN, callsign: 'SHOWN-CALL', deviceCallsign: null, team: null, role: null,
      battery: null, latitude: 30.5, longitude: -80.5, altitude: null, speed: null, course: null, lastSeen: nowMs, createdAt: nowMs,
    });
    await databaseService.assetNodes.setAsync(HIDDEN, 7);

    for (const userId of [harness.anonymous.id, harness.limited.id]) {
      await give(userId, 'channel_0', ['read', 'viewOnMap']);
      await give(userId, 'nodes', ['read']);
      await give(userId, 'info', ['read']);
      await give(userId, 'traceroute', ['read']);
      await give(userId, 'packetmonitor', ['read']);
    }
    await databaseService.settings.setSourceSetting(A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '1');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.settings.setSourceSetting(A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '0');
    await databaseService.settings.setSetting('packet_log_enabled', previousPacketLog ?? '0');
    await databaseService.traceroutes.deleteAllRouteSegments(A);
    await databaseService.packetLog.clearPacketLogs(A);
    await databaseService.assetNodes.clearAsync(HIDDEN);
    await sourceManagerRegistry.removeManager(A);
    await harness.revokeAll(harness.anonymous.id);
    await harness.cleanup();
  });

  const text = (res: { body: unknown }): string => JSON.stringify(res.body ?? null);

  it('route-segment longest-active: anonymous gets the best VISIBLE segment, signed-in the true best', async () => {
    const anon = await harness.loginAs(null);
    const anonRes = await anon.get('/route-segments/longest-active').query({ sourceId: A });
    expect(anonRes.status).toBe(200);
    expect(anonRes.body?.distanceKm).toBe(50);
    expect(text(anonRes)).not.toContain(HIDDEN_ID);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/route-segments/longest-active').query({ sourceId: A });
    expect(res.body?.distanceKm).toBe(100);
  });

  it('packet distribution: anonymous byDevice leaves out the hidden sender', async () => {
    const devices = (res: { body: { byDevice?: Array<{ from_node: number }> } }) =>
      (res.body.byDevice ?? []).map((d) => Number(d.from_node));
    const anon = await harness.loginAs(null);
    const anonRes = await anon.get('/packets/stats/distribution').query({ sourceId: A });
    expect(anonRes.status).toBe(200);
    expect(devices(anonRes)).toContain(SHOWN);
    expect(devices(anonRes)).not.toContain(HIDDEN);

    const agent = await harness.loginAs(harness.limited);
    expect(devices(await agent.get('/packets/stats/distribution').query({ sourceId: A }))).toContain(HIDDEN);
  });

  it('direct-neighbors: anonymous loses the hidden node\'s RSSI row', async () => {
    const anon = await harness.loginAs(null);
    const anonRes = await anon.get('/direct-neighbors').query({ sourceId: A });
    expect(anonRes.status).toBe(200);
    expect(Object.keys(anonRes.body.data)).toContain(String(SHOWN));
    expect(Object.keys(anonRes.body.data)).not.toContain(String(HIDDEN));

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/direct-neighbors').query({ sourceId: A });
    expect(Object.keys(res.body.data)).toContain(String(HIDDEN));
  });

  it('ATAK contacts: anonymous loses the contact relayed by the hidden node', async () => {
    const anon = await harness.loginAs(null);
    const anonRes = await anon.get(`/sources/${A}/atak/contacts`);
    expect(anonRes.status).toBe(200);
    expect(text(anonRes)).toContain('SHOWN-CALL');
    expect(text(anonRes)).not.toContain('HIDDEN-CALL');

    const agent = await harness.loginAs(harness.limited);
    expect(text(await agent.get(`/sources/${A}/atak/contacts`))).toContain('HIDDEN-CALL');
  });

  it('node source list: anonymous is not told which sources hold the hidden node', async () => {
    const anon = await harness.loginAs(null);
    const anonRes = await anon.get(`/nodes/${HIDDEN}/sources`).query({ sourceId: A });
    expect(anonRes.status).toBe(200);
    expect(anonRes.body.data.sources).toEqual([]);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/nodes/${HIDDEN}/sources`).query({ sourceId: A });
    expect(text(res)).toContain('HIDDEN-NODE');
  });

  it('tracked assets: the hidden node is not listed, and its track 404s, for anonymous', async () => {
    const anon = await harness.loginAs(null);
    const list = await anon.get('/assets');
    expect(list.status).toBe(200);
    expect((list.body.data as Array<{ nodeNum: number }>).map((a) => a.nodeNum)).not.toContain(HIDDEN);
    expect((await anon.get(`/assets/${HIDDEN}/track`)).status).toBe(404);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/assets');
    expect((res.body.data as Array<{ nodeNum: number }>).map((a) => a.nodeNum)).toContain(HIDDEN);
  });

  it('fails closed: a settings-read failure gives anonymous no Meshtastic nodes, signed-in unaffected', async () => {
    vi.spyOn(databaseService.settings, 'getSettingForSources').mockRejectedValue(new Error('settings down'));
    const anon = await harness.loginAs(null);
    const anonRes = await anon.get('/nodes').query({ sourceId: A });
    expect(anonRes.status).toBe(200);
    expect(text(anonRes)).not.toContain('SHOWN-NODE');
    expect(text(anonRes)).not.toContain('HIDDEN-NODE');

    const agent = await harness.loginAs(harness.limited);
    expect(text(await agent.get('/nodes').query({ sourceId: A }))).toContain('HIDDEN-NODE');
  });

  it('fails closed: a node-read failure on the flagged source hides all of its nodes from anonymous', async () => {
    vi.spyOn(databaseService.nodes, 'getMqttConsentWithheldNodeNums').mockRejectedValue(new Error('nodes down'));
    const anon = await harness.loginAs(null);
    const anonRes = await anon.get('/route-segments/longest-active').query({ sourceId: A });
    expect(anonRes.status).toBe(200);
    expect(anonRes.body).toBeNull();
    const nodesRes = await anon.get('/nodes').query({ sourceId: A });
    expect(text(nodesRes)).not.toContain('SHOWN-NODE');
  });
});
