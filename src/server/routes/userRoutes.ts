/**
 * User Management Routes
 *
 * Admin-only routes for managing users and permissions
 */

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import { createLocalUser, resetUserPassword, setUserPassword } from '../auth/localAuth.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { PermissionSet } from '../../types/permission.js';

const router = Router();

// All routes require admin
router.use(requireAdmin());

// List all users
router.get('/', async (_req: Request, res: Response) => {
  try {
    let users: any[];
    // For PostgreSQL/MySQL, use async repo
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      if (databaseService.authRepo) {
        users = await databaseService.authRepo.getAllUsers();
      } else {
        users = [];
      }
    } else {
      users = databaseService.userModel.findAll();
    }

    // Remove password hashes
    const usersWithoutPasswords = users.map(({ passwordHash, ...user }) => user);

    return res.json({ users: usersWithoutPasswords });
  } catch (error) {
    logger.error('Error listing users:', error);
    return res.status(500).json({ error: 'Failed to list users' });
  }
});

// Get user by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Use async method that works with both SQLite and PostgreSQL
    const user = await databaseService.findUserByIdAsync(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Remove password hash
    const { passwordHash, ...userWithoutPassword } = user;

    return res.json({ user: userWithoutPassword });
  } catch (error) {
    logger.error('Error getting user:', error);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// Create new user (local auth only)
router.post('/', async (req: Request, res: Response) => {
  try {
    const { username, password, email, displayName, isAdmin } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password are required'
      });
    }

    const user = await createLocalUser(
      username,
      password,
      email,
      displayName,
      isAdmin || false,
      req.user!.id
    );

    // Remove password hash
    const { passwordHash, ...userWithoutPassword } = user;

    return res.json({
      success: true,
      user: userWithoutPassword
    });
  } catch (error) {
    logger.error('Error creating user:', error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to create user'
    });
  }
});

// Update user
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const { email, displayName, isActive, passwordLocked } = req.body;

    let user;
    // For PostgreSQL/MySQL, use async repo
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      if (databaseService.authRepo) {
        await databaseService.authRepo.updateUser(userId, {
          email,
          displayName,
          isActive,
          passwordLocked
        });
        user = await databaseService.findUserByIdAsync(userId);
      }
    } else {
      user = databaseService.userModel.update(userId, {
        email,
        displayName,
        isActive,
        passwordLocked
      });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'user_updated',
      'users',
      JSON.stringify({ userId, updates: { email, displayName, isActive, passwordLocked } }),
      req.ip || null
    );

    // Remove password hash
    const { passwordHash, ...userWithoutPassword } = user;

    return res.json({
      success: true,
      user: userWithoutPassword
    });
  } catch (error) {
    logger.error('Error updating user:', error);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete/deactivate user
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Prevent deleting yourself
    if (userId === req.user!.id) {
      return res.status(400).json({
        error: 'Cannot delete your own account'
      });
    }

    const user = await databaseService.findUserByIdAsync(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Deactivate user
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      if (databaseService.authRepo) {
        await databaseService.authRepo.updateUser(userId, { isActive: false });
      }
    } else {
      databaseService.userModel.delete(userId);
    }

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'user_deleted',
      'users',
      JSON.stringify({ userId, username: user.username }),
      req.ip || null
    );

    return res.json({
      success: true,
      message: 'User deactivated successfully'
    });
  } catch (error) {
    logger.error('Error deleting user:', error);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Permanently delete user (removes from database entirely)
router.delete('/:id/permanent', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Prevent deleting yourself
    if (userId === req.user!.id) {
      return res.status(400).json({
        error: 'Cannot delete your own account'
      });
    }

    const user = await databaseService.findUserByIdAsync(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting the anonymous user
    if (user.username === 'anonymous') {
      return res.status(400).json({
        error: 'Cannot delete the anonymous user'
      });
    }

    // Check if this is the last admin
    if (user.isAdmin) {
      let allUsers: any[];
      if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
        allUsers = databaseService.authRepo ? await databaseService.authRepo.getAllUsers() : [];
      } else {
        allUsers = databaseService.userModel.findAll();
      }
      const adminCount = allUsers.filter(u => u.isAdmin && u.isActive && u.id !== userId).length;
      if (adminCount === 0) {
        return res.status(400).json({
          error: 'Cannot delete the last admin user'
        });
      }
    }

    // Permanently delete user (cascades to permissions, preferences, subscriptions, etc.)
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      if (databaseService.authRepo) {
        await databaseService.authRepo.deleteUser(userId);
      }
    } else {
      databaseService.userModel.hardDelete(userId);
    }

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'user_permanently_deleted',
      'users',
      JSON.stringify({ userId, username: user.username }),
      req.ip || null
    );

    return res.json({
      success: true,
      message: 'User permanently deleted'
    });
  } catch (error) {
    logger.error('Error permanently deleting user:', error);
    return res.status(500).json({ error: 'Failed to permanently delete user' });
  }
});

