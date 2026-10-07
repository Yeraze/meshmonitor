/**
 * The position gate (`buildPositionFilter` / `buildMeshCorePositionFilter`)
 * checks each row on its OWN source.
 *
 * `nodes_private:read` used to be checked with no source, which passes on a
 * grant for any source: a user allowed to see private positions on source A
 * saw the private positions held on source B. Every route that shows a
 * position through the gate is driven here, through the real auth middleware
 * with real permission rows:
 *
 *   - `GET /analysis/positions`, `GET /analysis/coverage-grid`
 *   - `GET /analysis/coverage/receivers`, `/senders`, `/receptions`
 *   - `GET /analysis/coverage/surveys`
 *   - `GET /analysis/cross-source-links`, `/traceroute-confirmed`
 *   - `GET /aircraft/trails`
 *   - `GET /unified/dashboard` (its own check, same fault)
 *   - `GET /telemetry/:nodeId` (its own check, same fault)
 *
 * The caller under test may read `nodes` and see channel 0 on BOTH sources and
 * holds `nodes_private:read` on source A only. Private positions carry marker
 * coordinates: A's must come back, B's must not appear anywhere in the body.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import analysisRoutes from './analysisRoutes.js';
import coverageRoutes from './coverageRoutes.js';
import crossSourceLinkRoutes from './crossSourceLinkRoutes.js';
import aircraftRoutes from './aircraftRoutes.js';
import unifiedRoutes from './unifiedRoutes.js';
import telemetryRoutes from './telemetryRoutes.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { localNodeNumSettingKey } from '../../db/repositories/settings.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';
import { buildPositionFilter, buildMeshCorePositionFilter } from '../utils/positionVisibility.js';
import { loadSourcePermissions } from '../utils/sourcePermissions.js';

const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;
const nowSec = (): number => Math.floor(Date.now() / 1000);
const HOUR = 3_600_000;

// Node numbers unique to this file: node rows outlive a test.
const LOCAL_A = 0x5c0a0001;
const PRIV_A = 0x5c0a0002;
const LOCAL_B = 0x5c0b0001;
const PRIV_B = 0x5c0b0002;
const PUB_B = 0x5c0b0003;
const CH1_B = 0x5c0b0004;
const ALL_NODES = [LOCAL_A, PRIV_A, LOCAL_B, PRIV_B, PUB_B, CH1_B];
const MC_KEY_B = 'b'.repeat(64);

/** Coordinates that exist for one private node only. */
const MARK = {
  /** PRIV_A's private override. */
  privA: 41.4141,
  /** PRIV_A's position telemetry. */
  fixA: 47.4747,
  /** PRIV_B's private override. */
  privB: 42.4242,
  /** PRIV_B's position telemetry. */
  fixB: 46.4646,
  /** PRIV_B as a coverage sender (the fix the receiver logged). */
  coverageB: 48.4848,
  /** PRIV_B's row in source A's table: public there. */
  privBSeenByA: 49.4949,
  /** PUB_B: visible to anyone who sees channel 0 on B. */
  pubB: 44.4444,
  /** CH1_B: a channel-1 node on B. */
  ch1B: 45.4545,
};
const B_PRIVATE_MARKERS = [MARK.privB, MARK.fixB, MARK.coverageB].map(String);

const text = (body: unknown): string => JSON.stringify(body ?? null);
const expectNoPrivateB = (body: unknown): void => {
  const serialized = text(body);
  for (const marker of B_PRIVATE_MARKERS) expect(serialized, `leaked ${marker}`).not.toContain(marker);
};

