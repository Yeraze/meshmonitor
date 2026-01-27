import bcrypt from 'bcrypt';

// Generate a new random password
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 20; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

function printSuccess(newPassword) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔐 Admin password has been reset');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Username: admin`);
  console.log(`   Password: ${newPassword}`);
  console.log('');
  console.log('   ⚠️  IMPORTANT: Save this password now!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

function printNotFound() {
  console.error('Failed to reset password - admin user not found');
  console.error('');
  console.error('If you have not yet started the application, start it first');
  console.error('to create the default admin account, then run this script.');
}

// Detect database type from DATABASE_URL
function detectDatabaseType() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const lower = url.toLowerCase();
    if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) return 'postgres';
    if (lower.startsWith('mysql://') || lower.startsWith('mariadb://')) return 'mysql';
  }
  return 'sqlite';
}

async function resetSqlite(hashedPassword) {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = process.env.DATABASE_PATH || '/data/meshmonitor.db';
  const db = new Database(dbPath);
  try {
    const stmt = db.prepare(
      'UPDATE users SET password_hash = ?, is_active = 1, password_locked = 0 WHERE username = ?'
    );
    const result = stmt.run(hashedPassword, 'admin');
    return result.changes > 0;
  } finally {
    db.close();
  }
}

async function resetPostgres(hashedPassword) {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
      'UPDATE users SET "passwordHash" = $1, "isActive" = true, "passwordLocked" = false WHERE username = $2',
      [hashedPassword, 'admin']
    );
    return result.rowCount > 0;
  } finally {
    await pool.end();
  }
}

async function resetMysql(hashedPassword) {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool(process.env.DATABASE_URL);
  try {
    const [result] = await pool.query(
      'UPDATE users SET passwordHash = ?, isActive = true, passwordLocked = false WHERE username = ?',
      [hashedPassword, 'admin']
    );
    return result.affectedRows > 0;
  } finally {
    await pool.end();
  }
}

const dbType = detectDatabaseType();
console.log(`Detected database: ${dbType}`);

const newPassword = generatePassword();
const hashedPassword = await bcrypt.hash(newPassword, 10);

let success = false;
switch (dbType) {
  case 'sqlite':
    success = await resetSqlite(hashedPassword);
    break;
  case 'postgres':
    success = await resetPostgres(hashedPassword);
    break;
  case 'mysql':
    success = await resetMysql(hashedPassword);
    break;
}

if (success) {
  printSuccess(newPassword);
} else {
  printNotFound();
}
