/**
 * Coverage Report API tests (#5277 Coverage Report epic, Phase 1 WP3).
 *
 * Uses the real-middleware harness (createRouteTestApp) against the live
 * :memory: singleton — see src/server/test-helpers/routeTestApp.ts for the
 * design rationale, and sourceRoutes.permissions.test.ts for the template.
 * Real `checkPermissionAsync`/`getUserPermissionSetAsync` SQL exercises the
 * SAME visibility gate `/positions` uses (via `buildPositionFilter`,
 * extracted into `positionVisibility.ts` in this work package), proving
 * per-source isolation and the display/permission gates with real data
 * rather than a hand-rolled mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import coverageRoutes from './coverageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

function nodeIdFor(num: number): string {
  return `!${num.toString(16).padStart(8, '0')}`;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('Coverage Report API (#5277 WP3)', () => {
  let harness: RouteTestHarness;

  // Node numbers, one per scenario, all distinct.
  const RECEIVER = 0x61000001;
  const SENDER_OK = 0x61000002;
  const SENDER_HIDDEN = 0x61000003;
  const SENDER_PRIVATE = 0x61000004;
  const SENDER_CH1 = 0x61000005;
  const RECEIVER_PRIVATE = 0x61000006;
  const B_RECEIVER = 0x62000001;
  const B_SENDER = 0x62000002;

  const seedReception = (overrides: Record<string, unknown> = {}) =>
    databaseService.coverageReceptions.recordReception({
      sourceId: harness.sourceA,
      protocol: 'meshtastic',
      receiverKind: 'local',
      receiverId: nodeIdFor(RECEIVER),
      receiverNodeNum: RECEIVER,
      receiverLatitude: 37.0,
      receiverLongitude: -122.0,
      senderId: nodeIdFor(SENDER_OK),
      senderNodeNum: SENDER_OK,
      packetKey: 'pkt-default',
      pathKey: 'r0:h0',
      latitude: 37.5,
      longitude: -122.5,
      receivedAt: Date.now(),
      ...overrides,
    } as Parameters<typeof databaseService.coverageReceptions.recordReception>[0]);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', coverageRoutes) });

    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

    // Nodes on sourceA
    await harness.db.nodes.upsertNode({
      nodeNum: RECEIVER, nodeId: nodeIdFor(RECEIVER), longName: 'Receiver', shortName: 'RX',
      channel: 0, latitude: 37.0, longitude: -122.0, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: SENDER_OK, nodeId: nodeIdFor(SENDER_OK), longName: 'Sender OK', shortName: 'SO',
      channel: 0, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: SENDER_HIDDEN, nodeId: nodeIdFor(SENDER_HIDDEN), longName: 'Sender Hidden', shortName: 'SH',
      channel: 0, hideFromMap: true, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: SENDER_PRIVATE, nodeId: nodeIdFor(SENDER_PRIVATE), longName: 'Sender Private', shortName: 'SP',
      channel: 0, positionOverrideIsPrivate: true, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: SENDER_CH1, nodeId: nodeIdFor(SENDER_CH1), longName: 'Sender Ch1', shortName: 'SC',
      channel: 1, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: RECEIVER_PRIVATE, nodeId: nodeIdFor(RECEIVER_PRIVATE), longName: 'Receiver Private', shortName: 'RP',
      channel: 0, positionOverrideIsPrivate: true, latitude: 38.0, longitude: -123.0, lastHeard: nowSec(),
    } as any, harness.sourceA);

    // Nodes on sourceB
    await harness.db.nodes.upsertNode({
      nodeNum: B_RECEIVER, nodeId: nodeIdFor(B_RECEIVER), longName: 'B Receiver', shortName: 'BR',
      channel: 0, latitude: 10.0, longitude: 20.0, lastHeard: nowSec(),
    } as any, harness.sourceB);
    await harness.db.nodes.upsertNode({
      nodeNum: B_SENDER, nodeId: nodeIdFor(B_SENDER), longName: 'B Sender', shortName: 'BS',
      channel: 0, lastHeard: nowSec(),
    } as any, harness.sourceB);

    // Receptions on sourceA
    await seedReception({ packetKey: 'pkt-ok' });
    await seedReception({
      packetKey: 'pkt-hidden-sender', senderId: nodeIdFor(SENDER_HIDDEN), senderNodeNum: SENDER_HIDDEN,
    });
    await seedReception({
      packetKey: 'pkt-private-sender', senderId: nodeIdFor(SENDER_PRIVATE), senderNodeNum: SENDER_PRIVATE,
    });
    await seedReception({
      packetKey: 'pkt-ch1-sender', senderId: nodeIdFor(SENDER_CH1), senderNodeNum: SENDER_CH1,
    });
    await seedReception({
      packetKey: 'pkt-private-receiver',
      receiverId: nodeIdFor(RECEIVER_PRIVATE), receiverNodeNum: RECEIVER_PRIVATE,
      receiverLatitude: 38.0, receiverLongitude: -123.0,
    });

    // Reception on sourceB
    await databaseService.coverageReceptions.recordReception({
      sourceId: harness.sourceB,
      protocol: 'meshtastic',
      receiverKind: 'local',
      receiverId: nodeIdFor(B_RECEIVER),
      receiverNodeNum: B_RECEIVER,
      receiverLatitude: 10.0,
      receiverLongitude: 20.0,
      senderId: nodeIdFor(B_SENDER),
      senderNodeNum: B_SENDER,
      packetKey: 'pkt-b',
      pathKey: 'r0:h0',
      latitude: 11.0,
      longitude: 21.0,
      receivedAt: Date.now(),
    });
  });

  afterEach(async () => {
    await databaseService.coverageReceptions.deleteForSource(harness.sourceA).catch(() => {});
    await databaseService.coverageReceptions.deleteForSource(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  // ── GET /receptions ─────────────────────────────────────────────────────

  describe('GET /receptions', () => {
    it('anonymous with no grants gets an empty result', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/receptions');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toEqual([]);
    });

    it('limited user with nodes:read on A only never sees B rows', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/receptions');
      expect(res.status).toBe(200);
      const senderIds = res.body.data.items.map((r: any) => r.senderId);
      expect(senderIds).not.toContain(nodeIdFor(B_SENDER));
    });

    it('sources=B for that user (no B grant) is empty', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/receptions?sources=${harness.sourceB}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    });

    it('drops a hidden-from-map sender for everyone, including admin', async () => {
      const agentLimited = await harness.loginAs(harness.limited);
      const resLimited = await agentLimited.get('/receptions');
      expect(resLimited.body.data.items.some((r: any) => r.senderId === nodeIdFor(SENDER_HIDDEN))).toBe(false);

      const agentAdmin = await harness.loginAs(harness.admin);
      const resAdmin = await agentAdmin.get('/receptions');
      expect(resAdmin.body.data.items.some((r: any) => r.senderId === nodeIdFor(SENDER_HIDDEN))).toBe(false);
    });

    it('drops a sender on a channel without viewOnMap', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/receptions');
      expect(res.body.data.items.some((r: any) => r.senderId === nodeIdFor(SENDER_CH1))).toBe(false);
    });

    it('shows the channel-1 sender once channel_1 viewOnMap is granted', async () => {
      await harness.grant(harness.limited.id, 'channel_1', 'viewOnMap', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/receptions');
      expect(res.body.data.items.some((r: any) => r.senderId === nodeIdFor(SENDER_CH1))).toBe(true);
    });

    it('drops a private-override sender without nodes_private:read', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/receptions');
      expect(res.body.data.items.some((r: any) => r.senderId === nodeIdFor(SENDER_PRIVATE))).toBe(false);
    });

    it('shows the private-override sender once nodes_private:read is granted', async () => {
      // `nodes_private` is a "sourcey" resource: buildPositionFilter's
      // checkPermissionAsync(userId, 'nodes_private', 'read') call (no
      // sourceId) unions across the caller's PER-SOURCE grants — a global
      // (sourceId=null) grant does not satisfy it. Scope the grant to sourceA.
      await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/receptions');
      expect(res.body.data.items.some((r: any) => r.senderId === nodeIdFor(SENDER_PRIVATE))).toBe(true);
    });

    it('nulls receiver coordinates when the receiver itself is not visible', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/receptions');
      const row = res.body.data.items.find((r: any) => r.packetKey === 'pkt-private-receiver');
      expect(row).toBeDefined();
      expect(row.receiverLatitude).toBeNull();
      expect(row.receiverLongitude).toBeNull();
    });

    it('admin sees every visible row (hidden sender still excluded)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions');
      const senderIds = res.body.data.items.map((r: any) => r.senderId).sort();
      expect(senderIds).toEqual(
        [
          nodeIdFor(B_SENDER),
          nodeIdFor(SENDER_CH1),
          nodeIdFor(SENDER_OK),
          nodeIdFor(SENDER_OK),
          nodeIdFor(SENDER_PRIVATE),
        ].sort(),
      );
      expect(senderIds).not.toContain(nodeIdFor(SENDER_HIDDEN));
    });

    it('400 INVALID_TIME_RANGE when until < since', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions?since=2000&until=1000');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TIME_RANGE');
      expect(res.body.success).toBe(false);
    });

    it('400 INVALID_HOPS for an out-of-range value', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions?hops=9');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_HOPS');
    });

    it('400 INVALID_HOPS_MODE for a bad value', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions?hops=1&hopsMode=bogus');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_HOPS_MODE');
    });

    it('400 INVALID_SENDER for a malformed sender param', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions?sender=not-a-node');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SENDER');
    });

    it('accepts a sender param as either !hex or a decimal node number', async () => {
      const agent = await harness.loginAs(harness.admin);
      const hexRes = await agent.get(`/receptions?sender=${nodeIdFor(SENDER_OK)}`);
      expect(hexRes.status).toBe(200);
      expect(hexRes.body.data.items.every((r: any) => r.senderId === nodeIdFor(SENDER_OK))).toBe(true);

      const decRes = await agent.get(`/receptions?sender=${SENDER_OK}`);
      expect(decRes.status).toBe(200);
      expect(decRes.body.data.items.every((r: any) => r.senderId === nodeIdFor(SENDER_OK))).toBe(true);
    });

    it('400 INVALID_CURSOR for a malformed cursor', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions?cursor=not-base64-json');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CURSOR');
    });

    it('envelope shape: success/data on 200, success/error/code on 400', async () => {
      const agent = await harness.loginAs(harness.admin);
      const ok = await agent.get('/receptions');
      expect(ok.body).toEqual(expect.objectContaining({ success: true, data: expect.any(Object) }));

      const bad = await agent.get('/receptions?hops=99');
      expect(bad.body).toEqual(
        expect.objectContaining({ success: false, error: expect.any(String), code: 'INVALID_HOPS' }),
      );
    });

    it('clamps pageSize to 2000', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions?pageSize=999999');
      expect(res.status).toBe(200);
      expect(res.body.data.pageSize).toBe(2000);
    });

    // ── receivers grammar (#5277 P2 §2.5/§2.7) ──────────────────────────────

    it('400 INVALID_RECEIVERS for a malformed receivers filter', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions?receivers=not-a-valid-filter');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_RECEIVERS');
      expect(res.body.success).toBe(false);
    });

    it('400 INVALID_RECEIVERS when the filter exceeds 1000 ids', async () => {
      const agent = await harness.loginAs(harness.admin);
      const ids = Array.from({ length: 1001 }, (_, i) => `!${i.toString(16).padStart(8, '0')}`).join(',');
      const res = await agent.get(`/receptions?receivers=${encodeURIComponent(`${harness.sourceA}:+${ids}`)}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_RECEIVERS');
    });

    it('applies a new-grammar include filter, source-scoped', async () => {
      const agent = await harness.loginAs(harness.admin);
      // Scope both `sources` and `receivers` to sourceA so an unconstrained
      // sourceB (no entry in the filter = fully selected) can't contribute rows.
      const filter = encodeURIComponent(`${harness.sourceA}:+${nodeIdFor(RECEIVER)}`);
      const res = await agent.get(`/receptions?sources=${harness.sourceA}&receivers=${filter}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.every((r: any) => r.receiverId === nodeIdFor(RECEIVER))).toBe(true);
      expect(res.body.data.items.length).toBeGreaterThan(0);
    });

    it('an include entry is scoped by sourceId — the same receiverId string on another (constrained) source never leaks in (P1 bug fix)', async () => {
      // Record a reception on sourceB using the SAME receiverId STRING as
      // sourceA's RECEIVER (independent networks can coincidentally reuse a
      // node number / derived !hex id). The P1 bug applied `receiverIds`
      // globally, so a filter for that id would have matched this row too
      // even though sourceB is explicitly constrained to a different id.
      await databaseService.coverageReceptions.recordReception({
        sourceId: harness.sourceB,
        protocol: 'meshtastic',
        receiverKind: 'local',
        receiverId: nodeIdFor(RECEIVER),
        receiverNodeNum: RECEIVER,
        senderId: nodeIdFor(B_SENDER),
        senderNodeNum: B_SENDER,
        packetKey: 'pkt-b-shared-receiver-id',
        pathKey: 'r0:h0',
        latitude: 11.0,
        longitude: 21.0,
        receivedAt: Date.now(),
      });

      const agent = await harness.loginAs(harness.admin);
      // sourceA constrained to RECEIVER; sourceB explicitly constrained to an
      // unrelated id, so it is NOT left "unconstrained" (which would trivially
      // include everything) — this is what actually exercises the fix.
      const filter = encodeURIComponent(
        `${harness.sourceA}:+${nodeIdFor(RECEIVER)};${harness.sourceB}:+${nodeIdFor(B_RECEIVER)}`,
      );
      const res = await agent.get(`/receptions?sources=${harness.sourceA},${harness.sourceB}&receivers=${filter}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.some((r: any) => r.packetKey === 'pkt-b-shared-receiver-id')).toBe(false);
      expect(res.body.data.items.some((r: any) => r.receiverId === nodeIdFor(RECEIVER) && r.sourceId === harness.sourceA)).toBe(true);
    });

    it('a blank receivers param is treated as no filter', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receptions?receivers=');
      expect(res.status).toBe(200);
    });
  });

  // ── GET /receivers ──────────────────────────────────────────────────────

  describe('GET /receivers', () => {
    it('is derived from the table only — no source.type dependency', async () => {
      await harness.db.sources.createSource({
        id: 'rt-source-meshcore', name: 'MeshCore Source', type: 'meshcore', config: {}, enabled: true,
      });
      try {
        await databaseService.coverageReceptions.recordReception({
          sourceId: 'rt-source-meshcore',
          protocol: 'meshcore',
          receiverKind: 'local',
          receiverId: 'deadbeefcafebabe',
          senderId: 'cafebabedeadbeef',
          packetKey: 'mc-pkt-1',
          pathKey: 'h1:1',
          latitude: 1,
          longitude: 2,
          receivedAt: Date.now(),
        });

        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get('/receivers');
        expect(res.status).toBe(200);
        const ids = res.body.data.receivers.map((r: any) => r.receiverId);
        expect(ids).toContain('deadbeefcafebabe');
      } finally {
        await databaseService.coverageReceptions.deleteForSource('rt-source-meshcore').catch(() => {});
        await harness.db.sources.deleteSource('rt-source-meshcore').catch(() => {});
      }
    });

    it('a permitted source with no receptions has no receiver', async () => {
      await harness.db.sources.createSource({
        id: 'rt-source-empty', name: 'Empty Source', type: 'meshtastic_tcp', config: {}, enabled: true,
      });
      try {
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get('/receivers?sources=rt-source-empty');
        expect(res.status).toBe(200);
        expect(res.body.data.receivers).toEqual([]);
      } finally {
        await harness.db.sources.deleteSource('rt-source-empty').catch(() => {});
      }
    });

    it('enriches a receiver with its node name and current position', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receivers');
      const receiver = res.body.data.receivers.find((r: any) => r.receiverId === nodeIdFor(RECEIVER));
      expect(receiver).toBeDefined();
      expect(receiver.longName).toBe('Receiver');
      expect(receiver.latitude).toBe(37.0);
      expect(receiver.longitude).toBe(-122.0);
    });

    it('includes receptionCount, one row per reception carrying this receiver', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/receivers');
      const receiver = res.body.data.receivers.find((r: any) => r.receiverId === nodeIdFor(RECEIVER));
      expect(receiver).toBeDefined();
      // pkt-ok, pkt-hidden-sender, pkt-private-sender, pkt-ch1-sender all seed with receiverId RECEIVER.
      expect(receiver.receptionCount).toBe(4);
    });

    it("nulls a receiver's coordinates when the receiver node is not visible to the caller", async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/receivers');
      const receiver = res.body.data.receivers.find((r: any) => r.receiverId === nodeIdFor(RECEIVER_PRIVATE));
      expect(receiver).toBeDefined();
      expect(receiver.latitude).toBeNull();
      expect(receiver.longitude).toBeNull();
    });

    it('anonymous with no grants gets an empty receivers list', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/receivers');
      expect(res.status).toBe(200);
      expect(res.body.data.receivers).toEqual([]);
      expect(res.body.data.retentionDays).toBe(7);
    });

    // ── mqttSources (#5277 P2 §2.7, user decision Q4) ───────────────────────

    describe('mqttSources', () => {
      function makeFakeManager(sourceId: string, sourceType: string): ISourceManager {
        return {
          sourceId,
          sourceType,
          start: async () => {},
          stop: async () => {},
          getStatus: () => ({ sourceId, sourceName: sourceId, sourceType, connected: true }),
        } as unknown as ISourceManager;
      }

      const BROKER = 'rt-source-mqtt-broker';
      const BRIDGE = 'rt-source-mqtt-bridge';
      const TCP = 'rt-source-mqtt-tcp';
      const MESHCORE_MQTT = 'rt-source-meshcore-mqtt';

      beforeEach(async () => {
        await harness.db.sources.createSource({ id: BROKER, name: 'Broker', type: 'mqtt_broker', config: {}, enabled: true });
        await harness.db.sources.createSource({ id: BRIDGE, name: 'Bridge', type: 'mqtt_bridge', config: {}, enabled: true });
        await harness.db.sources.createSource({ id: TCP, name: 'TCP', type: 'meshtastic_tcp', config: {}, enabled: true });
        await harness.db.sources.createSource({ id: MESHCORE_MQTT, name: 'MC MQTT', type: 'meshcore_mqtt', config: {}, enabled: true });

        await sourceManagerRegistry.addManager(makeFakeManager(BROKER, 'mqtt_broker'));
        await sourceManagerRegistry.addManager(makeFakeManager(BRIDGE, 'mqtt_bridge'));
        await sourceManagerRegistry.addManager(makeFakeManager(TCP, 'meshtastic_tcp'));
        await sourceManagerRegistry.addManager(makeFakeManager(MESHCORE_MQTT, 'meshcore_mqtt'));

        await harness.db.settings.setSourceSetting(BROKER, 'coverage_mqtt_enabled', '1');
      });

      afterEach(async () => {
        await sourceManagerRegistry.removeManager(BROKER).catch(() => {});
        await sourceManagerRegistry.removeManager(BRIDGE).catch(() => {});
        await sourceManagerRegistry.removeManager(TCP).catch(() => {});
        await sourceManagerRegistry.removeManager(MESHCORE_MQTT).catch(() => {});
        await harness.db.sources.deleteSource(BROKER).catch(() => {});
        await harness.db.sources.deleteSource(BRIDGE).catch(() => {});
        await harness.db.sources.deleteSource(TCP).catch(() => {});
        await harness.db.sources.deleteSource(MESHCORE_MQTT).catch(() => {});
        // Settings rows are namespaced by these fixed source ids and persist
        // in the singleton DB across tests — clear them so one test's write
        // (e.g. the 'true' string case) can't leak into the next.
        await harness.db.settings.deleteSourceSettings(BROKER).catch(() => {});
        await harness.db.settings.deleteSourceSettings(BRIDGE).catch(() => {});
        await harness.db.settings.deleteSetting('coverage_mqtt_enabled').catch(() => {});
      });

      it('lists only the MQTT broker/bridge sources — never TCP or MeshCore MQTT', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get('/receivers');
        expect(res.status).toBe(200);
        const ids = res.body.data.mqttSources.map((m: any) => m.sourceId).sort();
        expect(ids).toEqual([BRIDGE, BROKER].sort());
      });

      it('recordingEnabled reflects the per-source setting; absent defaults to false', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get('/receivers');
        const broker = res.body.data.mqttSources.find((m: any) => m.sourceId === BROKER);
        const bridge = res.body.data.mqttSources.find((m: any) => m.sourceId === BRIDGE);
        expect(broker.recordingEnabled).toBe(true);
        expect(bridge.recordingEnabled).toBe(false);
      });

      it("'true' string also reads as enabled", async () => {
        await harness.db.settings.setSourceSetting(BRIDGE, 'coverage_mqtt_enabled', 'true');
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get('/receivers');
        const bridge = res.body.data.mqttSources.find((m: any) => m.sourceId === BRIDGE);
        expect(bridge.recordingEnabled).toBe(true);
      });

      it('a global bare-key coverage_mqtt_enabled row never turns a source on (#5080 guard)', async () => {
        await harness.db.settings.setSetting('coverage_mqtt_enabled', '1');
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get('/receivers');
        const bridge = res.body.data.mqttSources.find((m: any) => m.sourceId === BRIDGE);
        expect(bridge.recordingEnabled).toBe(false);
      });

      it('a limited user with nodes:read on the broker only never sees the bridge status', async () => {
        await harness.grant(harness.limited.id, 'nodes', 'read', BROKER);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get('/receivers');
        const ids = res.body.data.mqttSources.map((m: any) => m.sourceId);
        expect(ids).toEqual([BROKER]);
      });

      it('listed even when the source has no receptions', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.get('/receivers?sources=' + BROKER);
        expect(res.body.data.receivers).toEqual([]);
        expect(res.body.data.mqttSources.map((m: any) => m.sourceId)).toEqual([BROKER]);
      });

      it('[] for an anonymous user with no grants', async () => {
        const agent = await harness.loginAs(null);
        const res = await agent.get('/receivers');
        expect(res.body.data.mqttSources).toEqual([]);
      });
    });
  });

  // ── GET /senders ─────────────────────────────────────────────────────────

  describe('GET /senders', () => {
    it('merges sender fix counts across permitted sources', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);

      await harness.db.nodes.upsertNode({
        nodeNum: SENDER_OK, nodeId: nodeIdFor(SENDER_OK), longName: 'Sender OK (B)', shortName: 'SO',
        channel: 0, lastHeard: nowSec(),
      } as any, harness.sourceB);
      await databaseService.coverageReceptions.recordReception({
        sourceId: harness.sourceB,
        protocol: 'meshtastic',
        receiverKind: 'local',
        receiverId: nodeIdFor(B_RECEIVER),
        receiverNodeNum: B_RECEIVER,
        senderId: nodeIdFor(SENDER_OK),
        senderNodeNum: SENDER_OK,
        packetKey: 'pkt-merge',
        pathKey: 'r0:h0',
        latitude: 1,
        longitude: 2,
        receivedAt: Date.now(),
      });

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/senders');
      expect(res.status).toBe(200);
      const sender = res.body.data.senders.find((s: any) => s.senderId === nodeIdFor(SENDER_OK));
      expect(sender).toBeDefined();
      // sourceA contributes 2 distinct fixes for SENDER_OK (pkt-ok, pkt-private-receiver);
      // sourceB contributes 1 (pkt-merge). Merged sum is an upper bound (documented).
      expect(sender.fixCount).toBe(3);
    });

    it('drops a hidden-from-map sender', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/senders');
      expect(res.body.data.senders.some((s: any) => s.senderId === nodeIdFor(SENDER_HIDDEN))).toBe(false);
    });

    it('400 INVALID_TIME_RANGE when until < since', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/senders?since=2000&until=1000');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TIME_RANGE');
    });

    it('anonymous with no grants gets an empty senders list', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/senders');
      expect(res.status).toBe(200);
      expect(res.body.data.senders).toEqual([]);
      expect(res.body.data.truncated).toBe(false);
    });
  });
});