describe('position gate: a private position is shown only with nodes_private:read on its own source', () => {
  let harness: RouteTestHarness;
  let limited: SeededUser;

  const give = async (
    resource: string,
    actions: Array<'read' | 'write' | 'viewOnMap'>,
    sourceId?: string,
  ): Promise<void> => {
    await databaseService.auth.createPermission({
      userId: limited.id,
      resource,
      canRead: actions.includes('read'),
      canWrite: actions.includes('write'),
      canViewOnMap: actions.includes('viewOnMap'),
      sourceId: sourceId ?? null,
      grantedAt: Date.now(),
      grantedBy: null,
    } as never);
  };

  const seedNode = async (sourceId: string, nodeNum: number, lat: number, channel = 0): Promise<void> => {
    await databaseService.nodes.upsertNode(
      {
        nodeNum, nodeId: nodeIdFor(nodeNum), longName: `Node ${nodeNum.toString(16)}`, shortName: 'N', hwModel: 43,
        channel, latitude: lat, longitude: lat, lastHeard: nowSec(), hideFromMap: false,
      } as never,
      sourceId,
    );
    // Node rows outlive a test: clear an override an earlier one set.
    await databaseService.setNodePositionOverrideAsync(nodeNum, false, sourceId, undefined, undefined, undefined, false);
  };

  const seedFix = async (sourceId: string, nodeNum: number, lat: number): Promise<void> => {
    const at = Date.now() - HOUR;
    for (const [telemetryType, value] of [['latitude', lat], ['longitude', lat], ['altitude', 9000]] as const) {
      await databaseService.telemetry.insertTelemetry(
        { nodeId: nodeIdFor(nodeNum), nodeNum, telemetryType, timestamp: at, value, createdAt: at, channel: 0 },
        sourceId,
      );
    }
  };

  const flagAircraft = (sourceId: string, nodeNum: number): Promise<unknown> =>
    databaseService.nodes.setAircraftClassification(nodeNum, sourceId, {
      likelyAircraft: true, aircraftBasis: null, groundElevation: 0, heightAboveGround: 3000, aircraftClassifiedAt: Date.now(),
    });

  const reception = (sourceId: string, overrides: Record<string, unknown>): Promise<unknown> =>
    databaseService.coverageReceptions.recordReception({
      sourceId, protocol: 'meshtastic', receiverKind: 'local',
      receiverId: nodeIdFor(LOCAL_B), receiverNodeNum: LOCAL_B, receiverLatitude: 10, receiverLongitude: 20,
      senderId: nodeIdFor(PUB_B), senderNodeNum: PUB_B,
      packetKey: 'pkt', pathKey: 'r0:h0', latitude: 11, longitude: 21, transportMechanism: 1, receivedAt: Date.now(),
      ...overrides,
    } as Parameters<typeof databaseService.coverageReceptions.recordReception>[0]);

  const hear = (overrides: Record<string, unknown>): Promise<unknown> =>
    databaseService.crossSourceLinks.recordHearing({
      txSourceId: harness.sourceA, txNodeId: nodeIdFor(LOCAL_A),
      rxSourceId: harness.sourceB, rxNodeId: nodeIdFor(LOCAL_B),
      protocol: 'meshtastic', kind: 'origin', transportClass: 'rf', snr: 5, rssi: -90, heardAt: Date.now() - 60_000,
      ...overrides,
    } as Parameters<typeof databaseService.crossSourceLinks.recordHearing>[0]);

  const traceroute = (sourceId: string, local: number, remote: number): Promise<unknown> =>
    databaseService.traceroutes.insertTraceroute({
      fromNodeNum: remote, toNodeNum: local, fromNodeId: nodeIdFor(remote), toNodeId: nodeIdFor(local),
      route: '[]', routeBack: '[]', snrTowards: '[-33]', snrBack: '[-45]', channel: 0, transportMechanism: 1,
      timestamp: Date.now() - 60_000, createdAt: Date.now() - 60_000,
    } as never, sourceId);

  /** `nodes:read` and channel 0 on both sources; `nodes_private:read` on A only. */
  const giveBothSourcesPrivateOnA = async (): Promise<void> => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await give('nodes', ['read', 'viewOnMap'], sourceId);
      await give('channel_0', ['read', 'viewOnMap'], sourceId);
      await give('traceroute', ['read'], sourceId);
    }
    await give('nodes_private', ['read'], harness.sourceA);
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/analysis/coverage', coverageRoutes);
        app.use('/analysis/cross-source-links', crossSourceLinkRoutes);
        app.use('/analysis', analysisRoutes);
        app.use('/aircraft', aircraftRoutes);
        app.use('/unified', unifiedRoutes);
        app.use('/', telemetryRoutes);
      },
    });
    limited = harness.limited;
    await databaseService.settings.setSetting(localNodeNumSettingKey(harness.sourceA), String(LOCAL_A));
    await databaseService.settings.setSetting(localNodeNumSettingKey(harness.sourceB), String(LOCAL_B));

    await seedNode(harness.sourceA, LOCAL_A, 30.1);
    await seedNode(harness.sourceA, PRIV_A, 30.2);
    await seedNode(harness.sourceB, LOCAL_B, 31.1);
    await seedNode(harness.sourceB, PRIV_B, 31.2);
    await seedNode(harness.sourceB, PUB_B, MARK.pubB);
    await seedNode(harness.sourceB, CH1_B, MARK.ch1B, 1);
    await databaseService.setNodePositionOverrideAsync(PRIV_A, true, harness.sourceA, MARK.privA, MARK.privA, 0, true);
    await databaseService.setNodePositionOverrideAsync(PRIV_B, true, harness.sourceB, MARK.privB, MARK.privB, 0, true);

    await seedFix(harness.sourceA, PRIV_A, MARK.fixA);
    await seedFix(harness.sourceB, PRIV_B, MARK.fixB);
    await seedFix(harness.sourceB, PUB_B, MARK.pubB);
    await seedFix(harness.sourceB, CH1_B, MARK.ch1B);
    await flagAircraft(harness.sourceA, PRIV_A);
    await flagAircraft(harness.sourceB, PRIV_B);
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      for (const nodeNum of ALL_NODES) {
        await databaseService.telemetry.purgeNodeTelemetry(nodeNum, sourceId).catch(() => {});
        await databaseService.nodes.deleteNodeRecord(nodeNum, sourceId).catch(() => {});
      }
      await databaseService.coverageReceptions.deleteForSource(sourceId).catch(() => {});
      await databaseService.settings.deleteSetting(localNodeNumSettingKey(sourceId)).catch(() => {});
    }
    await databaseService.crossSourceLinks.deleteAll().catch(() => {});
    await databaseService.traceroutes.deleteAllTraceroutes(ALL_SOURCES).catch(() => {});
    for (const survey of await databaseService.coverageSurveys.listSurveys()) {
      await databaseService.coverageSurveys.deleteSurvey(survey.id).catch(() => {});
    }
    await harness.cleanup();
  });

  // ── /analysis/positions, /analysis/coverage-grid ──────────────────────────
  describe('GET /analysis/positions', () => {
    const lats = (body: { items: Array<{ latitude: number }> }): number[] => body.items.map((p) => p.latitude).sort();

    it('returns A\'s private fixes and not B\'s to a user with nodes_private:read on A only', async () => {
      await giveBothSourcesPrivateOnA();
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/analysis/positions');

      expect(res.status).toBe(200);
      expect(lats(res.body)).toEqual([MARK.pubB, MARK.fixA]);
      expectNoPrivateB(res.body);
    });

    it('returns B\'s private fixes once nodes_private:read is held on B', async () => {
      await giveBothSourcesPrivateOnA();
      await give('nodes_private', ['read'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      expect(lats((await agent.get('/analysis/positions')).body)).toEqual([MARK.pubB, MARK.fixB, MARK.fixA]);
    });

    it('nodes_private:read on B alone does not show A\'s private fixes', async () => {
      for (const sourceId of [harness.sourceA, harness.sourceB]) {
        await give('nodes', ['read'], sourceId);
        await give('channel_0', ['viewOnMap'], sourceId);
      }
      await give('nodes_private', ['read'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const body = (await agent.get('/analysis/positions')).body;

      expect(lats(body)).toEqual([MARK.pubB, MARK.fixB]);
      expect(text(body)).not.toContain(String(MARK.fixA));
    });

    it('checks the channel on the row\'s own source: channel_1 on A does not show B\'s channel-1 node', async () => {
      await giveBothSourcesPrivateOnA();
      await give('channel_1', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const hidden = await agent.get('/analysis/positions');
      expect(text(hidden.body)).not.toContain(String(MARK.ch1B));

      await give('channel_1', ['viewOnMap'], harness.sourceB);
      expect(text((await agent.get('/analysis/positions')).body)).toContain(String(MARK.ch1B));
    });

    it('gives an admin every source\'s fixes, private ones included', async () => {
      const admin = await harness.loginAs(harness.admin);
      const ours = lats((await admin.get('/analysis/positions')).body);
      expect(ours).toEqual([MARK.pubB, MARK.ch1B, MARK.fixB, MARK.fixA]);
    });

    it('gives an anonymous caller nothing', async () => {
      const res = await (await harness.loginAs(null)).get('/analysis/positions');
      expect(res.body.items).toEqual([]);
    });
  });

  it('GET /analysis/coverage-grid counts B\'s private fixes only with nodes_private:read on B', async () => {
    await giveBothSourcesPrivateOnA();
    const agent = await harness.loginAs(limited);
    const cellCount = async (): Promise<number> => {
      const res = await agent.get('/analysis/coverage-grid').query({ zoom: 12 });
      expect(res.status).toBe(200);
      return res.body.cells.length;
    };

    const without = await cellCount();
    await give('nodes_private', ['read'], harness.sourceB);
    const withB = await cellCount();

    // PUB_B and PRIV_A's cells, then PRIV_B's as well.
    expect(without).toBe(2);
    expect(withB).toBe(3);
  });

  // ── /analysis/coverage ────────────────────────────────────────────────────
  describe('GET /analysis/coverage/*', () => {
    beforeEach(async () => {
      // PRIV_B as a receiver (its node position is the private override) and
      // as a sender (the fix it reported), both on source B.
      await reception(harness.sourceB, { packetKey: 'rx-priv-b', receiverId: nodeIdFor(PRIV_B), receiverNodeNum: PRIV_B });
      await reception(harness.sourceB, {
        packetKey: 'tx-priv-b', senderId: nodeIdFor(PRIV_B), senderNodeNum: PRIV_B, latitude: MARK.coverageB, longitude: MARK.coverageB,
      });
      // PRIV_A as a receiver on source A.
      await reception(harness.sourceA, {
        packetKey: 'rx-priv-a', receiverId: nodeIdFor(PRIV_A), receiverNodeNum: PRIV_A, senderId: nodeIdFor(LOCAL_A), senderNodeNum: LOCAL_A,
      });
    });

    it('/receivers nulls B\'s private receiver position and keeps A\'s', async () => {
      await giveBothSourcesPrivateOnA();
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/analysis/coverage/receivers');

      expect(res.status).toBe(200);
      const byNum = (num: number) => res.body.data.receivers.find((r: { receiverNodeNum: number }) => r.receiverNodeNum === num);
      expect(byNum(PRIV_A)).toMatchObject({ latitude: MARK.privA, longitude: MARK.privA });
      expect(byNum(PRIV_B)).toMatchObject({ latitude: null, longitude: null });
      expectNoPrivateB(res.body);

      await give('nodes_private', ['read'], harness.sourceB);
      const allowed = await agent.get('/analysis/coverage/receivers');
      expect(allowed.body.data.receivers.find((r: { receiverNodeNum: number }) => r.receiverNodeNum === PRIV_B))
        .toMatchObject({ latitude: MARK.privB });
    });

    it('/senders leaves out a sender whose position is private on B', async () => {
      await giveBothSourcesPrivateOnA();
      const agent = await harness.loginAs(limited);
      const senderIds = async (): Promise<string[]> =>
        (await agent.get('/analysis/coverage/senders')).body.data.senders.map((s: { senderId: string }) => s.senderId);

      expect(await senderIds()).not.toContain(nodeIdFor(PRIV_B));

      await give('nodes_private', ['read'], harness.sourceB);
      expect(await senderIds()).toContain(nodeIdFor(PRIV_B));
    });

    it('/receptions drops B\'s private sender and nulls B\'s private receiver', async () => {
      await giveBothSourcesPrivateOnA();
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/analysis/coverage/receptions');

      expect(res.status).toBe(200);
      const keys = res.body.data.items.map((r: { packetKey: string }) => r.packetKey).sort();
      expect(keys).toEqual(['rx-priv-a', 'rx-priv-b']);
      expect(res.body.data.items.find((r: { packetKey: string }) => r.packetKey === 'rx-priv-b'))
        .toMatchObject({ receiverLatitude: null, receiverLongitude: null });
      expect(res.body.data.items.find((r: { packetKey: string }) => r.packetKey === 'rx-priv-a'))
        .toMatchObject({ receiverLatitude: 10, receiverLongitude: 20 });
      expectNoPrivateB(res.body);
    });

    it('/surveys lists a survey of A\'s private sender and not one of B\'s', async () => {
      const make = (name: string, nodeNum: number) =>
        databaseService.coverageSurveys.createSurvey({
          name, senderId: nodeIdFor(nodeNum), startAt: Date.now() - 60_000, endAt: Date.now(),
          receivers: null, intervalSec: null, notes: null, createdBy: harness.admin.id,
        });
      await make('Survey of private A', PRIV_A);
      await make('Survey of private B', PRIV_B);
      await giveBothSourcesPrivateOnA();
      const agent = await harness.loginAs(limited);
      const names = async (): Promise<string[]> =>
        (await agent.get('/analysis/coverage/surveys')).body.data.map((s: { name: string }) => s.name).sort();

      expect(await names()).toEqual(['Survey of private A']);

      await give('nodes_private', ['read'], harness.sourceB);
      expect(await names()).toEqual(['Survey of private A', 'Survey of private B']);
    });
  });

  // ── /analysis/cross-source-links ──────────────────────────────────────────
  describe('GET /analysis/cross-source-links', () => {
    const KEY = (tx: number, rx: number): string => `${nodeIdFor(tx)}>${nodeIdFor(rx)}`;
    const edges = (body: { data: { links: Array<{ txNodeId: string; rxNodeId: string }> } }): string[] =>
      body.data.links.map((l) => `${l.txNodeId}>${l.rxNodeId}`).sort();

    beforeEach(async () => {
      await hear({ txNodeId: nodeIdFor(PRIV_A), rxNodeId: nodeIdFor(PUB_B) });
      await hear({ txNodeId: nodeIdFor(LOCAL_A), rxNodeId: nodeIdFor(PRIV_B) });
    });

    it('keeps the edge that ends at A\'s private node and drops the one that ends at B\'s', async () => {
      await giveBothSourcesPrivateOnA();
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/analysis/cross-source-links');

      expect(res.status).toBe(200);
      expect(edges(res.body)).toEqual([KEY(PRIV_A, PUB_B)]);
      expect(res.body.data.links[0].from).toEqual([MARK.privA, MARK.privA]);
      expectNoPrivateB(res.body);

      await give('nodes_private', ['read'], harness.sourceB);
      expect(edges((await agent.get('/analysis/cross-source-links')).body)).toEqual([KEY(LOCAL_A, PRIV_B), KEY(PRIV_A, PUB_B)].sort());
    });

    it('does not fall back to source A\'s row for a position source B marks private', async () => {
      // Source A has heard PRIV_B too and holds a public position for it.
      await seedNode(harness.sourceA, PRIV_B, MARK.privBSeenByA);
      await giveBothSourcesPrivateOnA();
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/analysis/cross-source-links');

      expect(edges(res.body)).toEqual([KEY(PRIV_A, PUB_B)]);
      expect(text(res.body)).not.toContain(String(MARK.privBSeenByA));
      await databaseService.nodes.deleteNodeRecord(PRIV_B, harness.sourceA).catch(() => {});
    });

    it('still needs both sources readable: nodes_private on B does not stand in for nodes:read on B', async () => {
      await give('nodes', ['read'], harness.sourceA);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      await give('nodes_private', ['read'], harness.sourceA);
      await give('nodes_private', ['read'], harness.sourceB);
      await give('channel_0', ['viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/analysis/cross-source-links');

      expect(res.body.data.links).toEqual([]);
      expect(text(res.body)).not.toContain(harness.sourceB);
    });

    it('gives an admin both edges', async () => {
      const admin = await harness.loginAs(harness.admin);
      expect(edges((await admin.get('/analysis/cross-source-links')).body)).toEqual([KEY(LOCAL_A, PRIV_B), KEY(PRIV_A, PUB_B)].sort());
    });
  });

  it('GET /analysis/cross-source-links/traceroute-confirmed drops the link to B\'s private node and keeps A\'s', async () => {
    await traceroute(harness.sourceA, LOCAL_A, PRIV_A);
    await traceroute(harness.sourceB, LOCAL_B, PRIV_B);
    await giveBothSourcesPrivateOnA();
    const agent = await harness.loginAs(limited);
    const read = async (): Promise<{ body: unknown; neighbors: number[] }> => {
      const res = await agent.get('/analysis/cross-source-links/traceroute-confirmed');
      expect(res.status).toBe(200);
      return { body: res.body, neighbors: res.body.data.links.map((l: { neighborNodeNum: number }) => l.neighborNodeNum).sort() };
    };

    const without = await read();
    expect(without.neighbors).toEqual([PRIV_A]);
    expectNoPrivateB(without.body);

    await give('nodes_private', ['read'], harness.sourceB);
    expect((await read()).neighbors).toEqual([PRIV_A, PRIV_B].sort());
  });

  // ── /aircraft/trails ──────────────────────────────────────────────────────
  it('GET /aircraft/trails returns A\'s private aircraft and not B\'s', async () => {
    await giveBothSourcesPrivateOnA();
    const agent = await harness.loginAs(limited);
    const trailNodes = async (): Promise<number[]> => {
      const res = await agent.get('/aircraft/trails');
      expect(res.status).toBe(200);
      return res.body.data.trails.map((t: { nodeNum: number }) => t.nodeNum).sort();
    };

    const first = await agent.get('/aircraft/trails');
    expectNoPrivateB(first.body);
    expect(text(first.body)).toContain(String(MARK.fixA));
    expect(await trailNodes()).toEqual([PRIV_A]);

    await give('nodes_private', ['read'], harness.sourceB);
    expect(await trailNodes()).toEqual([PRIV_A, PRIV_B].sort());
  });

  // ── /unified/dashboard ────────────────────────────────────────────────────
  it('GET /unified/dashboard strips B\'s private override and keeps A\'s', async () => {
    await giveBothSourcesPrivateOnA();
    const agent = await harness.loginAs(limited);
    type Bundle = { sourceId: string; nodes: Array<{ nodeNum: number; latitude?: number; latitudeOverride?: number }> };
    const node = (body: Bundle[], sourceId: string, nodeNum: number) =>
      body.find((b) => b.sourceId === sourceId)?.nodes.find((n) => Number(n.nodeNum) === nodeNum);

    const res = await agent.get('/unified/dashboard');

    expect(res.status).toBe(200);
    expect(node(res.body, harness.sourceA, PRIV_A)).toMatchObject({ latitude: MARK.privA });
    expect(node(res.body, harness.sourceB, PRIV_B)).toBeDefined();
    expect(node(res.body, harness.sourceB, PRIV_B)).not.toHaveProperty('latitudeOverride');
    expectNoPrivateB(res.body);

    await give('nodes_private', ['read'], harness.sourceB);
    expect(node((await agent.get('/unified/dashboard')).body, harness.sourceB, PRIV_B)).toMatchObject({ latitude: MARK.privB });
  });

  // ── /telemetry/:nodeId ────────────────────────────────────────────────────
  it('GET /telemetry/:nodeId strips B\'s private position telemetry and keeps A\'s', async () => {
    await giveBothSourcesPrivateOnA();
    await give('info', ['read']);
    const agent = await harness.loginAs(limited);
    const types = async (nodeNum: number, sourceId: string): Promise<string[]> => {
      const res = await agent.get(`/telemetry/${nodeIdFor(nodeNum)}`).query({ sourceId, hours: 24 });
      expect(res.status).toBe(200);
      return [...new Set<string>(res.body.map((t: { telemetryType: string }) => t.telemetryType))].sort();
    };

    expect(await types(PRIV_A, harness.sourceA)).toEqual(['altitude', 'latitude', 'longitude']);
    expect(await types(PRIV_B, harness.sourceB)).toEqual([]);

    await give('nodes_private', ['read'], harness.sourceB);
    expect(await types(PRIV_B, harness.sourceB)).toEqual(['altitude', 'latitude', 'longitude']);
  });

  // ── The predicates themselves ─────────────────────────────────────────────
  describe('buildPositionFilter / buildMeshCorePositionFilter', () => {
    it('answers per source from one load of the grants', async () => {
      await giveBothSourcesPrivateOnA();
      const user = { id: limited.id, username: limited.username, isAdmin: false } as never;
      const grants = await loadSourcePermissions(user);
      const filter = await buildPositionFilter(user, [harness.sourceA, harness.sourceB], undefined, grants);

      expect(filter({ sourceId: harness.sourceA, nodeNum: PRIV_A })).toBe(true);
      expect(filter({ sourceId: harness.sourceB, nodeNum: PRIV_B })).toBe(false);
      expect(filter({ sourceId: harness.sourceB, nodeNum: PUB_B })).toBe(true);
      // Channel 1 is granted on neither source.
      expect(filter({ sourceId: harness.sourceB, nodeNum: CH1_B })).toBe(false);
      // A row asked about on a source that does not hold it has no node record.
      expect(filter({ sourceId: harness.sourceA, nodeNum: PUB_B })).toBe(false);
    });

    it('keeps the display gates for an admin and hides nothing else', async () => {
      const admin = { id: harness.admin.id, username: harness.admin.username, isAdmin: true } as never;
      await databaseService.setNodeHideFromMapAsync(PUB_B, true, harness.sourceB);
      const filter = await buildPositionFilter(admin, [harness.sourceA, harness.sourceB]);

      expect(filter({ sourceId: harness.sourceB, nodeNum: PRIV_B })).toBe(true);
      expect(filter({ sourceId: harness.sourceB, nodeNum: PUB_B })).toBe(false);
      expect(filter({ sourceId: harness.sourceB, nodeNum: 0x5c0bffff })).toBe(false);
    });

    it('MeshCore: nodes:viewOnMap is checked on the row\'s own source', async () => {
      await give('nodes', ['read', 'viewOnMap'], harness.sourceA);
      await give('nodes', ['read'], harness.sourceB);
      const user = { id: limited.id, username: limited.username, isAdmin: false } as never;
      const mcNodes = new Map([
        [harness.sourceA, [{ publicKey: MC_KEY_B }]],
        [harness.sourceB, [{ publicKey: MC_KEY_B.toUpperCase() }]],
      ]) as never;

      const filter = await buildMeshCorePositionFilter(user, [harness.sourceA, harness.sourceB], mcNodes);

      expect(filter({ sourceId: harness.sourceA, publicKey: MC_KEY_B })).toBe(true);
      expect(filter({ sourceId: harness.sourceB, publicKey: MC_KEY_B })).toBe(false);
      expect(await buildMeshCorePositionFilter(null, [harness.sourceA], mcNodes).then((f) => f({ sourceId: harness.sourceA, publicKey: MC_KEY_B }))).toBe(false);
    });
  });
});
