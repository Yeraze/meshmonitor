import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const dbPath = process.env.DATABASE_PATH || '/data/meshmonitor.db';
console.log(`\n🔍 Checking admin user in: ${dbPath}\n`);

const db = new Database(dbPath);

// Check if users table exists
const tableCheck = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' AND name='users'
`).get();

if (!tableCheck) {
  console.error('❌ Users table does not exist! Database may not be initialized.');
  console.log('\nTip: Make sure the container has started completely and initialized the database.\n');
  db.close();
  process.exit(1);
}

// Get admin user
const admin = db.prepare(`
  SELECT id, username, password_hash, is_admin, is_active, created_at
  FROM users
  WHERE username = 'admin'
`).get();

if (!admin) {
  console.error('❌ Admin user not found in database!');
  console.log('\nThis suggests the database initialization did not complete.');
  console.log('Check the container logs for errors during startup.\n');
  db.close();
  process.exit(1);
}

console.log('✅ Admin user found:');
console.log(`   ID: ${admin.id}`);
console.log(`   Username: ${admin.username}`);
console.log(`   Is Admin: ${admin.is_admin ? 'Yes' : 'No'}`);
console.log(`   Is Active: ${admin.is_active ? 'Yes' : 'No'}`);
console.log(`   Created: ${new Date(admin.created_at).toLocaleString()}`);
console.log(`   Password Hash: ${admin.password_hash ? admin.password_hash.substring(0, 20) + '...' : 'NULL'}`);

if (!admin.password_hash) {
  console.error('\n❌ Password hash is NULL! User cannot login.');
  console.log('\nRun: node reset-admin.mjs to set a new password\n');
  db.close();
  process.exit(1);
}

if (!admin.is_active) {
  console.error('\n❌ User is inactive! User cannot login.');
  db.close();
  process.exit(1);
}

// Test password "changeme"
console.log('\n🔐 Testing default password "changeme"...');
const defaultPasswordWorks = await bcrypt.compare('changeme', admin.password_hash);

if (defaultPasswordWorks) {
  console.log('✅ Default password "changeme" works!\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   Username: admin');
  console.log('   Password: changeme');
  console.log('═══════════════════════════════════════════════════════════\n');
} else {
  console.log('❌ Default password "changeme" does NOT work.');
  console.log('\nThe password has been changed from the default.');
  console.log('If you forgot the password, run: node reset-admin.mjs\n');
}

db.close();
