#!/usr/bin/env node
/**
 * PostgreSQL Connection Test Script
 *
 * Tests the PostgreSQL driver and repositories to ensure they work correctly.
 *
 * Usage:
 *   npx tsx src/cli/test-postgres.ts
 */

import { createPostgresDriver } from '../db/drivers/postgres.js';
import { SettingsRepository } from '../db/repositories/settings.js';
import { NodesRepository } from '../db/repositories/nodes.js';
import { MessagesRepository } from '../db/repositories/messages.js';

const POSTGRES_URL = process.env.DATABASE_URL || 'postgres://meshmonitor:meshmonitor_dev@localhost:5432/meshmonitor';

async function createSchema(pool: import('pg').Pool): Promise<void> {
  console.log('📋 Creating PostgreSQL schema...');

  const client = await pool.connect();

  try {
    // Create tables matching Drizzle schema
    await client.query(`
      -- Settings table (matches Drizzle schema)
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL
      );

      -- Nodes table (matches Drizzle schema - core fields only)
      CREATE TABLE IF NOT EXISTS nodes (
        "nodeNum" INTEGER PRIMARY KEY,
        "nodeId" TEXT NOT NULL UNIQUE,
        "longName" TEXT,
        "shortName" TEXT,
        "hwModel" INTEGER,
        "role" INTEGER,
        "hopsAway" INTEGER,
        "lastMessageHops" INTEGER,
        "viaMqtt" BOOLEAN DEFAULT false,
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
        "isFavorite" BOOLEAN DEFAULT false,
        "isIgnored" BOOLEAN DEFAULT false,
        "mobile" INTEGER DEFAULT 0,
        "rebootCount" INTEGER,
        "publicKey" TEXT,
        "hasPKC" BOOLEAN DEFAULT false,
        "lastPKIPacket" BIGINT,
        "keyIsLowEntropy" BOOLEAN DEFAULT false,
        "duplicateKeyDetected" BOOLEAN DEFAULT false,
        "keyMismatchDetected" BOOLEAN DEFAULT false,
        "keySecurityIssueDetails" TEXT,
        "welcomedAt" BIGINT,
        "positionChannel" INTEGER,
        "positionPrecisionBits" INTEGER,
        "positionGpsAccuracy" INTEGER,
        "positionHdop" REAL,
        "positionTimestamp" BIGINT,
        "positionOverrideEnabled" BOOLEAN DEFAULT false,
        "latitudeOverride" REAL,
        "longitudeOverride" REAL,
        "altitudeOverride" REAL,
        "positionOverrideIsPrivate" BOOLEAN DEFAULT false,
        "createdAt" BIGINT,
        "updatedAt" BIGINT
      );

      -- Messages table (matches Drizzle schema)
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        "fromNodeNum" INTEGER,
        "toNodeNum" INTEGER,
        "fromNodeId" TEXT NOT NULL,
        "toNodeId" TEXT,
        "text" TEXT,
        "channel" INTEGER,
        "portnum" INTEGER,
        "requestId" INTEGER,
        "timestamp" BIGINT NOT NULL,
        "rxTime" BIGINT,
        "hopStart" INTEGER,
        "hopLimit" INTEGER,
        "relayNode" INTEGER,
        "replyId" TEXT,
        "emoji" INTEGER,
        "viaMqtt" BOOLEAN DEFAULT false,
        "rxSnr" REAL,
        "rxRssi" INTEGER,
        "ackFailed" BOOLEAN DEFAULT false,
        "routingErrorReceived" INTEGER,
        "deliveryState" TEXT,
        "wantAck" BOOLEAN DEFAULT false,
        "ackFromNode" INTEGER,
        "createdAt" BIGINT
      );
    `);

    console.log('✅ Schema created');
  } finally {
    client.release();
  }
}

async function cleanupTables(pool: import('pg').Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM messages');
    await client.query('DELETE FROM nodes');
    await client.query('DELETE FROM settings');
  } finally {
    client.release();
  }
}

async function testSettings(settingsRepo: SettingsRepository): Promise<boolean> {
  console.log('\n🧪 Testing SettingsRepository...');

  try {
    // Test set and get
    await settingsRepo.setSetting('test_key', 'test_value');
    const value = await settingsRepo.getSetting('test_key');

    if (value !== 'test_value') {
      console.error(`  ❌ Expected 'test_value', got '${value}'`);
      return false;
    }
    console.log('  ✅ setSetting/getSetting works');

    // Test update
    await settingsRepo.setSetting('test_key', 'updated_value');
    const updated = await settingsRepo.getSetting('test_key');

    if (updated !== 'updated_value') {
      console.error(`  ❌ Update failed: expected 'updated_value', got '${updated}'`);
      return false;
    }
    console.log('  ✅ Setting update works');

    // Test getAllSettings
    await settingsRepo.setSetting('key1', 'value1');
    await settingsRepo.setSetting('key2', 'value2');
    const all = await settingsRepo.getAllSettings();

    if (Object.keys(all).length < 3) {
      console.error(`  ❌ getAllSettings returned ${Object.keys(all).length} settings, expected at least 3`);
      return false;
    }
    console.log('  ✅ getAllSettings works');

    return true;
  } catch (error) {
    console.error('  ❌ Settings test error:', (error as Error).message);
    return false;
  }
}

