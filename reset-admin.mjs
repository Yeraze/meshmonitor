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

function printSuccess(newPassword, mfaDisabled) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔐 Admin password has been reset');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Username: admin`);
  console.log(`   Password: ${newPassword}`);
  if (mfaDisabled) {
    console.log('');
    console.log('   ℹ️  MFA was enabled and has been disabled.');
    console.log('      Re-enable it after logging in if needed.');
  }
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
    const before = db.prepare('SELECT mfa_enabled FROM users WHERE username = ?').get('admin');
    const stmt = db.prepare(
      'UPDATE users SET password_hash = ?, is_active = 1, password_locked = 0, mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE username = ?'
    );
    const result = stmt.run(hashedPassword, 'admin');
    const mfaDisabled = result.changes > 0 && before?.mfa_enabled === 1;
    return { changed: result.changes > 0, mfaDisabled };
  } finally {
    db.close();
  }
}

async function resetPostgres(hashedPassword) {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const before = await pool.query('SELECT "mfaEnabled" FROM users WHERE username = $1', ['admin']);
    const result = await pool.query(
      'UPDATE users SET "passwordHash" = $1, "isActive" = true, "passwordLocked" = false, "mfaEnabled" = false, "mfaSecret" = null, "mfaBackupCodes" = null WHERE username = $2',
      [hashedPassword, 'admin']
    );
    const mfaDisabled = result.rowCount > 0 && before.rows[0]?.mfaEnabled === true;
    return { changed: result.rowCount > 0, mfaDisabled };
  } finally {
    await pool.end();
  }
}

async function resetMysql(hashedPassword) {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool(process.env.DATABASE_URL);
  try {
    const [beforeRows] = await pool.query('SELECT mfaEnabled FROM users WHERE username = ?', ['admin']);
    const [result] = await pool.query(
      'UPDATE users SET passwordHash = ?, isActive = true, passwordLocked = false, mfaEnabled = false, mfaSecret = NULL, mfaBackupCodes = NULL WHERE username = ?',
      [hashedPassword, 'admin']
    );
    const mfaDisabled = result.affectedRows > 0 && beforeRows[0]?.mfaEnabled;
    return { changed: result.affectedRows > 0, mfaDisabled };
  } finally {
    await pool.end();
  }
}

const dbType = detectDatabaseType();
console.log(`Detected database: ${dbType}`);

const newPassword = generatePassword();
const hashedPassword = await bcrypt.hash(newPassword, 10);

let result = { changed: false, mfaDisabled: false };
switch (dbType) {
  case 'sqlite':
    result = await resetSqlite(hashedPassword);
    break;
  case 'postgres':
    result = await resetPostgres(hashedPassword);
    break;
  case 'mysql':
    result = await resetMysql(hashedPassword);
    break;
}

if (result.changed) {
  printSuccess(newPassword, result.mfaDisabled);
} else {
  printNotFound();
}
