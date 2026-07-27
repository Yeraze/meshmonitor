/**
 * Tests for the durable `ok_to_mqtt` violation write path — WP4 of
 * MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(d)/§2(f.1) (#4114). Runs against a real
 * in-memory SQLite database (via `createTestDb()`) so dedupe and retention
 * immunity are proven by real SQL, not a mocked repo.
 *
 * See spec §4.5.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema/index.js';
import { createTestDb } from './test-helpers/testDb.js';
import { MqttPacketLogRepository } from '../db/repositories/mqttPacketLog.js';
import { MqttOkToMqttViolationsRepository } from '../db/repositories/mqttOkToMqttViolations.js';

const settingsStore: Record<string, string> = {};

let mqttPacketLogRepo: MqttPacketLogRepository;
let violationsRepo: MqttOkToMqttViolationsRepository;

vi.mock('../services/database.js', () => ({
  default: {
    getSettingAsync: vi.fn(async (key: string) => settingsStore[key] ?? null),
    get mqttPacketLog() {
      return mqttPacketLogRepo;
    },
    get mqttOkToMqttViolations() {
      return violationsRepo;
    },
  },
}));

import mqttPacketLogService, { buildViolationRow, buildMqttPacketLogRow } from './services/mqttPacketLogService.js';
import type { ServiceEnvelopeShape } from './mqttPacketFilter.js';

const OUR_NODE_NUM = 0x99999999;
const ORIGINATOR_NUM = 0x11111111;

function envelope(overrides: Partial<{
  gatewayId: string | null;
  fromNode: number;
  bitfield: number | undefined;
  packetId: number;
}> = {}): ServiceEnvelopeShape {
  const { gatewayId = '!22222222', fromNode = ORIGINATOR_NUM, bitfield, packetId = 0x12345678 } = overrides;
  return {
    channelId: 'LongFast',
    gatewayId: gatewayId ?? undefined,
    packet: {
      id: packetId,
      from: fromNode,
      to: 0xffffffff,
      channel: 8,
      decoded: {
        portnum: 1,
        payload: new TextEncoder().encode('hello'),
        ...(bitfield !== undefined ? { bitfield } : {}),
      },
    },
  };
}

const okResult = { ingested: true as const, portnum: 1 };

describe('mqttPacketLogService — ok_to_mqtt violation writes (#4114)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    mqttPacketLogRepo = new MqttPacketLogRepository(drizzleDb, 'sqlite');
    violationsRepo = new MqttOkToMqttViolationsRepository(drizzleDb, 'sqlite');
    for (const key of Object.keys(settingsStore)) delete settingsStore[key];
    mqttPacketLogService.resetEnabledCache();
    mqttPacketLogService.resetViolationEnabledCache();
  });

  afterEach(() => {
    db.close();
  });

  async function countViolations(sourceId = 'src-a'): Promise<number> {
    return violationsRepo.getRowCount({ sourceId });
  }

  it('writes a violation row even while mqtt_packet_log_enabled is off (independence, §2(d))', async () => {
    // Packet log explicitly disabled; violation kill switch left unset (default ON).
    delete settingsStore['mqtt_packet_log_enabled'];
    const env = envelope({ gatewayId: '!22222222', fromNode: ORIGINATOR_NUM, bitfield: 0 });

    await mqttPacketLogService.logEnvelope('src-a', env, okResult);

    expect(await countViolations()).toBe(1);
    const packets = await mqttPacketLogRepo.getReceptions('src-a', env.packet!.id!, ORIGINATOR_NUM);
    expect(packets.length).toBe(0); // packet log itself stayed empty
  });

  it('does NOT write a violation row when the kill switch is explicitly off (=== "0")', async () => {
    settingsStore['mqtt_oktomqtt_violation_log_enabled'] = '0';
    const env = envelope({ gatewayId: '!22222222', fromNode: ORIGINATOR_NUM, bitfield: 0 });

    await mqttPacketLogService.logEnvelope('src-a', env, okResult);

    expect(await countViolations()).toBe(0);
  });

  it('does NOT write a violation row for originator self-publish (gatewayNodeNum === fromNode, bit 0)', async () => {
    const env = envelope({ gatewayId: '!11111111', fromNode: ORIGINATOR_NUM, bitfield: 0 });

    await mqttPacketLogService.logEnvelope('src-a', env, okResult);

    expect(await countViolations()).toBe(0);
  });

  describe('self-gateway guard (§2(f.1)) — REQUIRED', () => {
    it('never writes a violation row when gatewayId is our own local node, even with bit 0', async () => {
      const env = envelope({
        gatewayId: `!${OUR_NODE_NUM.toString(16).padStart(8, '0')}`,
        fromNode: ORIGINATOR_NUM, // different from OUR_NODE_NUM — shape of a genuine violation otherwise
        bitfield: 0,
      });

      await mqttPacketLogService.logEnvelope('src-a', env, okResult, undefined, OUR_NODE_NUM);

      expect(await countViolations()).toBe(0);
    });

    it('complement: same envelope with localGatewayNodeNum omitted DOES write a row (residual exposure, documented)', async () => {
      const env = envelope({
        gatewayId: `!${OUR_NODE_NUM.toString(16).padStart(8, '0')}`,
        fromNode: ORIGINATOR_NUM,
        bitfield: 0,
      });

      await mqttPacketLogService.logEnvelope('src-a', env, okResult); // no localGatewayNodeNum

      expect(await countViolations()).toBe(1);
    });

    it('complement: localGatewayNodeNum set but not matching still flags a normal violation', async () => {
      const env = envelope({ gatewayId: '!22222222', fromNode: ORIGINATOR_NUM, bitfield: 0 });

      await mqttPacketLogService.logEnvelope('src-a', env, okResult, undefined, OUR_NODE_NUM);

      expect(await countViolations()).toBe(1);
    });
  });

  it('does NOT write a violation row when gatewayId is malformed', async () => {
    const env = envelope({ gatewayId: 'not-a-gateway-id', fromNode: ORIGINATOR_NUM, bitfield: 0 });

    await mqttPacketLogService.logEnvelope('src-a', env, okResult);

    expect(await countViolations()).toBe(0);
  });

  it('does NOT write a violation row when fromNode is missing', async () => {
    const env: ServiceEnvelopeShape = {
      channelId: 'LongFast',
      gatewayId: '!22222222',
      packet: {
        id: 1,
        to: 0xffffffff,
        channel: 8,
        decoded: { portnum: 1, payload: new TextEncoder().encode('hi'), bitfield: 0 },
      } as any,
    };

    await mqttPacketLogService.logEnvelope('src-a', env, okResult);

    expect(await countViolations()).toBe(0);
  });

  it('an unknown-bitfield relayed reception writes NO violation row (only the packet-log row, when enabled)', async () => {
    settingsStore['mqtt_packet_log_enabled'] = '1';
    mqttPacketLogService.resetEnabledCache();
    const env = envelope({ gatewayId: '!22222222', fromNode: ORIGINATOR_NUM }); // no bitfield at all

    await mqttPacketLogService.logEnvelope('src-a', env, okResult);

    expect(await countViolations()).toBe(0);
    const packets = await mqttPacketLogRepo.getReceptions('src-a', env.packet!.id!, ORIGINATOR_NUM);
    expect(packets.length).toBe(1);
    expect(packets[0].bitfield).toBeNull();
    expect(packets[0].okToMqttViolation).toBe(0);
  });

  it('buildViolationRow projects field-for-field from its DbMqttPacket source', () => {
    const env = envelope({ gatewayId: '!22222222', fromNode: ORIGINATOR_NUM, bitfield: 0 });
    const row = buildMqttPacketLogRow('src-a', env, okResult, 'msh/US/2/e/LongFast/!22222222');
    expect(row).not.toBeNull();
    const v = buildViolationRow(row!);
    expect(v.sourceId).toBe(row!.sourceId);
    expect(v.packetId).toBe(row!.packetId);
    expect(v.fromNode).toBe(row!.fromNode);
    expect(v.fromNodeId).toBe(row!.fromNodeId);
    expect(v.gatewayId).toBe(row!.gatewayId);
    expect(v.gatewayNodeNum).toBe(row!.gatewayNodeNum);
    expect(v.channelId).toBe(row!.channelId);
    expect(v.portnum).toBe(row!.portnum);
    expect(v.portnumName).toBe(row!.portnumName);
    expect(v.bitfield).toBe(row!.bitfield);
    expect(v.topic).toBe(row!.topic);
    expect(v.rxTime).toBe(row!.rxTime);
    expect(v.timestamp).toBe(row!.timestamp);
    expect(v.createdAt).toBe(row!.createdAt);
  });

  it('duplicate ingest of the same reception results in exactly one stored violation row', async () => {
    const env = envelope({ gatewayId: '!22222222', fromNode: ORIGINATOR_NUM, bitfield: 0, packetId: 0xaabbccdd });

    await mqttPacketLogService.logEnvelope('src-a', env, okResult);
    await mqttPacketLogService.logEnvelope('src-a', env, okResult);
    await mqttPacketLogService.logEnvelope('src-a', env, okResult);

    expect(await countViolations()).toBe(1);
  });

  it('runCleanup() invokes both retention phases using the violation-specific cutoff/cap', async () => {
    settingsStore['mqtt_oktomqtt_violation_retention_days'] = '1';
    settingsStore['mqtt_oktomqtt_violation_max_count'] = '2';

    // Insert 3 violations, one deliberately old (older than the 1-day cutoff).
    const now = Date.now();
    await violationsRepo.insertViolation({
      sourceId: 'src-a', packetId: 1, fromNode: 1, gatewayId: '!aaaaaaaa', gatewayNodeNum: 0xaaaaaaaa,
      timestamp: now - 5 * 24 * 60 * 60 * 1000, createdAt: now - 5 * 24 * 60 * 60 * 1000,
    });
    await violationsRepo.insertViolation({
      sourceId: 'src-a', packetId: 2, fromNode: 2, gatewayId: '!bbbbbbbb', gatewayNodeNum: 0xbbbbbbbb,
      timestamp: now, createdAt: now,
    });
    await violationsRepo.insertViolation({
      sourceId: 'src-a', packetId: 3, fromNode: 3, gatewayId: '!cccccccc', gatewayNodeNum: 0xcccccccc,
      timestamp: now, createdAt: now,
    });

    expect(await countViolations()).toBe(3);
    await mqttPacketLogService.runCleanup();
    // The 5-day-old row is trimmed by the age cutoff; the max-count cap (2)
    // is already satisfied by the remaining two rows.
    expect(await countViolations()).toBe(2);
  });

  it('retention immunity: violation rows survive mqttPacketLog.deletePacketsOlderThan + deleteAllPackets', async () => {
    const env = envelope({ gatewayId: '!22222222', fromNode: ORIGINATOR_NUM, bitfield: 0 });
    settingsStore['mqtt_packet_log_enabled'] = '1';
    mqttPacketLogService.resetEnabledCache();

    await mqttPacketLogService.logEnvelope('src-a', env, okResult);
    expect(await countViolations()).toBe(1);

    await mqttPacketLogRepo.deletePacketsOlderThan(Date.now() + 1_000_000);
    await mqttPacketLogRepo.deleteAllPackets();

    expect(await countViolations()).toBe(1);
  });
});
