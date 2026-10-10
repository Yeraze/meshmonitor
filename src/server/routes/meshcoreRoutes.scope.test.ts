/**
 * Per-source permission scoping for the MeshCore routers
 * (`/api/sources/:id/meshcore/*`), #5666 / #5667 / #5668.
 *
 *   - `GET /snapshot`: each section is returned only to a caller who could read
 *     it through its own route, on that source. A grant on another source buys
 *     nothing.
 *   - `GET /neighbors` and the stored config reads: open to anyone holding the
 *     grant on the source, the anonymous account included.
 *   - Routes that transmit: never open to the anonymous account.
 *   - `GET /nodes/:publicKey/position-history`: points need `nodes:viewOnMap`.
 *   - Guard: every route on every MeshCore router has a class, and its
 *     middleware matches that class.
 *
 * Driven through the real auth middleware with real permission rows
 * (`createRouteTestApp`). Managers are fakes. Nothing is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Router } from 'express';

import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { getPermissionGate, isAuthGate } from '../auth/authMiddleware.js';
import { isMeshcoreTxGate, getMeshcoreChannelGate } from './meshcoreRouteShared.js';

const KEY_NODE = 'a1'.repeat(32);
const KEY_NEIGHBOR = 'b2'.repeat(32);

/** Marker values per source. A caller with no grant for a section must never see that section's marker. */
const marks = (tag: 'AA' | 'BB') => ({
  local: `${tag}-LOCAL-MARK`,
  contact: `${tag}-CONTACT-MARK`,
  node: `${tag}-NODE-MARK`,
  dm: `${tag}-DM-MARK`,
  room: `${tag}-ROOM-MARK`,
  ch0: `${tag}-CH0-MARK`,
  ch1: `${tag}-CH1-MARK`,
  ch9: `${tag}-CH9-MARK`,
  keyed: `${tag}-KEYED-MARK`,
  lat: tag === 'AA' ? 12.3456 : 23.4567,
  lon: tag === 'AA' ? 65.4321 : 76.5432,
});
const A = marks('AA');
const B = marks('BB');
const NODE_MARKS = (m: typeof A) => [m.contact, m.node];
const POSITION_MARKS = (m: typeof A) => [String(m.lat), String(m.lon)];
const MESSAGE_MARKS = (m: typeof A) => [m.dm, m.room, m.ch0, m.ch1, m.ch9, m.keyed];

const state = vi.hoisted(() => ({
  managers: new Map<string, unknown>(),
  /** Every call to a manager method the fake does not define: a device or radio action. */
  deviceCalls: [] as string[],
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => state.managers.get(sourceId),
    getAllManagers: () => Array.from(state.managers.values()),
  },
}));

const { default: meshcoreRoutes } = await import('./meshcoreRoutes.js');
const { default: deviceRoutes } = await import('./meshcoreDeviceRoutes.js');
const { default: contactsRoutes } = await import('./meshcoreContactsRoutes.js');
const { default: configRoutes } = await import('./meshcoreConfigRoutes.js');
const { default: messagingRoutes } = await import('./meshcoreMessagingRoutes.js');
const { default: adminRoutes } = await import('./meshcoreAdminRoutes.js');
const { default: automationRoutes } = await import('./meshcoreAutomationRoutes.js');
const { default: packetRoutes } = await import('./meshcorePacketRoutes.js');
const { default: ingestReadRoutes } = await import('./meshcoreIngestReadRoutes.js');
const { default: filterRoutes } = await import('./meshcoreFilterRoutes.js');
const { default: traceRoutes } = await import('./meshcoreTraceRoutes.js');

/**
 * A MeshCore manager that serves marked reads and records everything else.
 * The reads the routes under test use are defined; any other method is a
 * device or radio action, answered by a recorder.
 */
