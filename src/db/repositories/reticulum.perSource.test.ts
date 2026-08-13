/**
 * Per-source isolation tests for ReticulumRepository (epic #3960, Phase 1a WP1).
 *
 * Verifies the composite (sourceId, destinationHash) / (sourceId,
 * interfaceName) keys truly isolate Reticulum data between sources — the
 * same physical destination/interface observed via two different sources
 * must produce two independent rows, and `list*`/`get*` must never leak the
 * other source's row. Also verifies withSourceScope's fail-closed behavior
 * on an empty sourceId (the #1 hard rule per CLAUDE.md).
 *
 * Uses `createTestDb()` — a real SQLite database built from the full
 * migration registry (migrations 140/141 create these tables) — rather than
 * hand-rolled DDL, so this test can never silently drift from the schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReticulumRepository, type UpsertDestinationInput, type UpsertInterfaceInput } from './reticulum.js';
import { ALL_SOURCES } from './base.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';

function makeDest(overrides: Partial<UpsertDestinationInput> = {}): UpsertDestinationInput {
  return {
    destinationHash: 'shared-hash-' + '0'.repeat(20),
    appName: 'lxmf.delivery',
    displayName: 'Shared Destination',
    ...overrides,
  };
}

function makeIface(overrides: Partial<UpsertInterfaceInput> = {}): UpsertInterfaceInput {
  return {
    interfaceName: 'shared-iface',
    status: 'up',
    online: true,
    txBytes: 0,
    rxBytes: 0,
    ...overrides,
  };
}

describe('ReticulumRepository - per-source isolation', () => {
  let testDb: TestDb;
  let repo: ReticulumRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ReticulumRepository(testDb.db, 'sqlite');
  });

  afterEach(() => {
    testDb.close();
  });

  describe('destinations', () => {
    it('same destinationHash under two sources produces two independent rows', async () => {
      await repo.upsertDestination(SRC_A, makeDest({ displayName: 'On A' }));
      await repo.upsertDestination(SRC_B, makeDest({ displayName: 'On B' }));

      const onA = await repo.getDestination(SRC_A, 'shared-hash-' + '0'.repeat(20));
      const onB = await repo.getDestination(SRC_B, 'shared-hash-' + '0'.repeat(20));
      expect(onA?.displayName).toBe('On A');
      expect(onB?.displayName).toBe('On B');
    });

    it('listDestinations(A) excludes B rows and vice versa', async () => {
      await repo.upsertDestination(SRC_A, makeDest({ destinationHash: 'hash-a1'.padEnd(32, '0') }));
      await repo.upsertDestination(SRC_A, makeDest({ destinationHash: 'hash-a2'.padEnd(32, '0') }));
      await repo.upsertDestination(SRC_B, makeDest({ destinationHash: 'hash-b1'.padEnd(32, '0') }));

      const onA = await repo.listDestinations(SRC_A);
      expect(onA.map((d) => d.destinationHash).sort()).toEqual(
        ['hash-a1'.padEnd(32, '0'), 'hash-a2'.padEnd(32, '0')].sort(),
      );

      const onB = await repo.listDestinations(SRC_B);
      expect(onB.map((d) => d.destinationHash)).toEqual(['hash-b1'.padEnd(32, '0')]);
    });

    it('upserting on source A does not affect the same destinationHash on source B', async () => {
      await repo.upsertDestination(SRC_A, makeDest({ rssi: -50 }));
      await repo.upsertDestination(SRC_B, makeDest({ rssi: -90 }));

      await repo.upsertDestination(SRC_A, makeDest({ rssi: -10 }));

      const onA = await repo.getDestination(SRC_A, 'shared-hash-' + '0'.repeat(20));
      const onB = await repo.getDestination(SRC_B, 'shared-hash-' + '0'.repeat(20));
      expect(onA?.rssi).toBe(-10);
      expect(onB?.rssi).toBe(-90);
      // Each source's independent upsert history is its own — A's second
      // upsert must not have bumped B's announceCount.
      expect(onA?.announceCount).toBe(2);
      expect(onB?.announceCount).toBe(1);
    });

    it('setDestinationFavorite(A) does not favorite the same hash on B', async () => {
      await repo.upsertDestination(SRC_A, makeDest());
      await repo.upsertDestination(SRC_B, makeDest());

      await repo.setDestinationFavorite(SRC_A, 'shared-hash-' + '0'.repeat(20), true);

      expect((await repo.getDestination(SRC_A, 'shared-hash-' + '0'.repeat(20)))?.isFavorite).toBe(true);
      expect((await repo.getDestination(SRC_B, 'shared-hash-' + '0'.repeat(20)))?.isFavorite).toBe(false);
    });

    it('listDestinations(ALL_SOURCES) returns rows from every source in one query', async () => {
      await repo.upsertDestination(SRC_A, makeDest({ destinationHash: 'hash-a1'.padEnd(32, '0') }));
      await repo.upsertDestination(SRC_B, makeDest({ destinationHash: 'hash-b1'.padEnd(32, '0') }));

      const all = await repo.listDestinations(ALL_SOURCES);
      expect(all.map((d) => d.destinationHash).sort()).toEqual(
        ['hash-a1'.padEnd(32, '0'), 'hash-b1'.padEnd(32, '0')].sort(),
      );
      expect(new Set(all.map((d) => d.sourceId))).toEqual(new Set([SRC_A, SRC_B]));
    });

    it('listDestinations throws on an empty sourceId (withSourceScope fail-closed)', async () => {
      await expect(repo.listDestinations('')).rejects.toThrow(/sourceId is required/);
    });

    it('upsertDestination throws on an empty sourceId', async () => {
      await expect(repo.upsertDestination('', makeDest())).rejects.toThrow(/requires a sourceId/);
    });
  });

  describe('interfaces', () => {
    it('same interfaceName under two sources produces two independent rows', async () => {
      await repo.upsertInterface(SRC_A, makeIface({ txBytes: 100 }));
      await repo.upsertInterface(SRC_B, makeIface({ txBytes: 200 }));

      const onA = await repo.getInterface(SRC_A, 'shared-iface');
      const onB = await repo.getInterface(SRC_B, 'shared-iface');
      expect(onA?.txBytes).toBe(100);
      expect(onB?.txBytes).toBe(200);
    });

    it('listInterfaces(A) excludes B rows and vice versa', async () => {
      await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'iface-a1' }));
      await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'iface-a2' }));
      await repo.upsertInterface(SRC_B, makeIface({ interfaceName: 'iface-b1' }));

      const onA = await repo.listInterfaces(SRC_A);
      expect(onA.map((i) => i.interfaceName).sort()).toEqual(['iface-a1', 'iface-a2']);

      const onB = await repo.listInterfaces(SRC_B);
      expect(onB.map((i) => i.interfaceName)).toEqual(['iface-b1']);
    });

    it('upserting on source A does not affect the same interfaceName on source B', async () => {
      await repo.upsertInterface(SRC_A, makeIface({ status: 'up', txBytes: 1 }));
      await repo.upsertInterface(SRC_B, makeIface({ status: 'up', txBytes: 2 }));

      await repo.upsertInterface(SRC_A, makeIface({ status: 'down', txBytes: 999 }));

      expect((await repo.getInterface(SRC_A, 'shared-iface'))?.status).toBe('down');
      expect((await repo.getInterface(SRC_A, 'shared-iface'))?.txBytes).toBe(999);
      // B's row must be untouched by A's second upsert.
      expect((await repo.getInterface(SRC_B, 'shared-iface'))?.status).toBe('up');
      expect((await repo.getInterface(SRC_B, 'shared-iface'))?.txBytes).toBe(2);
    });

    it('listInterfaces(ALL_SOURCES) returns rows from every source in one query', async () => {
      await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'iface-a1' }));
      await repo.upsertInterface(SRC_B, makeIface({ interfaceName: 'iface-b1' }));

      const all = await repo.listInterfaces(ALL_SOURCES);
      expect(all.map((i) => i.interfaceName).sort()).toEqual(['iface-a1', 'iface-b1']);
      expect(new Set(all.map((i) => i.sourceId))).toEqual(new Set([SRC_A, SRC_B]));
    });

    it('listInterfaces throws on an empty sourceId (withSourceScope fail-closed)', async () => {
      await expect(repo.listInterfaces('')).rejects.toThrow(/sourceId is required/);
    });

    it('upsertInterface throws on an empty sourceId', async () => {
      await expect(repo.upsertInterface('', makeIface())).rejects.toThrow(/requires a sourceId/);
    });
  });
});
