#!/usr/bin/env node
/**
 * Test the security scanner and check if the test node is detected
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the database
const dbPath = process.env.DB_PATH || join(__dirname, '../data/meshmonitor.db');

console.log('🔍 Testing security scanner...\n');
console.log('📁 Using database:', dbPath);

const db = new Database(dbPath);

// Get the test node
const testNode = db.prepare('SELECT * FROM nodes WHERE nodeNum = ?').get(999999999);

if (!testNode) {
  console.error('❌ Test node not found! Run scripts/insert-test-node.js first.');
  db.close();
  process.exit(1);
}

console.log('\n✅ Found test node:');
console.log(`   Node Number: ${testNode.nodeNum}`);
console.log(`   Long Name: ${testNode.longName}`);
console.log(`   Short Name: ${testNode.shortName}`);
console.log(`   Public Key: ${testNode.publicKey}`);
console.log('');

// Check if the key is detected as low-entropy
const keyBuffer = Buffer.from(testNode.publicKey, 'base64');
const hash = crypto.createHash('sha256');
hash.update(keyBuffer);
const keyHash = hash.digest('hex');

console.log('🔐 Key analysis:');
console.log(`   Key size: ${keyBuffer.length} bytes`);
console.log(`   SHA-256 hash: ${keyHash}`);

// Known test hash
const testKeyHash = '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793';
const isTestKey = keyHash === testKeyHash;

console.log(`   Matches test key: ${isTestKey ? '✅ YES' : '❌ NO'}`);
console.log('');

console.log('📊 Database security flags:');
console.log(`   keyIsLowEntropy: ${testNode.keyIsLowEntropy ? '✅ YES' : '❌ NO'}`);
console.log(`   duplicateKeyDetected: ${testNode.duplicateKeyDetected ? 'YES' : 'NO'}`);
if (testNode.keySecurityIssueDetails) {
  console.log(`   Details: ${testNode.keySecurityIssueDetails}`);
}
console.log('');

// Get all nodes with security issues
const securityIssues = db.prepare(`
  SELECT nodeNum, longName, shortName, keyIsLowEntropy, duplicateKeyDetected, keySecurityIssueDetails
  FROM nodes
  WHERE keyIsLowEntropy = 1 OR duplicateKeyDetected = 1
`).all();

console.log(`🔒 Total nodes with security issues in database: ${securityIssues.length}`);
if (securityIssues.length > 0) {
  console.log('\nNodes with issues:');
  securityIssues.forEach(node => {
    console.log(`   - ${node.longName} (${node.nodeNum})`);
    console.log(`     Low Entropy: ${node.keyIsLowEntropy ? 'YES' : 'NO'}`);
    console.log(`     Duplicate Key: ${node.duplicateKeyDetected ? 'YES' : 'NO'}`);
    if (node.keySecurityIssueDetails) {
      console.log(`     Details: ${node.keySecurityIssueDetails}`);
    }
  });
} else {
  console.log('   ℹ️  No issues detected yet. Run a security scan to detect the test node.');
}

console.log('\n💡 Next steps:');
if (!testNode.keyIsLowEntropy) {
  console.log('   1. The test node has NOT been flagged yet.');
  console.log('   2. Go to http://localhost:8080 and navigate to the Security page');
  console.log('   3. Click "Run Scan Now" to trigger a manual security scan');
  console.log('   4. The test node should appear in the security issues list');
} else {
  console.log('   ✅ Test node is already flagged! Check the Security page at http://localhost:8080');
}

db.close();
