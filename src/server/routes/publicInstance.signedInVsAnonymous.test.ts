/**
 * Public-instance mode (#5156, Phase 1): what a signed-in viewer sees next to
 * what an anonymous viewer sees, on REAL routes.
 *
 * The real `nodesRoutes`, `pollRoutes` and `messageRoutes` routers are mounted
 * exactly as `server.ts` does, behind the real `publicInstanceRedaction()`
 * middleware, with real session + auth + permission rows on a real in-memory DB.
 * Only the source manager is a fake (nothing talks to a radio).
 *
 * Permission note: the anonymous account is granted `nodes` read + viewOnMap,
 * `messages` read and `channel_0` read + viewOnMap on source A. Without those
 * the route's own permission rules would hide the fields and the test would
 * show permission hiding rather than redaction. Every difference asserted
 * below therefore comes from the redaction middleware alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { optionalAuth } from '../auth/authMiddleware.js';
import nodesRoutes from './nodesRoutes.js';
import pollRoutes from './pollRoutes.js';
import messageRoutes from './messageRoutes.js';
import databaseService from '../../services/database.js';
import { publicInstanceRedaction } from '../middleware/publicInstanceRedaction.js';
import {
  __setPublicInstanceConfigForTest,
  __resetPublicInstanceConfigForTest,
} from '../services/publicInstanceConfig.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadVisibleNodesAcrossSources } from '../services/nodeDbMaintenanceService.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { snapToPrecisionCell } from '../../utils/precisionOffset.js';
import { PUBLIC_INSTANCE_HIDDEN_TEXT } from '../../utils/publicInstanceMode.js';

const NODE_NUM = 0x0c0ffee1;
const NODE_ID = '!0c0ffee1';
const LONG_NAME = 'Exact Long Name Sentinel';
const SHORT_NAME = 'EXCT';
const PUBLIC_KEY = Buffer.from('exact-public-key-sentinel-0123456789ab').toString('base64');
const LAT = 37.7749295;
const LON = -122.4194155;
const ALT = 123;
// 2030-01-01T00:07:42Z-ish: not on an hour boundary.
const LAST_HEARD = 1_893_456_000 + 7 * 60 + 42;
const LAST_HEARD_HOUR = Math.floor(LAST_HEARD / 3600) * 3600;
const MESSAGE_TEXT = 'exact message sentinel';
const MESSAGE_TS = LAST_HEARD * 1000;

const SNAPPED_LAT = snapToPrecisionCell(LAT, 14, false);
const SNAPPED_LON = snapToPrecisionCell(LON, 14, false);

const SENTINELS = [LONG_NAME, PUBLIC_KEY, MESSAGE_TEXT, '37.7749295', '-122.4194155'];

const ALL_ON = {
  enabled: true,
  hideLongNames: true,
  hidePublicKeys: true,
  roundTimestamps: true,
  hideMessageText: true,
} as const;

type Json = Record<string, unknown>;
const asRecord = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});

/** Find a value for `key` on the node row or its nested `user` / `position` objects. */
function pick(node: Json, key: string): unknown {
  for (const o of [node, asRecord(node.user), asRecord(node.position)]) {
    if (key in o && o[key] !== undefined) return o[key];
  }
  return undefined;
}

