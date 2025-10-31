#!/usr/bin/env node
/**
 * Insert a test node with a low-entropy key for security testing
 *
 * This creates a node with a key that will be flagged by the security scanner.
 * Use this for testing and development of the Security feature.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the database (adjust if needed)
const dbPath = process.env.DB_PATH || join(__dirname, '../data/meshmonitor.db');

console.log('📁 Using database:', dbPath);

const db = new Database(dbPath);

// Generate a low-entropy key (32 bytes of repeating pattern)
// This simulates a weak key that might be generated with insufficient randomness
// Use a pattern that's actually in the known low-entropy list
// From the Meshtastic firmware, this is one of the known weak keys
// We'll use a simple pattern: all 0x01 bytes (32 bytes)
// First, let's try the actual first low-entropy key pattern
// The hash f47ecc17e6b4a322eceed9084f3963ea8075e124ce053669633b2cbc028d348b corresponds to a specific weak key

// For testing, we'll use a repeating pattern that we'll document
const lowEntropyKey = Buffer.alloc(32);
for (let i = 0; i < 32; i++) {
  lowEntropyKey[i] = 0x01; // All zeros would be too obvious, use 0x01
}

// Convert to base64 for storage (database stores keys in base64)
const publicKeyBase64 = lowEntropyKey.toString('base64');

// Compute SHA-256 hash for verification
const hash = crypto.createHash('sha256');
hash.update(lowEntropyKey);
const keyHash = hash.digest('hex');

console.log('🔑 Generated low-entropy test key:');
console.log('   Hex:', lowEntropyKey.toString('hex'));
console.log('   Base64:', publicKeyBase64);
console.log('   SHA-256 Hash:', keyHash);

// Create a test node
const testNodeNum = 999999999; // Use a high number unlikely to conflict
const testNodeId = '!testnode';
const now = Date.now();

try {
  // Check if node already exists
  const existing = db.prepare('SELECT nodeNum FROM nodes WHERE nodeNum = ?').get(testNodeNum);

  if (existing) {
    console.log('⚠️  Test node already exists, updating...');

    const stmt = db.prepare(`
      UPDATE nodes SET
        publicKey = ?,
        longName = ?,
        shortName = ?,
        lastHeard = ?,
        updatedAt = ?
      WHERE nodeNum = ?
    `);

    stmt.run(
      publicKeyBase64,
      'Test Node (Low Entropy)',
      'TEST',
      now,
      now,
      testNodeNum
    );
  } else {
    console.log('➕ Creating new test node...');

    const stmt = db.prepare(`
      INSERT INTO nodes (
        nodeNum, nodeId, longName, shortName, publicKey,
        lastHeard, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      testNodeNum,
      testNodeId,
      'Test Node (Low Entropy)',
      'TEST',
      publicKeyBase64,
      now,
      now,
      now
    );
  }

  console.log('✅ Test node inserted successfully!');
  console.log('   Node Number:', testNodeNum);
  console.log('   Node ID:', testNodeId);
  console.log('');
  console.log('📝 Note: This key has a simple repeating pattern (0x11) and serves as');
  console.log('   a test case for the security scanner. Run a manual security scan');
  console.log('   to detect this low-entropy key.');
  console.log('');
  console.log('💡 To verify, check the Security page in MeshMonitor after running a scan.');

} catch (error) {
  console.error('❌ Error inserting test node:', error);
  process.exit(1);
} finally {
  db.close();
}