function fakeManager(sourceId: string, m: typeof A): unknown {
  const reads: Record<string, unknown> = {
    sourceId,
    sourceType: 'meshcore',
    isReceiveOnly: () => false,
    getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
    // The local node has no position, so no synthetic local contact row is added.
    getLocalNode: () => ({ publicKey: 'c3'.repeat(32), name: m.local }),
    getContactsForView: async () => [
      { publicKey: KEY_NODE, name: m.contact, advType: 2, latitude: m.lat, longitude: m.lon, positionSource: 'contact' },
    ],
    getAllNodes: async () => [
      { publicKey: KEY_NODE, name: m.node, latitude: m.lat, longitude: m.lon, lastAdvertHadPosition: true },
    ],
    getRecentMessages: () => [
      { id: 'dm', fromPublicKey: KEY_NODE, toPublicKey: 'c3'.repeat(32), text: m.dm, timestamp: 1000 },
      { id: 'room', fromPublicKey: KEY_NODE, toPublicKey: null, text: m.room, timestamp: 1100, messageType: 'room' },
      { id: 'ch0', fromPublicKey: KEY_NODE, toPublicKey: 'channel-0', text: m.ch0, timestamp: 2000 },
      { id: 'ch1', fromPublicKey: KEY_NODE, toPublicKey: 'channel-1', text: m.ch1, timestamp: 3000 },
      // Slot 9 has no `channel_N` resource: readable through `messages:read` alone.
      { id: 'ch9', fromPublicKey: KEY_NODE, toPublicKey: 'channel-9', text: m.ch9, timestamp: 3500 },
      // Decrypted with a key nobody but an admin may read (#5551).
      { id: 'keyed', fromPublicKey: KEY_NODE, toPublicKey: 'channel-0', text: m.keyed, timestamp: 4000, keyFingerprint: 'no-such-key' },
    ],
    getRespondToDiscovery: async () => true,
    getDefaultScope: async () => 'scope-mark',
    getDefaultPathHashSize: async () => 2,
  };
  return new Proxy(reads, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target) return target[prop as string];
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => {
        state.deviceCalls.push(`${sourceId}.${prop}(${args.length})`);
        return Promise.resolve(null);
      };
    },
  });
}

