/**
 * Analysis Routes — ok_to_mqtt violation detection endpoints (#4114)
 *
 * Covers GET /mqtt-violations/gateways and GET /mqtt-violations/packets.
 * Uses the real-middleware `createRouteTestApp` harness (not the deprecated
 * `vi.mock('../../services/database.js')` monkey-patch pattern) so that
 * cross-source permission isolation is proven by real `checkPermissionAsync`
 * SQL rather than a hand-rolled lambda. Do NOT modify the legacy
 * `analysisRoutes.test.ts` — it is a separate, pre-existing file covering
 * `/positions` et al. and converts opportunistically, not in this phase.
 *
 * See docs/internal/dev-notes/MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(e)/§3.17/§4.12.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import analysisRoutes from './analysisRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import mqttPacketLogService from '../services/mqttPacketLogService.js';
import type { DbMqttOkToMqttViolation } from '../../db/repositories/mqttOkToMqttViolations.js';
import type { DbMqttPacket } from '../../db/repositories/mqttPacketLog.js';

const T0 = 1_753_300_000_000;

function makeViolation(overrides: Partial<DbMqttOkToMqttViolation> & { sourceId: string }): DbMqttOkToMqttViolation {
  return {
    packetId: 1,
    fromNode: 0xaaaaaaaa,
    fromNodeId: '!aaaaaaaa',
    gatewayId: '!11111111',
    gatewayNodeNum: 0x11111111,
    channelId: 'LongFast',
    portnum: 1,
    portnumName: 'TEXT_MESSAGE_APP',
    bitfield: 0,
    topic: 'msh/US/2/e/LongFast/!11111111',
    rxTime: T0 - 100,
    timestamp: T0,
    createdAt: T0,
    ...overrides,
  };
}

function makeSuspectedPacket(overrides: Partial<DbMqttPacket> & { sourceId: string }): DbMqttPacket {
  return {
    packetId: 9001,
    fromNode: 0xdddddddd,
    fromNodeId: '!dddddddd',
    gatewayId: '!44444444',
    gatewayNodeNum: 0x44444444,
    channelId: 'LongFast',
    portnum: 1,
    portnumName: 'TEXT_MESSAGE_APP',
    encrypted: 1,
    ingestOutcome: 'encrypted',
    okToMqttViolation: 0,
    bitfield: null, // unreadable ⇒ "suspected", not confirmed
    topic: 'msh/US/2/e/LongFast/!44444444',
    rxTime: T0 - 100,
    timestamp: T0,
    createdAt: T0,
    ...overrides,
  };
}

describe('analysisRoutes — GET /mqtt-violations/gateways', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', analysisRoutes) });
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);

    // sourceA: gateway !11111111 sees 2 violations from 2 distinct originators;
    // gateway !33333333 sees 1 violation. sourceB: gateway !22222222 sees 1 violation.
    await harness.db.mqttOkToMqttViolations.insertViolation(
      makeViolation({ sourceId: harness.sourceA, packetId: 1001, fromNode: 0xaaaaaaaa, fromNodeId: '!aaaaaaaa', timestamp: T0 }),
    );
    await harness.db.mqttOkToMqttViolations.insertViolation(
      makeViolation({ sourceId: harness.sourceA, packetId: 1002, fromNode: 0xbbbbbbbb, fromNodeId: '!bbbbbbbb', timestamp: T0 + 1000 }),
    );
    await harness.db.mqttOkToMqttViolations.insertViolation(
      makeViolation({
        sourceId: harness.sourceA,
        packetId: 1003,
        fromNode: 0xeeeeeeee,
        fromNodeId: '!eeeeeeee',
        gatewayId: '!33333333',
        gatewayNodeNum: 0x33333333,
        timestamp: T0 + 500,
      }),
    );
    await harness.db.mqttOkToMqttViolations.insertViolation(
      makeViolation({
        sourceId: harness.sourceB,
        packetId: 2001,
        fromNode: 0xcccccccc,
        fromNodeId: '!cccccccc',
        gatewayId: '!22222222',
        gatewayNodeNum: 0x22222222,
        timestamp: T0 + 500,
      }),
    );
  });

  afterEach(async () => {
    await harness.db.mqttOkToMqttViolations.deleteAllViolations(harness.sourceA);
    await harness.db.mqttOkToMqttViolations.deleteAllViolations(harness.sourceB);
    await harness.db.mqttPacketLog.deleteAllPackets(harness.sourceA);
    await harness.db.mqttPacketLog.deleteAllPackets(harness.sourceB);
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '0');
    mqttPacketLogService.resetEnabledCache();
    await harness.cleanup();
  });

  it('admin sees gateways across both sources', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0');
    expect(res.status).toBe(200);
    const gatewayIds = res.body.data.gateways.map((g: any) => g.gatewayId).sort();
    expect(gatewayIds).toEqual(['!11111111', '!22222222', '!33333333']);
    expect(res.body.data.sources.sort()).toEqual([harness.sourceA, harness.sourceB].sort());
  });

  it('limited user (granted sourceA only) sees only sourceA gateways — real SQL enforcement', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/mqtt-violations/gateways?since=0');
    expect(res.status).toBe(200);
    const gatewayIds = res.body.data.gateways.map((g: any) => g.gatewayId).sort();
    expect(gatewayIds).toEqual(['!11111111', '!33333333']);
    expect(res.body.data.sources).toEqual([harness.sourceA]);
  });

  it('anonymous / ungranted user gets 200 with empty gateways and sources', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/mqtt-violations/gateways?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.gateways).toEqual([]);
    expect(res.body.data.sources).toEqual([]);
  });

  it('?sources= intersects with the permitted set and cannot widen it', async () => {
    const agent = await harness.loginAs(harness.limited);
    // limited is granted sourceA only; requesting sourceB must not leak sourceB data.
    const res = await agent.get(`/mqtt-violations/gateways?since=0&sources=${harness.sourceB}`);
    expect(res.status).toBe(200);
    expect(res.body.data.gateways).toEqual([]);
    expect(res.body.data.sources).toEqual([]);
  });

  it('envelope shape is exactly { success: true, data: {...} }', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0');
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.gateways).toBeInstanceOf(Array);
    expect(typeof res.body.data.total).toBe('number');
  });

  it('sorts by violationCount desc by default', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0');
    const counts = res.body.data.gateways.map((g: any) => g.violationCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(res.body.data.gateways[0].gatewayId).toBe('!11111111');
  });

  it('sorts by violationCount asc when dir=asc', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&dir=asc');
    const counts = res.body.data.gateways.map((g: any) => g.violationCount);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('sorts by gatewayId', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&sort=gatewayId&dir=asc');
    const ids = res.body.data.gateways.map((g: any) => g.gatewayId);
    expect(ids).toEqual([...ids].sort());
  });

  it('unknown sort field ⇒ 400 INVALID_SORT_FIELD', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&sort=bogus');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SORT_FIELD');
    expect(res.body.success).toBe(false);
  });

  it('unknown sort direction ⇒ 400 INVALID_SORT_DIRECTION', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&dir=sideways');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SORT_DIRECTION');
  });

  it('since > until ⇒ 400 INVALID_RANGE', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/mqtt-violations/gateways?since=${T0 + 10_000}&until=${T0}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RANGE');
  });

  it('paginates with limit/offset and reports total', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&limit=1&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data.gateways.length).toBe(1);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.limit).toBe(1);
    expect(res.body.data.offset).toBe(0);

    const res2 = await agent.get('/mqtt-violations/gateways?since=0&limit=1&offset=1');
    expect(res2.body.data.gateways.length).toBe(1);
    expect(res2.body.data.gateways[0].gatewayId).not.toBe(res.body.data.gateways[0].gatewayId);
  });

  it('a negative offset is clamped to 0 rather than passed through', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&limit=10&offset=-5');
    expect(res.status).toBe(200);
    expect(res.body.data.offset).toBe(0);
    expect(res.body.data.gateways.length).toBe(3);
  });

  it('lookbackDays clamps to 1..365 and is ignored when since is explicit', async () => {
    const agent = await harness.loginAs(harness.admin);
    // lookbackDays=99999 would clamp to 365; explicit since=0 must win regardless.
    const res = await agent.get('/mqtt-violations/gateways?since=0&lookbackDays=99999');
    expect(res.status).toBe(200);
    expect(res.body.data.since).toBe(0);
  });

  it('includeUnknown=false (default): suspectedCount is 0 on every row and the packet-log path is not queried', async () => {
    // Seed a suspected-only gateway in mqtt_packet_log; it must not appear at all
    // when includeUnknown is false.
    await harness.db.mqttPacketLog.insertPacket(makeSuspectedPacket({ sourceId: harness.sourceA }));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0');
    expect(res.status).toBe(200);
    for (const g of res.body.data.gateways) {
      expect(g.suspectedCount).toBe(0);
    }
    expect(res.body.data.gateways.some((g: any) => g.gatewayId === '!44444444')).toBe(false);
    expect(res.body.data.suspectedAvailable).toBe(false);
    expect(res.body.data.suspectedWindowMs).toBe(0);
  });

  it('includeUnknown=true with mqtt_packet_log_enabled off ⇒ suspectedAvailable: false', async () => {
    await harness.db.mqttPacketLog.insertPacket(makeSuspectedPacket({ sourceId: harness.sourceA }));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&includeUnknown=true');
    expect(res.status).toBe(200);
    expect(res.body.data.suspectedAvailable).toBe(false);
    // Suspected-only gateway must not be merged in when the packet monitor is off.
    expect(res.body.data.gateways.some((g: any) => g.gatewayId === '!44444444')).toBe(false);
  });

  it('includeUnknown=true with mqtt_packet_log_enabled on ⇒ suspected gateway merged in, with its sourceIds populated', async () => {
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '1');
    mqttPacketLogService.resetEnabledCache();
    await harness.db.mqttPacketLog.insertPacket(makeSuspectedPacket({ sourceId: harness.sourceA }));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&includeUnknown=true');
    expect(res.status).toBe(200);
    expect(res.body.data.suspectedAvailable).toBe(true);
    expect(res.body.data.suspectedWindowMs).toBeGreaterThan(0);
    const suspectedGw = res.body.data.gateways.find((g: any) => g.gatewayId === '!44444444');
    expect(suspectedGw).toBeDefined();
    expect(suspectedGw.violationCount).toBe(0);
    expect(suspectedGw.suspectedCount).toBe(1);
    // Regression (#4114 code review): a gateway seen ONLY in the suspected set
    // (mqtt_packet_log) must still report which source it was observed on —
    // it must not silently fall back to an empty sourceIds array.
    expect(suspectedGw.sourceIds).toEqual([harness.sourceA]);
  });

  it('a gateway present in BOTH the confirmed and suspected sets merges counts without one overwriting the other, and spans firstSeen/lastSeen', async () => {
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '1');
    mqttPacketLogService.resetEnabledCache();

    // Confirmed violation on !11111111 at T0 (seeded in beforeEach: !11111111
    // already carries 2 confirmed violations at T0 and T0+1000).
    // Add a suspected (bitfield-unreadable) reception from the SAME gateway,
    // outside that confirmed window on both ends, so the merged firstSeen/
    // lastSeen must span both signals rather than reporting only the
    // confirmed side's.
    await harness.db.mqttPacketLog.insertPacket(
      makeSuspectedPacket({
        sourceId: harness.sourceA,
        packetId: 9099,
        fromNode: 0xffffffff,
        fromNodeId: '!ffffffff',
        gatewayId: '!11111111',
        gatewayNodeNum: 0x11111111,
        timestamp: T0 - 5000, // earlier than the confirmed rows' T0
      }),
    );
    await harness.db.mqttPacketLog.insertPacket(
      makeSuspectedPacket({
        sourceId: harness.sourceA,
        packetId: 9100,
        fromNode: 0xffffffff,
        fromNodeId: '!ffffffff',
        gatewayId: '!11111111',
        gatewayNodeNum: 0x11111111,
        timestamp: T0 + 6000, // later than the confirmed rows' T0+1000
      }),
    );

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&includeUnknown=true');
    expect(res.status).toBe(200);
    const gw = res.body.data.gateways.find((g: any) => g.gatewayId === '!11111111');
    expect(gw).toBeDefined();
    // Confirmed count (2 rows seeded in beforeEach) must survive the merge...
    expect(gw.violationCount).toBe(2);
    // ...and the suspected count (2 rows seeded above) must be added, not
    // overwrite the confirmed count.
    expect(gw.suspectedCount).toBe(2);
    // firstSeen/lastSeen must span BOTH the confirmed rows (T0..T0+1000) and
    // the suspected rows (T0-5000..T0+6000) — not just the confirmed side.
    expect(gw.firstSeen).toBe(T0 - 5000);
    expect(gw.lastSeen).toBe(T0 + 6000);
    expect(gw.sourceIds).toEqual([harness.sourceA]);
  });

  // ── #4330: capApplied / scanCap contract + the sourceIds trap ──────────

  it('#4330: capApplied is false and scanCap is 2000 on the default (includeUnknown=false) path', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.capApplied).toBe(false);
    expect(res.body.data.scanCap).toBe(2000);
  });

  it('#4330: sourceIds is populated per gateway on the default path (the merge-skip trap)', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.gateways.length).toBeGreaterThan(0);
    for (const g of res.body.data.gateways) {
      expect(Array.isArray(g.sourceIds)).toBe(true);
      expect(g.sourceIds.length).toBeGreaterThan(0);
    }
    const gw1 = res.body.data.gateways.find((g: any) => g.gatewayId === '!11111111');
    expect(gw1.sourceIds).toEqual([harness.sourceA]);
  });

  it('#4330: includeUnknown=true reports capApplied=false when the pre-merge fetch does not saturate', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&includeUnknown=true');
    expect(res.status).toBe(200);
    expect(res.body.data.capApplied).toBe(false);
    expect(res.body.data.scanCap).toBe(2000);
  });
});

describe('analysisRoutes — GET /mqtt-violations/gateways — pagination beyond the 2000-row cap (#4330)', () => {
  let harness: RouteTestHarness;
  const TOTAL_GATEWAYS = 2100;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', analysisRoutes) });
    // Each violation carries a distinct gatewayId/gatewayNodeNum, so the
    // per-gateway summary groups into TOTAL_GATEWAYS rows — well past the
    // old hardcoded 2000-row cap.
    const inserts: Promise<void>[] = [];
    for (let i = 0; i < TOTAL_GATEWAYS; i++) {
      const gatewayNodeNum = 0x50000000 + i;
      const gatewayId = `!${gatewayNodeNum.toString(16).padStart(8, '0')}`;
      inserts.push(
        harness.db.mqttOkToMqttViolations.insertViolation(
          makeViolation({
            sourceId: harness.sourceA,
            packetId: 5000 + i,
            fromNode: 0xaaaaaaaa,
            fromNodeId: '!aaaaaaaa',
            gatewayId,
            gatewayNodeNum,
            timestamp: T0 + i,
          }),
        ),
      );
    }
    await Promise.all(inserts);
  }, 30_000);

  afterEach(async () => {
    await harness.db.mqttOkToMqttViolations.deleteAllViolations(harness.sourceA);
    await harness.cleanup();
  }, 30_000);

  it('#4330: total is exact beyond the cap and capApplied is false on the default path', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&limit=50&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(TOTAL_GATEWAYS);
    expect(res.body.data.capApplied).toBe(false);
    expect(res.body.data.scanCap).toBe(2000);
  });

  it('#4330 regression: offset beyond 2000 returns real, non-empty rows', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&limit=500&offset=2050');
    expect(res.status).toBe(200);
    expect(res.body.data.gateways.length).toBe(TOTAL_GATEWAYS - 2050);
    expect(res.body.data.total).toBe(TOTAL_GATEWAYS);
  });

  it('#4330 regression: ascending sort by lastSeen returns the earliest groups first, not just the tail of a truncated scan', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&sort=lastSeen&dir=asc&limit=5&offset=0');
    expect(res.status).toBe(200);
    const lastSeens = res.body.data.gateways.map((g: any) => g.lastSeen);
    expect(lastSeens).toEqual([...lastSeens].sort((a, b) => a - b));
    // i=0 inserted at T0 — the true earliest. The old bug would only ever
    // sort within whatever subset of rows the hardcoded 2000-row confirmed
    // fetch happened to retain, which could omit this row entirely.
    expect(lastSeens[0]).toBe(T0);
  });

  it('#4330: includeUnknown=true reports capApplied=true once the confirmed pre-merge fetch saturates', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/gateways?since=0&includeUnknown=true&limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data.capApplied).toBe(true);
    expect(res.body.data.scanCap).toBe(2000);
  });
});

describe('analysisRoutes — GET /mqtt-violations/packets', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', analysisRoutes) });
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);

    await harness.db.mqttOkToMqttViolations.insertViolation(
      makeViolation({ sourceId: harness.sourceA, packetId: 1001, fromNode: 0xaaaaaaaa, fromNodeId: '!aaaaaaaa', timestamp: T0 }),
    );
    await harness.db.mqttOkToMqttViolations.insertViolation(
      makeViolation({
        sourceId: harness.sourceA,
        packetId: 1002,
        fromNode: 0xbbbbbbbb,
        fromNodeId: '!bbbbbbbb',
        gatewayId: '!33333333',
        gatewayNodeNum: 0x33333333,
        timestamp: T0 + 1000,
      }),
    );
    await harness.db.mqttOkToMqttViolations.insertViolation(
      makeViolation({
        sourceId: harness.sourceB,
        packetId: 2001,
        fromNode: 0xcccccccc,
        fromNodeId: '!cccccccc',
        gatewayId: '!22222222',
        gatewayNodeNum: 0x22222222,
        timestamp: T0 + 500,
      }),
    );
  });

  afterEach(async () => {
    await harness.db.mqttOkToMqttViolations.deleteAllViolations(harness.sourceA);
    await harness.db.mqttOkToMqttViolations.deleteAllViolations(harness.sourceB);
    await harness.db.mqttPacketLog.deleteAllPackets(harness.sourceA);
    await harness.db.mqttPacketLog.deleteAllPackets(harness.sourceB);
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '0');
    mqttPacketLogService.resetEnabledCache();
    await harness.cleanup();
  });

  it('admin sees violations across both sources, kind: confirmed', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.violations.length).toBe(3);
    for (const v of res.body.data.violations) {
      expect(v.kind).toBe('confirmed');
    }
  });

  it('limited user sees only sourceA violations', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/mqtt-violations/packets?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.violations.length).toBe(2);
    expect(res.body.data.violations.every((v: any) => v.sourceId === harness.sourceA)).toBe(true);
  });

  it('anonymous ⇒ 200 with empty violations', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/mqtt-violations/packets?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.violations).toEqual([]);
  });

  it('?gateway= filters to one gateway', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&gateway=!33333333');
    expect(res.status).toBe(200);
    expect(res.body.data.violations.length).toBe(1);
    expect(res.body.data.violations[0].gatewayId).toBe('!33333333');
    expect(res.body.data.gateway).toBe('!33333333');
  });

  it('unknown sort field ⇒ 400 INVALID_SORT_FIELD', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&sort=bogus');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SORT_FIELD');
  });

  it('unknown sort direction ⇒ 400 INVALID_SORT_DIRECTION', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&dir=up');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SORT_DIRECTION');
  });

  it('since > until ⇒ 400 INVALID_RANGE', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/mqtt-violations/packets?since=${T0 + 10_000}&until=${T0}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RANGE');
  });

  it('paginates with limit/offset and reports total', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&limit=1&offset=0');
    expect(res.body.data.violations.length).toBe(1);
    expect(res.body.data.total).toBe(3);
  });

  it('a negative offset is clamped to 0 rather than passed through', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&limit=10&offset=-5');
    expect(res.status).toBe(200);
    expect(res.body.data.offset).toBe(0);
    expect(res.body.data.violations.length).toBe(3);
  });

  it('includeUnknown=true with mqtt_packet_log_enabled on merges suspected rows with kind: suspected', async () => {
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '1');
    mqttPacketLogService.resetEnabledCache();
    await harness.db.mqttPacketLog.insertPacket(makeSuspectedPacket({ sourceId: harness.sourceA, packetId: 9001 }));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&includeUnknown=true');
    expect(res.status).toBe(200);
    expect(res.body.data.suspectedAvailable).toBe(true);
    const suspected = res.body.data.violations.filter((v: any) => v.kind === 'suspected');
    expect(suspected.length).toBe(1);
    expect(suspected[0].gatewayId).toBe('!44444444');
  });

  it('includeUnknown=false does not include suspected rows even when packet log is enabled', async () => {
    await harness.db.settings.setSetting('mqtt_packet_log_enabled', '1');
    mqttPacketLogService.resetEnabledCache();
    await harness.db.mqttPacketLog.insertPacket(makeSuspectedPacket({ sourceId: harness.sourceA, packetId: 9002 }));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.violations.every((v: any) => v.kind === 'confirmed')).toBe(true);
  });

  // ── #4330: capApplied / scanCap contract ────────────────────────────────

  it('#4330: capApplied is false and scanCap is 2000 on the default (includeUnknown=false) path', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.capApplied).toBe(false);
    expect(res.body.data.scanCap).toBe(2000);
  });

  it('#4330: includeUnknown=true reports capApplied=false when the pre-merge fetch does not saturate', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&includeUnknown=true');
    expect(res.status).toBe(200);
    expect(res.body.data.capApplied).toBe(false);
    expect(res.body.data.scanCap).toBe(2000);
  });
});

describe('analysisRoutes — GET /mqtt-violations/packets — pagination beyond the 2000-row cap (#4330)', () => {
  let harness: RouteTestHarness;
  const TOTAL_VIOLATIONS = 2100;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', analysisRoutes) });
    const inserts: Promise<void>[] = [];
    for (let i = 0; i < TOTAL_VIOLATIONS; i++) {
      inserts.push(
        harness.db.mqttOkToMqttViolations.insertViolation(
          makeViolation({
            sourceId: harness.sourceA,
            packetId: 6000 + i,
            fromNode: 0xaaaaaaaa,
            fromNodeId: '!aaaaaaaa',
            timestamp: T0 + i,
          }),
        ),
      );
    }
    await Promise.all(inserts);
  }, 30_000);

  afterEach(async () => {
    await harness.db.mqttOkToMqttViolations.deleteAllViolations(harness.sourceA);
    await harness.cleanup();
  }, 30_000);

  it('#4330: total is exact beyond the cap and capApplied is false on the default path', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&limit=50&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(TOTAL_VIOLATIONS);
    expect(res.body.data.capApplied).toBe(false);
    expect(res.body.data.scanCap).toBe(2000);
  });

  it('#4330 regression: offset beyond 2000 returns real, non-empty rows', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&limit=500&offset=2050');
    expect(res.status).toBe(200);
    expect(res.body.data.violations.length).toBe(TOTAL_VIOLATIONS - 2050);
    expect(res.body.data.total).toBe(TOTAL_VIOLATIONS);
  });

  it('#4330 regression: ascending sort by timestamp returns the oldest rows first, not just the tail of a truncated scan', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&sort=timestamp&dir=asc&limit=5&offset=0');
    expect(res.status).toBe(200);
    const timestamps = res.body.data.violations.map((v: any) => v.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(timestamps[0]).toBe(T0);
  });

  it('#4330: includeUnknown=true reports capApplied=true once the confirmed pre-merge fetch saturates', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/mqtt-violations/packets?since=0&includeUnknown=true&limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data.capApplied).toBe(true);
    expect(res.body.data.scanCap).toBe(2000);
  });
});