describe('public instance mode: signed-in vs anonymous on real routes', () => {
  let harness: RouteTestHarness;
  let anonymousRows: Array<Record<string, unknown>>;

  const fakeManager = (sourceId: string): ISourceManager =>
    ({
      sourceId,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: `name of ${sourceId}`, sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue(null),
      getAllNodesAsync: vi.fn((id?: string) => loadVisibleNodesAcrossSources(id ? [id] : ALL_SOURCES, (row) => row)),
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, nodeResponsive: true, configuring: false, userDisconnected: false }),
      getDeviceConfig: vi.fn().mockResolvedValue(null),
      getDeviceNodeNums: vi.fn().mockReturnValue([NODE_NUM]),
      isLocalNodeBridged: vi.fn().mockReturnValue(false),
    }) as unknown as ISourceManager;

  const grantAnonymous = async (): Promise<void> => {
    const a = harness.anonymous.id;
    await harness.revokeAll(a);
    for (const resource of ['nodes', 'channel_0', 'messages']) {
      // One row per (user, resource, source) carrying several actions.
      await databaseService.auth.createPermission({
        userId: a,
        resource,
        canRead: true,
        canWrite: false,
        canViewOnMap: true,
        sourceId: harness.sourceA,
        grantedAt: Date.now(),
        grantedBy: null,
      } as never);
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        // As server.ts: every /api router sits behind the redaction middleware.
        const api = express.Router();
        api.use(publicInstanceRedaction());
        api.use('/messages', messageRoutes);
        api.use(nodesRoutes);
        api.use(pollRoutes);
        app.use('/api', api);
      },
    });
    anonymousRows = (await databaseService.auth.getPermissionsForUser(harness.anonymous.id)) as never;
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceA));

    await databaseService.nodes.upsertNode(
      {
        nodeNum: NODE_NUM, nodeId: NODE_ID, longName: LONG_NAME, shortName: SHORT_NAME, hwModel: 43, channel: 0,
        publicKey: PUBLIC_KEY, latitude: LAT, longitude: LON, altitude: ALT, positionPrecisionBits: 32,
        lastHeard: LAST_HEARD,
      } as never,
      harness.sourceA,
    );
    await databaseService.channels.upsertChannel({ id: 0, name: 'Primary', psk: 'AQ==', role: 1 }, harness.sourceA);
    await databaseService.messages.insertMessage(
      {
        id: `${harness.sourceA}_${NODE_NUM}_1`, fromNodeNum: NODE_NUM, toNodeNum: 0xffffffff, fromNodeId: NODE_ID, toNodeId: '!ffffffff',
        text: MESSAGE_TEXT, channel: 0, portnum: 1, timestamp: MESSAGE_TS, rxTime: MESSAGE_TS, createdAt: MESSAGE_TS,
      } as never,
      harness.sourceA,
    );
    await grantAnonymous();
    __setPublicInstanceConfigForTest(ALL_ON);
  });

  afterEach(async () => {
    __resetPublicInstanceConfigForTest();
    await databaseService.messages.deleteAllMessages(harness.sourceA);
    await databaseService.nodes.deleteNodeRecord(NODE_NUM, harness.sourceA);
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.revokeAll(harness.anonymous.id);
    for (const row of anonymousRows) {
      const { id: _id, ...rest } = row;
      await databaseService.auth.createPermission(rest as never);
    }
    await harness.cleanup();
  });

  const signedIn = async () => harness.loginAs(harness.admin);
  const anonymous = async () => harness.loginAs(null);

  const nodeFrom = (body: unknown): Json => {
    const list = Array.isArray(body) ? body : (asRecord(body).nodes as unknown[]);
    const found = list.map(asRecord).find((n) => Number(n.nodeNum) === NODE_NUM);
    if (!found) throw new Error(`node not in response: ${JSON.stringify(body).slice(0, 400)}`);
    return found;
  };
  const messageFrom = (body: unknown): Json => {
    const list = Array.isArray(body) ? body : (asRecord(body).messages as unknown[]);
    const found = list.map(asRecord).find((m) => m.fromNodeId === NODE_ID);
    if (!found) throw new Error(`message not in response: ${JSON.stringify(body).slice(0, 400)}`);
    return found;
  };

  /** The node-level assertions shared by `/api/nodes` and `/api/poll`. */
  const expectExactNode = (node: Json): void => {
    expect(pick(node, 'latitude')).toBeCloseTo(LAT, 6);
    expect(pick(node, 'longitude')).toBeCloseTo(LON, 6);
    expect(pick(node, 'altitude')).toBe(ALT);
    expect(pick(node, 'longName')).toBe(LONG_NAME);
    expect(pick(node, 'shortName')).toBe(SHORT_NAME);
    expect(pick(node, 'publicKey')).toBe(PUBLIC_KEY);
    expect(node.lastHeard).toBe(LAST_HEARD);
  };
  const expectRedactedNode = (node: Json): void => {
    const lat = pick(node, 'latitude') as number;
    const lon = pick(node, 'longitude') as number;
    expect(lat).toBe(SNAPPED_LAT);
    expect(lon).toBe(SNAPPED_LON);
    expect(lat).not.toBe(LAT);
    expect(lon).not.toBe(LON);
    // Altitude is rounded to the nearest 100 m.
    expect(pick(node, 'altitude')).toBe(100);
    expect(pick(node, 'longName')).toBeNull();
    expect(pick(node, 'shortName')).toBe(SHORT_NAME);
    expect(pick(node, 'publicKey') ?? null).toBeNull();
    expect(node.lastHeard).toBe(LAST_HEARD_HOUR);
    expect(LAST_HEARD_HOUR).not.toBe(LAST_HEARD);
  };
  const expectNoSentinels = (body: unknown): void => {
    const text = JSON.stringify(body);
    for (const s of SENTINELS) expect(text, `leaked ${s}`).not.toContain(s);
  };

  describe('GET /api/nodes', () => {
    it('signed-in sees exact position, names, key, last-heard and altitude', async () => {
      const res = await (await signedIn()).get('/api/nodes');
      expect(res.status).toBe(200);
      expectExactNode(nodeFrom(res.body));
    });

    it('anonymous sees a ~1.5 km grid position, no long name or key, hour-rounded time, 100 m altitude', async () => {
      const res = await (await anonymous()).get('/api/nodes');
      expect(res.status).toBe(200);
      expectRedactedNode(nodeFrom(res.body));
      expectNoSentinels(res.body);
    });
  });

  describe('GET /api/poll', () => {
    it('signed-in sees exact node data and exact message text', async () => {
      const res = await (await signedIn()).get('/api/poll').query({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expectExactNode(nodeFrom(res.body));
      expect(messageFrom(res.body).text).toBe(MESSAGE_TEXT);
    });

    it('anonymous sees redacted node data and hidden message text', async () => {
      const res = await (await anonymous()).get('/api/poll').query({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expectRedactedNode(nodeFrom(res.body));
      expect(messageFrom(res.body).text).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
      expectNoSentinels(res.body);
    });
  });

  describe('GET /api/messages/channel/0', () => {
    it('signed-in sees the exact message text', async () => {
      const res = await (await signedIn()).get('/api/messages/channel/0').query({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expect(messageFrom(res.body).text).toBe(MESSAGE_TEXT);
    });

    it('anonymous sees the hidden-text placeholder and no sentinel anywhere', async () => {
      const res = await (await anonymous()).get('/api/messages/channel/0').query({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expect(messageFrom(res.body).text).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
      expectNoSentinels(res.body);
    });
  });

  describe('mode off', () => {
    beforeEach(() => {
      __setPublicInstanceConfigForTest({ ...ALL_ON, enabled: false });
    });

    it('anonymous gets exact values from /api/nodes (only the permission rules apply)', async () => {
      const res = await (await anonymous()).get('/api/nodes');
      expect(res.status).toBe(200);
      const node = nodeFrom(res.body);
      expect(pick(node, 'latitude')).toBeCloseTo(LAT, 6);
      expect(pick(node, 'longitude')).toBeCloseTo(LON, 6);
      expect(pick(node, 'longName')).toBe(LONG_NAME);
      expect(pick(node, 'publicKey')).toBe(PUBLIC_KEY);
      expect(node.lastHeard).toBe(LAST_HEARD);
    });

    it('anonymous gets exact message text from /api/messages/channel/0 and /api/poll', async () => {
      const agent = await anonymous();
      const ch = await agent.get('/api/messages/channel/0').query({ sourceId: harness.sourceA });
      expect(messageFrom(ch.body).text).toBe(MESSAGE_TEXT);
      const poll = await agent.get('/api/poll').query({ sourceId: harness.sourceA });
      expect(messageFrom(poll.body).text).toBe(MESSAGE_TEXT);
    });

    it('anonymous body is identical to the one served with no middleware mounted', async () => {
      // Same router and auth, no redaction middleware.
      const bareApp = express();
      bareApp.use(session({ secret: 'bare', resave: false, saveUninitialized: false, name: 'meshmonitor.sid' }));
      bareApp.use(optionalAuth());
      bareApp.use('/api', nodesRoutes);
      const withMw = await (await anonymous()).get('/api/nodes');
      const without = await request(bareApp).get('/api/nodes');
      expect(without.status).toBe(200);
      expect(withMw.body).toEqual(without.body);
    });
  });
});
