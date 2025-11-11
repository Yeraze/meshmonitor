/**
 * Local Authentication Module
 *
 * Handles username/password authentication
 */

import { User } from '../../types/auth.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Authenticate a user with username and password
 */
export async function authenticateLocal(
  username: string,
  password: string
): Promise<User | null> {
  try {
    logger.debug(`🔐 Local auth attempt for user: ${username}`);

    // Use the UserModel to authenticate
    const user = await databaseService.userModel.authenticate(username, password);

    if (!user) {
      logger.debug(`❌ Authentication failed for user: ${username}`);
      return null;
    }

    if (!user.isActive) {
      logger.debug(`❌ User ${username} is inactive`);
      return null;
    }

    logger.debug(`✅ Authentication successful for user: ${username}`);
    return user;
  } catch (error) {
    logger.error('Local authentication error:', error);
    return null;
  }
}

/**
 * Create a new local user
 */
export async function createLocalUser(
  username: string,
  password: string,
  email?: string,
  displayName?: string,
  isAdmin: boolean = false,
  createdBy?: number
): Promise<User> {
  try {
    // Validate password strength
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters long');
    }

    // Check if username already exists
    const existing = databaseService.userModel.findByUsername(username);
    if (existing) {
      throw new Error('Username already exists');
    }

    // Create user
    const user = await databaseService.userModel.create({
      username,
      password,
      email,
      displayName,
      authProvider: 'local',
      isAdmin,
      createdBy
    });

    // Grant default permissions
    databaseService.permissionModel.grantDefaultPermissions(user.id, isAdmin, createdBy);

    logger.debug(`✅ Created new local user: ${username} (admin: ${isAdmin})`);

    // Audit log
    databaseService.auditLog(
      createdBy || null,
      'user_created',
      'users',
      JSON.stringify({ userId: user.id, username, isAdmin }),
      null
    );

    return user;
  } catch (error) {
    logger.error('Failed to create local user:', error);
    throw error;
  }
}

/**
 * Change user password
 */
export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  try {
    const user = databaseService.userModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (user.authProvider !== 'local') {
      throw new Error('Cannot change password for non-local user');
    }

    // Verify current password
    if (!user.passwordHash) {
      throw new Error('User has no password set');
    }

    const isValid = await databaseService.userModel.verifyPassword(
      currentPassword,
      user.passwordHash
    );

    if (!isValid) {
      throw new Error('Current password is incorrect');
    }

    // Validate new password
    if (newPassword.length < 8) {
      throw new Error('New password must be at least 8 characters long');
    }

    // Update password
    await databaseService.userModel.updatePassword(userId, newPassword);

    logger.debug(`✅ Password changed for user: ${user.username}`);

    // Audit log
    databaseService.auditLog(
      userId,
      'password_changed',
      'users',
      JSON.stringify({ userId }),
      null
    );
  } catch (error) {
    logger.error('Failed to change password:', error);
    throw error;
  }
}

/**
 * Reset user password (admin only)
 */
export async function resetUserPassword(
  userId: number,
  adminUserId: number
): Promise<string> {
  try {
    const user = databaseService.userModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (user.authProvider !== 'local') {
      throw new Error('Cannot reset password for non-local user');
    }

    if (user.passwordLocked) {
      throw new Error('Password changes are locked for this account');
    }

    // Generate random password
    const newPassword = generateRandomPassword();

    // Update password
    await databaseService.userModel.updatePassword(userId, newPassword);

    logger.debug(`✅ Password reset for user: ${user.username}`);

    // Audit log
    databaseService.auditLog(
      adminUserId,
      'password_reset',
      'users',
      JSON.stringify({ userId, resetBy: adminUserId }),
      null
    );

    return newPassword;
  } catch (error) {
    logger.error('Failed to reset user password:', error);
    throw error;
  }
}

/**
 * Set user password to a specific value (admin only)
 */
export async function setUserPassword(
  userId: number,
  newPassword: string,
  adminUserId: number
): Promise<void> {
  try {
    const user = databaseService.userModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (user.authProvider !== 'local') {
      throw new Error('Cannot set password for non-local user');
    }

    if (user.passwordLocked) {
      throw new Error('Password changes are locked for this account');
    }

    // Validate password
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Update password
    await databaseService.userModel.updatePassword(userId, newPassword);

    logger.debug(`✅ Password set for user: ${user.username}`);

    // Audit log
    databaseService.auditLog(
      adminUserId,
      'password_set',
      'users',
      JSON.stringify({ userId, setBy: adminUserId }),
      null
    );
  } catch (error) {
    logger.error('Failed to set user password:', error);
    throw error;
  }
}

/**
 * Generate a random password
 */
function generateRandomPassword(): string {
  const length = 16;
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';

  // Ensure at least one of each type
  password += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  password += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
  password += '0123456789'[Math.floor(Math.random() * 10)];
  password += '!@#$%^&*'[Math.floor(Math.random() * 8)];

  // Fill the rest
  for (let i = password.length; i < length; i++) {
    password += charset[Math.floor(Math.random() * charset.length)];
  }

  // Shuffle the password
  return password.split('').sort(() => Math.random() - 0.5).join('');
}
