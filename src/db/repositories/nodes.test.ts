/**
 * Multi-Database Nodes Repository Tests
 *
 * Validates NodesRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { NodesRepository } from './nodes.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';

// SQL for creating the nodes table per backend
const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS nodes (
    nodeNum INTEGER NOT NULL,
    nodeId TEXT NOT NULL,
    longName TEXT,
    shortName TEXT,
    hwModel INTEGER,
    role INTEGER,
    hopsAway INTEGER,
    lastMessageHops INTEGER,
    viaMqtt INTEGER DEFAULT 0,
    macaddr TEXT,
    latitude REAL,
    longitude REAL,
    altitude REAL,
    batteryLevel INTEGER,
    voltage REAL,
    channelUtilization REAL,
    airUtilTx REAL,
    lastHeard INTEGER,
    snr REAL,
    rssi INTEGER,
    lastTracerouteRequest INTEGER,
    firmwareVersion TEXT,
    channel INTEGER,
    isFavorite INTEGER DEFAULT 0,
    favoriteLocked INTEGER DEFAULT 0,
    isIgnored INTEGER DEFAULT 0,
    mobile INTEGER DEFAULT 0,
    rebootCount INTEGER,
    publicKey TEXT,
    lastMeshReceivedKey TEXT,
    hasPKC INTEGER,
    lastPKIPacket INTEGER,
    keyIsLowEntropy INTEGER,
    duplicateKeyDetected INTEGER,
    keyMismatchDetected INTEGER,
    keySecurityIssueDetails TEXT,
    isExcessivePackets INTEGER DEFAULT 0,
    packetRatePerHour INTEGER,
    packetRateLastChecked INTEGER,
    isTimeOffsetIssue INTEGER DEFAULT 0,
    timeOffsetSeconds INTEGER,
    welcomedAt INTEGER,
    positionChannel INTEGER,
    positionPrecisionBits INTEGER,
    positionGpsAccuracy REAL,
    positionHdop REAL,
    positionTimestamp INTEGER,
    positionOverrideEnabled INTEGER DEFAULT 0,
    latitudeOverride REAL,
    longitudeOverride REAL,
    altitudeOverride REAL,
    positionOverrideIsPrivate INTEGER DEFAULT 0,
    hasRemoteAdmin INTEGER DEFAULT 0,
    lastRemoteAdminCheck INTEGER,
    remoteAdminMetadata TEXT,
    lastTimeSync INTEGER,
    isStoreForwardServer INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    sourceId TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS nodes CASCADE;
  CREATE TABLE nodes (
    "nodeNum" BIGINT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "longName" TEXT,
    "shortName" TEXT,
    "hwModel" INTEGER,
    "role" INTEGER,
    "hopsAway" INTEGER,
    "lastMessageHops" INTEGER,
    "viaMqtt" BOOLEAN DEFAULT FALSE,
    "macaddr" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "altitude" REAL,
    "batteryLevel" INTEGER,
    "voltage" REAL,
    "channelUtilization" REAL,
    "airUtilTx" REAL,
    "lastHeard" BIGINT,
    "snr" REAL,
    "rssi" INTEGER,
    "lastTracerouteRequest" BIGINT,
    "firmwareVersion" TEXT,
    "channel" INTEGER,
    "isFavorite" BOOLEAN DEFAULT FALSE,
    "favoriteLocked" BOOLEAN DEFAULT FALSE,
    "isIgnored" BOOLEAN DEFAULT FALSE,
    "mobile" INTEGER DEFAULT 0,
    "rebootCount" INTEGER,
    "publicKey" TEXT,
    "lastMeshReceivedKey" TEXT,
    "hasPKC" BOOLEAN,
    "lastPKIPacket" BIGINT,
    "keyIsLowEntropy" BOOLEAN,
    "duplicateKeyDetected" BOOLEAN,
    "keyMismatchDetected" BOOLEAN,
    "keySecurityIssueDetails" TEXT,
    "isExcessivePackets" BOOLEAN DEFAULT FALSE,
    "packetRatePerHour" INTEGER,
    "packetRateLastChecked" BIGINT,
    "isTimeOffsetIssue" BOOLEAN DEFAULT FALSE,
    "timeOffsetSeconds" INTEGER,
    "welcomedAt" BIGINT,
    "positionChannel" INTEGER,
    "positionPrecisionBits" INTEGER,
    "positionGpsAccuracy" REAL,
    "positionHdop" REAL,
    "positionTimestamp" BIGINT,
    "positionOverrideEnabled" BOOLEAN DEFAULT FALSE,
    "latitudeOverride" REAL,
    "longitudeOverride" REAL,
    "altitudeOverride" REAL,
    "positionOverrideIsPrivate" BOOLEAN DEFAULT FALSE,
    "hasRemoteAdmin" BOOLEAN DEFAULT FALSE,
    "lastRemoteAdminCheck" BIGINT,
    "remoteAdminMetadata" TEXT,
    "lastTimeSync" BIGINT,
    "isStoreForwardServer" BOOLEAN DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY ("nodeNum", "sourceId")
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS nodes;
  CREATE TABLE nodes (
    nodeNum BIGINT NOT NULL,
    nodeId VARCHAR(255) NOT NULL,
    longName VARCHAR(255),
    shortName VARCHAR(255),
    hwModel INTEGER,
    \`role\` INTEGER,
    hopsAway INTEGER,
    lastMessageHops INTEGER,
    viaMqtt BOOLEAN DEFAULT FALSE,
    macaddr VARCHAR(255),
    latitude DOUBLE,
    longitude DOUBLE,
    altitude DOUBLE,
    batteryLevel INTEGER,
    voltage DOUBLE,
    channelUtilization DOUBLE,
    airUtilTx DOUBLE,
    lastHeard BIGINT,
    snr DOUBLE,
    rssi INTEGER,
    lastTracerouteRequest BIGINT,
    firmwareVersion VARCHAR(255),
    channel INTEGER,
    isFavorite BOOLEAN DEFAULT FALSE,
    favoriteLocked BOOLEAN DEFAULT FALSE,
    isIgnored BOOLEAN DEFAULT FALSE,
    mobile INTEGER DEFAULT 0,
    rebootCount INTEGER,
    publicKey TEXT,
    lastMeshReceivedKey TEXT,
    hasPKC BOOLEAN,
    lastPKIPacket BIGINT,
    keyIsLowEntropy BOOLEAN,
    duplicateKeyDetected BOOLEAN,
    keyMismatchDetected BOOLEAN,
    keySecurityIssueDetails TEXT,
    isExcessivePackets BOOLEAN DEFAULT FALSE,
    packetRatePerHour INTEGER,
    packetRateLastChecked BIGINT,
    isTimeOffsetIssue BOOLEAN DEFAULT FALSE,
    timeOffsetSeconds INTEGER,
    welcomedAt BIGINT,
    positionChannel INTEGER,
    positionPrecisionBits INTEGER,
    positionGpsAccuracy DOUBLE,
    positionHdop DOUBLE,
    positionTimestamp BIGINT,
    positionOverrideEnabled BOOLEAN DEFAULT FALSE,
    latitudeOverride DOUBLE,
    longitudeOverride DOUBLE,
    altitudeOverride DOUBLE,
    positionOverrideIsPrivate BOOLEAN DEFAULT FALSE,
    hasRemoteAdmin BOOLEAN DEFAULT FALSE,
    lastRemoteAdminCheck BIGINT,
    remoteAdminMetadata TEXT,
    lastTimeSync BIGINT,
    isStoreForwardServer BOOLEAN DEFAULT FALSE,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    sourceId VARCHAR(36) NOT NULL DEFAULT 'default',
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

/**
 * Helper to create a minimal valid node for testing
 */
