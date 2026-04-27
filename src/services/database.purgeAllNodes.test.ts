/**
 * Integration tests for DatabaseService.purgeAllNodesAsync (#2637)
 *
 * Builds a real DatabaseService singleton against in-memory SQLite
 * (real Drizzle, real repositories, real migrations) so we exercise
 * the full purge path end-to-end and prove that packet_log is wiped
 * along with nodes, messages, telemetry, traceroutes, and neighbors.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

// ─── Mock environment to point at in-memory SQLite ────────────────────────────

const mockGetEnvironmentConfig = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    databasePath: ':memory:',
    databasePathProvided: true,
    baseUrl: '/',
    port: 8080,
    debug: false,
    mqttUrl: null,
    mqttUsername: null,
    mqttPassword: null,
    mqttChannelKey: null,
    mqttTopicPrefix: 'msh',
    mqttEnabled: false,
    mapboxToken: null,
    mapTilerKey: null,
    sessionSecret: 'test-secret',
    allowedOrigins: [],
    retroactiveDecryptionBatchSize: 100,
    oidcEnabled: false,
    oidcIssuerUrl: null,
    oidcClientId: null,
    oidcClientSecret: null,
    oidcRedirectUri: null,
    oidcDisplayName: 'OIDC',
  })
);

vi.mock('../server/config/environment.js', () => ({
  getEnvironmentConfig: mockGetEnvironmentConfig,
  resetEnvironmentConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Import the real singleton AFTER mocks ───────────────────────────────────

import databaseService from './database.js';

describe('DatabaseService.purgeAllNodesAsync — packet_log integration (#2637)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    // Async repo init may complete slightly after waitForReady on SQLite path;
    // ensure miscRepo is ready before we exercise it.
    for (let i = 0; i < 50 && !databaseService.miscRepo; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it('clears packet_log alongside nodes when purgeAllNodesAsync runs', async () => {
    expect(databaseService.miscRepo).not.toBeNull();
    expect(databaseService.nodesRepo).not.toBeNull();

    // Seed two real nodes via the public sync API
    databaseService.upsertNode({ nodeNum: 1001, nodeId: '!000003e9', longName: 'Alpha', shortName: 'A' });
    databaseService.upsertNode({ nodeNum: 1002, nodeId: '!000003ea', longName: 'Beta', shortName: 'B' });

    // Seed packet_log rows directly via the underlying SQLite connection.
    // Bypasses insertPacketLogAsync's `packet_log_enabled` gate which is off
    // by default in a fresh in-memory DB.
    const rawDb = (databaseService as any).db;
    const now = Date.now();
    rawDb.exec(`
      INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, encrypted, direction, created_at)
      VALUES
        (1, ${now},     1001, '!000003e9', 1002, '!000003ea', 1, 0, 'rx', ${now}),
        (2, ${now + 1}, 1002, '!000003ea', 1001, '!000003e9', 3, 0, 'rx', ${now + 1});
    `);

    const beforeCount = await databaseService.getPacketLogCountAsync();
    expect(beforeCount).toBe(2);

    // Exercise the actual code path under test
    await databaseService.purgeAllNodesAsync();

    // packet_log must be empty — this is the #2637 regression assertion
    const afterCount = await databaseService.getPacketLogCountAsync();
    expect(afterCount).toBe(0);

    // Nodes must be gone (the broadcast node ffffffff/4294967295 may persist;
    // assert our seeded user nodes specifically are gone)
    const remainingNodes = databaseService.getAllNodes();
    expect(remainingNodes.find((n: any) => n.nodeNum === 1001)).toBeUndefined();
    expect(remainingNodes.find((n: any) => n.nodeNum === 1002)).toBeUndefined();
  });
});
