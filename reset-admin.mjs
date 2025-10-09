import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const db = new Database('./data/meshmonitor.db');

// Generate a new random password
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 20; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

const newPassword = generatePassword();
const hashedPassword = await bcrypt.hash(newPassword, 10);

// Update admin password
const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?');
const result = stmt.run(hashedPassword, 'admin');

if (result.changes > 0) {
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
} else {
  console.error('Failed to reset password - admin user not found');
}

db.close();