// Update admin status
router.put('/:id/admin', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const { isAdmin } = req.body;

    if (typeof isAdmin !== 'boolean') {
      return res.status(400).json({
        error: 'isAdmin must be a boolean'
      });
    }

    // Prevent removing your own admin status
    if (userId === req.user!.id && !isAdmin) {
      return res.status(400).json({
        error: 'Cannot remove your own admin status'
      });
    }

    let user;
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      if (databaseService.authRepo) {
        await databaseService.authRepo.updateUser(userId, { isAdmin });
        user = await databaseService.findUserByIdAsync(userId);
      }
    } else {
      user = databaseService.userModel.updateAdminStatus(userId, isAdmin);
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'admin_status_changed',
      'users',
      JSON.stringify({ userId, isAdmin }),
      req.ip || null
    );

    return res.json({
      success: true,
      message: `User ${isAdmin ? 'promoted to' : 'demoted from'} admin`
    });
  } catch (error) {
    logger.error('Error updating admin status:', error);
    return res.status(500).json({ error: 'Failed to update admin status' });
  }
});

// Reset user password (admin only)
router.post('/:id/reset-password', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const newPassword = await resetUserPassword(userId, req.user!.id);

    return res.json({
      success: true,
      password: newPassword,
      message: 'Password reset successfully. Please provide this password to the user.'
    });
  } catch (error) {
    logger.error('Error resetting password:', error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to reset password'
    });
  }
});

// Set user password (admin only)
router.post('/:id/set-password', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const { newPassword } = req.body;

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required' });
    }

    await setUserPassword(userId, newPassword, req.user!.id);

    return res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    logger.error('Error setting password:', error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to set password'
    });
  }
});

// Get user permissions
router.get('/:id/permissions', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Use async method that works with both SQLite and PostgreSQL
    const permissions = await databaseService.getUserPermissionSetAsync(userId);

    return res.json({ permissions });
  } catch (error) {
    logger.error('Error getting user permissions:', error);
    return res.status(500).json({ error: 'Failed to get permissions' });
  }
});

// Update user permissions
router.put('/:id/permissions', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const { permissions } = req.body as { permissions: PermissionSet };

    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({
        error: 'Invalid permissions format'
      });
    }

    // Update permissions
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      if (databaseService.authRepo) {
        // Delete existing permissions and create new ones
        await databaseService.authRepo.deletePermissionsForUser(userId);
        for (const [resource, perms] of Object.entries(permissions)) {
          await databaseService.authRepo.createPermission({
            userId,
            resource,
            canRead: perms.read,
            canWrite: perms.write,
            grantedBy: req.user!.id,
            grantedAt: Date.now()
          });
        }
      }
    } else {
      databaseService.permissionModel.updateUserPermissions(
        userId,
        permissions,
        req.user!.id
      );
    }

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'permissions_updated',
      'permissions',
      JSON.stringify({ userId, permissions }),
      req.ip || null
    );

    return res.json({
      success: true,
      message: 'Permissions updated successfully'
    });
  } catch (error) {
    logger.error('Error updating permissions:', error);
    return res.status(500).json({ error: 'Failed to update permissions' });
  }
});

export default router;