async function testNodes(nodesRepo: NodesRepository): Promise<boolean> {
  console.log('\n🧪 Testing NodesRepository...');

  try {
    const now = Date.now();

    // Test upsert
    await nodesRepo.upsertNode({
      nodeNum: 12345678,
      nodeId: '!test1234',
      longName: 'Test Node',
      shortName: 'TEST',
      hwModel: 1,
      lastHeard: now,
      createdAt: now,
      updatedAt: now,
    });
    console.log('  ✅ upsertNode works');

    // Test getNode
    const node = await nodesRepo.getNode(12345678);
    if (!node || node.nodeId !== '!test1234') {
      console.error(`  ❌ getNode failed: ${JSON.stringify(node)}`);
      return false;
    }
    console.log('  ✅ getNode works');

    // Test getAllNodes
    const allNodes = await nodesRepo.getAllNodes();
    if (allNodes.length < 1) {
      console.error(`  ❌ getAllNodes returned ${allNodes.length} nodes, expected at least 1`);
      return false;
    }
    console.log('  ✅ getAllNodes works');

    // Test getNodeCount
    const count = await nodesRepo.getNodeCount();
    if (count < 1) {
      console.error(`  ❌ getNodeCount returned ${count}, expected at least 1`);
      return false;
    }
    console.log('  ✅ getNodeCount works');

    return true;
  } catch (error) {
    console.error('  ❌ Nodes test error:', (error as Error).message);
    return false;
  }
}

async function testMessages(messagesRepo: MessagesRepository): Promise<boolean> {
  console.log('\n🧪 Testing MessagesRepository...');

  try {
    const now = Date.now();

    // Test insertMessage
    await messagesRepo.insertMessage({
      id: 'test-msg-1',
      fromNodeNum: 12345678,
      toNodeNum: 0xFFFFFFFF, // broadcast
      fromNodeId: '!test1234',
      toNodeId: '!broadcast',
      channel: 0,
      text: 'Hello, World!',
      timestamp: now,
      createdAt: now,
    });
    console.log('  ✅ insertMessage works');

    // Test getMessage
    const msg = await messagesRepo.getMessage('test-msg-1');
    // Note: Drizzle schema uses 'text' field, not 'message'
    if (!msg || msg.fromNodeId !== '!test1234') {
      console.error(`  ❌ getMessage failed: ${JSON.stringify(msg)}`);
      return false;
    }
    console.log('  ✅ getMessage works');

    // Test getMessages
    const messages = await messagesRepo.getMessages(10, 0);
    if (messages.length < 1) {
      console.error(`  ❌ getMessages returned ${messages.length} messages, expected at least 1`);
      return false;
    }
    console.log('  ✅ getMessages works');

    // Test getMessageCount
    const count = await messagesRepo.getMessageCount();
    if (count < 1) {
      console.error(`  ❌ getMessageCount returned ${count}, expected at least 1`);
      return false;
    }
    console.log('  ✅ getMessageCount works');

    return true;
  } catch (error) {
    console.error('  ❌ Messages test error:', (error as Error).message);
    return false;
  }
}

async function main(): Promise<void> {
  console.log('\n🐘 PostgreSQL Connection Test\n');
  console.log('━'.repeat(50));
  console.log(`Connecting to: ${POSTGRES_URL.replace(/:[^:@]+@/, ':****@')}`);

  let pool: import('pg').Pool | null = null;

  try {
    // Connect to PostgreSQL
    const { db, pool: dbPool } = await createPostgresDriver({
      connectionString: POSTGRES_URL,
    });
    pool = dbPool;

    console.log('✅ Connected to PostgreSQL\n');

    // Create schema
    await createSchema(pool);

    // Clean up existing test data
    await cleanupTables(pool);

    // Initialize repositories
    const settingsRepo = new SettingsRepository(db, 'postgres');
    const nodesRepo = new NodesRepository(db, 'postgres');
    const messagesRepo = new MessagesRepository(db, 'postgres');

    // Run tests
    const results = {
      settings: await testSettings(settingsRepo),
      nodes: await testNodes(nodesRepo),
      messages: await testMessages(messagesRepo),
    };

    // Summary
    console.log('\n' + '━'.repeat(50));
    console.log('\n📊 Test Results:\n');

    const passed = Object.values(results).filter((r) => r).length;
    const total = Object.keys(results).length;

    for (const [name, result] of Object.entries(results)) {
      console.log(`  ${result ? '✅' : '❌'} ${name}`);
    }

    console.log(`\n  Total: ${passed}/${total} passed`);

    if (passed === total) {
      console.log('\n✅ All PostgreSQL tests passed!\n');
    } else {
      console.log('\n❌ Some tests failed\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Test failed:', (error as Error).message);
    process.exit(1);
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}

main();
