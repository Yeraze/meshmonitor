/**
 * getDirectNeighborRssiAsync per-source scoping (#4726).
 *
 * The method originally aggregated `packet_log` across every source, so a node
 * heard by a SECOND radio inflated the first radio's direct-neighbour stats —
 * the cross-source leak the per-source rule exists to prevent. The network
 * survey reports these as "who this radio hears directly", so an unscoped
 * answer is not merely imprecise, it is wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NeighborsRepository } from './neighbors.js';
import { PacketLogRepository } from './packetLog.js';
import { ALL_SOURCES } from './base.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';
const NODE = 0xaabbccdd;

let testDb: TestDb;
let neighbors: NeighborsRepository;
let packets: PacketLogRepository;

/** A zero-hop rx packet — hop_start === hop_limit is what "direct" means here. */
async function seedDirectPacket(sourceId: string, rssi: number) {
  await packets.insertPacketLog({
    timestamp: Date.now(),
    from_node: NODE,
    portnum: 1,
    encrypted: false,
    rssi,
    hop_limit: 3,
    hop_start: 3,
    direction: 'rx',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4726 fixture: DbPacketLog has many optional fields irrelevant here
  } as any, sourceId);
}

beforeEach(() => {
  testDb = createTestDb();
  neighbors = new NeighborsRepository(testDb.db, 'sqlite');
  packets = new PacketLogRepository(testDb.db, 'sqlite');
});
afterEach(() => testDb.close());

describe('getDirectNeighborRssiAsync scoping', () => {
  it('counts only the requested source\'s packets', async () => {
    await seedDirectPacket(SRC_A, -60);
    await seedDirectPacket(SRC_B, -61);
    await seedDirectPacket(SRC_B, -62);

    const a = await neighbors.getDirectNeighborRssiAsync(24, SRC_A);
    expect(a.get(NODE)?.packetCount).toBe(1);

    const b = await neighbors.getDirectNeighborRssiAsync(24, SRC_B);
    expect(b.get(NODE)?.packetCount).toBe(2);
  });

  it('reports nothing for a source that heard nothing', async () => {
    await seedDirectPacket(SRC_B, -60);
    expect((await neighbors.getDirectNeighborRssiAsync(24, SRC_A)).size).toBe(0);
  });

  it('still aggregates across sources when explicitly asked to', async () => {
    // ALL_SOURCES is the deliberate cross-source request, distinct from the
    // old implicit leak.
    await seedDirectPacket(SRC_A, -60);
    await seedDirectPacket(SRC_B, -61);
    expect((await neighbors.getDirectNeighborRssiAsync(24, ALL_SOURCES)).get(NODE)?.packetCount).toBe(2);
  });
});