describe('MeshCore routes: per-source grants (#5666 / #5667 / #5668)', () => {
  let harness: RouteTestHarness;
  let SA: string;
  let SB: string;

  /** One permission row carrying several actions (`harness.grant` writes one action per row). */
  const give = async (
    userId: number,
    resource: string,
    actions: Array<'read' | 'write' | 'viewOnMap'>,
    sourceId: string,
  ): Promise<void> => {
    await databaseService.auth.createPermission({
      userId,
      resource,
      canRead: actions.includes('read'),
      canWrite: actions.includes('write'),
      canViewOnMap: actions.includes('viewOnMap'),
      sourceId,
      grantedAt: Date.now(),
      grantedBy: null,
    } as never);
  };

  const url = (sourceId: string, path: string): string => `/sources/${sourceId}/meshcore${path}`;
  const text = (body: unknown): string => JSON.stringify(body ?? null);
  const expectNone = (body: unknown, markers: string[]): void => {
    const serialized = text(body);
    for (const marker of markers) expect(serialized, `leaked ${marker}`).not.toContain(marker);
  };
  const expectAll = (body: unknown, markers: string[]): void => {
    const serialized = text(body);
    for (const marker of markers) expect(serialized, `missing ${marker}`).toContain(marker);
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    SA = harness.sourceA;
    SB = harness.sourceB;
    state.managers.clear();
    state.managers.set(SA, fakeManager(SA, A));
    state.managers.set(SB, fakeManager(SB, B));
    state.deviceCalls.length = 0;
  });

  afterEach(async () => {
    // `cleanup()` leaves the shared anonymous account's grants in place.
    await harness.db.auth.deletePermissionsForUser(harness.anonymous.id).catch(() => {});
    for (const id of [SA, SB]) {
      await databaseService.meshcore.deleteAllNeighbors(id).catch(() => {});
      await databaseService.meshcore.deleteAllPositionHistory(id).catch(() => {});
    }
    await harness.cleanup();
  });

  // ── GET /snapshot (#5667) ─────────────────────────────────────────────────
  describe('GET /snapshot returns each section only with its own grant', () => {
    const snapshot = async (who: 'limited' | 'anonymous' | 'admin', sourceId = SA) => {
      const agent = await harness.loginAs(who === 'anonymous' ? null : harness[who]);
      return agent.get(url(sourceId, '/snapshot'));
    };

    it('connection:read alone: status and local node, and no node, position or message', async () => {
      await give(harness.limited.id, 'connection', ['read'], SA);
      const res = await snapshot('limited');
      expect(res.status).toBe(200);
      // The reply keeps its shape, so the page shell still loads.
      expect(res.body.data.status.connected).toBe(true);
      expect(res.body.data.status.localNode.name).toBe(A.local);
      expect(res.body.data.contacts).toEqual([]);
      expect(res.body.data.nodes).toEqual([]);
      expect(res.body.data.messages).toEqual([]);
      expect(res.body.data.seqCursor).toBe(0);
      expectNone(res.body, [...NODE_MARKS(A), ...POSITION_MARKS(A), ...MESSAGE_MARKS(A), KEY_NODE]);
    });

    it('the anonymous account is held to the same rule', async () => {
      await give(harness.anonymous.id, 'connection', ['read'], SA);
      const res = await snapshot('anonymous');
      expect(res.status).toBe(200);
      expect(res.body.data.status.localNode.name).toBe(A.local);
      expectNone(res.body, [...NODE_MARKS(A), ...POSITION_MARKS(A), ...MESSAGE_MARKS(A), KEY_NODE]);
    });

    it('no connection:read on the source: refused, whatever else is held', async () => {
      await give(harness.limited.id, 'nodes', ['read', 'viewOnMap'], SA);
      await give(harness.limited.id, 'messages', ['read'], SA);
      const res = await snapshot('limited');
      expect(res.status).toBe(403);
      expectNone(res.body, [A.local, ...NODE_MARKS(A), ...MESSAGE_MARKS(A)]);
    });

    it('nodes:read adds contacts and nodes, without positions or messages', async () => {
      await give(harness.limited.id, 'connection', ['read'], SA);
      await give(harness.limited.id, 'nodes', ['read'], SA);
      const res = await snapshot('limited');
      expect(res.body.data.contacts.map((c: { name: string }) => c.name)).toEqual([A.contact]);
      expect(res.body.data.nodes.map((n: { name: string }) => n.name)).toEqual([A.node]);
      for (const row of [...res.body.data.contacts, ...res.body.data.nodes]) {
        expect(row).not.toHaveProperty('latitude');
        expect(row).not.toHaveProperty('longitude');
        expect(row).not.toHaveProperty('positionSource');
        expect(row).not.toHaveProperty('lastAdvertHadPosition');
      }
      expectNone(res.body, [...POSITION_MARKS(A), ...MESSAGE_MARKS(A)]);
    });

    it('nodes:viewOnMap on top of nodes:read adds the positions', async () => {
      await give(harness.limited.id, 'connection', ['read'], SA);
      await give(harness.limited.id, 'nodes', ['read', 'viewOnMap'], SA);
      const res = await snapshot('limited');
      expect(res.body.data.contacts[0]).toMatchObject({ latitude: A.lat, longitude: A.lon });
      expect(res.body.data.nodes[0]).toMatchObject({ latitude: A.lat, longitude: A.lon });
      expectNone(res.body, MESSAGE_MARKS(A));
    });

    it('nodes:viewOnMap without nodes:read shows no row at all', async () => {
      await give(harness.limited.id, 'connection', ['read'], SA);
      await give(harness.limited.id, 'nodes', ['viewOnMap'], SA);
      const res = await snapshot('limited');
      expect(res.body.data.contacts).toEqual([]);
      expect(res.body.data.nodes).toEqual([]);
      expectNone(res.body, [...NODE_MARKS(A), ...POSITION_MARKS(A)]);
    });

    it('messages:read adds every message but the one keyed with a key the caller cannot read', async () => {
      await give(harness.limited.id, 'connection', ['read'], SA);
      await give(harness.limited.id, 'messages', ['read'], SA);
      const res = await snapshot('limited');
      expect(res.body.data.messages.map((m: { id: string }) => m.id)).toEqual(['dm', 'room', 'ch0', 'ch1', 'ch9']);
      expect(res.body.data.seqCursor).toBe(3500);
      expectNone(res.body, [A.keyed, ...NODE_MARKS(A)]);
    });

    it('channel_1:read alone adds that channel only: no DM, no room post, no other channel', async () => {
      await give(harness.anonymous.id, 'connection', ['read'], SA);
      await give(harness.anonymous.id, 'channel_1', ['read'], SA);
      const res = await snapshot('anonymous');
      expect(res.body.data.messages.map((m: { id: string }) => m.id)).toEqual(['ch1']);
      expect(res.body.data.seqCursor).toBe(3000);
      expectNone(res.body, [A.dm, A.room, A.ch0, A.ch9, A.keyed, ...NODE_MARKS(A)]);
    });

    it('channel_0:read does not open a channel-0 message keyed with an unreadable key', async () => {
      await give(harness.limited.id, 'connection', ['read'], SA);
      await give(harness.limited.id, 'channel_0', ['read'], SA);
      const res = await snapshot('limited');
      expect(res.body.data.messages.map((m: { id: string }) => m.id)).toEqual(['ch0']);
      expectNone(res.body, [A.keyed, A.dm, A.ch1]);
    });

    it('grants on another source buy nothing here', async () => {
      await give(harness.limited.id, 'connection', ['read'], SA);
      // Everything, on B.
      await give(harness.limited.id, 'connection', ['read'], SB);
      await give(harness.limited.id, 'nodes', ['read', 'viewOnMap'], SB);
      await give(harness.limited.id, 'messages', ['read'], SB);
      await give(harness.limited.id, 'channel_0', ['read'], SB);
      await give(harness.limited.id, 'channel_1', ['read'], SB);

      const a = await snapshot('limited', SA);
      expect(a.status).toBe(200);
      expect(a.body.data.contacts).toEqual([]);
      expect(a.body.data.nodes).toEqual([]);
      expect(a.body.data.messages).toEqual([]);
      expectNone(a.body, [...NODE_MARKS(A), ...POSITION_MARKS(A), ...MESSAGE_MARKS(A), KEY_NODE]);
      // And nothing of B rides along.
      expectNone(a.body, [B.local, ...NODE_MARKS(B), ...POSITION_MARKS(B), ...MESSAGE_MARKS(B), SB]);

      // The same caller reads B in full (bar the keyed row).
      const b = await snapshot('limited', SB);
      expectAll(b.body, [B.local, ...NODE_MARKS(B), ...POSITION_MARKS(B), B.dm, B.ch0, B.ch1]);
      expectNone(b.body, [A.local, ...NODE_MARKS(A), ...MESSAGE_MARKS(A)]);
    });

    it('an admin gets every section, as before', async () => {
      const res = await snapshot('admin');
      expect(res.status).toBe(200);
      expectAll(res.body, [A.local, ...NODE_MARKS(A), ...POSITION_MARKS(A), ...MESSAGE_MARKS(A)]);
      expect(res.body.data.seqCursor).toBe(4000);
    });
  });

  // ── GET /nodes/:publicKey/position-history ───────────────────────────────
  describe('GET /nodes/:publicKey/position-history: the points need nodes:viewOnMap', () => {
    beforeEach(async () => {
      const now = Date.now();
      await databaseService.meshcore.insertPositionHistory({
        sourceId: SA, publicKey: KEY_NODE, latitude: A.lat, longitude: A.lon, timestamp: now, createdAt: now,
      });
    });

    it('nodes:read alone gets an empty trail', async () => {
      await give(harness.anonymous.id, 'nodes', ['read'], SA);
      const res = await (await harness.loginAs(null)).get(url(SA, `/nodes/${KEY_NODE}/position-history`));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, count: 0, data: [] });
      expectNone(res.body, POSITION_MARKS(A));
    });

    it('nodes:viewOnMap on another source does not help', async () => {
      await give(harness.limited.id, 'nodes', ['read'], SA);
      await give(harness.limited.id, 'nodes', ['read', 'viewOnMap'], SB);
      const res = await (await harness.loginAs(harness.limited)).get(url(SA, `/nodes/${KEY_NODE}/position-history`));
      expect(res.body.data).toEqual([]);
    });

    it('nodes:read + nodes:viewOnMap gets the points', async () => {
      await give(harness.limited.id, 'nodes', ['read', 'viewOnMap'], SA);
      const res = await (await harness.loginAs(harness.limited)).get(url(SA, `/nodes/${KEY_NODE}/position-history`));
      expect(res.body.count).toBe(1);
      expect(res.body.data[0]).toMatchObject({ latitude: A.lat, longitude: A.lon });
    });
  });

  // ── GET /neighbors (#5668) ───────────────────────────────────────────────
  describe('GET /neighbors: nodes:read on the source, signed in or not', () => {
    beforeEach(async () => {
      await databaseService.meshcore.insertNeighborsBatch(SA, KEY_NODE, [{ neighborPublicKey: KEY_NEIGHBOR, snr: 7.5, lastHeardSecs: 60 }]);
      await databaseService.meshcore.insertNeighborsBatch(SB, KEY_NODE, [{ neighborPublicKey: 'd4'.repeat(32), snr: 1, lastHeardSecs: 5 }]);
    });

    it('serves the anonymous account when it holds nodes:read on the source', async () => {
      await give(harness.anonymous.id, 'nodes', ['read'], SA);
      const res = await (await harness.loginAs(null)).get(url(SA, '/neighbors'));
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { neighborPublicKey: string }) => i.neighborPublicKey)).toEqual([KEY_NEIGHBOR]);
      expectNone(res.body, ['d4'.repeat(32), SB]);
      expect(state.deviceCalls).toEqual([]);
    });

    it('refuses the anonymous account without the grant', async () => {
      const res = await (await harness.loginAs(null)).get(url(SA, '/neighbors'));
      expect(res.status).toBe(403);
      expectNone(res.body, [KEY_NEIGHBOR]);
    });

    it('refuses on a grant for another source', async () => {
      await give(harness.anonymous.id, 'nodes', ['read'], SB);
      const res = await (await harness.loginAs(null)).get(url(SA, '/neighbors'));
      expect(res.status).toBe(403);
      expectNone(res.body, [KEY_NEIGHBOR]);
    });

    it('serves a signed-in holder and an admin, as before', async () => {
      await give(harness.limited.id, 'nodes', ['read'], SA);
      expect((await (await harness.loginAs(harness.limited)).get(url(SA, '/neighbors'))).status).toBe(200);
      expect((await (await harness.loginAs(harness.admin)).get(url(SA, '/neighbors'))).body.data.items).toHaveLength(1);
    });
  });

  // ── Stored config reads ──────────────────────────────────────────────────
  describe('stored config reads: configuration:read on the source, signed in or not', () => {
    const reads = [
      '/config/discoverable',
      '/config/default-scope',
      '/config/default-path-hash-size',
      '/saved-regions',
      `/rooms/sync-config?publicKey=${KEY_NODE}`,
    ];

    it.each(reads)('GET %s serves the anonymous account with the grant and touches no device', async (path) => {
      await give(harness.anonymous.id, 'configuration', ['read'], SA);
      const res = await (await harness.loginAs(null)).get(url(SA, path));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(state.deviceCalls).toEqual([]);
    });

    it.each(reads)('GET %s refuses the anonymous account without it, and on a grant for another source', async (path) => {
      const agent = await harness.loginAs(null);
      expect((await agent.get(url(SA, path))).status).toBe(403);
      await give(harness.anonymous.id, 'configuration', ['read'], SB);
      const res = await agent.get(url(SA, path));
      expect(res.status).toBe(403);
      expectNone(res.body, ['scope-mark']);
    });
  });

  // ── Routes that transmit stay closed to the anonymous account ────────────
  describe('routes that transmit', () => {
    const transmits: Array<{ method: 'get' | 'post'; path: string; body?: object }> = [
      { method: 'post', path: '/neighbors/request', body: { publicKey: KEY_NODE } },
      { method: 'post', path: `/nodes/${KEY_NODE}/neighbours/poll` },
      { method: 'post', path: `/nodes/${KEY_NODE}/neighbours/fetch`, body: { requestId: 'r1' } },
      { method: 'post', path: `/nodes/${KEY_NODE}/telemetry/poll`, body: { type: 'status' } },
      { method: 'get', path: `/contacts/${KEY_NODE}/neighbours` },
      { method: 'post', path: `/contacts/${KEY_NODE}/ping` },
      { method: 'post', path: '/advert', body: { mode: 'zero_hop' } },
    ];
    const name = (t: { method: string; path: string }): string => `${t.method.toUpperCase()} ${t.path}`;
    const send = (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>, t: (typeof transmits)[number], sourceId: string) =>
      t.method === 'get' ? agent.get(url(sourceId, t.path)) : agent.post(url(sourceId, t.path)).send(t.body ?? {});

    it.each(transmits.map((t) => [name(t), t] as const))('%s refuses the anonymous account even with every grant, and sends nothing', async (_n, t) => {
      for (const resource of ['nodes', 'connection', 'configuration', 'messages']) {
        await give(harness.anonymous.id, resource, ['read', 'write'], SA);
      }
      const res = await send(await harness.loginAs(null), t, SA);
      expect(res.status).toBe(401);
      expect(state.deviceCalls).toEqual([]);
    });

    it.each(transmits.map((t) => [name(t), t] as const))('%s refuses a signed-in user with no grant on the source (read and write on another), and sends nothing', async (_n, t) => {
      for (const resource of ['nodes', 'connection']) {
        await give(harness.limited.id, resource, ['read', 'write'], SB);
      }
      const res = await send(await harness.loginAs(harness.limited), t, SA);
      expect(res.status).toBe(403);
      expect(state.deviceCalls).toEqual([]);
    });

    it.each([
      `/contacts/${KEY_NODE}/ping`,
      `/contacts/${KEY_NODE}/discover-path`,
      `/contacts/${KEY_NODE}/trace-path`,
      '/discover',
      '/advert',
    ])('POST %s refuses a signed-in read-only user, and sends nothing', async (path) => {
      for (const resource of ['nodes', 'connection', 'configuration', 'messages']) {
        await give(harness.limited.id, resource, ['read'], SA);
      }
      const res = await (await harness.loginAs(harness.limited)).post(url(SA, path)).send({});
      expect(res.status).toBe(403);
      expect(state.deviceCalls).toEqual([]);
    });

    // Unchanged policy, pinned so a change to it is a choice: an on-demand
    // poll is "a read that happens to transmit" (see the route comments), so
    // a SIGNED-IN holder of nodes:read may run it. The 60 s per-source TX
    // floor and the device rate limiter still apply.
    it('POST /neighbors/request still runs for a signed-in holder of nodes:read', async () => {
      await give(harness.limited.id, 'nodes', ['read'], SA);
      const res = await (await harness.loginAs(harness.limited)).post(url(SA, '/neighbors/request')).send({});
      expect(res.status).toBe(200);
      expect(state.deviceCalls).toEqual([`${SA}.requestNeighbors(1)`]);
    });
  });
});