function makeNode(nodeNum: number, overrides: Record<string, any> = {}) {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    ...overrides,
  };
}

/**
 * Shared test suite that runs against any backend.
 */
function runNodesTests(getBackend: () => TestBackend) {
  let repo: NodesRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new NodesRepository(backend.drizzleDb, backend.dbType);
  });

  // --- upsertNode ---

  it('upsertNode - inserts a new node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(100));
    const node = await repo.getNode(100);
    expect(node).not.toBeNull();
    expect(node!.nodeNum).toBe(100);
    expect(node!.longName).toBe('Node 100');
    expect(node!.shortName).toBe('N100');
  });

  it('upsertNode - updates existing node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(200, { longName: 'Original' }));
    await repo.upsertNode(makeNode(200, { longName: 'Updated' }));
    const node = await repo.getNode(200);
    expect(node).not.toBeNull();
    expect(node!.longName).toBe('Updated');
  });

  it('upsertNode - ignores missing nodeNum or nodeId', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Missing nodeNum
    await repo.upsertNode({ nodeId: '!abc' } as any);
    // Missing nodeId
    await repo.upsertNode({ nodeNum: 1 } as any);

    const count = await repo.getNodeCount();
    expect(count).toBe(0);
  });

  // --- getNode ---

  it('getNode - returns null for missing node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const result = await repo.getNode(999999);
    expect(result).toBeNull();
  });

  // --- getNodeByNodeId ---

  it('getNodeByNodeId - finds node by hex ID string', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const nodeId = '!deadbeef';
    await repo.upsertNode(makeNode(300, { nodeId }));

    const result = await repo.getNodeByNodeId(nodeId);
    expect(result).not.toBeNull();
    expect(result!.nodeNum).toBe(300);
    expect(result!.nodeId).toBe(nodeId);
  });

  it('getNodeByNodeId - returns null for unknown nodeId', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const result = await repo.getNodeByNodeId('!00000000');
    expect(result).toBeNull();
  });

  // --- getNodesByNums ---

  it('getNodesByNums - returns map of matching nodes', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(400));
    await repo.upsertNode(makeNode(401));
    await repo.upsertNode(makeNode(402));

    const map = await repo.getNodesByNums([400, 402, 999]);
    expect(map.size).toBe(2);
    expect(map.has(400)).toBe(true);
    expect(map.has(402)).toBe(true);
    expect(map.has(999)).toBe(false);
  });

  it('getNodesByNums - returns empty map for empty input', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const map = await repo.getNodesByNums([]);
    expect(map.size).toBe(0);
  });

  // --- getAllNodes / getNodeCount ---

  it('getAllNodes - returns all inserted nodes', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(500));
    await repo.upsertNode(makeNode(501));
    await repo.upsertNode(makeNode(502));

    const all = await repo.getAllNodes();
    expect(all.length).toBe(3);
  });

  it('getNodeCount - returns correct count', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.getNodeCount()).toBe(0);

    await repo.upsertNode(makeNode(600));
    await repo.upsertNode(makeNode(601));
    expect(await repo.getNodeCount()).toBe(2);
  });

  it('getDistinctNodeCount - dedupes nodes shared across sources (issue #2805)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.getDistinctNodeCount(['src-a', 'src-b'])).toBe(0);

    // Two sources with one node in common (610) — distinct count must be 3,
    // not 4. The previous Unified card formula summed per-source counts and
    // would have returned 4 here.
    await repo.upsertNode(makeNode(610), 'src-a');
    await repo.upsertNode(makeNode(611), 'src-a');
    await repo.upsertNode(makeNode(610), 'src-b');
    await repo.upsertNode(makeNode(612), 'src-b');

    expect(await repo.getDistinctNodeCount(['src-a'])).toBe(2);
    expect(await repo.getDistinctNodeCount(['src-b'])).toBe(2);
    expect(await repo.getDistinctNodeCount(['src-a', 'src-b'])).toBe(3);
  });

  it('getDistinctNodeCount - returns 0 for empty source list', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }
    expect(await repo.getDistinctNodeCount([])).toBe(0);
  });

  // --- updateNodeSecurityFlags ---

  it('updateNodeSecurityFlags - sets duplicate key flag and details', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(700), 'test-src');
    await repo.updateNodeSecurityFlags(700, true, 'Key shared with Node 701', 'test-src');

    const node = await repo.getNode(700, 'test-src');
    expect(node).not.toBeNull();
    expect(node!.duplicateKeyDetected).toBe(true);
    expect(node!.keySecurityIssueDetails).toBe('Key shared with Node 701');
  });

  it('updateNodeSecurityFlags - clears details when not provided', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(701), 'test-src');
    await repo.updateNodeSecurityFlags(701, true, 'Some details', 'test-src');
    await repo.updateNodeSecurityFlags(701, false, undefined, 'test-src');

    const node = await repo.getNode(701, 'test-src');
    expect(node!.duplicateKeyDetected).toBe(false);
    expect(node!.keySecurityIssueDetails).toBeNull();
  });

  // --- updateNodeLowEntropyFlag ---

  it('updateNodeLowEntropyFlag - sets low entropy flag', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(710), 'test-src');
    await repo.updateNodeLowEntropyFlag(710, true, 'Known low-entropy key', 'test-src');

    const node = await repo.getNode(710, 'test-src');
    expect(node!.keyIsLowEntropy).toBe(true);
    expect(node!.keySecurityIssueDetails).toBe('Known low-entropy key');
  });

  it('updateNodeLowEntropyFlag - does nothing for nonexistent node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Should not throw
    await repo.updateNodeLowEntropyFlag(99999, true, 'details', 'test-src');
    const node = await repo.getNode(99999, 'test-src');
    expect(node).toBeNull();
  });

  // --- setNodeFavorite ---

  it('setNodeFavorite - toggles favorite status', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(800), 'default');

    await repo.setNodeFavorite(800, true, 'default');
    let node = await repo.getNode(800);
    expect(node!.isFavorite).toBe(true);

    await repo.setNodeFavorite(800, false, 'default');
    node = await repo.getNode(800);
    expect(node!.isFavorite).toBe(false);
  });

  it('setNodeFavorite - also sets favoriteLocked when provided', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(801), 'default');
    await repo.setNodeFavorite(801, true, 'default', true);

    const node = await repo.getNode(801);
    expect(node!.isFavorite).toBe(true);
    expect(node!.favoriteLocked).toBe(true);
  });

  it('upsertNode - preserves isFavorite when favoriteLocked=true (regression #2743)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(802), 'default');
    await repo.setNodeFavorite(802, true, 'default', true);

    // Simulate a NodeInfo sync from the device reporting isFavorite=false
    await repo.upsertNode({ ...makeNode(802), isFavorite: false }, 'default');

    const node = await repo.getNode(802);
    expect(node!.isFavorite).toBe(true);
    expect(node!.favoriteLocked).toBe(true);
  });

  it('upsertNode - allows isFavorite change when favoriteLocked=false', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(803), 'default');
    await repo.setNodeFavorite(803, true, 'default', false);

    await repo.upsertNode({ ...makeNode(803), isFavorite: false }, 'default');

    const node = await repo.getNode(803);
    expect(node!.isFavorite).toBe(false);
  });

  it('upsertNode - preserves positionOverride columns across updates (regression #2743)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode({
      ...makeNode(804),
      positionOverrideEnabled: true,
      latitudeOverride: 12.34,
      longitudeOverride: 56.78,
      altitudeOverride: 100,
      positionOverrideIsPrivate: false,
    } as any, 'default');

    // Simulate a mesh position packet that updates raw lat/lon but carries no override fields
    await repo.upsertNode({
      ...makeNode(804),
      latitude: 1.0,
      longitude: 2.0,
      altitude: 50,
    }, 'default');

    const node = await repo.getNode(804) as any;
    expect(node!.positionOverrideEnabled).toBe(true);
    expect(Number(node!.latitudeOverride)).toBeCloseTo(12.34);
    expect(Number(node!.longitudeOverride)).toBeCloseTo(56.78);
    expect(Number(node!.altitudeOverride)).toBe(100);
  });

  // --- setNodeIgnored ---

  it('setNodeIgnored - toggles ignored status', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(900), 'default');

    await repo.setNodeIgnored(900, true, 'default');
    let node = await repo.getNode(900);
    expect(node!.isIgnored).toBe(true);

    await repo.setNodeIgnored(900, false, 'default');
    node = await repo.getNode(900);
    expect(node!.isIgnored).toBe(false);
  });

  // --- deleteNodeRecord ---

  it('deleteNodeRecord - deletes existing node and returns true', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(1000), 'default');
    const deleted = await repo.deleteNodeRecord(1000, 'default');
    expect(deleted).toBe(true);
    expect(await repo.getNode(1000)).toBeNull();
  });

  it('deleteNodeRecord - returns false for nonexistent node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const deleted = await repo.deleteNodeRecord(99999, 'default');
    expect(deleted).toBe(false);
  });

  // --- cleanupInactiveNodes ---

  it('cleanupInactiveNodes - removes old nodes, keeps recent and ignored', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    // Old node (lastHeard far in the past - cleanupInactiveNodes uses millisecond cutoff via this.now())
    const oldTime = now - (60 * 24 * 60 * 60 * 1000); // 60 days ago in ms
    await repo.upsertNode(makeNode(1100, { lastHeard: oldTime }), 'default');

    // Recent node
    const recentTime = now - (1 * 24 * 60 * 60 * 1000); // 1 day ago in ms
    await repo.upsertNode(makeNode(1101, { lastHeard: recentTime }), 'default');

    // Old but ignored node (should NOT be deleted)
    await repo.upsertNode(makeNode(1102, { lastHeard: oldTime }), 'default');
    await repo.setNodeIgnored(1102, true, 'default');

    // Node with null lastHeard (should be deleted)
    await repo.upsertNode(makeNode(1103), 'default');

    const deletedCount = await repo.cleanupInactiveNodes(30);
    // Should delete node 1100 (old) and 1103 (null lastHeard), keep 1101 (recent) and 1102 (ignored)
    expect(deletedCount).toBe(2);
    expect(await repo.getNode(1100)).toBeNull();
    expect(await repo.getNode(1101)).not.toBeNull();
    expect(await repo.getNode(1102)).not.toBeNull();
    expect(await repo.getNode(1103)).toBeNull();
  });

  // --- markAllNodesAsWelcomed ---

  it('markAllNodesAsWelcomed - sets welcomedAt for all unwelcomed nodes', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(1200));
    await repo.upsertNode(makeNode(1201));
    // Pre-welcomed node
    await repo.upsertNode(makeNode(1202, { welcomedAt: Date.now() }));

    const count = await repo.markAllNodesAsWelcomed();
    // Only 1200 and 1201 were unwelcomed
    expect(count).toBe(2);

    const node1200 = await repo.getNode(1200);
    expect(node1200!.welcomedAt).not.toBeNull();
    const node1202 = await repo.getNode(1202);
    expect(node1202!.welcomedAt).not.toBeNull();
  });

  // --- markNodeAsWelcomedIfNotAlready ---

  it('markNodeAsWelcomedIfNotAlready - welcomes unwelcomed node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const nodeId = '!00001300';
    await repo.upsertNode(makeNode(1300, { nodeId }), 'test-src');

    const result = await repo.markNodeAsWelcomedIfNotAlready(1300, nodeId, 'test-src');
    expect(result).toBe(true);

    const node = await repo.getNode(1300, 'test-src');
    expect(node!.welcomedAt).not.toBeNull();
  });

  it('markNodeAsWelcomedIfNotAlready - returns false for already welcomed node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const nodeId = '!00001301';
    await repo.upsertNode(makeNode(1301, { nodeId, welcomedAt: Date.now() }), 'test-src');

    const result = await repo.markNodeAsWelcomedIfNotAlready(1301, nodeId, 'test-src');
    expect(result).toBe(false);
  });

  // --- deleteAllNodes ---

  it('deleteAllNodes - removes all nodes and returns count', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(1400));
    await repo.upsertNode(makeNode(1401));
    await repo.upsertNode(makeNode(1402));

    const count = await repo.deleteAllNodes();
    expect(count).toBe(3);
    expect(await repo.getNodeCount()).toBe(0);
  });

  // --- updateNodeMessageHops ---

  it('updateNodeMessageHops - sets lastMessageHops', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(1500), 'test-src');
    await repo.updateNodeMessageHops(1500, 3, 'test-src');

    const node = await repo.getNode(1500, 'test-src');
    expect(node!.lastMessageHops).toBe(3);
  });

  // --- getNodesWithPublicKeys ---

  it('getNodesWithPublicKeys - returns only nodes with non-empty publicKey', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(1600, { publicKey: 'abc123' }));
    await repo.upsertNode(makeNode(1601, { publicKey: '' }));
    await repo.upsertNode(makeNode(1602)); // null publicKey

    const result = await repo.getNodesWithPublicKeys();
    expect(result.length).toBe(1);
    expect(Number(result[0].nodeNum)).toBe(1600);
    expect(result[0].publicKey).toBe('abc123');
  });

  // --- upsertNode with position data ---

  it('upsertNode - stores and retrieves position data', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertNode(makeNode(1700, {
      latitude: 40.7128,
      longitude: -74.006,
      altitude: 10.5,
    }));

    const node = await repo.getNode(1700);
    expect(node).not.toBeNull();
    expect(node!.latitude).toBeCloseTo(40.7128, 3);
    expect(node!.longitude).toBeCloseTo(-74.006, 3);
    expect(node!.altitude).toBeCloseTo(10.5, 1);
  });

  // --- Large nodeNum (unsigned 32-bit) ---

  it('upsertNode - handles large unsigned 32-bit nodeNum', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const largeNum = 4294967295; // max unsigned 32-bit
    await repo.upsertNode(makeNode(largeNum));

    const node = await repo.getNode(largeNum);
    expect(node).not.toBeNull();
    expect(node!.nodeNum).toBe(largeNum);
  });
}

// --- SQLite Backend ---
describe('NodesRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runNodesTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('NodesRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('PostgreSQL connection established for nodes tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'nodes');
  });

  runNodesTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('NodesRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('MySQL connection established for nodes tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'nodes');
  });

  runNodesTests(() => backend);
});