// ── Guard: every MeshCore route is classified ───────────────────────────────

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
 * How a MeshCore route decides who gets in. Every permission is checked on the
 * source in the path (`sourceIdFrom: 'params.id'`).
 *  - `read`: `requirePermission(x, 'read')`, no `requireAuth()`. Open to anyone
 *    holding the grant on the source, the anonymous account included. It must
 *    not transmit.
 *  - `read-signed-in`: a read grant AND `requireAuth()`. The anonymous account
 *    is refused whatever it holds. Each one needs a reason in SIGNED_IN_READS.
 *  - `write`: `requireAuth()` + `requirePermission(x, 'write')`.
 *  - `admin`: `requireAuth()` + a `remote_admin` grant (remote admin, CLI and
 *    saved admin credentials; see MESHCORE_REMOTE_ADMIN.md).
 *  - `owner`: `requireAuth()` only. A handle to a job the caller started
 *    through a gated route; the handler serves it to that user on that source.
 *  - `channel-read` / `channel-write`: `requireMeshcoreChannelAccess()`, the
 *    channel's own grant or `messages` on the source. Writes need `requireAuth()`.
 *  - `listed`: no permission middleware; the handler answers only for the
 *    channels the caller may read.
 */
type Kind = 'read' | 'read-signed-in' | 'write' | 'admin' | 'owner' | 'channel-read' | 'channel-write' | 'listed';

const CLASSIFIED: Record<string, Record<string, Kind>> = {
  device: {
    'GET /status': 'read',
    'POST /connect': 'write',
    'POST /disconnect': 'write',
    'GET /stats/:type': 'read',
    'GET /snapshot': 'read',
    'GET /info': 'read',
    'POST /advert': 'write',
  },
  contacts: {
    'GET /nodes': 'read',
    'GET /nodes/:publicKey/position-history': 'read',
    'GET /contacts': 'read',
    'POST /contacts/refresh': 'write',
    'GET /contacts/device-sync': 'read',
    'POST /contacts/push-to-device': 'write',
    'POST /contacts/:publicKey/reset-path': 'write',
    'POST /contacts/:publicKey/discover-path': 'write',
    'POST /discover': 'write',
    'POST /regions/discover': 'write',
    'POST /contacts/:publicKey/trace-path': 'write',
    'POST /contacts/:publicKey/ping': 'write',
    'PUT /contacts/:publicKey/out-path': 'write',
    'POST /contacts/:publicKey/share': 'write',
    'DELETE /contacts/:publicKey': 'write',
    'POST /contacts/:publicKey/add-to-device': 'write',
    'GET /contacts/:publicKey/export': 'read-signed-in',
    'POST /contacts/import': 'write',
    'GET /contacts/:publicKey/neighbours': 'read-signed-in',
    'GET /nodes/:publicKey/telemetry-config': 'read',
    'POST /nodes/:publicKey/telemetry/poll': 'read-signed-in',
    'PATCH /nodes/:publicKey/telemetry-config': 'write',
    'GET /nodes/:publicKey/neighbours-config': 'read',
    'POST /nodes/:publicKey/neighbours/poll': 'read-signed-in',
    'POST /nodes/:publicKey/neighbours/fetch': 'read-signed-in',
    'GET /nodes/:publicKey/neighbours/fetch/:requestId': 'owner',
    'POST /nodes/:publicKey/neighbours/fetch/:requestId/cancel': 'owner',
    'PATCH /nodes/:publicKey/neighbours-config': 'write',
    'GET /nodes/:publicKey/time-sync-config': 'read',
    'PATCH /nodes/:publicKey/time-sync-config': 'write',
    'POST /nodes/:publicKey/time-sync': 'write',
    'POST /nodes/:publicKey/favorite': 'write',
    'POST /neighbors/request': 'read-signed-in',
    'GET /neighbors': 'read',
  },
  config: {
    'GET /config/discoverable': 'read',
    'POST /config/discoverable': 'write',
    'GET /config/default-scope': 'read',
    'POST /config/default-scope': 'write',
    'GET /config/default-path-hash-size': 'read',
    'POST /config/default-path-hash-size': 'write',
    'GET /saved-regions': 'read',
    'POST /saved-regions': 'write',
    'DELETE /saved-regions/:regionId': 'write',
    'POST /config/sync-time': 'write',
    'POST /config/reboot': 'write',
    'GET /config/private-key': 'write',
    'POST /config/private-key': 'write',
    'POST /config/name': 'write',
    'POST /config/tx-power': 'write',
    'POST /config/radio': 'write',
    'POST /config/coords': 'write',
    'POST /config/advert-loc-policy': 'write',
    'POST /config/auto-add-contacts': 'write',
    'POST /config/telemetry-mode-base': 'write',
    'POST /config/telemetry-mode-loc': 'write',
    'POST /config/telemetry-mode-env': 'write',
    'POST /channels/reorder': 'write',
  },
  messaging: {
    'GET /messages': 'read',
    'GET /messages/channel/:idx': 'channel-read',
    'GET /messages/channel-counts': 'listed',
    'DELETE /messages': 'write',
    'DELETE /messages/channel/:idx': 'channel-write',
    'DELETE /messages/conversation/:publicKey': 'write',
    'DELETE /messages/:messageId': 'write',
    'POST /messages/send': 'write',
    'POST /messages/:messageId/resend': 'write',
    'GET /rooms/servers': 'read',
    'POST /rooms/login': 'write',
    'POST /rooms/login-with-saved': 'write',
    'GET /rooms/credentials': 'read-signed-in',
    'DELETE /rooms/credentials/:publicKey': 'write',
    'POST /rooms/post': 'write',
    'GET /rooms/sync-config': 'read',
    'PATCH /rooms/sync-config': 'write',
  },
  admin: {
    'POST /admin/login': 'admin',
    'POST /admin/cli': 'admin',
    'POST /cli': 'write',
    'GET /admin/credentials-capability': 'admin',
    'POST /admin/login-with-saved': 'admin',
    'GET /admin/login-progress/:requestId': 'owner',
    'POST /admin/login-cancel': 'owner',
    'DELETE /admin/credentials/:publicKey': 'admin',
    'GET /admin/status/:publicKey': 'admin',
  },
  automation: {
    'GET /automation/pathfinding': 'read',
    'POST /automation/pathfinding': 'write',
    'GET /automation/pathfinding/filter': 'read',
    'POST /automation/pathfinding/filter': 'write',
    'GET /automation/autoack': 'read',
    'POST /automation/autoack': 'write',
    'GET /automation/announce': 'read',
    'POST /automation/announce': 'write',
    'GET /automation/announce/preview': 'read',
    'POST /automation/announce/send': 'write',
    'GET /automation/timers': 'read',
    'POST /automation/timers': 'write',
    'POST /automation/timers/:triggerId/run': 'write',
    'GET /automation/responder': 'read',
    'POST /automation/responder': 'write',
  },
  packet: {
    'GET /packets': 'read',
    'GET /packets/grouped': 'read',
    'GET /packets/receptions': 'read',
    'GET /packets/stats': 'read',
    'GET /packets/export': 'read',
    // POST for the body size; it decodes the caller's own bytes and changes nothing.
    'POST /packets/decode': 'read',
    'DELETE /packets': 'write',
  },
  ingest: {
    'GET /ingest/overview': 'read',
    'GET /ingest/nodes': 'read',
    'GET /ingest/messages': 'read',
  },
  filter: {
    'GET /ignored-nodes': 'read',
    'POST /ignored-nodes': 'write',
    'DELETE /ignored-nodes/:publicKey': 'write',
    'GET /message-filters': 'read',
    'POST /message-filters': 'write',
    'PUT /message-filters/:filterId': 'write',
    'DELETE /message-filters/:filterId': 'write',
  },
  // #5722: per-hop trace SNR history. Stored data; sends nothing.
  trace: {
    'GET /hop-snr': 'read',
  },
};

/**
 * Why a read keeps `requireAuth()` and so refuses the anonymous account:
 *  - `transmits`: it puts a packet on the air.
 *  - `credentials`: it lists which nodes have a saved password.
 *  - `device-command`: each call runs a command on the radio (no RF).
 */
const SIGNED_IN_READS: Record<string, 'transmits' | 'credentials' | 'device-command'> = {
  'contacts GET /contacts/:publicKey/export': 'device-command',
  'contacts GET /contacts/:publicKey/neighbours': 'transmits',
  'contacts POST /nodes/:publicKey/telemetry/poll': 'transmits',
  'contacts POST /nodes/:publicKey/neighbours/poll': 'transmits',
  'contacts POST /nodes/:publicKey/neighbours/fetch': 'transmits',
  'contacts POST /neighbors/request': 'transmits',
  'messaging GET /rooms/credentials': 'credentials',
};

describe('guard: every MeshCore route is classified', () => {
  const routers: Record<string, Router> = {
    device: deviceRoutes,
    contacts: contactsRoutes,
    config: configRoutes,
    messaging: messagingRoutes,
    admin: adminRoutes,
    automation: automationRoutes,
    packet: packetRoutes,
    ingest: ingestReadRoutes,
    filter: filterRoutes,
    trace: traceRoutes,
  };
  const key = (r: RegisteredRoute): string => `${r.method.toUpperCase()} ${r.path}`;

  /** The class a route's middleware amounts to, or a description of what is wrong with it. */
  const detected = (route: RegisteredRoute): Kind | string => {
    const gates = route.handlers.map((h) => getPermissionGate(h)).filter((g) => g !== undefined);
    const signedIn = route.handlers.some((h) => isAuthGate(h));
    const channel = route.handlers.map((h) => getMeshcoreChannelGate(h)).find((a) => a !== undefined);
    const transmits = route.handlers.some((h) => isMeshcoreTxGate(h));
    if (gates.length > 1) return 'more than one permission gate';
    if (transmits && !signedIn) return 'transmits without requireAuth()';
    const gate = gates[0];
    if (gate) {
      if (channel) return 'permission gate and channel gate';
      if (!gate.sourceScoped) return `${gate.resource}:${gate.action} names no source`;
      if (gate.resource === 'remote_admin') return signedIn ? 'admin' : 'remote_admin without requireAuth()';
      if (gate.action === 'write') return signedIn ? 'write' : 'write without requireAuth()';
      if (gate.action !== 'read') return `unexpected action ${gate.action}`;
      return signedIn ? 'read-signed-in' : 'read';
    }
    if (channel === 'write') return signedIn ? 'channel-write' : 'channel write without requireAuth()';
    if (channel === 'read') return 'channel-read';
    return signedIn ? 'owner' : 'listed';
  };

  it('the barrel mounts exactly these routers', async () => {
    const mounted = (meshcoreRoutes as unknown as { stack: Array<{ handle: unknown; route?: unknown }> }).stack
      .filter((layer) => !layer.route)
      .map((layer) => layer.handle)
      .filter((handle) => typeof (handle as { stack?: unknown }).stack !== 'undefined');
    expect(mounted).toHaveLength(Object.keys(routers).length);
    for (const router of Object.values(routers)) expect(mounted).toContain(router);
  });

  it.each(Object.keys(routers))('every %s route has a class, and its middleware matches it', (name) => {
    const routes = registeredRoutes(routers[name]);
    // A new route must be added to CLASSIFIED, with a test for who it admits.
    expect(routes.map(key).sort()).toEqual(Object.keys(CLASSIFIED[name]).sort());
    for (const route of routes) {
      expect(detected(route), `${name} ${key(route)}`).toBe(CLASSIFIED[name][key(route)]);
    }
  });

  it('every read that refuses the anonymous account has a stated reason', () => {
    const signedInReads = Object.entries(CLASSIFIED)
      .flatMap(([name, routes]) => Object.entries(routes).filter(([, kind]) => kind === 'read-signed-in').map(([route]) => `${name} ${route}`));
    expect(signedInReads.sort()).toEqual(Object.keys(SIGNED_IN_READS).sort());
  });

  it('the one handler-filtered route and the job handles are the known ones', () => {
    const of = (kind: Kind): string[] => Object.entries(CLASSIFIED)
      .flatMap(([name, routes]) => Object.entries(routes).filter(([, k]) => k === kind).map(([route]) => `${name} ${route}`));
    expect(of('listed')).toEqual(['messaging GET /messages/channel-counts']);
    expect(of('owner').sort()).toEqual([
      'admin GET /admin/login-progress/:requestId',
      'admin POST /admin/login-cancel',
      'contacts GET /nodes/:publicKey/neighbours/fetch/:requestId',
      'contacts POST /nodes/:publicKey/neighbours/fetch/:requestId/cancel',
    ]);
  });

  it('no route open to the anonymous account runs requireMeshcoreTx()', () => {
    for (const [name, router] of Object.entries(routers)) {
      for (const route of registeredRoutes(router)) {
        const open = !route.handlers.some((h) => isAuthGate(h));
        if (open) expect(route.handlers.some((h) => isMeshcoreTxGate(h)), `${name} ${key(route)}`).toBe(false);
      }
    }
  });
});
